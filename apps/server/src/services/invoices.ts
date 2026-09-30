// Invoices + payments (Flow 4, D-77 · M8 · FR-801…807 · BR-09 · BR-10…21).
// Prices: Admin / CEO (invoice.issue) · discount: GM / CEO (discount.give; ≥ limit needs discount.approve) · payments: payment.record ·
// void: Admin → GM, GM → CEO, never self, CEO directly (BR-19). Technicians hold none of these permissions (AC-01).
// Money = US cents; KHR riel with the rate stored on each row. Rows are never deleted (BR-20).
import { formatUsd, khrToCents, usdToKhr } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { notifyUser } from "./telegram.js";
import { applyDeposits } from "./deposits.js";
import { postInvoiceIssue, postPayment, reverseSource } from "./ledger-hooks.js";
import { deductSale, reverseRef } from "./inventory.js";

export type InvoiceLineInput = { catalog_item_id?: string | null; description: string; kind: "service" | "product"; qty: number; unit: string; unit_price: number };
export type PayMethod = "cash_usd" | "cash_khr" | "aba" | "acleda";
type Inv = { id: string; company_id: string; booking_id: string | null; customer_id: string; number: string; status: "draft" | "issued" | "void";
  discount: number; discount_status: string; discount_requested: number | null; discount_by: string | null; customer_name: string };

/** INV-YYMM-#### — YYMM in the company's time zone at `at`; the per-month counter row is locked by the upsert (BR-13 · AC-11 · AC-21) */
export async function nextInvoiceNumber(t: Db, companyId: string, at: Date = new Date()): Promise<string> {
  const c = (await t<{ yymm: string; prefix: string }[]>`select to_char(${at}::timestamptz at time zone co.timezone, 'YYMM') as yymm, s.invoice_prefix as prefix
    from companies co join company_settings s on s.company_id = co.id where co.id = ${companyId}`)[0];
  if (!c) throw notFound();
  const no = (await t<{ last_no: number }[]>`insert into invoice_counters (company_id, yymm, last_no) values (${companyId}, ${c.yymm}, 1)
    on conflict (company_id, yymm) do update set last_no = invoice_counters.last_no + 1 returning last_no`)[0]!.last_no;
  return `${c.prefix}-${c.yymm}-${String(no).padStart(4, "0")}`;
}

const fxOf = async (db: Db, companyId: string) => Number((await db<{ fx: string }[]>`select fx_rate_khr::text as fx from company_settings where company_id = ${companyId}`)[0]?.fx ?? 4100);

async function checkItems(t: Db, user: SessionUser, lines: InvoiceLineInput[]) {
  const ids = [...new Set(lines.map((l) => l.catalog_item_id).filter((x): x is string => !!x))];
  if (ids.length && (await t`select id from catalog_items where id = any(${t.array(ids)}::uuid[]) and company_id = ${user.companyId}`).length !== ids.length) throw new AppError("ITEM_NOT_FOUND", 404);
}
async function writeLines(t: Db, id: string, lines: InvoiceLineInput[]) {
  await t`delete from invoice_lines where invoice_id = ${id}`;
  let i = 0;
  for (const l of lines) await t`insert into invoice_lines (invoice_id, sort, catalog_item_id, description, kind, qty, unit, unit_price)
    values (${id}, ${i++}, ${l.catalog_item_id ?? null}, ${l.description.trim()}, ${l.kind}::item_kind, ${l.qty}, ${l.unit.trim() || "unit"}, ${l.unit_price})`;
}
const subtotalOf = (lines: InvoiceLineInput[]) => lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price), 0);

async function sums(db: Db, id: string): Promise<{ subtotal: number; paid: number; payments: number }> {
  return (await db<{ subtotal: number; paid: number; payments: number }[]>`select
    (select coalesce(sum(round(qty * unit_price)), 0)::int from invoice_lines where invoice_id = ${id}) as subtotal,
    (select coalesce(sum(usd_cents), 0)::int from payments where invoice_id = ${id}) as paid,
    (select count(*)::int from payments where invoice_id = ${id}) as payments`)[0]!;
}
const payStatus = (total: number, paid: number) => (paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid");

async function lockInvoice(t: Db, user: SessionUser, id: string): Promise<Inv> {
  const i = (await t<Inv[]>`select i.id, i.company_id, i.booking_id, i.customer_id, i.number, i.status, i.discount, i.discount_status, i.discount_requested, i.discount_by, c.name as customer_name
    from invoices i join customers c on c.id = i.customer_id where i.id = ${id} and i.company_id = ${user.companyId} for update of i`)[0];
  if (!i) throw notFound();
  return i;
}
function assertDraft(i: Inv) {
  if (i.status === "void") throw new AppError("INVOICE_VOID", 400);
  if (i.status !== "draft") throw new AppError("INVOICE_LOCKED", 400);
}

/** active users of these roles (CEO + CFO for BR-21 notices), never the person who acted */
async function usersByRole(db: Db, companyId: string, roles: string[], exclude: string, perm?: string) {
  return db<{ id: string }[]>`select u.id from users u
    ${perm ? db`join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = ${perm} and rp.allowed` : db``}
    where u.company_id = ${companyId} and u.is_active and u.id <> ${exclude} and u.role::text = any(${db.array(roles)})`;
}

// ---------- prefill + create (FR-801 / FR-802) ----------
async function openInvoice(db: Db, bookingId: string) {
  return (await db`select 1 from invoices where booking_id = ${bookingId} and status <> 'void'`).length > 0;
}

/** lines suggested for a reviewed job: the accepted quote (type B), else the booked service + the materials of the report, at catalog prices */
export async function prefill(user: SessionUser, bookingId: string) {
  const b = (await sql<{ id: string; number: string; status: string; service_text: string; service_item_id: string | null; customer_id: string; customer_name: string; warranty_of_number: string | null }[]>`
    select b.id, b.number, b.status, b.service_text, b.service_item_id, b.customer_id, c.name as customer_name, pb.number as warranty_of_number
    from bookings b join customers c on c.id = b.customer_id left join bookings pb on pb.id = b.parent_booking_id
    where b.id = ${bookingId} and b.company_id = ${user.companyId}`)[0];
  if (!b) throw notFound();
  if (await openInvoice(sql, b.id)) throw new AppError("INVOICE_EXISTS", 409);
  if (b.status !== "reviewed") throw new AppError("NOT_REVIEWED", 400); // BR-09 · AC-02
  const quote = await sql<InvoiceLineInput[]>`select l.catalog_item_id, l.description, l.kind::text as kind, l.qty::float as qty, l.unit, l.unit_price
    from quotes q join quote_lines l on l.quote_id = q.id where q.booking_id = ${b.id} and q.status = 'accepted' order by l.sort, l.id`;
  let lines: InvoiceLineInput[] = [...quote];
  if (!lines.length) {
    const svc = b.service_item_id ? (await sql<InvoiceLineInput[]>`select id as catalog_item_id, name_km as description, kind::text as kind, 1::float as qty, unit, coalesce(sell_price, 0)::int as unit_price
      from catalog_items where id = ${b.service_item_id}`)[0] : undefined;
    lines.push(svc ?? { catalog_item_id: null, description: b.service_text.slice(0, 300), kind: "service", qty: 1, unit: "unit", unit_price: 0 });
    lines.push(...await sql<InvoiceLineInput[]>`select m.catalog_item_id, i.name_km as description, i.kind::text as kind, m.qty::float as qty, i.unit, coalesce(i.sell_price, 0)::int as unit_price
      from booking_materials m join catalog_items i on i.id = m.catalog_item_id where m.booking_id = ${b.id} order by i.name_km`);
  }
  // FR-1201: a warranty job is free — same lines, $0
  const free = !!b.warranty_of_number;
  lines = lines.map((l) => ({ catalog_item_id: l.catalog_item_id ?? null, description: l.description, kind: l.kind, qty: Number(l.qty), unit: l.unit, unit_price: free ? 0 : Number(l.unit_price) }));
  return { booking_id: b.id, booking_number: b.number, customer_id: b.customer_id, customer_name: b.customer_name, service_text: b.service_text, warranty_of_number: b.warranty_of_number, lines };
}

export async function createInvoice(user: SessionUser, ip: string | null, v: { booking_id?: string; customer_id?: string; lines: InvoiceLineInput[]; notes?: string | null }) {
  return tx(user.id, async (t) => {
    let customerId: string, bookingId: string | null = null;
    if (v.booking_id) {
      const b = (await t<{ id: string; status: string; customer_id: string }[]>`select id, status, customer_id from bookings where id = ${v.booking_id} and company_id = ${user.companyId} for update`)[0];
      if (!b) throw notFound();
      if (await openInvoice(t, b.id)) throw new AppError("INVOICE_EXISTS", 409);
      if (b.status !== "reviewed") throw new AppError("NOT_REVIEWED", 400);
      customerId = b.customer_id; bookingId = b.id;
    } else {
      if (!(await t`select 1 from customers where id = ${v.customer_id!} and company_id = ${user.companyId}`).length) throw notFound();
      customerId = v.customer_id!;
    }
    await checkItems(t, user, v.lines);
    const number = await nextInvoiceNumber(t, user.companyId);
    const id = (await t<{ id: string }[]>`insert into invoices (company_id, booking_id, customer_id, number, notes, fx_rate_khr, created_by)
      values (${user.companyId}, ${bookingId}, ${customerId}, ${number}, ${v.notes?.trim() || null}, ${await fxOf(t, user.companyId)}, ${user.id}) returning id`)[0]!.id;
    await writeLines(t, id, v.lines);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.create", table: "invoices", rowId: id, new: { number, booking_id: bookingId, customer_id: customerId, lines: v.lines.length, subtotal: subtotalOf(v.lines) }, ip });
    return { id, number };
  });
}

export async function updateInvoice(user: SessionUser, ip: string | null, id: string, v: { lines: InvoiceLineInput[]; notes?: string | null }) {
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    assertDraft(i);
    const sub = subtotalOf(v.lines);
    if (i.discount > sub || (i.discount_status === "pending" && (i.discount_requested ?? 0) > sub)) throw new AppError("DISCOUNT_TOO_HIGH", 400);
    await checkItems(t, user, v.lines);
    await writeLines(t, id, v.lines);
    await t`update invoices set notes = ${v.notes?.trim() || null} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.update", table: "invoices", rowId: id, new: { lines: v.lines.length, subtotal: sub }, ip });
    return { id };
  });
}

// ---------- discount (BR-12 · AC-03/04/05) ----------
async function tellBoss(t: Db, i: Inv, actor: SessionUser, kind: string, title: string, body: string) {
  for (const u of await usersByRole(t, i.company_id, ["ceo", "cfo"], actor.id))
    await notifyUser(t, i.company_id, u.id, kind, title, body, `/invoices/${i.id}`, `${kind}:${i.id}:${Date.now()}:${u.id}`);
}

export async function setDiscount(user: SessionUser, perms: string[], ip: string | null, id: string, v: { amount: number; note?: string | null }) {
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    assertDraft(i);
    const { subtotal } = await sums(t, id);
    if (v.amount > subtotal) throw new AppError("DISCOUNT_TOO_HIGH", 400);
    const limit = (await t<{ limit: number }[]>`select discount_approval_limit as limit from company_settings where company_id = ${user.companyId}`)[0]?.limit ?? 5000;
    const direct = perms.includes("discount.approve"); // the CEO decides himself (BR-19)
    const status = v.amount === 0 ? "none" : direct || v.amount < limit ? "applied" : "pending";
    const note = v.note?.trim() || null;
    await t`update invoices set discount = ${status === "applied" ? v.amount : 0}, discount_status = ${status}::discount_status,
      discount_requested = ${status === "none" ? null : v.amount}, discount_note = ${note}, discount_by = ${user.id}, discount_at = now(),
      discount_decided_by = ${status === "applied" && direct ? user.id : null}, discount_decided_at = ${status === "applied" && direct ? t`now()` : null}
      where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.discount", table: "invoices", rowId: id, old: { discount: i.discount, status: i.discount_status }, new: { amount: v.amount, status, note }, ip });
    if (v.amount >= limit) // BR-21: CEO + CFO hear about every discount ≥ limit
      await tellBoss(t, i, user, "invoice.discount", `💸 Discount ${formatUsd(v.amount)} · ${i.number}`,
        [`👤 ${i.customer_name} · សរុប ${formatUsd(subtotal)}`, `ដោយ ${user.fullName}`, note ? `📝 ${note}` : "", status === "pending" ? "⏳ រង់ចាំ CEO អនុម័ត" : "✅ អនុវត្តរួច"].filter(Boolean).join("\n"));
    return { discount_status: status };
  });
}

export async function decideDiscount(user: SessionUser, ip: string | null, id: string, approve: boolean, note: string) {
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    assertDraft(i);
    if (i.discount_status !== "pending") throw new AppError("NOT_PENDING", 400);
    if (i.discount_by === user.id) throw new AppError("OWN_REQUEST", 403);
    const amount = i.discount_requested ?? 0;
    await t`update invoices set discount = ${approve ? amount : 0}, discount_status = ${approve ? "applied" : "rejected"}::discount_status,
      discount_decided_by = ${user.id}, discount_decided_at = now() where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: approve ? "invoice.discount_approve" : "invoice.discount_reject", table: "invoices", rowId: id, new: { amount, note: note.trim() || null }, ip });
    if (i.discount_by) await notifyUser(t, i.company_id, i.discount_by, "invoice.discount_decided",
      `${approve ? "✅ Discount អនុម័ត" : "❌ Discount មិនអនុម័ត"} · ${i.number}`, `${formatUsd(amount)} · ${user.fullName}${note.trim() ? `\n📝 ${note.trim()}` : ""}`, `/invoices/${id}`, `disc-dec:${id}:${Date.now()}`);
    return { discount_status: approve ? "applied" : "rejected" };
  });
}

// ---------- issue (lines locked, rate frozen, job → invoiced) ----------
export async function issueInvoice(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    assertDraft(i);
    if (i.discount_status === "pending") throw new AppError("DISCOUNT_PENDING", 400); // AC-04
    const fx = await fxOf(t, user.companyId);
    await t`update invoices set status = 'issued', issued_at = now(), issued_by = ${user.id}, fx_rate_khr = ${fx} where id = ${id}`;
    const { subtotal } = await sums(t, id);
    const total = subtotal - i.discount;
    if (i.booking_id) {
      const deposited = await applyDeposits(t, user, { id, booking_id: i.booking_id, total }); // deposits taken at quote acceptance
      await t`update bookings set status = 'invoiced' where id = ${i.booking_id}`;
      if (total <= 0 || deposited >= total) await t`update bookings set status = 'closed' where id = ${i.booking_id}`;
      else if (deposited > 0) await t`update bookings set status = 'partially_paid' where id = ${i.booking_id}`;
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.issue", table: "invoices", rowId: id, new: { number: i.number, total, fx }, ip });
    if (!i.booking_id) await deductSale(t, user, id); // direct sale: tracked products leave stock now (job materials are confirmed on the job)
    await postInvoiceIssue(t, user, id);
    return { id, status: "issued" as const };
  });
}

// ---------- payments (FR-805 · BR-14/15 · AC-10) ----------
export async function recordPayment(user: SessionUser, ip: string | null, id: string, v: { amount: number; currency: "usd" | "khr"; method: PayMethod; paid_on?: string | null; note?: string | null }) {
  if ((v.method === "cash_usd" && v.currency !== "usd") || (v.method === "cash_khr" && v.currency !== "khr")) throw new AppError("BAD_METHOD", 400);
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    if (i.status !== "issued") throw new AppError("NOT_ISSUED", 400);
    if (v.paid_on && (await t<{ future: boolean }[]>`select ${v.paid_on}::date > (now() at time zone co.timezone)::date as future from companies co where co.id = ${user.companyId}`)[0]!.future)
      throw new AppError("BAD_DATE", 400);
    const fx = await fxOf(t, user.companyId);
    const { subtotal, paid } = await sums(t, id);
    const balance = subtotal - i.discount - paid;
    let cents = v.currency === "usd" ? v.amount : khrToCents(v.amount, fx);
    // ៛ is rounded to 100 on the invoice: a payment within one rounding step of the balance settles it exactly
    if (v.currency === "khr" && Math.abs(cents - balance) <= Math.ceil((100 / fx) * 100)) cents = balance;
    if (balance <= 0 || cents > balance) throw new AppError("OVERPAY", 400);
    if (cents <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const pid = (await t<{ id: string }[]>`insert into payments (company_id, invoice_id, amount, currency, method, fx_rate_khr, usd_cents, paid_on, note, received_by)
      values (${user.companyId}, ${id}, ${v.amount}, ${v.currency}::pay_currency, ${v.method}::pay_method, ${fx}, ${cents},
        ${v.paid_on ? t`${v.paid_on}::date` : t`(now() at time zone (select timezone from companies where id = ${user.companyId}))::date`}, ${v.note?.trim() || null}, ${user.id}) returning id`)[0]!.id;
    const nowPaid = paid + cents, total = subtotal - i.discount;
    if (i.booking_id) {
      const st = (await t<{ status: string }[]>`select status from bookings where id = ${i.booking_id} for update`)[0]!.status;
      if (nowPaid >= total && st !== "closed") await t`update bookings set status = 'closed' where id = ${i.booking_id}`;
      else if (nowPaid < total && st === "invoiced") await t`update bookings set status = 'partially_paid' where id = ${i.booking_id}`;
    }
    await postPayment(t, user, { id: pid, method: v.method, usd_cents: cents, fx, date: v.paid_on ?? (await t<{ d: string }[]>`select (now() at time zone (select timezone from companies where id = ${user.companyId}))::date::text as d`)[0]!.d });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "payment.record", table: "payments", rowId: pid, new: { invoice: i.number, amount: v.amount, currency: v.currency, method: v.method, usd_cents: cents, fx }, ip });
    return { id: pid, paid: nowPaid, balance: total - nowPaid, payment_status: payStatus(total, nowPaid) };
  });
}

// ---------- void (BR-18 … BR-21 · AC-06/07/20) ----------
async function assertVoidable(t: Db, i: Inv) {
  if (i.status === "void") throw new AppError("INVOICE_VOID", 400);
  const s = await sums(t, i.id);
  if (s.paid > 0) throw new AppError("HAS_PAYMENTS", 400); // net of voided (reversed) payments
  if (i.status === "issued" && s.subtotal - i.discount <= 0) throw new AppError("INVOICE_PAID", 400);
}

async function doVoid(t: Db, user: SessionUser, i: Inv, reason: string, ip: string | null) {
  await t`update invoices set status = 'void', voided_at = now(), voided_by = ${user.id}, void_reason = ${reason} where id = ${i.id}`;
  if (i.booking_id) await t`update bookings set status = 'reviewed' where id = ${i.booking_id} and status = 'invoiced'`;
  await audit(t, { companyId: i.company_id, userId: user.id, action: "invoice.void", table: "invoices", rowId: i.id, new: { number: i.number, reason }, ip });
  await reverseSource(t, user, "invoice", i.id, `VOID: ${reason}`);
  await reverseRef(t, user, "invoice", i.id); // a direct sale gives its stock back
  await tellBoss(t, i, user, "invoice.void", `🚫 VOID · ${i.number}`, `👤 ${i.customer_name}\nដោយ ${user.fullName}\n📝 ${reason}`);
}

/** who approves: an Admin's request → GM (or CEO); anyone else's → the CEO */
const approverRoles = (requesterRole: string) => (requesterRole === "admin" ? ["gm", "ceo"] : ["ceo"]);

export async function requestVoid(user: SessionUser, ip: string | null, id: string, reason: string) {
  const why = reason.trim();
  if (why.length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    await assertVoidable(t, i);
    if ((await t`select 1 from invoice_void_requests where invoice_id = ${id} and status = 'pending'`).length) throw new AppError("VOID_PENDING", 409);
    if (user.role === "ceo") { await doVoid(t, user, i, why, ip); return { status: "void" as const }; } // AC-20
    const rid = (await t<{ id: string }[]>`insert into invoice_void_requests (company_id, invoice_id, reason, requested_by, requester_role)
      values (${user.companyId}, ${id}, ${why}, ${user.id}, ${user.role}::user_role) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.void_request", table: "invoice_void_requests", rowId: rid, new: { number: i.number, reason: why }, ip });
    for (const u of await usersByRole(t, user.companyId, user.role === "admin" ? ["gm"] : ["ceo"], user.id, "void.approve"))
      await notifyUser(t, user.companyId, u.id, "invoice.void_request", `🚫 សំណើ Void · ${i.number}`, `👤 ${i.customer_name}\nស្នើដោយ ${user.fullName}\n📝 ${why}`, `/invoices/${id}`, `void-req:${rid}:${u.id}`);
    return { status: "pending" as const };
  });
}

export async function decideVoid(user: SessionUser, ip: string | null, id: string, approve: boolean, note: string) {
  return tx(user.id, async (t) => {
    const i = await lockInvoice(t, user, id);
    const r = (await t<{ id: string; reason: string; requested_by: string; requester_role: string }[]>`select id, reason, requested_by, requester_role::text from invoice_void_requests
      where invoice_id = ${id} and status = 'pending' for update`)[0];
    if (!r) throw new AppError("NOT_PENDING", 400);
    if (r.requested_by === user.id) throw new AppError("OWN_REQUEST", 403);
    if (!approverRoles(r.requester_role).includes(user.role)) throw new AppError("NEEDS_CEO", 403); // AC-07
    if (approve) await assertVoidable(t, i);
    await t`update invoice_void_requests set status = ${approve ? "approved" : "rejected"}::void_request_status, decided_by = ${user.id}, decided_at = now(),
      decision_note = ${note.trim() || null} where id = ${r.id}`;
    if (approve) await doVoid(t, user, i, r.reason, ip);
    else await audit(t, { companyId: user.companyId, userId: user.id, action: "invoice.void_reject", table: "invoice_void_requests", rowId: r.id, new: { note: note.trim() || null }, ip });
    await notifyUser(t, user.companyId, r.requested_by, "invoice.void_decided", `${approve ? "✅ Void អនុម័ត" : "❌ Void មិនអនុម័ត"} · ${i.number}`,
      `${user.fullName}${note.trim() ? `\n📝 ${note.trim()}` : ""}`, `/invoices/${id}`, `void-dec:${r.id}`);
    return { status: approve ? ("void" as const) : ("rejected" as const) };
  });
}

// ---------- read ----------
export async function getInvoice(user: SessionUser, perms: string[], id: string) {
  const i = (await sql`select i.id, i.number, i.status, i.notes, i.booking_id, i.customer_id, i.fx_rate_khr::float as fx_rate_khr, i.discount, i.discount_status,
      i.discount_requested, i.discount_note, i.created_at, i.issued_at, i.voided_at, i.void_reason,
      b.number as booking_number, b.service_text, coalesce(b.address, c.address) as address, c.name as customer_name, c.phones as customer_phones,
      cu.full_name as created_by_name, iu.full_name as issued_by_name, vu.full_name as voided_by_name, du.full_name as discount_by_name
    from invoices i join customers c on c.id = i.customer_id left join bookings b on b.id = i.booking_id
      left join users cu on cu.id = i.created_by left join users iu on iu.id = i.issued_by left join users vu on vu.id = i.voided_by left join users du on du.id = i.discount_by
    where i.id = ${id} and i.company_id = ${user.companyId}`)[0];
  if (!i) throw notFound();
  const lines = (await sql<{ id: number; catalog_item_id: string | null; description: string; kind: string; qty: number; unit: string; unit_price: number }[]>`
    select id, catalog_item_id, description, kind, qty::float as qty, unit, unit_price from invoice_lines where invoice_id = ${id} order by sort, id`)
    .map((l) => ({ ...l, line_total: Math.round(l.qty * l.unit_price) }));
  const payments = await sql`select p.id, p.amount::float8 as amount, p.currency, p.method, p.fx_rate_khr::float as fx_rate_khr, p.usd_cents, p.paid_on::text, p.note, p.created_at, u.full_name as received_by_name,
      p.deposit_id is not null as from_deposit, p.reversal_of, p.voided_at, p.void_reason,
      (select json_build_object('reason', r.reason, 'requester_role', r.requester_role, 'requested_by_name', ru.full_name) from payment_void_requests r join users ru on ru.id = r.requested_by
        where r.payment_id = p.id and r.status = 'pending') as void_request
    from payments p left join users u on u.id = p.received_by where p.invoice_id = ${id} order by p.created_at, p.id`;
  const vr = (await sql`select r.id, r.reason, r.requested_by, r.requester_role, r.created_at, u.full_name as requested_by_name from invoice_void_requests r
    join users u on u.id = r.requested_by where r.invoice_id = ${id} and r.status = 'pending'`)[0] ?? null;
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const total = subtotal - (i.discount as number);
  const paid = payments.reduce((s, p) => s + (p.usd_cents as number), 0);
  const fx = i.fx_rate_khr as number;
  const company = (await sql<{ name: string; company_info: Record<string, string>; has_logo: boolean; has_qr: boolean; fx_now: number }[]>`select c.name, s.company_info, s.fx_rate_khr::float as fx_now,
    s.logo_path is not null as has_logo, s.qr_image_path is not null as has_qr from companies c join company_settings s on s.company_id = c.id where c.id = ${user.companyId}`)[0];
  return {
    ...i, lines, payments, void_request: vr, subtotal, total, paid, balance: total - paid, payment_status: payStatus(total, paid),
    total_khr: usdToKhr(total, fx), balance_khr: usdToKhr(total - paid, fx), company,
    can: { issue: perms.includes("invoice.issue"), discount: perms.includes("discount.give"), discount_approve: perms.includes("discount.approve"),
      pay: perms.includes("payment.record"), void_request: perms.includes("void.request"), void_approve: perms.includes("void.approve") },
  };
}

const LIST = (companyId: string) => sql`
  select i.id, i.number, i.status, i.created_at, i.issued_at, i.booking_id, i.customer_id, i.discount_status, c.name as customer_name, b.number as booking_number,
    (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from invoice_lines l where l.invoice_id = i.id) - i.discount as total,
    (select coalesce(sum(p.usd_cents), 0)::int from payments p where p.invoice_id = i.id) as paid,
    exists (select 1 from invoice_void_requests r where r.invoice_id = i.id and r.status = 'pending') as void_pending
  from invoices i join customers c on c.id = i.customer_id left join bookings b on b.id = i.booking_id where i.company_id = ${companyId}`;

export type ListFilter = "draft" | "unpaid" | "paid" | "void" | "approval";
export async function listInvoices(user: SessionUser, status?: ListFilter, bookingId?: string) {
  const rows = await sql<{ status: string; total: number; paid: number; discount_status: string; void_pending: boolean }[]>`select * from (${LIST(user.companyId)}) x where true
    ${status === "draft" ? sql`and x.status = 'draft'` : status === "unpaid" ? sql`and x.status = 'issued' and x.paid < x.total` : status === "paid" ? sql`and x.status = 'issued' and x.paid >= x.total`
      : status === "void" ? sql`and x.status = 'void'` : status === "approval" ? sql`and (x.void_pending or (x.status = 'draft' and x.discount_status = 'pending'))` : sql``}
    ${bookingId ? sql`and x.booking_id = ${bookingId}` : sql``}
    order by x.created_at desc limit 300`;
  return rows.map((r) => ({ ...r, payment_status: payStatus(r.total, r.paid) }));
}

/** FR-807: what each customer still owes, by age of the issued invoice (company time zone) */
export async function debts(user: SessionUser) {
  return sql<{ customer_id: string; customer_name: string; phones: string[]; d0_30: number; d31_60: number; d60_plus: number; total: number; invoices: number; oldest: Date }[]>`
    with x as (select l.*, (now() at time zone co.timezone)::date - (l.issued_at at time zone co.timezone)::date as age, l.total - l.paid as balance
      from (${LIST(user.companyId)}) l join companies co on co.id = ${user.companyId} where l.status = 'issued')
    select x.customer_id, c.name as customer_name, c.phones,
      coalesce(sum(x.balance) filter (where x.age <= 30), 0)::int as d0_30,
      coalesce(sum(x.balance) filter (where x.age between 31 and 60), 0)::int as d31_60,
      coalesce(sum(x.balance) filter (where x.age > 60), 0)::int as d60_plus,
      sum(x.balance)::int as total, count(*)::int as invoices, min(x.issued_at) as oldest
    from x join customers c on c.id = x.customer_id where x.balance > 0
    group by x.customer_id, c.name, c.phones order by total desc`;
}

export function assertCanView(perms: string[]) {
  const VIEW = ["invoice.issue", "payment.record", "discount.give", "discount.approve", "void.request", "void.approve", "report.finance"];
  if (!perms.some((p) => VIEW.includes(p))) throw forbidden();
}

// ---------- A1 done but not invoiced ----------
/** finished jobs (work done … reviewed) without an open invoice: age from the finish checkpoint, estimate = accepted quote,
 *  else booked service + materials at catalog prices; a warranty job is free (estimate 0) */
export async function uninvoiced(companyId: string) {
  return sql<{ booking_id: string; number: string; status: string; customer_name: string; phones: string[]; finished_at: Date; age_days: number; estimate: number; warranty: boolean }[]>`
    select x.*, (now() at time zone x.tz)::date - (x.finished_at at time zone x.tz)::date as age_days from (
      select b.id as booking_id, b.number, b.status, c.name as customer_name, c.phones, co.timezone as tz, b.parent_booking_id is not null as warranty,
        coalesce((select max(k.at) from booking_checkpoints k where k.booking_id = b.id and k.step = 'finish'), b.updated_at) as finished_at,
        case when b.parent_booking_id is not null then 0 else coalesce(
          (select sum(round(l.qty * l.unit_price))::int from quotes q join quote_lines l on l.quote_id = q.id where q.booking_id = b.id and q.status = 'accepted'),
          coalesce((select sell_price from catalog_items where id = b.service_item_id), 0)
            + coalesce((select sum(round(m.qty * coalesce(i.sell_price, 0)))::int from booking_materials m join catalog_items i on i.id = m.catalog_item_id where m.booking_id = b.id), 0)
        ) end as estimate
      from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id
      where b.company_id = ${companyId} and b.status in ('work_done', 'pending_review', 'revision', 'reviewed')
        and not exists (select 1 from invoices i where i.booking_id = b.id and i.status <> 'void')
    ) x order by x.finished_at`;
}
