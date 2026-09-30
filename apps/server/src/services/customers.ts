// Customer history (FR-203): bookings (with warranty state), invoices with balance, total debt, warranties still running.
// Money only for people who may see invoices (same rule as the invoice pages); technicians never (D-18).
import { sql } from "../db.js";
import { notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { warrantyJson } from "./bookings.js";

const INVOICE_VIEW = ["invoice.issue", "payment.record", "discount.give", "discount.approve", "void.request", "void.approve", "report.finance"];

export async function customerHistory(user: SessionUser, perms: string[], id: string) {
  const customer = (await sql`select id, name, phones, address, zone, lat, lng, notes, is_active, created_at from customers where id = ${id} and company_id = ${user.companyId}`)[0];
  if (!customer) throw notFound();
  const bookings = await sql<{ id: string; number: string; status: string; warranty: { until: string; days_left: number; active: boolean } | null }[]>`
    select b.id, b.number, b.status, b.type, b.category, b.service_text, b.scheduled_at, b.closed_at, b.cancel_reason, b.parent_booking_id as warranty_of, ${warrantyJson(sql)} as warranty
    from bookings b join companies co on co.id = b.company_id where b.customer_id = ${id} and b.company_id = ${user.companyId}
    order by b.scheduled_at desc nulls last, b.created_at desc limit 200`;
  const warranties = bookings.filter((b) => b.warranty?.active).map((b) => ({ booking_id: b.id, number: b.number, until: b.warranty!.until, days_left: b.warranty!.days_left }));
  const out: Record<string, unknown> = { customer, bookings, warranties };
  if (perms.some((p) => INVOICE_VIEW.includes(p))) {
    const invoices = (await sql<{ id: string; status: string; total: number; paid: number }[]>`select i.id, i.number, i.status, i.created_at, i.issued_at, b.number as booking_number,
        (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = i.id) - i.discount as total,
        (select coalesce(sum(p.usd_cents), 0)::int from payments p where p.invoice_id = i.id) as paid
      from invoices i left join bookings b on b.id = i.booking_id where i.customer_id = ${id} and i.company_id = ${user.companyId} order by i.created_at desc limit 200`)
      .map((i) => ({ ...i, balance: i.status === "issued" ? Math.max(0, i.total - i.paid) : 0, payment_status: i.paid >= i.total ? "paid" : i.paid > 0 ? "partial" : "unpaid" }));
    out.invoices = invoices;
    out.debt = invoices.reduce((s, i) => s + i.balance, 0);
  }
  return out;
}
