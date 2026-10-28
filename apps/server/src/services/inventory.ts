// Inventory (D-87 · D-144 «stock is separate»): the Admin's stock, in the warehouse only — bought in (a direct entry: the item is made
// on its first entry, on the client's code scheme D-142), taken out when a technician collects it (with the technician and the job
// or the place), counted / corrected. Append-only moves (qty 3 decimals, value in integer cents), weighted-average cost per item,
// no negative stock unless the setting allows it, low-stock alert once a day, accounting hook on every move (the cost side follows
// the item's group — D-143). Technician work never moves stock; an invoice never moves stock (D-144). Read with inventory.view,
// change with inventory.manage (technicians never).
import { assertDebtAccount, isStockAccount, stockAccountIds } from "./account-map.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { assertCodeOnAccount, nextItemCode } from "./catalog.js";
import { postStock, postSupplierPay } from "./ledger-hooks.js";
import { khrToCents, payStatusOf, type SupplierKind } from "@sms/shared";
import { notifyUser } from "./telegram.js";

export type Pay = "cash_usd" | "cash_khr" | "aba" | "acleda" | "credit";
type Kind = "opening" | "in" | "out" | "adjust" | "transfer_out" | "transfer_in" | "reverse" | "out_job" | "out_sale";

// ---------- the warehouse (the only place stock lives since D-144) ----------
export async function ensureLocations(db: Db, companyId: string): Promise<void> {
  if (!(await db`select 1 from stock_locations where company_id = ${companyId} and kind = 'warehouse' and is_active`).length)
    await db`insert into stock_locations (company_id, name, kind) values (${companyId}, 'ឃ្លាំង', 'warehouse')`;
}
export async function warehouseId(db: Db, companyId: string): Promise<string> {
  await ensureLocations(db, companyId);
  return (await db<{ id: string }[]>`select id from stock_locations where company_id = ${companyId} and kind = 'warehouse' and is_active order by created_at limit 1`)[0]!.id;
}
export async function listLocations(user: SessionUser) {
  await ensureLocations(sql, user.companyId);
  return sql`select l.id, l.name, l.kind, l.is_active from stock_locations l where l.company_id = ${user.companyId} and l.kind = 'warehouse' and l.is_active order by l.created_at`;
}

// ---------- the one place that moves stock ----------
type MoveIn = { item: string; location: string; kind: Kind; qty: number; value?: number | null; ref_type?: string; ref_id?: string | null;
  pay?: Pay | null; supplier?: string | null; reason?: string | null; group?: string | null; reversal_of?: number | null; date?: string | null; paid?: number | null; supplier_invoice?: string | null;
  technician?: string | null; place?: string | null; supplier_kind?: SupplierKind | null; payable_account_id?: string | null;
  /** D-182: a CEO's «remove the amounts» may leave a quantity below zero */
  force?: boolean };

async function move(t: Db, user: SessionUser, m: MoveIn): Promise<number> {
  const loc = (await t<{ id: string }[]>`select id from stock_locations where id = ${m.location} and company_id = ${user.companyId} and is_active`)[0];
  if (!loc) throw new AppError("LOCATION_NOT_FOUND", 404);
  const it = (await t<{ reorder: string | null; name: string; kind: string; is_stock: boolean }[]>`select reorder_level::text as reorder, name_km as name, kind::text as kind, is_stock from catalog_items
    where id = ${m.item} and company_id = ${user.companyId}`)[0];
  if (!it) throw notFound();
  if (it.kind !== "product") throw new AppError("NOT_A_PRODUCT", 400);
  if (!it.is_stock) throw new AppError("NOT_STOCK_ITEM", 400); // D-144: a price-list line is never stock
  await t`update catalog_items set track_stock = true where id = ${m.item} and not track_stock`;
  await t`insert into stock_items (company_id, item_id) values (${user.companyId}, ${m.item}) on conflict do nothing`;
  await t`insert into stock_balances (location_id, item_id) values (${m.location}, ${m.item}) on conflict do nothing`;
  const s = (await t<{ qty: string; value: string }[]>`select qty::text, value_cents::text as value from stock_items where item_id = ${m.item} for update`)[0]!;
  const b = (await t<{ qty: string }[]>`select qty::text from stock_balances where location_id = ${m.location} and item_id = ${m.item} for update`)[0]!;
  const q = m.qty;
  let value: number;
  if (q < 0) {
    const allowNeg = (await t<{ a: boolean }[]>`select allow_negative_stock as a from company_settings where company_id = ${user.companyId}`)[0]?.a ?? false;
    if (!allowNeg && !m.force && Number(b.qty) + q < -1e-9) throw new AppError("INSUFFICIENT_STOCK", 400, { item: it.name, available: Number(b.qty) });
    // weighted average: the last unit takes whatever value is left, so nothing stays behind in cents
    value = m.kind === "transfer_out" ? 0 : m.value != null ? m.value : -Number((await t<{ v: string }[]>`select case
        when ${-q}::numeric >= ${s.qty}::numeric then greatest(${s.value}::bigint, 0)
        when ${s.qty}::numeric <= 0 then 0
        else round(${s.value}::numeric * ${-q}::numeric / ${s.qty}::numeric) end::text as v`)[0]!.v);
  } else {
    value = m.kind === "transfer_in" ? 0 : m.value != null ? m.value : Number((await t<{ v: string }[]>`select case when ${s.qty}::numeric > 0
        then round(${s.value}::numeric * ${q}::numeric / ${s.qty}::numeric) else 0 end::text as v`)[0]!.v); // + adjustment at today's average
  }
  const tz = (await t<{ tz: string; fx: string; today: string }[]>`select c.timezone as tz, s.fx_rate_khr::text as fx, (now() at time zone c.timezone)::date::text as today
    from companies c join company_settings s on s.company_id = c.id where c.id = ${user.companyId}`)[0]!;
  if (m.date && (Number.isNaN(Date.parse(m.date)) || m.date > tz.today)) throw new AppError("BAD_DATE", 400); // a date of choice, never in the future
  const id = (await t<{ id: number }[]>`insert into stock_moves (company_id, item_id, location_id, kind, qty, value_cents, fx_rate_khr, move_date, ref_type, ref_id, pay, supplier, reason, transfer_group, reversal_of,
      technician_id, place, created_by, paid_cents, supplier_invoice, supplier_kind, payable_account_id)
    values (${user.companyId}, ${m.item}, ${m.location}, ${m.kind}::stock_move_kind, ${q}, ${value}, ${tz.fx}::numeric, ${m.date ?? tz.today}::date,
      ${m.ref_type ?? "manual"}, ${m.ref_id ?? null}, ${m.pay ?? null}, ${m.supplier ?? null}, ${m.reason ?? null}, ${m.group ?? null}, ${m.reversal_of ?? null},
      ${m.technician ?? null}, ${m.place ?? null}, ${user.id}, ${m.paid ?? null}, ${m.supplier_invoice ?? null}, ${m.supplier_kind ?? null}, ${m.payable_account_id ?? null}) returning id`)[0]!.id; // D-167: the ledger is append-only — the paid part and the supplier's invoice number go in with the row
  await t`update stock_items set qty = qty + ${q}, value_cents = value_cents + ${value} where item_id = ${m.item}`;
  await t`update stock_balances set qty = qty + ${q} where location_id = ${m.location} and item_id = ${m.item}`;
  if (q < 0 && it.reorder != null) await lowStock(t, user, m.item, it.name, Number(it.reorder), tz.tz);
  return Number(id);
}

/** once a day per item: inventory managers hear that it is below the reorder level */
async function lowStock(t: Db, user: SessionUser, item: string, name: string, reorder: number, tz: string) {
  const r = (await t<{ qty: string }[]>`update stock_items set low_alerted_on = (now() at time zone ${tz})::date
    where item_id = ${item} and qty < ${reorder} and low_alerted_on is distinct from (now() at time zone ${tz})::date returning qty::text`)[0];
  if (!r) return;
  for (const u of await t<{ id: string }[]>`select u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role
      and rp.permission_key = 'inventory.manage' and rp.allowed where u.company_id = ${user.companyId} and u.is_active`)
    await notifyUser(t, user.companyId, u.id, "stock.low", { km: `📦 ស្តុកជិតអស់ · ${name}`, en: `📦 Low stock · ${name}` }, { km: `នៅសល់ ${Number(r.qty)} (កម្រិត ${reorder})`, en: `${Number(r.qty)} left (level ${reorder})` }, "/inventory", `low:${item}:${Date.now()}`);
}

const cents = async (t: Db, qty: number, unit?: number | null, total?: number | null) => total != null ? total
  : Number((await t<{ v: string }[]>`select round(${qty}::numeric * ${unit ?? 0}::numeric)::text as v`)[0]!.v);
const balanceOf = async (t: Db, item: string, location: string) => Number((await t<{ q: string }[]>`select qty::text as q from stock_balances where item_id = ${item} and location_id = ${location}`)[0]?.q ?? 0);

// ---------- stock in: a direct entry (D-144) ----------
export type StockInInput = { item_id?: string | null; name?: string | null; code?: string | null; unit?: string | null; account_id?: string | null;
  qty: number; unit_cost?: number | null; total?: number | null; pay?: Pay | null; supplier?: string | null; date?: string | null; note?: string | null;
  /** the stock the shop already held before the books (no money moves: Dr stock / Cr opening equity) */
  opening?: boolean;
  /** D-167: what is paid now (cents; the rest is owed to the supplier — pay «credit» = nothing) and the supplier's invoice number */
  paid?: number | null; supplier_invoice?: string | null;
  /** D-178: the supplier's type → the payable it is owed on (map ap_ac · ap_washing · ap); none → this supplier's last type, else «other» */
  supplier_kind?: SupplierKind | null;
  /** D-181: the debt account picked for what stays owed (none → the one this supplier owed on last time, else the supplier type's) */
  payable_account_id?: string | null };

/** the stock item an entry is about: the one chosen, else the one on that account with that name (a no-sub account IS its one item),
 *  else a new one — code on the client's scheme (D-142), made as the Admin's stock item (never in the price list) */
async function stockItemFor(t: Db, user: SessionUser, ip: string | null, v: StockInInput): Promise<{ id: string; created: boolean; name: string }> {
  if (v.item_id) {
    const it = (await t<{ id: string; name_km: string; is_stock: boolean; kind: string }[]>`select id, name_km, is_stock, kind::text as kind from catalog_items where id = ${v.item_id} and company_id = ${user.companyId}`)[0];
    if (!it) throw notFound();
    if (it.kind !== "product" || !it.is_stock) throw new AppError("NOT_STOCK_ITEM", 400);
    return { id: it.id, created: false, name: it.name_km };
  }
  const name = v.name?.trim().slice(0, 120) ?? "";
  if (!v.account_id) throw new AppError("NOT_STOCK_ACCOUNT", 400);
  const acc = (await t<{ id: string; code: string; sub_codes: boolean; is_group: boolean; type: string }[]>`select id, code, sub_codes, is_group, type::text as type from accounts
    where id = ${v.account_id} and company_id = ${user.companyId}`)[0];
  if (!acc || !(await isStockAccount(t, user.companyId, acc.id, true))) throw new AppError("NOT_STOCK_ACCOUNT", 400); // D-178: under a mapped stock header
  if (!name && !acc.sub_codes) { // a no-sub account (13001 …) IS its one item
    const one = (await t<{ id: string; name_km: string }[]>`select id, name_km from catalog_items where company_id = ${user.companyId} and inventory_account_id = ${acc.id} and is_stock limit 1`)[0];
    if (one) return { id: one.id, created: false, name: one.name_km };
  }
  if (!name) throw new AppError("ITEM_REQUIRED", 400);
  const code = v.code?.trim().toUpperCase() || null;
  const found = (await t<{ id: string; name_km: string }[]>`select id, name_km from catalog_items where company_id = ${user.companyId} and is_stock and kind = 'product'
    and (${code}::text is not null and code = ${code} or (inventory_account_id = ${acc.id} and (${!acc.sub_codes} or lower(name_km) = lower(${name})))) order by (code = ${code}) desc nulls last limit 1`)[0];
  if (found) return { id: found.id, created: false, name: found.name_km };
  const next = await nextItemCode(t, user.companyId, acc.id);
  if (!acc.sub_codes && next.taken) throw new AppError("ONE_ITEM_PER_CODE", 409);
  const useCode = code ?? next.code;
  await assertCodeOnAccount(t, user.companyId, acc.id, useCode, null);
  if ((await t`select 1 from catalog_items where company_id = ${user.companyId} and code = ${useCode}`).length) throw new AppError("CODE_TAKEN", 409);
  const id = (await t<{ id: string }[]>`insert into catalog_items (company_id, code, name_km, kind, category, unit, sell_price, is_stock, track_stock, inventory_account_id, show_on_website, created_by, updated_by)
    values (${user.companyId}, ${useCode}, ${name}, 'product', 'mep', ${v.unit?.trim().slice(0, 20) || "unit"}, 0, true, true, ${acc.id}, false, ${user.id}, ${user.id}) returning id`)[0]!.id;
  await t`insert into stock_items (company_id, item_id) values (${user.companyId}, ${id}) on conflict do nothing`;
  await audit(t, { companyId: user.companyId, userId: user.id, action: "catalog.upsert", table: "catalog_items", rowId: id, new: { name_km: name, code: useCode, is_stock: true, account: acc.code }, ip });
  return { id, created: true, name };
}

export async function stockIn(user: SessionUser, ip: string | null, v: StockInInput) {
  if (v.unit_cost == null && v.total == null) throw new AppError("COST_REQUIRED", 400);
  if (!v.opening && !v.pay) throw new AppError("PAY_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const loc = await warehouseId(t, user.companyId);
    const item = await stockItemFor(t, user, ip, v);
    if (v.opening && (await t`select 1 from stock_moves where item_id = ${item.id} and company_id = ${user.companyId}`).length) throw new AppError("OPENING_EXISTS", 400);
    const value = await cents(t, v.qty, v.unit_cost, v.total);
    const paid = v.opening ? null : v.pay === "credit" ? 0 : v.paid == null ? value : v.paid; // D-167
    if (paid != null && (paid < 0 || paid > value)) throw new AppError("PAID_OVER_TOTAL", 400);
    if (paid != null && paid !== value && !v.supplier?.trim()) throw new AppError("SUPPLIER_REQUIRED", 400); // the rest is owed to someone
    const invoice = v.supplier_invoice?.trim().slice(0, 60) || null, supplier = v.supplier?.trim() || null;
    const skind: SupplierKind | null = v.opening ? null : v.supplier_kind ?? (supplier ? (await t<{ k: SupplierKind }[]>`select supplier_kind as k from stock_moves where company_id = ${user.companyId}
      and lower(btrim(supplier)) = lower(${supplier}) and supplier_kind is not null order by id desc limit 1`)[0]?.k : null) ?? "other";
    // D-181: the debt account picked for what stays owed; none → the account this supplier owed on last time (else the supplier type's map key)
    if (!v.opening && v.payable_account_id) await assertDebtAccount(t, user.companyId, v.payable_account_id);
    const payAccount = v.opening ? null : v.payable_account_id ?? (supplier ? (await t<{ a: string }[]>`select payable_account_id::text as a from stock_moves where company_id = ${user.companyId}
      and lower(btrim(supplier)) = lower(${supplier}) and payable_account_id is not null order by id desc limit 1`)[0]?.a ?? null : null);
    const id = await move(t, user, { item: item.id, location: loc, kind: v.opening ? "opening" : "in", qty: v.qty, value, ref_type: v.opening ? "opening" : "purchase",
      pay: v.opening ? null : v.pay, supplier, reason: v.note?.trim() || null, date: v.date, paid, supplier_invoice: v.opening ? null : invoice, supplier_kind: skind, payable_account_id: payAccount });
    await audit(t, { companyId: user.companyId, userId: user.id, action: v.opening ? "stock.opening" : "stock.in", table: "stock_moves", rowId: String(id),
      new: { item_id: item.id, name: item.name, created: item.created, qty: v.qty, unit_cost: v.unit_cost ?? null, total: value, pay: v.opening ? null : v.pay, paid, supplier_invoice: invoice, supplier: v.supplier ?? null, supplier_kind: skind, date: v.date ?? null }, ip });
    await postStock(t, user, [id]);
    return { id, item_id: item.id, created: item.created, total: value, paid, owed: paid == null ? 0 : value - paid, balance: await balanceOf(t, item.id, loc) };
  });
}

// ---------- stock out: the Admin records what a technician collects (D-144) ----------
export async function stockOut(user: SessionUser, ip: string | null, v: { item_id: string; qty: number; technician_id: string; booking_id?: string | null; place?: string | null; date?: string | null; note?: string | null }) {
  return tx(user.id, async (t) => {
    const loc = await warehouseId(t, user.companyId);
    const tech = (await t<{ id: string; full_name: string }[]>`select id, full_name from users where id = ${v.technician_id} and company_id = ${user.companyId} and is_active and role = 'tech'`)[0];
    if (!tech) throw new AppError("TECH_NOT_FOUND", 404);
    const place = v.place?.trim().slice(0, 120) || null;
    let number: string | null = null;
    if (v.booking_id) {
      const b = (await t<{ number: string }[]>`select number from bookings where id = ${v.booking_id} and company_id = ${user.companyId}`)[0];
      if (!b) throw notFound();
      number = b.number;
    } else if (!place) throw new AppError("PLACE_REQUIRED", 400); // a job, or the project / borey / house no.
    const id = await move(t, user, { item: v.item_id, location: loc, kind: "out", qty: -v.qty, ref_type: v.booking_id ? "booking" : "out", ref_id: v.booking_id ?? null,
      technician: tech.id, place, reason: v.note?.trim() || null, date: v.date });
    const balance = await balanceOf(t, v.item_id, loc);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.out", table: "stock_moves", rowId: String(id),
      new: { item_id: v.item_id, qty: v.qty, technician: tech.full_name, booking: number, place, date: v.date ?? null, balance }, ip });
    await postStock(t, user, [id]);
    return { id, balance };
  });
}

/** a count («កែតម្រូវ»): + or − at the warehouse, with a reason; a + takes the average cost (or the one given) */
export async function adjust(user: SessionUser, ip: string | null, v: { item_id: string; qty: number; reason: string; unit_cost?: number | null; date?: string | null }) {
  if (v.reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const loc = await warehouseId(t, user.companyId);
    const id = await move(t, user, { item: v.item_id, location: loc, kind: "adjust", qty: v.qty, value: v.qty > 0 && v.unit_cost != null ? await cents(t, v.qty, v.unit_cost) : null, reason: v.reason.trim(), date: v.date });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.adjust", table: "stock_moves", rowId: String(id), new: v, ip });
    await postStock(t, user, [id]);
    return { id, balance: await balanceOf(t, v.item_id, loc) };
  });
}

export async function setReorder(user: SessionUser, ip: string | null, itemId: string, level: number | null) {
  return tx(user.id, async (t) => {
    const r = await t`update catalog_items set reorder_level = ${level} where id = ${itemId} and company_id = ${user.companyId} and is_stock returning id`;
    if (!r.length) throw notFound();
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.track", table: "catalog_items", rowId: itemId, new: { reorder_level: level }, ip });
    return { ok: true };
  });
}

/** D-181: what each supplier is owed, from the books: every liability line carrying the supplier (stock receipts, opening debts, credit
 *  purchases, payments — wherever they were recorded), per debt account; the purchases and open invoice numbers from the stock receipts */
async function payablesFromBooks(user: SessionUser, db: Db) {
  const lines = await db<{ supplier: string; account_id: string; code: string; name_km: string; name_en: string | null; cr: string; dr: string; d: string; source: string }[]>`
    select btrim(l.supplier) as supplier, a.id as account_id, a.code, a.name_km, a.name_en, l.credit_cents::text as cr, l.debit_cents::text as dr, e.entry_date::text as d, e.source
    from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
    where l.company_id = ${user.companyId} and a.type = 'liability' and l.supplier is not null and btrim(l.supplier) <> '' order by e.created_at, l.id`;
  const buys = await db<{ k: string; purchases: string; last: string | null; inv: string[] | null }[]>`select lower(btrim(supplier)) as k, count(*)::text as purchases, max(move_date)::text as last,
      array_remove(array_agg(distinct supplier_invoice) filter (where supplier_invoice is not null and value_cents > coalesce(paid_cents, case when pay = 'credit' then 0 else value_cents end)), null) as inv
    from stock_moves where company_id = ${user.companyId} and kind = 'in' and supplier is not null and btrim(supplier) <> '' group by 1`;
  type Acc = { account_id: string; code: string; name_km: string; name_en: string | null; owed: number };
  const by = new Map<string, { supplier: string; owed: number; opening: number; paid: number; last_payment: string | null; accounts: Map<string, Acc> }>();
  for (const l of lines) {
    const k = l.supplier.toLowerCase(), cr = Number(l.cr), dr = Number(l.dr);
    const s = by.get(k) ?? { supplier: l.supplier, owed: 0, opening: 0, paid: 0, last_payment: null, accounts: new Map<string, Acc>() };
    s.supplier = l.supplier; s.owed += cr - dr; // the latest spelling names the row
    if (l.source === "opening") s.opening += cr - dr;
    else if (dr > 0) { s.paid += dr; if (!s.last_payment || l.d > s.last_payment) s.last_payment = l.d; }
    const a = s.accounts.get(l.account_id) ?? { account_id: l.account_id, code: l.code, name_km: l.name_km, name_en: l.name_en, owed: 0 };
    a.owed += cr - dr; s.accounts.set(l.account_id, a); by.set(k, s);
  }
  return [...by.entries()].map(([k, s]) => {
    const b = buys.find((x) => x.k === k);
    return { supplier: s.supplier, owed: s.owed, purchases: Number(b?.purchases ?? 0), opening: s.opening, paid: s.paid, invoices: b?.inv ?? [], last_purchase: b?.last ?? null,
      last_payment: s.last_payment, pay_status: payStatusOf(s.owed + s.paid, s.paid), accounts: [...s.accounts.values()].filter((a) => a.owed !== 0).sort((x, y) => x.code.localeCompare(y.code)) };
  }).filter((p) => p.owed !== 0 || p.paid || p.purchases).sort((a, b) => b.owed - a.owed || a.supplier.localeCompare(b.supplier));
}

/** D-182: one stock movement undone by its mirror (kind «reverse», the same quantity and value with the sign flipped, the same place,
 *  dated today) — the history keeps both; the books get the mirror entry from postStock */
export async function reverseMove(t: Db, user: SessionUser, moveId: number): Promise<number> {
  const m = (await t<{ item_id: string; location_id: string; qty: string; value: string; ref_type: string | null; ref_id: string | null }[]>`select item_id, location_id, qty::text, value_cents::text as value, ref_type, ref_id from stock_moves
    where id = ${moveId} and company_id = ${user.companyId}`)[0];
  if (!m) throw notFound();
  return move(t, user, { item: m.item_id, location: m.location_id, kind: "reverse", qty: -Number(m.qty), value: -Number(m.value), ref_type: m.ref_type ?? "manual", ref_id: m.ref_id, reversal_of: moveId, force: true }); // the same purchase / job; reversal_of marks the mirror
}

// ---------- an item leaves the stock (D-179) ----------
/** what removing a stock item does: refused while it holds stock; switched off when anything ever used it (movements, job materials,
 *  added work, invoice lines, bookings — the history stays); else deleted */
export async function itemRemoval(db: Db, companyId: string, itemId: string): Promise<{ code: string | null; name: string; qty: number; action: "delete" | "off" }> {
  const it = (await db<{ code: string | null; name_km: string; is_stock: boolean; qty: string }[]>`select ci.code, ci.name_km, ci.is_stock, coalesce(s.qty, 0)::text as qty
    from catalog_items ci left join stock_items s on s.item_id = ci.id where ci.id = ${itemId} and ci.company_id = ${companyId}`)[0];
  if (!it) throw notFound();
  if (!it.is_stock) throw new AppError("NOT_STOCK_ITEM", 400);
  const used = (await db`select 1 from stock_moves where item_id = ${itemId} union all select 1 from booking_materials where catalog_item_id = ${itemId}
    union all select 1 from job_extras where catalog_item_id = ${itemId} union all select 1 from invoice_lines where catalog_item_id = ${itemId}
    union all select 1 from bookings where service_item_id = ${itemId} limit 1`).length > 0;
  return { code: it.code, name: it.name_km, qty: Number(it.qty), action: used ? "off" : "delete" };
}
export async function removeItem(user: SessionUser, ip: string | null, itemId: string) {
  return tx(user.id, async (t) => {
    await t`select id from catalog_items where id = ${itemId} and company_id = ${user.companyId} for update`;
    const r = await itemRemoval(t, user.companyId, itemId);
    if (r.qty !== 0) throw new AppError("ITEM_HAS_STOCK", 400, { qty: r.qty });
    if (r.action === "off") await t`update catalog_items set is_active = false where id = ${itemId}`;
    else {
      await t`delete from stock_balances where item_id = ${itemId}`;
      await t`delete from stock_items where item_id = ${itemId}`;
      await t`delete from catalog_items where id = ${itemId}`;
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: r.action === "off" ? "stock.item_off" : "stock.item_delete", table: "catalog_items", rowId: itemId,
      old: { code: r.code, name_km: r.name }, ip });
    return { removed: r.action === "off" ? "off" as const : "deleted" as const };
  });
}

// ---------- read ----------
/** the stock items with quantity, value, average cost and their stock account (13110 …, 13400 …; none → 14500, D-176) */
export async function items(user: SessionUser) {
  await ensureLocations(sql, user.companyId);
  const rows = await sql<{ item_id: string; code: string | null; name: string; unit: string; qty: string; value: string; reorder: string | null; account_id: string | null; account_code: string | null; account_name: string | null; account_name_en: string | null }[]>`
    select i.id as item_id, i.code, i.name_km as name, i.unit, coalesce(s.qty, 0)::text as qty, coalesce(s.value_cents, 0)::text as value, i.reorder_level::text as reorder,
      coalesce(a.id, d.id) as account_id, coalesce(a.code, d.code) as account_code, coalesce(a.name_km, d.name_km) as account_name, coalesce(a.name_en, d.name_en) as account_name_en
    from catalog_items i left join stock_items s on s.item_id = i.id left join accounts a on a.id = i.inventory_account_id
      left join account_map dm on dm.company_id = i.company_id and dm.key = 'inventory' left join accounts d on d.id = dm.account_id
    where i.company_id = ${user.companyId} and i.is_stock and i.kind = 'product' and (i.is_active or coalesce(s.qty, 0) <> 0) order by coalesce(a.code, d.code) nulls last, i.code nulls last, i.name_km`;
  const bal = await sql<{ item_id: string; location_id: string; name: string; qty: string }[]>`select b.item_id, b.location_id, l.name, b.qty::text from stock_balances b
    join stock_locations l on l.id = b.location_id where l.company_id = ${user.companyId} and (b.qty <> 0 or l.is_active) order by l.kind, l.name`;
  return rows.map((r) => {
    const qty = Number(r.qty), value = Number(r.value);
    return { item_id: r.item_id, code: r.code, name: r.name, unit: r.unit, qty, value, avg_cost: qty > 0 ? Math.round(value / qty) : 0,
      account_id: r.account_id, account_code: r.account_code, account_name: r.account_name, account_name_en: r.account_name_en,
      reorder_level: r.reorder == null ? null : Number(r.reorder), low: r.reorder != null && qty < Number(r.reorder),
      by_location: bal.filter((b) => b.item_id === r.item_id).map((b) => ({ location_id: b.location_id, name: b.name, qty: Number(b.qty) })) };
  });
}

/** D-177 (One Team 26-10 «the stock still shows the same accounts»): the stock part of the chart — the headers (13000 «ស្តុកថ្មី»,
 *  18000 «ស្តុក Second hand») and every active stock account under them in code order; the stock page lists each one, an empty one too */
export async function stockAccounts(user: SessionUser) {
  const ids = await stockAccountIds(sql, user.companyId, true); // D-178: the mapped stock headers and the accounts under them
  return sql<{ id: string; code: string; name_km: string; name_en: string | null; is_group: boolean; parent_code: string | null }[]>`select id, code, name_km, name_en,
      is_group, parent_code from accounts where company_id = ${user.companyId} and is_active and (id = any(${sql.array(ids)}::uuid[])
        or id in (select account_id from account_map where company_id = ${user.companyId} and key in ('stock_new', 'stock_second_hand'))) order by code`;
}

/** D-142 «តម្លៃស្តុកចុងខែ»: stock on a day by account (quantity + value from the moves) beside the books' balance of the stock accounts
 *  (13000–18999) — the difference per account and in total; the books side only when accounting is on and the user may read it */
export async function monthEnd(user: SessionUser, to: string, withBooks: boolean) {
  const rows = await sql<{ code: string; name_km: string; name_en: string | null; item_id: string; item_code: string | null; item_name: string; unit: string; qty: string; value: string }[]>`
    select coalesce(a.code, '—') as code, coalesce(a.name_km, '—') as name_km, a.name_en,
      i.id as item_id, i.code as item_code, i.name_km as item_name, i.unit, coalesce(sum(m.qty), 0)::text as qty, coalesce(sum(m.value_cents), 0)::text as value
    from catalog_items i left join stock_moves m on m.item_id = i.id and m.move_date <= ${to}::date
      left join account_map dm on dm.company_id = i.company_id and dm.key = 'inventory'
      left join accounts a on a.id = coalesce(m.account_id, i.inventory_account_id, dm.account_id)
    where i.company_id = ${user.companyId} and i.is_stock group by 1, 2, 3, 4, 5, 6, 7 order by 1, 5 nulls last, 6`;
  const byCode = new Map<string, { code: string; name_km: string; name_en: string | null; qty: number; value: number; balance: number | null; difference: number | null;
    items: { item_id: string; code: string | null; name: string; unit: string; qty: number; value: number }[] }>();
  for (const r of rows) {
    const acc = byCode.get(r.code) ?? { code: r.code, name_km: r.name_km, name_en: r.name_en, qty: 0, value: 0, balance: null, difference: null, items: [] };
    const qty = Number(r.qty), value = Number(r.value);
    acc.qty += qty; acc.value += value; acc.items.push({ item_id: r.item_id, code: r.item_code, name: r.item_name, unit: r.unit, qty, value });
    byCode.set(r.code, acc);
  }
  let books: { total: number } | null = null;
  if (withBooks) {
    const bal = await sql<{ code: string; name_km: string; name_en: string | null; balance: string }[]>`
      select a.code, a.name_km, a.name_en, coalesce(sum(case when e.entry_date <= ${to}::date then l.debit_cents - l.credit_cents else 0 end), 0)::text as balance
      from accounts a left join journal_lines l on l.account_id = a.id left join journal_entries e on e.id = l.entry_id
      where a.company_id = ${user.companyId} and a.id = any(${sql.array(await stockAccountIds(sql, user.companyId))}::uuid[]) group by a.id, a.code, a.name_km, a.name_en order by a.code`;
    let total = 0;
    for (const b of bal) {
      const balance = Number(b.balance);
      total += balance;
      const acc = byCode.get(b.code) ?? { code: b.code, name_km: b.name_km, name_en: b.name_en, qty: 0, value: 0, balance: null, difference: null, items: [] };
      acc.balance = balance; acc.difference = acc.value - balance;
      byCode.set(b.code, acc);
    }
    books = { total };
  }
  const accounts = [...byCode.values()].filter((a) => a.items.length || (a.balance ?? 0) !== 0).sort((x, y) => x.code.localeCompare(y.code));
  const stock_total = accounts.reduce((s, a) => s + a.value, 0);
  return { to, accounts, stock_total, books_total: books?.total ?? null, difference: books ? stock_total - books.total : null };
}

/** D-144 «ផ្ទៀងផ្ទាត់សម្ភារៈ»: per job (or place) and per stock group, what left the stock against what the invoice charged through the
 *  price-list lines linked to that group («ភ្ជាប់កូដស្តុក») — a difference is the thing to look at; totals per group for the period */
export async function reconcile(user: SessionUser, q: { from: string; to: string; technician?: string | null; borey?: string | null }) {
  const c = user.companyId;
  const outs = await sql<{ booking_id: string | null; place: string | null; grp: string; grp_name: string; technician: string | null; technician_id: string | null; qty: string }[]>`
    select m.ref_id as booking_id, m.place, coalesce(a.code, '—') as grp, coalesce(a.name_km, '—') as grp_name, u.full_name as technician, m.technician_id, sum(-m.qty)::text as qty
    from stock_moves m join catalog_items i on i.id = m.item_id left join account_map dm on dm.company_id = m.company_id and dm.key = 'inventory'
      left join accounts a on a.id = coalesce(m.account_id, i.inventory_account_id, dm.account_id) left join users u on u.id = m.technician_id
      left join bookings b on b.id::text = m.ref_id left join customers cu on cu.id = b.customer_id
    where m.company_id = ${c} and m.kind = 'out' and m.move_date between ${q.from}::date and ${q.to}::date
      ${q.technician ? sql`and m.technician_id = ${q.technician}` : sql``} ${q.borey ? sql`and cu.borey_id = ${q.borey}` : sql``}
    group by 1, 2, 3, 4, 5, 6`;
  const invs = await sql<{ booking_id: string | null; number: string; grp: string; grp_name: string; qty: string }[]>`
    select i.booking_id, i.number, sa.code as grp, sa.name_km as grp_name, sum(l.qty)::text as qty
    from invoices i join invoice_lines l on l.invoice_id = i.id join catalog_items ci on ci.id = l.catalog_item_id join accounts sa on sa.id = ci.stock_link_account_id
      join companies co on co.id = i.company_id left join bookings b on b.id = i.booking_id left join customers cu on cu.id = i.customer_id
    where i.company_id = ${c} and i.status = 'issued' and (i.issued_at at time zone co.timezone)::date between ${q.from}::date and ${q.to}::date
      ${q.technician ? sql`and exists (select 1 from booking_technicians bt where bt.booking_id = i.booking_id and bt.user_id = ${q.technician})` : sql``}
      ${q.borey ? sql`and cu.borey_id = ${q.borey}` : sql``}
    group by 1, 2, 3, 4`;
  type Row = { key: string; booking_id: string | null; booking_number: string | null; customer_name: string | null; borey_name: string | null; place: string | null; technician: string | null;
    group_code: string; group_name: string; out_qty: number; invoiced_qty: number; difference: number };
  const rows = new Map<string, Row>();
  const at = (key: string, seed: Omit<Row, "key" | "out_qty" | "invoiced_qty" | "difference">) => {
    const r = rows.get(key) ?? { key, ...seed, out_qty: 0, invoiced_qty: 0, difference: 0 };
    rows.set(key, r); return r;
  };
  for (const o of outs) { const r = at(`${o.booking_id ?? `p:${o.place ?? ""}`}|${o.grp}`, { booking_id: o.booking_id, booking_number: null, customer_name: null, borey_name: null, place: o.place, technician: o.technician, group_code: o.grp, group_name: o.grp_name }); r.out_qty += Number(o.qty); if (!r.technician) r.technician = o.technician; }
  for (const i of invs) { const r = at(`${i.booking_id ?? `inv:${i.number}`}|${i.grp}`, { booking_id: i.booking_id, booking_number: null, customer_name: null, borey_name: null, place: i.booking_id ? null : i.number, technician: null, group_code: i.grp, group_name: i.grp_name }); r.invoiced_qty += Number(i.qty); }
  const ids = [...new Set([...rows.values()].map((r) => r.booking_id).filter((x): x is string => !!x))];
  const info = ids.length ? await sql<{ id: string; number: string; customer_name: string; borey_name: string | null; lead: string | null }[]>`select b.id, b.number, cu.name as customer_name, bo.name as borey_name,
      (select u.full_name from booking_technicians bt join users u on u.id = bt.user_id where bt.booking_id = b.id order by (bt.role = 'lead') desc limit 1) as lead
    from bookings b join customers cu on cu.id = b.customer_id left join boreys bo on bo.id = cu.borey_id where b.id = any(${sql.array(ids)}::uuid[])` : [];
  const byId = new Map(info.map((x) => [x.id, x]));
  const out = [...rows.values()].map((r) => { const b = r.booking_id ? byId.get(r.booking_id) : null; return { ...r, booking_number: b?.number ?? null, customer_name: b?.customer_name ?? null, borey_name: b?.borey_name ?? null,
    technician: r.technician ?? b?.lead ?? null, out_qty: Math.round(r.out_qty * 1000) / 1000, invoiced_qty: Math.round(r.invoiced_qty * 1000) / 1000, difference: Math.round((r.out_qty - r.invoiced_qty) * 1000) / 1000 }; })
    .sort((x, y) => (x.booking_number ?? x.place ?? "").localeCompare(y.booking_number ?? y.place ?? "") || x.group_code.localeCompare(y.group_code));
  const totals = new Map<string, { group_code: string; group_name: string; out_qty: number; invoiced_qty: number; difference: number }>();
  for (const r of out) { const tt = totals.get(r.group_code) ?? { group_code: r.group_code, group_name: r.group_name, out_qty: 0, invoiced_qty: 0, difference: 0 }; tt.out_qty += r.out_qty; tt.invoiced_qty += r.invoiced_qty; tt.difference = Math.round((tt.out_qty - tt.invoiced_qty) * 1000) / 1000; totals.set(r.group_code, tt); }
  return { from: q.from, to: q.to, rows: out, totals: [...totals.values()].sort((x, y) => x.group_code.localeCompare(y.group_code)) };
}

/** stock card: opening, every move with running quantity and value, ending (value only for the whole company) */
export async function card(user: SessionUser, itemId: string, from: string, to: string, locationId?: string) {
  if (!(await sql`select 1 from catalog_items where id = ${itemId} and company_id = ${user.companyId}`).length) throw notFound();
  const loc = locationId ? sql`and m.location_id = ${locationId}` : sql``;
  const op = (await sql<{ qty: string; value: string }[]>`select coalesce(sum(m.qty), 0)::text as qty, coalesce(sum(m.value_cents), 0)::text as value from stock_moves m
    where m.item_id = ${itemId} and m.company_id = ${user.companyId} and m.move_date < ${from}::date ${loc}`)[0]!;
  const moves = await sql<{ id: number; date: string; kind: string; qty: string; value: string; ref_type: string | null; ref_id: string | null; reason: string | null; supplier: string | null; location: string; ref_label: string | null; by_name: string | null; technician: string | null; place: string | null }[]>`
    select m.id, m.move_date::text as date, m.kind::text, m.qty::text, m.value_cents::text as value, m.ref_type, m.ref_id, m.reason, m.supplier, m.supplier_invoice, m.paid_cents::text as paid, l.name as location, u.full_name as by_name, tu.full_name as technician, m.place,
      case m.ref_type when 'booking' then (select number from bookings where id::text = m.ref_id) when 'invoice' then (select number from invoices where id::text = m.ref_id) end as ref_label
    from stock_moves m join stock_locations l on l.id = m.location_id left join users u on u.id = m.created_by left join users tu on tu.id = m.technician_id
    where m.item_id = ${itemId} and m.company_id = ${user.companyId} and m.move_date between ${from}::date and ${to}::date ${loc} order by m.move_date, m.id`;
  let q = Number(op.qty), v = Number(op.value);
  const opening = { qty: q, value: locationId ? null : v };
  const rows = moves.map((m) => {
    q = Math.round((q + Number(m.qty)) * 1000) / 1000; v += Number(m.value);
    return { ...m, qty: Number(m.qty), value: locationId ? null : Number(m.value), balance_qty: q, balance_value: locationId ? null : v };
  });
  return { opening, rows, ending: { qty: q, value: locationId ? null : v } };
}

// ---------- D-167 (client 25-10): what the shop owes its suppliers, and paying them later in $ or ៛ by any method ----------
export type SupplierPayInput = { supplier: string; amount: number; currency: "usd" | "khr"; method: "cash_usd" | "cash_khr" | "aba" | "acleda"; date?: string | null; note?: string | null;
  /** D-181: the debt account this payment clears (none → the supplier's open debts in account order) */
  account_id?: string | null };
export async function supplierPay(user: SessionUser, ip: string | null, v: SupplierPayInput) {
  if ((v.method === "cash_usd" && v.currency !== "usd") || (v.method === "cash_khr" && v.currency !== "khr")) throw new AppError("BAD_METHOD", 400);
  return tx(user.id, async (t) => {
    const s = (await t<{ fx: string; today: string }[]>`select s.fx_rate_khr::text as fx, (now() at time zone c.timezone)::date::text as today from company_settings s join companies c on c.id = s.company_id where s.company_id = ${user.companyId}`)[0]!;
    const fx = Number(s.fx), date = v.date ?? s.today;
    if (date > s.today) throw new AppError("BAD_DATE", 400);
    const cents = v.currency === "usd" ? Math.round(v.amount) : khrToCents(v.amount, fx);
    if (cents <= 0) throw new AppError("AMOUNT_TOO_SMALL", 400);
    const supplier = v.supplier.trim().slice(0, 120);
    if (v.account_id) await assertDebtAccount(t, user.companyId, v.account_id);
    const id = (await t<{ id: string }[]>`insert into supplier_payments (company_id, supplier, amount_cents, currency, amount_native, fx_rate_khr, method, paid_on, note, created_by, account_id)
      values (${user.companyId}, ${supplier}, ${cents}, ${v.currency}, ${v.currency === "usd" ? cents / 100 : v.amount}, ${fx}, ${v.method}, ${date}::date, ${v.note?.trim() || null}, ${user.id}, ${v.account_id ?? null}) returning id::text`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.supplier_pay", table: "supplier_payments", rowId: id, new: { supplier, amount: v.amount, currency: v.currency, usd_cents: cents, method: v.method, date, note: v.note ?? null }, ip });
    await postSupplierPay(t, user, { id, supplier, usd_cents: cents, method: v.method, fx, date, khr: v.currency === "khr" ? v.amount : null, note: v.note?.trim() || null, account: v.account_id ?? null });
    const owed = (await payables(user, t)).find((p) => p.supplier.toLowerCase() === supplier.toLowerCase())?.owed ?? 0;
    return { id, usd_cents: cents, owed };
  });
}
/** per supplier: purchases not paid (value − paid now), + the opening debt entered with the balances, − the payments made; the open
 *  supplier invoice numbers and the last purchase — the same whether the books are started or not */
export async function payables(user: SessionUser, db: Db = sql) {
  // D-181: once the books run, the debts come from the books — per supplier (spellings merged) and per debt account, whatever recorded them
  if ((await db<{ s: string | null }[]>`select books_start::text as s from company_settings where company_id = ${user.companyId}`)[0]?.s) return payablesFromBooks(user, db);
  const buys = await db<{ supplier: string; owed: string; invoices: string[] | null; last: string | null; purchases: string }[]>`
    select m.supplier, sum(case when m.kind = 'in' then m.value_cents - coalesce(m.paid_cents, case when m.pay = 'credit' then 0 else m.value_cents end)
                              when m.kind = 'reverse' and o.kind = 'in' then -(o.value_cents - coalesce(o.paid_cents, case when o.pay = 'credit' then 0 else o.value_cents end)) else 0 end)::text as owed,
      array_remove(array_agg(distinct m.supplier_invoice) filter (where m.kind = 'in' and m.supplier_invoice is not null and m.value_cents > coalesce(m.paid_cents, case when m.pay = 'credit' then 0 else m.value_cents end)), null) as invoices,
      max(m.move_date)::text as last, count(*) filter (where m.kind = 'in')::text as purchases
    from stock_moves m left join stock_moves o on o.id = m.reversal_of where m.company_id = ${user.companyId} and m.supplier is not null and m.supplier <> '' group by m.supplier`;
  const opening = ((await db<{ d: { payables?: { supplier: string; amount: number }[] } | null }[]>`select opening_draft as d from company_settings where company_id = ${user.companyId}`)[0]?.d?.payables ?? []);
  const paid = await db<{ supplier: string; paid: string; last: string | null }[]>`select supplier, sum(amount_cents)::text as paid, max(paid_on)::text as last from supplier_payments where company_id = ${user.companyId} and reversal_of is null group by supplier`;
  const names = new Set([...buys.map((b) => b.supplier), ...opening.map((o) => o.supplier.trim()), ...paid.map((p) => p.supplier)]);
  return [...names].map((supplier) => {
    const b = buys.find((x) => x.supplier === supplier), o = opening.filter((x) => x.supplier.trim() === supplier).reduce((a, x) => a + x.amount, 0), p = paid.find((x) => x.supplier === supplier);
    const owed = Number(b?.owed ?? 0) + o - Number(p?.paid ?? 0), paid = Number(p?.paid ?? 0);
    return { supplier, owed, purchases: Number(b?.purchases ?? 0), opening: o, paid, invoices: b?.invoices ?? [], last_purchase: b?.last ?? null, last_payment: p?.last ?? null, pay_status: payStatusOf(owed + paid, paid) };
  }).filter((p) => p.owed !== 0 || p.paid || p.purchases).sort((a, b) => b.owed - a.owed || a.supplier.localeCompare(b.supplier));
}
