// Void a mistyped payment (D-86, approved extra): reason required; Admin → GM, GM → CEO, never self, CEO directly (same chain as
// invoice void, BR-19). The original row is never changed except its void mark; an approved void adds a REVERSAL row
// (negative amount + usd_cents, reversal_of) so every sum — balances, reports, cash close, exports — is right on its own.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { reverseSource } from "./ledger-hooks.js";
import { notifyUser } from "./telegram.js";

type Pay = { id: string; company_id: string; invoice_id: string; amount: string; currency: string; method: string; fx: string; usd_cents: number;
  reversal_of: string | null; voided_at: Date | null; deposit_id: string | null; number: string; booking_id: string | null; inv_status: string; timezone: string };

async function lockPayment(t: Db, user: SessionUser, id: string): Promise<Pay> {
  const p = (await t<Pay[]>`select p.id, p.company_id, p.invoice_id, p.amount::text, p.currency::text, p.method::text, p.fx_rate_khr::text as fx, p.usd_cents,
      p.reversal_of, p.voided_at, p.deposit_id, i.number, i.booking_id, i.status::text as inv_status, c.timezone
    from payments p join invoices i on i.id = p.invoice_id join companies c on c.id = p.company_id
    where p.id = ${id} and p.company_id = ${user.companyId} for update of p`)[0];
  if (!p) throw notFound();
  if (p.reversal_of) throw new AppError("NOT_VOIDABLE", 400);
  if (p.voided_at) throw new AppError("ALREADY_VOID", 400);
  if (p.deposit_id) throw new AppError("DEPOSIT_PAYMENT", 400); // comes from a deposit — the deposit is the record to correct
  return p;
}
const approverRoles = (requesterRole: string) => (requesterRole === "admin" ? ["gm", "ceo"] : ["ceo"]);

async function doVoid(t: Db, user: SessionUser, p: Pay, reason: string, ip: string | null) {
  await t`insert into payments (company_id, invoice_id, amount, currency, method, fx_rate_khr, usd_cents, paid_on, note, received_by, reversal_of)
    values (${p.company_id}, ${p.invoice_id}, ${-Number(p.amount)}, ${p.currency}::pay_currency, ${p.method}::pay_method, ${p.fx}::numeric, ${-p.usd_cents},
      (now() at time zone ${p.timezone})::date, ${"VOID: " + reason}, ${user.id}, ${p.id})`;
  await t`update payments set voided_at = now(), voided_by = ${user.id}, void_reason = ${reason} where id = ${p.id}`;
  // the job's status follows the money again: closed → partially_paid / invoiced, partially_paid → invoiced
  if (p.booking_id) {
    const s = (await t<{ total: number; paid: number; status: string }[]>`select
        (select coalesce(sum(round(qty * unit_price)), 0)::int from invoice_lines where invoice_id = ${p.invoice_id}) - (select discount from invoices where id = ${p.invoice_id}) as total,
        (select coalesce(sum(usd_cents), 0)::int from payments where invoice_id = ${p.invoice_id}) as paid,
        (select status::text from bookings where id = ${p.booking_id}) as status`)[0]!;
    const want = s.paid >= s.total ? "closed" : s.paid > 0 ? "partially_paid" : "invoiced";
    if (["closed", "partially_paid", "invoiced"].includes(s.status) && want !== s.status) await t`update bookings set status = ${want}::booking_status where id = ${p.booking_id}`;
  }
  await audit(t, { companyId: p.company_id, userId: user.id, action: "payment.void", table: "payments", rowId: p.id, new: { invoice: p.number, usd_cents: p.usd_cents, reason }, ip });
  await reverseSource(t, user, "payment", p.id, `VOID: ${reason}`);
  // BR-21: CEO + CFO hear about every void
  for (const u of await t<{ id: string }[]>`select id from users where company_id = ${p.company_id} and is_active and role in ('ceo', 'cfo') and id <> ${user.id}`)
    await notifyUser(t, p.company_id, u.id, "payment.void", `🚫 VOID ការទទួលប្រាក់ · ${p.number}`, `ដោយ ${user.fullName}\n📝 ${reason}`, `/invoices/${p.invoice_id}`, `pvoid:${p.id}:${u.id}`);
}

export async function requestPaymentVoid(user: SessionUser, ip: string | null, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const p = await lockPayment(t, user, id);
    if ((await t`select 1 from payment_void_requests where payment_id = ${id} and status = 'pending'`).length) throw new AppError("VOID_PENDING", 409);
    if (user.role === "ceo") { await doVoid(t, user, p, why, ip); return { status: "void" as const }; }
    const rid = (await t<{ id: string }[]>`insert into payment_void_requests (company_id, payment_id, reason, requested_by, requester_role)
      values (${user.companyId}, ${id}, ${why}, ${user.id}, ${user.role}::user_role) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payment.void_request", table: "payment_void_requests", rowId: rid, new: { payment_id: id, reason: why }, ip });
    for (const u of await t<{ id: string }[]>`select u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = 'void.approve' and rp.allowed
        where u.company_id = ${user.companyId} and u.is_active and u.id <> ${user.id} and u.role::text = any(${t.array(user.role === "admin" ? ["gm"] : ["ceo"])})`)
      await notifyUser(t, user.companyId, u.id, "payment.void_request", `🚫 សំណើ Void ការទទួលប្រាក់ · ${p.number}`, `ស្នើដោយ ${user.fullName}\n📝 ${why}`, `/invoices/${p.invoice_id}`, `pvoid-req:${rid}:${u.id}`);
    return { status: "pending" as const };
  });
}

export async function decidePaymentVoid(user: SessionUser, ip: string | null, id: string, approve: boolean, note: string) {
  return tx(user.id, async (t) => {
    const p = await lockPayment(t, user, id);
    const r = (await t<{ id: string; reason: string; requested_by: string; requester_role: string }[]>`select id, reason, requested_by, requester_role::text from payment_void_requests
      where payment_id = ${id} and status = 'pending' for update`)[0];
    if (!r) throw new AppError("NOT_PENDING", 400);
    if (r.requested_by === user.id) throw new AppError("OWN_REQUEST", 403);
    if (!approverRoles(r.requester_role).includes(user.role)) throw new AppError("NEEDS_CEO", 403);
    await t`update payment_void_requests set status = ${approve ? "approved" : "rejected"}::void_request_status, decided_by = ${user.id}, decided_at = now(), decision_note = ${note.trim() || null} where id = ${r.id}`;
    if (approve) await doVoid(t, user, p, r.reason, ip);
    else await audit(t, { companyId: user.companyId, userId: user.id, action: "payment.void_reject", table: "payment_void_requests", rowId: r.id, new: { note: note.trim() || null }, ip });
    await notifyUser(t, user.companyId, r.requested_by, "payment.void_decided", `${approve ? "✅ Void អនុម័ត" : "❌ Void មិនអនុម័ត"} · ${p.number}`, `${user.fullName}${note.trim() ? `\n📝 ${note.trim()}` : ""}`, `/invoices/${p.invoice_id}`, `pvoid-dec:${r.id}`);
    return { status: approve ? ("void" as const) : ("rejected" as const) };
  });
}

/** pending payment voids (approvals tab / dashboard) */
export async function pendingPaymentVoids(user: SessionUser) {
  return sql`select r.id, r.payment_id, r.reason, r.requester_role, r.created_at, p.invoice_id, i.number, p.usd_cents, u.full_name as requested_by_name
    from payment_void_requests r join payments p on p.id = r.payment_id join invoices i on i.id = p.invoice_id join users u on u.id = r.requested_by
    where r.company_id = ${user.companyId} and r.status = 'pending' order by r.created_at`;
}
