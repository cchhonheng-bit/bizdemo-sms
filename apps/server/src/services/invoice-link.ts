// D-194 / D-195: the signed invoice link and a booking's issued invoices as the customer sees them. Only config + db here, so the
// customer pages (customer-home, web-booking) and the payment service (invoice-pay) all use it without import cycles.
import { createHmac, timingSafeEqual } from "node:crypto";
import { INVOICE_LINK_DAYS } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";

// <invoice id>.<expiry, base 36 seconds>.<HMAC> — tied to one invoice, expires, cannot be made up
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

export type BookingInvoice = { id: string; number: string; total: number; paid: number; balance: number; slip_pending: boolean };
/** the job's issued invoices — what they ask, what is paid, a transfer receipt waiting for the office */
export async function bookingInvoices(companyId: string, bookingId: string): Promise<BookingInvoice[]> {
  return (await sql<Omit<BookingInvoice, "balance">[]>`select iv.id, iv.number,
      (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = iv.id) - iv.discount as total,
      (select coalesce(sum(p.usd_cents), 0)::int from payments p where p.invoice_id = iv.id) as paid,
      exists (select 1 from payment_slips x where x.invoice_id = iv.id and x.status = 'pending') as slip_pending
    from invoices iv where iv.booking_id = ${bookingId} and iv.company_id = ${companyId} and iv.status = 'issued' order by iv.issued_at`).map((x) => ({ ...x, balance: Math.max(0, x.total - x.paid) }));
}
/** D-195: what the customer's open page compares every 30 s — a change (state, a new invoice, a payment, a receipt decided) reloads it */
export const trackSig = (state: string, inv: BookingInvoice[]) => `${state}|${inv.map((i) => `${i.id}:${i.balance}:${i.slip_pending ? 1 : 0}`).join(",")}`;
/** nothing more will change: cancelled / declined / expired, or closed with nothing left to pay */
export const trackFinal = (status: string, state: string, inv: BookingInvoice[]) =>
  ["cancelled", "declined", "expired"].includes(state) || (status === "closed" && inv.every((i) => i.balance <= 0));
