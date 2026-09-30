// Deposits (D-86, approved extra): money taken when the customer accepts a quote. Kept per booking with its own rate; when the
// job's invoice is issued every active deposit becomes a payment on it (no new cash). GM / CEO void a deposit (refund) with a reason.
import { khrToCents } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { postDeposit, postDepositApplied, reverseSource } from "./ledger-hooks.js";
import type { PayMethod } from "./invoices.js";

const fxOf = async (db: Db, companyId: string) => Number((await db<{ fx: string }[]>`select fx_rate_khr::text as fx from company_settings where company_id = ${companyId}`)[0]?.fx ?? 4100);

export async function recordDeposit(user: SessionUser, ip: string | null, bookingId: string, v: { amount: number; currency: "usd" | "khr"; method: PayMethod; paid_on?: string | null; note?: string | null }) {
  if ((v.method === "cash_usd" && v.currency !== "usd") || (v.method === "cash_khr" && v.currency !== "khr")) throw new AppError("BAD_METHOD", 400);
  return tx(user.id, async (t) => {
    const b = (await t<{ id: string; timezone: string }[]>`select b.id, c.timezone from bookings b join companies c on c.id = b.company_id
      where b.id = ${bookingId} and b.company_id = ${user.companyId} and b.status <> 'cancelled' for update of b`)[0];
    if (!b) throw notFound();
    const q = (await t<{ id: string }[]>`select id from quotes where booking_id = ${b.id} and status = 'accepted' limit 1`)[0];
    if (!q) throw new AppError("QUOTE_NOT_ACCEPTED", 400);
    if ((await t`select 1 from invoices where booking_id = ${b.id} and status = 'issued'`).length) throw new AppError("INVOICE_ISSUED", 400); // then it is a normal payment
    if (v.paid_on && (await t<{ future: boolean }[]>`select ${v.paid_on}::date > (now() at time zone ${b.timezone})::date as future`)[0]!.future) throw new AppError("BAD_DATE", 400);
    const fx = await fxOf(t, user.companyId);
    const cents = v.currency === "usd" ? v.amount : khrToCents(v.amount, fx);
    if (cents <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const d = (await t<{ id: string; paid_on: string }[]>`insert into deposits (company_id, booking_id, quote_id, amount, currency, method, fx_rate_khr, usd_cents, paid_on, note, received_by)
      values (${user.companyId}, ${b.id}, ${q.id}, ${v.amount}, ${v.currency}::pay_currency, ${v.method}::pay_method, ${fx}, ${cents},
        ${v.paid_on ? t`${v.paid_on}::date` : t`(now() at time zone ${b.timezone})::date`}, ${v.note?.trim() || null}, ${user.id}) returning id, paid_on::text`)[0]!;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "deposit.record", table: "deposits", rowId: d.id, new: { booking_id: b.id, amount: v.amount, currency: v.currency, method: v.method, usd_cents: cents, fx }, ip });
    await postDeposit(t, user, { id: d.id, method: v.method, usd_cents: cents, fx, date: d.paid_on });
    return { id: d.id, usd_cents: cents };
  });
}

export async function listDeposits(user: SessionUser, bookingId: string) {
  return sql`select d.id, d.amount::float8 as amount, d.currency, d.method, d.fx_rate_khr::float as fx_rate_khr, d.usd_cents, d.paid_on::text, d.note, d.status,
      d.applied_invoice_id, d.created_at, u.full_name as received_by_name
    from deposits d left join users u on u.id = d.received_by where d.booking_id = ${bookingId} and d.company_id = ${user.companyId} order by d.created_at, d.id`;
}

/** refund / mistake: GM or CEO (void.approve), reason required, only while not yet applied */
export async function voidDeposit(user: SessionUser, ip: string | null, id: string, reason: string) {
  if (reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const d = (await t<{ status: string }[]>`select status from deposits where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!d) throw notFound();
    if (d.status !== "active") throw new AppError("DEPOSIT_NOT_ACTIVE", 400);
    await t`update deposits set status = 'void', note = coalesce(note || ' · ', '') || ${"VOID: " + reason.trim()} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "deposit.void", table: "deposits", rowId: id, new: { reason: reason.trim() }, ip });
    await reverseSource(t, user, "deposit", id, `VOID: ${reason.trim()}`);
    return { ok: true };
  });
}

/** at issue: every active deposit of the job becomes a payment on the invoice (same amount, method and rate; no new cash) */
export async function applyDeposits(t: Db, user: SessionUser, inv: { id: string; booking_id: string; total: number }): Promise<number> {
  const deps = await t<{ id: string; amount: string; currency: string; method: string; fx: string; usd_cents: number; paid_on: string; received_by: string | null }[]>`
    select id, amount::text, currency::text, method::text, fx_rate_khr::text as fx, usd_cents, paid_on::text, received_by from deposits
    where booking_id = ${inv.booking_id} and status = 'active' for update`;
  const sum = deps.reduce((s, d) => s + d.usd_cents, 0);
  if (sum > inv.total) throw new AppError("DEPOSIT_EXCEEDS_TOTAL", 400);
  for (const d of deps) {
    const pid = (await t<{ id: string }[]>`insert into payments (company_id, invoice_id, amount, currency, method, fx_rate_khr, usd_cents, paid_on, note, received_by, deposit_id)
      values (${user.companyId}, ${inv.id}, ${d.amount}::bigint, ${d.currency}::pay_currency, ${d.method}::pay_method, ${d.fx}::numeric, ${d.usd_cents}, ${d.paid_on}::date, 'deposit', ${d.received_by}, ${d.id}) returning id`)[0]!.id;
    await t`update deposits set status = 'applied', applied_invoice_id = ${inv.id} where id = ${d.id}`;
    await postDepositApplied(t, user, { payment_id: pid, usd_cents: d.usd_cents, fx: Number(d.fx) });
  }
  return sum;
}
