// Leave requests + absences (owner D3, FR-903, BR-22a/BR-24).
//  • GM, Admin and technicians request their own leave (whole days or half a day); CEO/CFO do not (BR-22a).
//  • Approval chain BR-24: technician → GM (leave.approve.tech) · Admin → CEO (leave.approve.admin) · GM → CEO (leave.approve.gm).
//    Nobody approves their own request (fixed rule, FR-105).
//  • An approver may mark someone ABSENT directly (sick call, no-show) — approved at once.
//  • Approved rows block the person in the technician picker and in every assign / reschedule (bookings.ts).
import type { LeavePart, PermissionKey } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { notifyUser } from "./telegram.js";

const APPROVE_KEY: Record<string, PermissionKey> = { tech: "leave.approve.tech", admin: "leave.approve.admin", gm: "leave.approve.gm" };
const ATTENDANCE_ROLES = ["tech", "admin", "gm"];

type Row = { id: string; company_id: string; user_id: string; kind: "leave" | "absent"; status: string; date_from: string; date_to: string; part: LeavePart; starts_at: Date; ends_at: Date; role: string };

async function tz(db: Db, companyId: string): Promise<string> {
  return (await db<{ timezone: string }[]>`select timezone from companies where id = ${companyId}`)[0]?.timezone ?? "Asia/Phnom_Penh";
}
/** local calendar days → [start, end): full = whole days · am = 00:00–12:00 · pm = 12:00–24:00 (company time zone) */
async function range(db: Db, companyId: string, from: string, to: string, part: LeavePart): Promise<{ starts_at: Date; ends_at: Date }> {
  if (to < from) throw new AppError("END_BEFORE_START", 400);
  if (part !== "full" && to !== from) throw new AppError("HALF_DAY_ONE_DATE", 400);
  const zone = await tz(db, companyId);
  const today = (await db<{ d: string }[]>`select to_char((now() at time zone ${zone})::date, 'YYYY-MM-DD') as d`)[0]!.d;
  if (from < today) throw new AppError("START_IN_PAST", 400);
  const r = (await db<{ s: Date; e: Date }[]>`
    select ((${from}::date + ${part === "pm" ? "12:00" : "00:00"}::time) at time zone ${zone}) as s,
           (case when ${part} = 'am' then (${from}::date + '12:00'::time) else (${to}::date + 1)::timestamp end at time zone ${zone}) as e`)[0]!;
  return { starts_at: r.s, ends_at: r.e };
}

/** approved bookings of this person that fall inside [s, e) — the approver sees what must be re-assigned */
async function affected(db: Db, userId: string, s: Date, e: Date) {
  return db<{ id: string; number: string; scheduled_at: Date }[]>`
    select b.id, b.number, b.scheduled_at from booking_technicians t join bookings b on b.id = t.booking_id
    where t.user_id = ${userId} and b.status in ('new', 'assigned', 'en_route', 'on_site', 'working')
      and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${s}, ${e}, '[)') order by b.scheduled_at`;
}

async function approvers(db: Db, companyId: string, targetRole: string, exclude: string) {
  return db<{ id: string }[]>`select u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role
    where u.company_id = ${companyId} and u.is_active and u.id <> ${exclude} and rp.permission_key = ${APPROVE_KEY[targetRole]!} and rp.allowed`;
}

export async function requestLeave(user: SessionUser, ip: string | null, v: { date_from: string; date_to: string; part: LeavePart; reason: string }) {
  if (!ATTENDANCE_ROLES.includes(user.role)) throw new AppError("NO_ATTENDANCE_ROLE", 400);
  return tx(user.id, async (t) => {
    const r = await range(t, user.companyId, v.date_from, v.date_to, v.part);
    const id = (await t<{ id: string }[]>`insert into staff_leaves (company_id, user_id, kind, date_from, date_to, part, starts_at, ends_at, reason, requested_by)
      values (${user.companyId}, ${user.id}, 'leave', ${v.date_from}, ${v.date_to}, ${v.part}::leave_part, ${r.starts_at}, ${r.ends_at}, ${v.reason.trim()}, ${user.id}) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "leave.request", table: "staff_leaves", rowId: id, new: { ...v }, ip });
    const when = v.date_from === v.date_to ? v.date_from : `${v.date_from} → ${v.date_to}`;
    for (const a of await approvers(t, user.companyId, user.role, user.id))
      await notifyUser(t, user.companyId, a.id, "leave.request", { km: `🗓 សំណើច្បាប់ឈប់ · ${user.fullName}`, en: `🗓 Leave request · ${user.fullName}` },
      { km: `${when} (${v.part === "full" ? "ពេញថ្ងៃ" : v.part === "am" ? "ព្រឹក" : "រសៀល"})\n📝 ${v.reason.trim()}`, en: `${when} (${v.part === "full" ? "full day" : v.part === "am" ? "morning" : "afternoon"})\n📝 ${v.reason.trim()}` }, "/leave", `leave:${id}:req:${a.id}`);
    return { id, status: "pending" as const };
  });
}

async function loadForDecision(t: Db, user: SessionUser, id: string): Promise<Row> {
  const row = (await t<Row[]>`select l.*, u.role from staff_leaves l join users u on u.id = l.user_id where l.id = ${id} and l.company_id = ${user.companyId} for update of l`)[0];
  if (!row) throw notFound();
  if (row.user_id === user.id) throw forbidden("OWN_REQUEST"); // nobody approves their own request (FR-105 fixed rule)
  const perms = (await t<{ permission_key: string }[]>`select permission_key from role_permissions where company_id = ${user.companyId} and role = ${user.role}::user_role and allowed`).map((p) => p.permission_key);
  if (!perms.includes(APPROVE_KEY[row.role] ?? "-")) throw forbidden();
  return row;
}

export async function decideLeave(user: SessionUser, ip: string | null, id: string, approve: boolean, note: string | null) {
  return tx(user.id, async (t) => {
    const row = await loadForDecision(t, user, id);
    if (row.status !== "pending") throw new AppError("LEAVE_NOT_PENDING", 400);
    const status = approve ? "approved" : "rejected";
    await t`update staff_leaves set status = ${status}::leave_status, decided_by = ${user.id}, decided_at = now(), decision_note = ${note} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: approve ? "leave.approve" : "leave.reject", table: "staff_leaves", rowId: id, new: { note }, ip });
    await notifyUser(t, user.companyId, row.user_id, approve ? "leave.approved" : "leave.rejected",
      approve ? { km: "✅ ច្បាប់ឈប់ត្រូវបានអនុម័ត", en: "✅ Leave approved" } : { km: "❌ ច្បាប់ឈប់ត្រូវបានបដិសេធ", en: "❌ Leave rejected" }, `${row.date_from}${row.date_to !== row.date_from ? " → " + row.date_to : ""}${note ? `\n📝 ${note}` : ""}`, "/leave", `leave:${id}:${status}`);
    return { id, status, affected: approve ? await affected(t, row.user_id, row.starts_at, row.ends_at) : [] };
  });
}

export async function markAbsent(user: SessionUser, ip: string | null, v: { user_id: string; date_from: string; date_to: string; part: LeavePart; reason: string }) {
  return tx(user.id, async (t) => {
    const target = (await t<{ id: string; role: string }[]>`select id, role from users where id = ${v.user_id} and company_id = ${user.companyId} and is_active`)[0];
    if (!target) throw notFound();
    if (target.id === user.id) throw forbidden("OWN_REQUEST");
    if (!ATTENDANCE_ROLES.includes(target.role)) throw new AppError("NO_ATTENDANCE_ROLE", 400);
    const perms = (await t<{ permission_key: string }[]>`select permission_key from role_permissions where company_id = ${user.companyId} and role = ${user.role}::user_role and allowed`).map((p) => p.permission_key);
    if (!perms.includes(APPROVE_KEY[target.role]!)) throw forbidden();
    const r = await range(t, user.companyId, v.date_from, v.date_to, v.part);
    const id = (await t<{ id: string }[]>`insert into staff_leaves (company_id, user_id, kind, date_from, date_to, part, starts_at, ends_at, reason, status, requested_by, decided_by, decided_at)
      values (${user.companyId}, ${target.id}, 'absent', ${v.date_from}, ${v.date_to}, ${v.part}::leave_part, ${r.starts_at}, ${r.ends_at}, ${v.reason.trim()}, 'approved', ${user.id}, ${user.id}, now()) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "leave.absent", table: "staff_leaves", rowId: id, new: { ...v }, ip });
    return { id, status: "approved" as const, affected: await affected(t, target.id, r.starts_at, r.ends_at) };
  });
}

export async function cancelLeave(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    const row = (await t<Row[]>`select * from staff_leaves where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!row) throw notFound();
    if (row.user_id !== user.id || row.kind !== "leave") throw forbidden();
    if (row.status !== "pending") throw new AppError("LEAVE_NOT_PENDING", 400);
    await t`update staff_leaves set status = 'cancelled' where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "leave.cancel", table: "staff_leaves", rowId: id, ip });
    return { id, status: "cancelled" as const };
  });
}

/** mine (default) · approve = everything the caller may decide/see as an approver */
export async function listLeave(user: SessionUser, perms: string[], scope: "mine" | "approve") {
  const base = sql`select l.id, l.user_id, u.full_name, u.role, l.kind, l.date_from::text, l.date_to::text, l.part, l.reason, l.status, l.created_at, l.decided_at, l.decision_note,
      d.full_name as decided_by_name from staff_leaves l join users u on u.id = l.user_id left join users d on d.id = l.decided_by`;
  if (scope === "mine") return sql`${base} where l.company_id = ${user.companyId} and l.user_id = ${user.id} order by l.date_from desc limit 200`;
  const roles = Object.entries(APPROVE_KEY).filter(([, k]) => perms.includes(k)).map(([r]) => r);
  if (!roles.length) throw forbidden();
  return sql`${base} where l.company_id = ${user.companyId} and u.role = any(${sql.array(roles)}::user_role[]) and l.user_id <> ${user.id}
    order by (l.status = 'pending') desc, l.date_from desc limit 300`;
}
