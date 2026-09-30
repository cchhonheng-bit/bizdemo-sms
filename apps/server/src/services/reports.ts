// Reports (Flow 6, D-79 · M10/M11 · FR-1004 · FR-1101 · FR-1102 · FR-1103 · FR-1106 · FR-1202 · AC-13).
// Revenue = issued (not void) invoice totals by issue date; received = payments by payment date; zone from the booking,
// else the customer (AC-13). Money figures only for report.finance (CEO, CFO); operations for report.ops.
import { formatKhr, formatUsd } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { report as attendanceReport } from "./attendance.js";
import { notifyUser } from "./telegram.js";

const MAX_DAYS = 92;
const tzOf = async (db: Db, companyId: string) => (await db<{ tz: string }[]>`select timezone as tz from companies where id = ${companyId}`)[0]?.tz ?? "Asia/Phnom_Penh";
const localDay = (col: ReturnType<typeof sql>, tz: string) => sql`(${col} at time zone ${tz})::date`;

function checkRange(from: string, to: string) {
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from > to) throw new AppError("BAD_RANGE", 400);
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 + 1 > MAX_DAYS) throw new AppError("RANGE_TOO_LONG", 400);
}

/** issued invoices with total and paid (all payments to date) */
const INV = (companyId: string) => sql`
  select i.id, i.number, i.status, i.issued_at, i.voided_at, i.discount, i.discount_status, i.discount_requested, i.customer_id,
    coalesce(b.zone, c.zone)::text as zone, coalesce(b.category::text, 'direct') as category,
    (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = i.id) - i.discount as total,
    (select coalesce(sum(p.usd_cents), 0)::int from payments p where p.invoice_id = i.id) as paid
  from invoices i join customers c on c.id = i.customer_id left join bookings b on b.id = i.booking_id where i.company_id = ${companyId}`;

type Money = { total: number; invoices: number; inside: number; outside: number; by_category: Record<string, number> };
export async function summaryData(companyId: string, from: string, to: string, finance: boolean) {
  const tz = await tzOf(sql, companyId);
  const inRange = (col: ReturnType<typeof sql>) => sql`${localDay(col, tz)} between ${from}::date and ${to}::date`;
  const jobs = (await sql<{ created: number; finished: number; cancelled: number; pending_review: number; in_progress: number }[]>`select
      (select count(*)::int from bookings where company_id = ${companyId} and ${inRange(sql`created_at`)}) as created,
      (select count(distinct k.booking_id)::int from booking_checkpoints k where k.company_id = ${companyId} and k.step = 'finish' and ${inRange(sql`k.at`)}) as finished,
      (select count(*)::int from bookings where company_id = ${companyId} and status = 'cancelled' and ${inRange(sql`cancelled_at`)}) as cancelled,
      (select count(*)::int from bookings where company_id = ${companyId} and status = 'pending_review') as pending_review,
      (select count(*)::int from bookings where company_id = ${companyId} and status in ('en_route', 'on_site', 'working')) as in_progress`)[0]!;
  const out: Record<string, unknown> = { from, to, jobs, cancels: jobs.cancelled };
  if (from === to) { // the day's attendance line (daily report / summary)
    const a = await attendanceReport({ companyId } as SessionUser, from, to);
    const day = a.users.map((u) => u.days[0]!).filter((d) => d.status !== "none");
    out.attendance = { people: day.length, present: day.filter((d) => d.status === "present" || d.status === "late").length, late: day.filter((d) => d.status === "late").length,
      absent: day.filter((d) => d.status === "absent").length, leave: day.filter((d) => d.status === "leave").length, out_of_range: day.filter((d) => "out_of_range" in d && d.out_of_range).length };
  }
  if (!finance) return out;
  const inv = await sql<{ status: string; issued_at: Date | null; voided_at: Date | null; zone: string; category: string; total: number; paid: number; issued_day: string | null; void_day: string | null }[]>`
    select x.*, ${localDay(sql`x.issued_at`, tz)}::text as issued_day, ${localDay(sql`x.voided_at`, tz)}::text as void_day from (${INV(companyId)}) x`;
  const inPeriod = (d: string | null) => !!d && d >= from && d <= to;
  const issued = inv.filter((i) => i.status === "issued" && inPeriod(i.issued_day));
  const revenue: Money = { total: 0, invoices: issued.length, inside: 0, outside: 0, by_category: { mep: 0, construction: 0, decor: 0, camera: 0, direct: 0 } };
  for (const i of issued) { revenue.total += i.total; revenue[i.zone === "inside" ? "inside" : "outside"] += i.total; revenue.by_category[i.category] = (revenue.by_category[i.category] ?? 0) + i.total; }
  const pays = await sql<{ method: string; cents: number; riel: number; n: number }[]>`select p.method::text as method, coalesce(sum(p.usd_cents), 0)::int as cents,
      coalesce(sum(p.amount) filter (where p.currency = 'khr'), 0)::float8 as riel, count(*)::int as n
    from payments p where p.company_id = ${companyId} and p.paid_on between ${from}::date and ${to}::date group by p.method`;
  const by_method: Record<string, number> = { cash_usd: 0, cash_khr: 0, aba: 0, acleda: 0 };
  for (const p of pays) by_method[p.method] = p.cents;
  const limit = (await sql<{ l: number }[]>`select discount_approval_limit as l from company_settings where company_id = ${companyId}`)[0]?.l ?? 5000;
  const disc = (await sql<{ n: number; total: number; over: number }[]>`select count(*)::int as n, coalesce(sum(discount), 0)::int as total, count(*) filter (where discount >= ${limit})::int as over
    from invoices where company_id = ${companyId} and discount_status = 'applied' and discount > 0 and ${inRange(sql`coalesce(discount_decided_at, discount_at, created_at)`)}`)[0]!;
  const voids = inv.filter((i) => i.status === "void" && inPeriod(i.void_day));
  return {
    ...out, revenue,
    payments: { total: pays.reduce((s, p) => s + p.cents, 0), count: pays.reduce((s, p) => s + p.n, 0), by_method, khr_riel: pays.reduce((s, p) => s + p.riel, 0) },
    new_debt: issued.reduce((s, i) => s + Math.max(0, i.total - i.paid), 0),
    debt_total: inv.filter((i) => i.status === "issued").reduce((s, i) => s + Math.max(0, i.total - i.paid), 0),
    voids: { count: voids.length, total: voids.reduce((s, i) => s + i.total, 0) },
    discounts: { count: disc.n, total: disc.total, over_limit: disc.over },
  };
}

export async function summary(user: SessionUser, perms: string[], from: string, to: string) {
  checkRange(from, to);
  return summaryData(user.companyId, from, to, perms.includes("report.finance"));
}

// ---------- verification (FR-1103 · FR-1106) ----------
export type VerifyType = "void" | "discount" | "cancel" | "payment";
async function items(companyId: string, range: { from: string; to: string } | null, unverified: boolean) {
  const tz = await tzOf(sql, companyId);
  const rows = await sql<Record<string, unknown>[]>`
    with x as (
      select 'void' as type, i.id, i.voided_at as at, i.number as ref, null::text as ref2,
        (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = i.id) - i.discount as amount,
        i.void_reason as reason, null::text as status, null::text as method, null::text as currency, null::float8 as raw_amount,
        coalesce(r.requested_by, i.voided_by) as requested_by, case when r.id is null then null else i.voided_by end as approved_by, '/invoices/' || i.id as link
      from invoices i left join invoice_void_requests r on r.invoice_id = i.id and r.status = 'approved'
      where i.company_id = ${companyId} and i.status = 'void'
      union all
      select 'discount', i.id, coalesce(i.discount_decided_at, i.discount_at, i.created_at), i.number, null, i.discount_requested, i.discount_note, i.discount_status::text, null, null, null,
        i.discount_by, case when i.discount_decided_by = i.discount_by then null else i.discount_decided_by end, '/invoices/' || i.id
      from invoices i where i.company_id = ${companyId} and coalesce(i.discount_requested, 0) > 0
      union all
      select 'cancel', b.id, b.cancelled_at, b.number, null, null, b.cancel_reason, null, null, null, null, b.cancelled_by, null, '/bookings/' || b.id
      from bookings b where b.company_id = ${companyId} and b.status = 'cancelled'
      union all
      select 'payment', p.id, p.created_at, i.number, null, p.usd_cents, p.note, null, p.method::text, p.currency::text, p.amount::float8, p.received_by, null, '/invoices/' || i.id
      from payments p join invoices i on i.id = p.invoice_id where p.company_id = ${companyId}
    )
    select x.type, x.id, x.at, x.ref, x.amount, x.reason, x.status, x.method, x.currency, x.raw_amount, x.link,
      rq.full_name as requested_by_name, ap.full_name as approved_by_name, v.verified_at, vu.full_name as verified_by_name, v.note as verify_note
    from x left join users rq on rq.id = x.requested_by left join users ap on ap.id = x.approved_by
      left join verifications v on v.company_id = ${companyId} and v.item_type::text = x.type and v.item_id = x.id left join users vu on vu.id = v.verified_by
    where x.at is not null ${range ? sql`and ${localDay(sql`x.at`, tz)} between ${range.from}::date and ${range.to}::date` : sql``}
      ${unverified ? sql`and v.item_id is null` : sql``}
    order by x.at desc limit 1000`;
  return rows;
}

export async function verification(user: SessionUser, from: string, to: string, unverified: boolean) {
  checkRange(from, to);
  return items(user.companyId, { from, to }, unverified);
}

export async function verify(user: SessionUser, ip: string | null, type: VerifyType, id: string, note: string) {
  return tx(user.id, async (t) => {
    const exists = type === "void" ? t`select 1 from invoices where id = ${id} and company_id = ${user.companyId} and status = 'void'`
      : type === "discount" ? t`select 1 from invoices where id = ${id} and company_id = ${user.companyId} and coalesce(discount_requested, 0) > 0`
      : type === "cancel" ? t`select 1 from bookings where id = ${id} and company_id = ${user.companyId} and status = 'cancelled'`
      : t`select 1 from payments where id = ${id} and company_id = ${user.companyId}`;
    if (!(await exists).length) throw notFound();
    const r = await t`insert into verifications (company_id, item_type, item_id, verified_by, note) values (${user.companyId}, ${type}::verify_item, ${id}, ${user.id}, ${note.trim() || null})
      on conflict do nothing returning item_id`;
    if (r.length) await audit(t, { companyId: user.companyId, userId: user.id, action: "report.verify", table: "verifications", rowId: id, new: { type, note: note.trim() || null }, ip });
    return { ok: true };
  });
}

// ---------- CEO dashboard (FR-1101) ----------
export async function dashboard(user: SessionUser, perms: string[]) {
  const c = user.companyId;
  const tz = await tzOf(sql, c);
  const today = (await sql<{ d: string }[]>`select (now() at time zone ${tz})::date::text as d`)[0]!.d;
  const counts = (await sql<{ pending_review: number; jobs: number; done: number; disc: number; voids: number; leave: number }[]>`select
      (select count(*)::int from bookings where company_id = ${c} and status = 'pending_review') as pending_review,
      (select count(*)::int from bookings where company_id = ${c} and status <> 'cancelled' and ${localDay(sql`scheduled_at`, tz)} = ${today}::date) as jobs,
      (select count(*)::int from bookings where company_id = ${c} and status not in ('cancelled', 'new', 'survey', 'quoted', 'assigned', 'en_route', 'on_site', 'working')
        and ${localDay(sql`scheduled_at`, tz)} = ${today}::date) as done,
      (select count(*)::int from invoices where company_id = ${c} and status = 'draft' and discount_status = 'pending') as disc,
      (select count(*)::int from invoice_void_requests where company_id = ${c} and status = 'pending') as voids,
      (select count(*)::int from staff_leaves where company_id = ${c} and status = 'pending') as leave`)[0]!;
  const techs = await sql<{ user_id: string; full_name: string; status: string; job_number: string | null; job_id: string | null; in_at: Date | null; out_at: Date | null }[]>`
    select u.id as user_id, u.full_name,
      coalesce((select b.status::text from bookings b join booking_technicians t on t.booking_id = b.id where t.user_id = u.id and b.status in ('en_route', 'on_site', 'working') order by b.scheduled_at limit 1),
        case when exists (select 1 from staff_leaves l where l.user_id = u.id and l.status = 'approved' and ${today}::date between l.date_from and l.date_to) then 'leave' else 'free' end) as status,
      (select b.number from bookings b join booking_technicians t on t.booking_id = b.id where t.user_id = u.id and b.status in ('en_route', 'on_site', 'working') order by b.scheduled_at limit 1) as job_number,
      (select b.id from bookings b join booking_technicians t on t.booking_id = b.id where t.user_id = u.id and b.status in ('en_route', 'on_site', 'working') order by b.scheduled_at limit 1) as job_id,
      a.in_at, a.out_at
    from users u left join attendance a on a.user_id = u.id and a.work_date = ${today}::date
    where u.company_id = ${c} and u.is_active and u.role = 'tech' order by u.full_name`;
  const out: Record<string, unknown> = {
    date: today, pending_review: counts.pending_review, today: { jobs: counts.jobs, done: counts.done },
    approvals: { discounts: counts.disc, voids: counts.voids, leave: counts.leave }, techs,
  };
  if (perms.includes("report.verify")) out.unverified = (await items(c, null, true)).length;
  if (perms.includes("report.finance")) {
    const month = today.slice(0, 8) + "01";
    const d = await summaryData(c, today, today, true) as { revenue: Money; payments: { total: number } };
    const m = await summaryData(c, month, today, true) as { revenue: Money; payments: { total: number } };
    const debt = await sql<{ total: number; d60: number }[]>`select coalesce(sum(greatest(x.total - x.paid, 0)), 0)::int as total,
        coalesce(sum(greatest(x.total - x.paid, 0)) filter (where (now() at time zone ${tz})::date - ${localDay(sql`x.issued_at`, tz)} > 60), 0)::int as d60
      from (${INV(c)}) x where x.status = 'issued'`;
    Object.assign(out.today as object, { revenue: d.revenue.total, received: d.payments.total });
    out.month = { revenue: m.revenue.total, received: m.payments.total };
    out.debts = { total: debt[0]!.total, d60_plus: debt[0]!.d60 };
  }
  return out;
}

// ---------- audit log viewer (FR-1202) ----------
export async function auditLog(user: SessionUser, q: { action?: string; from?: string; to?: string; limit: number }) {
  const tz = await tzOf(sql, user.companyId);
  return sql`select a.id, a.at, a.action, a.source, a.table_name, a.row_id, a.old_data, a.new_data, u.full_name as user_name
    from audit_log a left join users u on u.id = a.user_id where a.company_id = ${user.companyId}
      ${q.action ? sql`and a.action like ${q.action.replace(/[%_\\]/g, (m) => "\\" + m) + "%"}` : sql``}
      ${q.from ? sql`and ${localDay(sql`a.at`, tz)} >= ${q.from}::date` : sql``} ${q.to ? sql`and ${localDay(sql`a.at`, tz)} <= ${q.to}::date` : sql``}
    order by a.at desc, a.id desc limit ${q.limit}`;
}

// ---------- Telegram summaries to CEO + CFO (FR-1004) ----------
function localParts(at: Date, tz: string) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
    .formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: Number(p.hour) * 60 + Number(p.minute), monday: p.weekday === "Mon", first: p.day === "01" };
}
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function summaryText(kind: "daily" | "weekly" | "monthly", from: string, to: string, s: Awaited<ReturnType<typeof summaryData>>): string {
  const x = s as Record<string, any>;
  const title = kind === "daily" ? `📊 របាយការណ៍ប្រចាំថ្ងៃ · ${from}` : kind === "weekly" ? `📊 របាយការណ៍ប្រចាំសប្តាហ៍ · ${from} → ${to}` : `📊 របាយការណ៍ប្រចាំខែ · ${from.slice(0, 7)} (${from} → ${to})`;
  const m = x.payments.by_method;
  const lines = [
    title,
    `🧾 ចំណូល: ${formatUsd(x.revenue.total)} (${x.revenue.invoices} វិក្កយបត្រ) · ក្នុងបុរី ${formatUsd(x.revenue.inside)} · ក្រៅបុរី ${formatUsd(x.revenue.outside)}`,
    `💵 ទទួលប្រាក់: ${formatUsd(x.payments.total)} · សាច់ប្រាក់ $ ${formatUsd(m.cash_usd)} · សាច់ប្រាក់ ៛ ${formatUsd(m.cash_khr)} · ABA ${formatUsd(m.aba)} · ACLEDA ${formatUsd(m.acleda)}${x.payments.khr_riel ? ` (${formatKhr(x.payments.khr_riel)})` : ""}`,
    `📌 ជំពាក់ថ្មី: ${formatUsd(x.new_debt)} · ជំពាក់សរុប: ${formatUsd(x.debt_total)}`,
    `🔧 ការងារ: ថ្មី ${x.jobs.created} · បញ្ចប់ ${x.jobs.finished} · លុប ${x.jobs.cancelled} · រង់ចាំពិនិត្យ ${x.jobs.pending_review}`,
    `🚫 Void ${x.voids.count} (${formatUsd(x.voids.total)}) · 💸 Discount ${x.discounts.count} (${formatUsd(x.discounts.total)}; ≥ limit ${x.discounts.over_limit})`,
  ];
  if (x.attendance) lines.push(`👷 វត្តមាន: មក ${x.attendance.present}/${x.attendance.people} · យឺត ${x.attendance.late} · អវត្តមាន ${x.attendance.absent} · ច្បាប់ ${x.attendance.leave} · ក្រៅរង្វង់ ${x.attendance.out_of_range}`);
  return lines.join("\n");
}

/** called by the cron every few minutes; returns how many summaries were sent (each to every CEO + CFO) */
export async function sendSummaries(at: Date = new Date()): Promise<number> {
  let sent = 0;
  for (const co of await sql<{ id: string; timezone: string }[]>`select id, timezone from companies where is_active`) {
    const l = localParts(at, co.timezone);
    const runs: { kind: "daily" | "weekly" | "monthly"; period: string; from: string; to: string }[] = [];
    if (l.hm >= 20 * 60) runs.push({ kind: "daily", period: l.date, from: l.date, to: l.date });
    if (l.monday && l.hm >= 8 * 60) runs.push({ kind: "weekly", period: `${addDays(l.date, -7)}..${addDays(l.date, -1)}`, from: addDays(l.date, -7), to: addDays(l.date, -1) });
    if (l.first && l.hm >= 8 * 60) { const end = addDays(l.date, -1); runs.push({ kind: "monthly", period: end.slice(0, 7), from: end.slice(0, 8) + "01", to: end }); }
    for (const r of runs) {
      const fresh = await sql`insert into report_runs (company_id, kind, period) values (${co.id}, ${r.kind}, ${r.period}) on conflict do nothing returning period`;
      if (!fresh.length) continue;
      const text = summaryText(r.kind, r.from, r.to, await summaryData(co.id, r.from, r.to, true));
      const [title, ...body] = text.split("\n");
      for (const u of await sql<{ id: string }[]>`select id from users where company_id = ${co.id} and is_active and role in ('ceo', 'cfo')`)
        await notifyUser(sql, co.id, u.id, `report.${r.kind}`, title!, body.join("\n"), `/reports?from=${r.from}&to=${r.to}`, `sum:${r.kind}:${r.period}:${u.id}`);
      sent++;
    }
  }
  return sent;
}
