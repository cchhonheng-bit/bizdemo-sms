// Flow 7b (D-81): technician performance (FR-1104), export to Excel as CSV (FR-1105), daily cash close (FR-1107).
import { sql, tx, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { report as attendanceReport } from "./attendance.js";
import { postCashClose } from "./ledger-hooks.js";

const MAX_DAYS = 92;
const tzOf = async (db: Db, companyId: string) => (await db<{ tz: string }[]>`select timezone as tz from companies where id = ${companyId}`)[0]?.tz ?? "Asia/Phnom_Penh";
const localDay = (col: ReturnType<typeof sql>, tz: string) => sql`(${col} at time zone ${tz})::date`;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export function checkRange(from: string, to: string) {
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new AppError("BAD_RANGE", 400);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) throw new AppError("RANGE_TOO_LONG", 400);
}

// ---------- technician performance (FR-1104) ----------
/** per technician: jobs finished in the period (finish checkpoint), work minutes (start → finish), revision rounds, late arrivals */
export async function techPerformance(companyId: string, from: string, to: string) {
  const tz = await tzOf(sql, companyId);
  const inRange = (col: ReturnType<typeof sql>) => sql`${localDay(col, tz)} between ${from}::date and ${to}::date`;
  return sql<{ user_id: string; full_name: string; jobs: number; work_min: number; revisions: number; late: number }[]>`
    with crew as (select t.user_id, t.booking_id from booking_technicians t join bookings b on b.id = t.booking_id where b.company_id = ${companyId} and not b.is_test),
    fin as (select k.booking_id, k.at as finish_at, (select s.at from booking_checkpoints s where s.booking_id = k.booking_id and s.step = 'start') as start_at
      from booking_checkpoints k where k.company_id = ${companyId} and k.step = 'finish' and ${inRange(sql`k.at`)})
    select u.id as user_id, u.full_name,
      (select count(*)::int from crew c join fin f on f.booking_id = c.booking_id where c.user_id = u.id) as jobs,
      (select coalesce(sum(greatest(0, extract(epoch from (f.finish_at - f.start_at)) / 60)), 0)::int from crew c join fin f on f.booking_id = c.booking_id
        where c.user_id = u.id and f.start_at is not null) as work_min,
      (select count(*)::int from crew c join booking_status_log l on l.booking_id = c.booking_id where c.user_id = u.id and l.to_status = 'revision' and ${inRange(sql`l.at`)}) as revisions,
      (select count(*)::int from crew c join bookings b on b.id = c.booking_id where c.user_id = u.id and b.late_alerted_at is not null and ${inRange(sql`b.late_alerted_at`)}) as late
    from users u where u.company_id = ${companyId} and u.is_active and u.role = 'tech' order by u.full_name`;
}

// ---------- export to Excel as CSV (FR-1105) ----------
export type ExportKind = "invoices" | "payments" | "jobs" | "attendance";
const money = (cents: number | null | undefined) => (cents == null ? "" : (cents / 100).toFixed(2));
/** RFC 4180 cell; a leading = + - @ (or tab / CR) is neutralised with ' so Excel never runs it as a formula (CSV injection) */
export function cell(v: unknown): string {
  let s = v == null ? "" : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: unknown[][]) => "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";

type Row = Record<string, string | number | null>;
export async function exportCsv(user: SessionUser, perms: string[], kind: ExportKind, from: string, to: string): Promise<string> {
  checkRange(from, to);
  const c = user.companyId;
  if ((kind === "invoices" || kind === "payments") && !perms.includes("report.finance")) throw new AppError("FORBIDDEN", 403);
  const tz = await tzOf(sql, c);
  if (kind === "invoices") {
    const day = localDay(sql`coalesce(i.issued_at, i.created_at)`, tz);
    const rows = await sql<Row[]>`select i.number, i.status, ${day}::text as day, cu.name as customer, b.number as booking,
        coalesce(b.zone, cu.zone)::text as zone, coalesce(b.category::text, 'direct') as category, i.discount,
        (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = i.id) as subtotal,
        (select coalesce(sum(p.usd_cents), 0)::int from payments p where p.invoice_id = i.id) as paid
      from invoices i join customers cu on cu.id = i.customer_id left join bookings b on b.id = i.booking_id
      where i.company_id = ${c} and ${day} between ${from}::date and ${to}::date order by i.created_at`;
    return csv([["number", "status", "date", "customer", "booking", "zone", "category", "subtotal_usd", "discount_usd", "total_usd", "paid_usd", "balance_usd"],
      ...rows.map((r) => {
        const total = Number(r.subtotal) - Number(r.discount), paid = Number(r.paid);
        return [r.number, r.status, r.day, r.customer, r.booking, r.zone, r.category, money(Number(r.subtotal)), money(Number(r.discount)), money(total), money(paid), money(r.status === "issued" ? Math.max(0, total - paid) : 0)];
      })]);
  }
  if (kind === "payments") {
    const rows = await sql<Row[]>`select p.paid_on::text as day, i.number, cu.name as customer, p.method, p.currency, p.amount::float8 as amount, p.fx_rate_khr::float as fx, p.usd_cents,
        u.full_name as received_by, p.note
      from payments p join invoices i on i.id = p.invoice_id join customers cu on cu.id = i.customer_id left join users u on u.id = p.received_by
      where p.company_id = ${c} and p.paid_on between ${from}::date and ${to}::date order by p.paid_on, p.created_at`;
    return csv([["date", "invoice", "customer", "method", "currency", "amount", "rate_khr", "usd", "received_by", "note"],
      ...rows.map((r) => [r.day, r.number, r.customer, r.method, r.currency, r.currency === "usd" ? money(Number(r.amount)) : r.amount, r.fx, money(Number(r.usd_cents)), r.received_by, r.note])]);
  }
  if (kind === "jobs") {
    const day = localDay(sql`b.scheduled_at`, tz);
    const rows = await sql<Row[]>`select b.number, b.status, ${day}::text as day, to_char(b.scheduled_at at time zone ${tz}, 'HH24:MI') as time,
        cu.name as customer, b.type, b.category, b.zone, b.service_text,
        (select string_agg(u.full_name, ' + ' order by t.role, u.full_name) from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as crew, b.cancel_reason
      from bookings b join customers cu on cu.id = b.customer_id
      where b.company_id = ${c} and not b.is_test and ${day} between ${from}::date and ${to}::date order by b.scheduled_at`;
    return csv([["number", "status", "date", "time", "customer", "type", "category", "zone", "service", "crew", "cancel_reason"],
      ...rows.map((r) => [r.number, r.status, r.day, r.time, r.customer, r.type, r.category, r.zone, r.service_text, r.crew, r.cancel_reason])]);
  }
  const a = await attendanceReport(user, from, to);
  const out: unknown[][] = [["date", "name", "role", "status", "in", "out", "late_min", "after_hours_min", "out_of_range", "no_gps", "distance_in_m", "distance_out_m", "leave_part"]];
  for (const u of a.users) for (const d of u.days) if (d.status !== "none") {
    const x = d as Record<string, unknown>;
    out.push([d.date, u.full_name, u.role, d.status, x.in, x.out, x.late_min, x.ot_min, x.out_of_range ? "yes" : "", x.no_gps ? "yes" : "", x.distance_in, x.distance_out, x.leave_part]);
  }
  return csv(out);
}

// ---------- daily cash close (FR-1107) ----------
/** cash taken that day: payments (not those made from a deposit) + deposits received that day (not voided) */
async function expectedCash(db: Db, companyId: string, day: string) {
  return (await db<{ usd: number; khr: number }[]>`select coalesce(sum(x.amount) filter (where x.method = 'cash_usd'), 0)::int as usd,
      coalesce(sum(x.amount) filter (where x.method = 'cash_khr'), 0)::float8 as khr
    from (select amount, method::text from payments where company_id = ${companyId} and paid_on = ${day}::date and deposit_id is null
      union all select amount, method::text from deposits where company_id = ${companyId} and paid_on = ${day}::date and status <> 'void') x`)[0]!;
}

export async function cashCloses(user: SessionUser, from: string, to: string) {
  checkRange(from, to);
  const closes = await sql<Row[]>`select cc.day::text as day, cc.counted_usd, cc.counted_khr::float8 as counted_khr, cc.note, cc.closed_at, cc.verified_at,
      cu.full_name as closed_by_name, vu.full_name as verified_by_name
    from cash_closes cc left join users cu on cu.id = cc.closed_by left join users vu on vu.id = cc.verified_by
    where cc.company_id = ${user.companyId} and cc.day between ${from}::date and ${to}::date`;
  const byDay = new Map(closes.map((c) => [String(c.day), c]));
  const out = [];
  for (let day = to; day >= from; day = addDays(day, -1)) {
    const e = await expectedCash(sql, user.companyId, day);
    const c = byDay.get(day);
    out.push({ day, expected_usd: e.usd, expected_khr: e.khr, counted_usd: c ? Number(c.counted_usd) : null, counted_khr: c ? Number(c.counted_khr) : null,
      diff_usd: c ? Number(c.counted_usd) - e.usd : null, diff_khr: c ? Number(c.counted_khr) - e.khr : null, note: c?.note ?? null,
      closed: !!c?.verified_at, closed_at: c?.closed_at ?? null, closed_by_name: c?.closed_by_name ?? null, verified_at: c?.verified_at ?? null, verified_by_name: c?.verified_by_name ?? null });
  }
  return out;
}

export async function closeCash(user: SessionUser, ip: string | null, v: { day: string; counted_usd: number; counted_khr: number; note?: string | null }) {
  return tx(user.id, async (t) => {
    const tz = await tzOf(t, user.companyId);
    if ((await t<{ future: boolean }[]>`select ${v.day}::date > (now() at time zone ${tz})::date as future`)[0]!.future) throw new AppError("BAD_DATE", 400);
    const old = (await t<{ verified_at: Date | null }[]>`select verified_at from cash_closes where company_id = ${user.companyId} and day = ${v.day}::date for update`)[0];
    if (old?.verified_at) throw new AppError("CASH_VERIFIED", 409);
    const e = await expectedCash(t, user.companyId, v.day);
    await t`insert into cash_closes (company_id, day, counted_usd, counted_khr, expected_usd, expected_khr, note, closed_by)
      values (${user.companyId}, ${v.day}::date, ${v.counted_usd}, ${v.counted_khr}, ${e.usd}, ${e.khr}, ${v.note?.trim() || null}, ${user.id})
      on conflict (company_id, day) do update set counted_usd = excluded.counted_usd, counted_khr = excluded.counted_khr, expected_usd = excluded.expected_usd,
        expected_khr = excluded.expected_khr, note = excluded.note, closed_by = excluded.closed_by, closed_at = now()`;
    const diff = { diff_usd: v.counted_usd - e.usd, diff_khr: v.counted_khr - e.khr };
    await postCashClose(t, user, { day: v.day, ...diff }); // over / short → accounting
    await audit(t, { companyId: user.companyId, userId: user.id, action: "cash.close", table: "cash_closes", rowId: user.companyId, new: { day: v.day, counted_usd: v.counted_usd, counted_khr: v.counted_khr, ...diff }, ip });
    return { day: v.day, expected_usd: e.usd, expected_khr: e.khr, ...diff };
  });
}

export async function verifyCash(user: SessionUser, ip: string | null, day: string) {
  return tx(user.id, async (t) => {
    const r = await t`update cash_closes set verified_by = ${user.id}, verified_at = now() where company_id = ${user.companyId} and day = ${day}::date and verified_at is null returning day`;
    if (r.length) await audit(t, { companyId: user.companyId, userId: user.id, action: "cash.verify", table: "cash_closes", rowId: user.companyId, new: { day }, ip });
    else if (!(await t`select 1 from cash_closes where company_id = ${user.companyId} and day = ${day}::date`).length) throw new AppError("NOT_CLOSED", 400);
    return { ok: true };
  });
}
