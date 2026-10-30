// D-194 (owner 29-10, part 5): an issued invoice reaches the customer and is paid from the phone.
//   notice   the website shows it (the booking page's invoice card, «ត្រូវបង់» on «ការកក់របស់ខ្ញុំ», /my/invoice/<id>); a linked Telegram
//            chat gets the amount, the day to pay by and a button with a signed link to that ONE invoice (/i/<token>, 30 days) — the
//            link shows the invoice and takes a transfer receipt, nothing else: it never signs in and carries no PIN
//   pay      phase 1: the shop's own QR / bank line + «ខ្ញុំបានបង់រួច» with a photo of the transfer receipt → the office confirms it
//            (= a payment on the mapped cash / bank account: the books, the invoice paid / part paid, the customer told) or refuses it
//            with a reason. Phase 2 (PayWay / Bakong KHQR with the bank's own confirmation) needs a merchant account — not built.
//   remind   ONE Telegram message once the days to pay (Settings → Website, default 3; 0 = none) have passed with a balance and no
//            receipt waiting; 09:00–17:00 shop time; only invoices whose notice went out this way (a deploy never reminds old ones)
// Security: a customer reads only own invoices (the customer-home rule) or the one a valid link names; receipts are private (staff
// with payment.record); uploads and link views are rate-limited; every receipt and decision is audited.
import { createHmac, timingSafeEqual } from "node:crypto";
import { customerText, formatUsd, INVOICE_LINK_DAYS, kmDate, MAX_PENDING_SLIPS, PAY_DUE_DAYS_DEFAULT, payStatusOf } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { featureOn } from "../lib/features.js";
import { checkRate } from "../lib/rate-limit.js";
import { tx as T } from "../lib/i18n.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { tellSubscriber, webOn, type Btn } from "./customer-bot.js";
import { myInvoiceRule, type CustomerSession } from "./customer-home.js";
import { hubConfigured } from "./hub-client.js";
import { recordPaymentIn, type PayMethod } from "./invoices.js";
import { checkImage, writeImage } from "./jobs.js";
import { readUpload, siteCompanyId } from "./site.js";
import { notifyUser } from "./telegram.js";

// ---------- the signed link: <invoice id>.<expiry, base 36 seconds>.<HMAC> — tied to one invoice, expires, cannot be made up ----------
const linkSig = (id: string, exp: number) => createHmac("sha256", config.sessionSecret).update(`invoice-link:${id}:${exp}`).digest("base64url").slice(0, 32);
export function invoiceToken(id: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + INVOICE_LINK_DAYS * 86_400;
  return `${id}.${exp.toString(36)}.${linkSig(id, exp)}`;
}
/** the invoice a link names; "expired" when it was real but is too old; null when it was never ours */
export function readInvoiceToken(tok: string, now = Date.now()): { id: string } | "expired" | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([0-9a-z]{5,8})\.([A-Za-z0-9_-]{32})$/.exec(tok);
  if (!m) return null;
  const exp = parseInt(m[2]!, 36), want = Buffer.from(linkSig(m[1]!, exp)), got = Buffer.from(m[3]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  return exp * 1000 < now ? "expired" : { id: m[1]! };
}
const linkButton = (id: string): Btn[][] | undefined => (webOn() ? [[{ text: "🧾 មើលវិក្កយបត្រ", web_app: `${config.publicUrl}/i/${invoiceToken(id)}` }]] : undefined);

// ---------- what the customer sees ----------
type SlipStatus = "pending" | "confirmed" | "rejected";
async function invoiceView(companyId: string, id: string) {
  const days = sql`coalesce((s.website->>'pay_due_days')::int, ${PAY_DUE_DAYS_DEFAULT}::int)`;
  const i = (await sql<{ id: string; number: string; status: "issued" | "void"; discount: number; booking_id: string | null; booking_number: string | null; service_text: string | null;
      customer_name: string; issued_on: string; due: string | null; today: string; has_qr: boolean; info: Record<string, string> | null }[]>`
    select i.id, i.number, i.status::text as status, i.discount, i.booking_id, b.number as booking_number, b.service_text, c.name as customer_name,
      (i.issued_at at time zone co.timezone)::date::text as issued_on, (now() at time zone co.timezone)::date::text as today,
      case when ${days} > 0 then ((i.issued_at at time zone co.timezone)::date + ${days})::text end as due, s.qr_image_path is not null as has_qr, s.company_info as info
    from invoices i join customers c on c.id = i.customer_id join companies co on co.id = i.company_id join company_settings s on s.company_id = i.company_id
      left join bookings b on b.id = i.booking_id
    where i.id = ${id} and i.company_id = ${companyId} and i.status <> 'draft'`)[0];
  if (!i) throw notFound();
  const lines = (await sql<{ description: string; qty: number; unit: string; unit_price: number }[]>`select description, qty::float as qty, unit, unit_price from invoice_lines
    where invoice_id = ${id} order by sort, id`).map((l) => ({ ...l, total: Math.round(l.qty * l.unit_price) }));
  const pays = await sql<{ paid_on: string; usd_cents: number; method: PayMethod; live: boolean }[]>`select paid_on::text, usd_cents, method::text as method,
    (voided_at is null and reversal_of is null) as live from payments where invoice_id = ${id} order by created_at, id`;
  const slip = (await sql<{ status: SlipStatus; amount: number; created_at: Date; reject_reason: string | null }[]>`select status::text as status, amount, created_at, reject_reason
    from payment_slips where invoice_id = ${id} order by created_at desc limit 1`)[0] ?? null;
  const subtotal = lines.reduce((a, l) => a + l.total, 0), total = subtotal - i.discount, paid = pays.reduce((a, p) => a + p.usd_cents, 0), balance = Math.max(0, total - paid);
  return {
    id: i.id, number: i.number, status: i.status, booking_id: i.booking_id, booking_number: i.booking_number, service_text: i.service_text, customer_name: i.customer_name,
    issued_on: i.issued_on, due: i.due, overdue: !!i.due && balance > 0 && i.today > i.due, lines, subtotal, discount: i.discount, total, paid, balance,
    pay_status: payStatusOf(total, paid), payments: pays.filter((p) => p.live).map(({ paid_on, usd_cents, method }) => ({ paid_on, usd_cents, method })),
    slip, slip_pending: slip?.status === "pending", has_qr: i.has_qr, bank_line: i.info?.bank_line ?? null,
  };
}
export type CustomerInvoice = Awaited<ReturnType<typeof invoiceView>>;

/** an invoice of this customer session (another one = «not found») */
export async function myInvoice(s: CustomerSession, id: string): Promise<CustomerInvoice> {
  if (!(await sql`select 1 from invoices i where i.id = ${id} and ${myInvoiceRule(s)}`).length) throw notFound();
  return invoiceView(s.companyId, id);
}
/** the invoice a signed link names (the shop's own company only) */
export async function linkInvoice(token: string): Promise<CustomerInvoice | "expired"> {
  const r = readInvoiceToken(token);
  if (!r) throw notFound();
  if (r === "expired") return "expired";
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  return invoiceView(companyId, r.id);
}

// ---------- «ខ្ញុំបានបង់រួច»: the transfer receipt ----------
export type SlipInput = { photo: string; amount: number; bank: "aba" | "acleda" | "other"; note?: string | null };
/** a photo of the transfer receipt for an issued invoice with a balance: stored privately (camera data removed), the office alerted */
export async function submitSlip(o: { companyId: string; invoiceId: string; via: "account" | "link"; ip: string | null }, v: SlipInput) {
  if (!checkRate(`site:slip:ip:${o.ip}`, 10, 3600) || !checkRate(`site:slip:inv:${o.invoiceId}`, 6, 3600)) throw new AppError("RATE_LIMITED", 429);
  const inv = await invoiceView(o.companyId, o.invoiceId);
  if (inv.status !== "issued") throw new AppError("INVOICE_VOID", 400);
  if (inv.balance <= 0) throw new AppError("ALREADY_PAID", 400);
  if (v.amount > inv.balance) throw new AppError("AMOUNT_TOO_LARGE", 400);
  const file = await writeImage(o.companyId, checkImage(v.photo, undefined, "BAD_IMAGE", true)); // a real photo by its bytes (≤ 2 MB)
  const slip = await tx(null, async (t) => {
    await t`select id from invoices where id = ${o.invoiceId} for update`;
    const waiting = (await t<{ n: number }[]>`select count(*)::int as n from payment_slips where invoice_id = ${o.invoiceId} and status = 'pending'`)[0]!.n;
    if (waiting >= MAX_PENDING_SLIPS) throw new AppError("TOO_MANY_SLIPS", 429);
    const id = (await t<{ id: string }[]>`insert into payment_slips (company_id, invoice_id, file_path, amount, bank, note, via)
      values (${o.companyId}, ${o.invoiceId}, ${file.rel}, ${v.amount}, ${v.bank}, ${v.note?.trim().slice(0, 300) || null}, ${o.via}) returning id`)[0]!.id;
    await audit(t, { companyId: o.companyId, userId: null, action: "payment.slip", source: "system", table: "payment_slips", rowId: id,
      new: { invoice: inv.number, amount: v.amount, bank: v.bank, via: o.via }, ip: o.ip });
    const staff = await t<{ id: string }[]>`select u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = 'payment.record' and rp.allowed
      where u.company_id = ${o.companyId} and u.is_active`;
    const body = `${inv.number} · ${inv.customer_name} · ${formatUsd(v.amount)} · ${v.bank === "other" ? "—" : v.bank.toUpperCase()}`;
    for (const u of staff) await notifyUser(t, o.companyId, u.id, "payment.slip", T("🧾 អតិថិជនផ្ញើបង្កាន់ដៃបង់ប្រាក់", "🧾 A customer sent a payment receipt"), body, `/invoices/${o.invoiceId}`, `slip:${id}:${u.id}`);
    return id;
  });
  return { id: slip, status: "pending" as const };
}
export const submitMySlip = async (s: CustomerSession, ip: string | null, invoiceId: string, v: SlipInput) => {
  await myInvoice(s, invoiceId); // own invoices only
  return submitSlip({ companyId: s.companyId, invoiceId, via: "account", ip }, v);
};
export async function submitLinkSlip(token: string, ip: string | null, v: SlipInput) {
  const r = readInvoiceToken(token), companyId = await siteCompanyId();
  if (!r || !companyId) throw notFound();
  if (r === "expired") throw new AppError("LINK_EXPIRED", 410);
  return submitSlip({ companyId, invoiceId: r.id, via: "link", ip }, v);
}

// ---------- the office decides (payment.record) ----------
/** the subscriber of the invoice's chat: the booking's own link, else the customer's */
async function chatOf(invoiceId: string): Promise<number | null> {
  const r = (await sql<{ sub: string | null }[]>`select coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub from invoices i join customers c on c.id = i.customer_id
    left join bookings b on b.id = i.booking_id where i.id = ${invoiceId}`)[0];
  return r?.sub ? Number(r.sub) : null;
}
const tell = async (invoiceId: string, text: string): Promise<boolean> => {
  if (!featureOn("website") || !hubConfigured()) return false;
  const sub = await chatOf(invoiceId);
  return sub ? tellSubscriber(sub, { text, buttons: linkButton(invoiceId) }) : false;
};

export type SlipDecision = { approve: true; amount: number; method: "aba" | "acleda" | "cash_usd"; paid_on?: string | null } | { approve: false; reason: string };
/** confirm = the payment (books, invoice state) + the receipt marked in ONE transaction; refuse = a reason the customer reads */
export async function decideSlip(user: SessionUser, ip: string | null, invoiceId: string, slipId: string, d: SlipDecision) {
  const r = await tx(user.id, async (t) => {
    const x = (await t<{ status: SlipStatus; amount: number; number: string }[]>`select x.status::text as status, x.amount, i.number from payment_slips x join invoices i on i.id = x.invoice_id
      where x.id = ${slipId} and x.invoice_id = ${invoiceId} and x.company_id = ${user.companyId} for update of x`)[0];
    if (!x) throw notFound();
    if (x.status !== "pending") throw new AppError("SLIP_DECIDED", 409);
    if (!d.approve) {
      await t`update payment_slips set status = 'rejected', decided_by = ${user.id}, decided_at = now(), reject_reason = ${d.reason} where id = ${slipId}`;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "payment.slip_reject", table: "payment_slips", rowId: slipId, new: { invoice: x.number, amount: x.amount, reason: d.reason }, ip });
      return { number: x.number, approve: false as const };
    }
    const p = await recordPaymentIn(t, user, ip, invoiceId, { parts: [{ amount: d.amount, currency: "usd", method: d.method }], paid_on: d.paid_on ?? null, note: "បង្កាន់ដៃផ្ទេរប្រាក់ (គេហទំព័រ)" });
    await t`update payment_slips set status = 'confirmed', decided_by = ${user.id}, decided_at = now(), payment_id = ${p.id} where id = ${slipId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payment.slip_confirm", table: "payment_slips", rowId: slipId,
      new: { invoice: x.number, amount: d.amount, method: d.method, ...(d.amount !== x.amount ? { slip_amount: x.amount } : {}) }, ip });
    return { number: x.number, approve: true as const, amount: d.amount, balance: p.balance, payment_status: p.payment_status };
  });
  void tell(invoiceId, r.approve ? customerText.slipConfirmed(r.number, formatUsd(r.amount), r.balance > 0 ? formatUsd(r.balance) : null) : customerText.slipRejected(r.number, (d as { reason: string }).reason));
  return r;
}
/** the receipt's photo — staff with payment.record of the same company only */
export async function slipPhoto(user: SessionUser, invoiceId: string, slipId: string) {
  return readUpload((await sql<{ path: string }[]>`select file_path as path from payment_slips where id = ${slipId} and invoice_id = ${invoiceId} and company_id = ${user.companyId}`)[0]?.path);
}

// ---------- the notice at issue, and the one reminder ----------
/** after «ចេញវិក្កយបត្រ»: a linked chat gets the amount, the day to pay by and the invoice button (nothing when nothing is owed) */
export async function notifyInvoiceIssued(invoiceId: string): Promise<boolean> {
  try {
    if (!featureOn("website") || !hubConfigured()) return false;
    const companyId = (await sql<{ company_id: string }[]>`select company_id from invoices where id = ${invoiceId} and status = 'issued' and customer_notified_at is null`)[0]?.company_id;
    if (!companyId) return false;
    const v = await invoiceView(companyId, invoiceId);
    if (v.balance <= 0) return false;
    const sub = await chatOf(invoiceId);
    if (!sub) return false;
    const ok = await tellSubscriber(sub, { text: customerText.invoice(v.number, formatUsd(v.balance), v.due ? kmDate(v.due) : null), buttons: linkButton(invoiceId) });
    if (ok) await sql`update invoices set customer_notified_at = now() where id = ${invoiceId}`;
    return ok;
  } catch {
    return false;
  }
}
export const PAY_REMINDER_HOURS = { from: 9, to: 17 } as const;
/** cron: the reminder once the days to pay have passed — a balance, no receipt waiting, notified by D-194 and not older than 60 days */
export async function payReminders(now: Date = new Date()): Promise<number> {
  if (!featureOn("website") || !hubConfigured()) return 0;
  const at = sql`${now}::timestamptz`, local = sql`(${now}::timestamptz at time zone co.timezone)`, days = sql`coalesce((s.website->>'pay_due_days')::int, ${PAY_DUE_DAYS_DEFAULT}::int)`;
  const due = await sql<{ id: string; number: string; balance: number; sub: string | null }[]>`
    select x.id, x.number, x.balance, x.sub from (
      select i.id, i.number, coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub,
        (select coalesce(sum(round(l.qty * l.unit_price)), 0) from invoice_lines l where l.invoice_id = i.id) - i.discount - (select coalesce(sum(p.usd_cents), 0) from payments p where p.invoice_id = i.id) as balance
      from invoices i join customers c on c.id = i.customer_id join companies co on co.id = i.company_id join company_settings s on s.company_id = i.company_id
        left join bookings b on b.id = i.booking_id
      where i.status = 'issued' and i.customer_notified_at is not null and i.pay_reminded_at is null and ${days} > 0
        and (i.issued_at at time zone co.timezone)::date + ${days} <= ${local}::date and i.issued_at > ${at} - interval '60 days'
        and extract(hour from ${local}) >= ${PAY_REMINDER_HOURS.from} and extract(hour from ${local}) < ${PAY_REMINDER_HOURS.to}
        and not exists (select 1 from payment_slips x where x.invoice_id = i.id and x.status = 'pending')) x
    where x.balance > 0 limit 50`;
  let sent = 0;
  for (const d of due) {
    const ok = d.sub ? await tellSubscriber(Number(d.sub), { text: customerText.payReminder(d.number, formatUsd(Number(d.balance))), buttons: linkButton(d.id) }) : false;
    await sql`update invoices set pay_reminded_at = ${now} where id = ${d.id}`; // once — a chat that stopped its notices is not asked again
    if (ok) sent++;
  }
  return sent;
}
