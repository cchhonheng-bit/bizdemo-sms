// Inventory (D-87 · flag "inventory"): generic stock for any shop. Append-only moves (qty 3 decimals, value in integer cents),
// weighted-average cost per item across all locations (computed in SQL numeric — no floats), quantities per location,
// no negative stock unless the setting allows it, low-stock alert once a day, accounting hook on every move.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { featureOn } from "../lib/features.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { postStock } from "./ledger-hooks.js";
import { notifyUser } from "./telegram.js";

export type Pay = "cash_usd" | "cash_khr" | "aba" | "acleda" | "credit";
type Kind = "opening" | "in" | "out_job" | "out_sale" | "adjust" | "transfer_out" | "transfer_in" | "reverse";

// ---------- locations ----------
/** a warehouse and one location per active vehicle exist by default (a shop can add, rename or switch them off) */
export async function ensureLocations(db: Db, companyId: string): Promise<void> {
  if (!(await db`select 1 from stock_locations where company_id = ${companyId} and kind = 'warehouse'`).length)
    await db`insert into stock_locations (company_id, name, kind) values (${companyId}, 'ឃ្លាំងធំ', 'warehouse')`;
  await db`insert into stock_locations (company_id, name, kind, vehicle_id)
    select v.company_id, 'ឡាន ' || v.code, 'vehicle', v.id from vehicles v
    where v.company_id = ${companyId} and v.is_active and not exists (select 1 from stock_locations l where l.vehicle_id = v.id)`;
}
export async function listLocations(user: SessionUser) {
  await ensureLocations(sql, user.companyId);
  return sql`select l.id, l.name, l.kind, l.vehicle_id, v.code as vehicle_code, l.is_active from stock_locations l left join vehicles v on v.id = l.vehicle_id
    where l.company_id = ${user.companyId} order by l.kind desc, l.name`;
}
export async function saveLocation(user: SessionUser, ip: string | null, v: { id?: string; name: string; kind: "warehouse" | "vehicle"; vehicle_id?: string | null; is_active?: boolean }) {
  return tx(user.id, async (t) => {
    if (v.vehicle_id && !(await t`select 1 from vehicles where id = ${v.vehicle_id} and company_id = ${user.companyId}`).length) throw notFound();
    const id = v.id
      ? (await t<{ id: string }[]>`update stock_locations set name = ${v.name.trim()}, is_active = coalesce(${v.is_active ?? null}, is_active) where id = ${v.id} and company_id = ${user.companyId} returning id`)[0]?.id
      : (await t<{ id: string }[]>`insert into stock_locations (company_id, name, kind, vehicle_id) values (${user.companyId}, ${v.name.trim()}, ${v.kind}, ${v.vehicle_id ?? null}) returning id`)[0]!.id;
    if (!id) throw notFound();
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.location", table: "stock_locations", rowId: id, new: v, ip });
    return { id };
  });
}

export async function trackItem(user: SessionUser, ip: string | null, itemId: string, track: boolean, reorderLevel: number | null | undefined) {
  return tx(user.id, async (t) => {
    const it = (await t<{ kind: string }[]>`select kind::text from catalog_items where id = ${itemId} and company_id = ${user.companyId} for update`)[0];
    if (!it) throw notFound();
    if (it.kind !== "product") throw new AppError("NOT_A_PRODUCT", 400);
    await t`update catalog_items set track_stock = ${track}, reorder_level = case when ${reorderLevel !== undefined} then ${reorderLevel ?? null}::numeric else reorder_level end where id = ${itemId}`;
    await t`insert into stock_items (company_id, item_id) values (${user.companyId}, ${itemId}) on conflict do nothing`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.track", table: "catalog_items", rowId: itemId, new: { track, reorder_level: reorderLevel }, ip });
    return { ok: true };
  });
}

// ---------- the one place that moves stock ----------
type MoveIn = { item: string; location: string; kind: Kind; qty: number; value?: number | null; ref_type?: string; ref_id?: string | null;
  pay?: Pay | null; supplier?: string | null; reason?: string | null; group?: string | null; reversal_of?: number | null };

async function move(t: Db, user: SessionUser, m: MoveIn): Promise<number> {
  const loc = (await t<{ id: string }[]>`select id from stock_locations where id = ${m.location} and company_id = ${user.companyId} and is_active`)[0];
  if (!loc) throw new AppError("LOCATION_NOT_FOUND", 404);
  const it = (await t<{ track: boolean; reorder: string | null; name: string }[]>`select track_stock as track, reorder_level::text as reorder, name_km as name from catalog_items
    where id = ${m.item} and company_id = ${user.companyId}`)[0];
  if (!it) throw notFound();
  if (!it.track) throw new AppError("NOT_TRACKED", 400);
  await t`insert into stock_items (company_id, item_id) values (${user.companyId}, ${m.item}) on conflict do nothing`;
  await t`insert into stock_balances (location_id, item_id) values (${m.location}, ${m.item}) on conflict do nothing`;
  const s = (await t<{ qty: string; value: string }[]>`select qty::text, value_cents::text as value from stock_items where item_id = ${m.item} for update`)[0]!;
  const b = (await t<{ qty: string }[]>`select qty::text from stock_balances where location_id = ${m.location} and item_id = ${m.item} for update`)[0]!;
  const q = m.qty;
  let value: number;
  if (q < 0) {
    const allowNeg = (await t<{ a: boolean }[]>`select allow_negative_stock as a from company_settings where company_id = ${user.companyId}`)[0]?.a ?? false;
    if (!allowNeg && Number(b.qty) + q < -1e-9) throw new AppError("INSUFFICIENT_STOCK", 400, { item: it.name, available: Number(b.qty) });
    // weighted average: the last unit takes whatever value is left, so nothing stays behind in cents
    value = m.kind === "transfer_out" ? 0 : m.value != null ? m.value : -Number((await t<{ v: string }[]>`select case
        when ${-q}::numeric >= ${s.qty}::numeric then greatest(${s.value}::bigint, 0)
        when ${s.qty}::numeric <= 0 then 0
        else round(${s.value}::numeric * ${-q}::numeric / ${s.qty}::numeric) end::text as v`)[0]!.v);
  } else {
    value = m.kind === "transfer_in" ? 0 : m.value != null ? m.value : Number((await t<{ v: string }[]>`select case when ${s.qty}::numeric > 0
        then round(${s.value}::numeric * ${q}::numeric / ${s.qty}::numeric) else 0 end::text as v`)[0]!.v); // + adjustment at today's average
  }
  const tz = (await t<{ tz: string; fx: string }[]>`select c.timezone as tz, s.fx_rate_khr::text as fx from companies c join company_settings s on s.company_id = c.id where c.id = ${user.companyId}`)[0]!;
  const id = (await t<{ id: number }[]>`insert into stock_moves (company_id, item_id, location_id, kind, qty, value_cents, fx_rate_khr, move_date, ref_type, ref_id, pay, supplier, reason, transfer_group, reversal_of, created_by)
    values (${user.companyId}, ${m.item}, ${m.location}, ${m.kind}::stock_move_kind, ${q}, ${value}, ${tz.fx}::numeric, (now() at time zone ${tz.tz})::date,
      ${m.ref_type ?? "manual"}, ${m.ref_id ?? null}, ${m.pay ?? null}, ${m.supplier ?? null}, ${m.reason ?? null}, ${m.group ?? null}, ${m.reversal_of ?? null}, ${user.id}) returning id`)[0]!.id;
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
    await notifyUser(t, user.companyId, u.id, "stock.low", { km: `📦 ស្តុកជិតអស់ · ${name}`, en: `📦 Low stock · ${name}` }, { km: `នៅសល់ ${Number(r.qty)} (កម្រិត ${reorder})`, en: `${Number(r.qty)} left (level ${reorder})` }, "/inventory", `low:${item}:${Date.now()}:${u.id}`);
}

// ---------- operations ----------
const cents = async (t: Db, qty: number, unit?: number | null, total?: number | null) => total != null ? total
  : Number((await t<{ v: string }[]>`select round(${qty}::numeric * ${unit ?? 0}::numeric)::text as v`)[0]!.v);

export async function opening(user: SessionUser, ip: string | null, v: { item_id: string; location_id: string; qty: number; unit_cost: number }) {
  return tx(user.id, async (t) => {
    if ((await t`select 1 from stock_moves where item_id = ${v.item_id} and company_id = ${user.companyId}`).length) throw new AppError("OPENING_EXISTS", 400);
    const id = await move(t, user, { item: v.item_id, location: v.location_id, kind: "opening", qty: v.qty, value: await cents(t, v.qty, v.unit_cost), ref_type: "opening" });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.opening", table: "stock_moves", rowId: String(id), new: v, ip });
    await postStock(t, user, [id]);
    return { id };
  });
}

export async function stockIn(user: SessionUser, ip: string | null, v: { item_id: string; location_id: string; qty: number; unit_cost?: number; total?: number; pay: Pay; supplier?: string | null; note?: string | null }) {
  if (v.unit_cost == null && v.total == null) throw new AppError("COST_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const id = await move(t, user, { item: v.item_id, location: v.location_id, kind: "in", qty: v.qty, value: await cents(t, v.qty, v.unit_cost, v.total), ref_type: "purchase", pay: v.pay, supplier: v.supplier?.trim() || null, reason: v.note?.trim() || null });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.in", table: "stock_moves", rowId: String(id), new: v, ip });
    await postStock(t, user, [id]);
    return { id };
  });
}

export async function adjust(user: SessionUser, ip: string | null, v: { item_id: string; location_id: string; qty: number; reason: string; unit_cost?: number | null }) {
  if (v.reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
  return tx(user.id, async (t) => {
    const id = await move(t, user, { item: v.item_id, location: v.location_id, kind: "adjust", qty: v.qty, value: v.qty > 0 && v.unit_cost != null ? await cents(t, v.qty, v.unit_cost) : null, reason: v.reason.trim() });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.adjust", table: "stock_moves", rowId: String(id), new: v, ip });
    await postStock(t, user, [id]);
    return { id };
  });
}

export async function transfer(user: SessionUser, ip: string | null, v: { item_id: string; from: string; to: string; qty: number }) {
  if (v.from === v.to) throw new AppError("SAME_LOCATION", 400);
  return tx(user.id, async (t) => {
    const group = (await t<{ g: string }[]>`select gen_random_uuid()::text as g`)[0]!.g;
    const a = await move(t, user, { item: v.item_id, location: v.from, kind: "transfer_out", qty: -v.qty, ref_type: "transfer", group });
    const b = await move(t, user, { item: v.item_id, location: v.to, kind: "transfer_in", qty: v.qty, ref_type: "transfer", group });
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.transfer", table: "stock_moves", rowId: String(a), new: { ...v, moves: [a, b] }, ip });
    return { ids: [a, b] };
  });
}

// ---------- job materials: technician records, Admin confirms ----------
const FINISHED = ["work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];
export async function pendingJobs(user: SessionUser) {
  await ensureLocations(sql, user.companyId);
  return sql`select b.id as booking_id, b.number, b.status, c.name as customer_name,
      coalesce((select l.id from stock_locations l where l.vehicle_id = b.vehicle_id and l.is_active),
               (select l.id from stock_locations l where l.company_id = b.company_id and l.kind = 'warehouse' and l.is_active order by l.created_at limit 1)) as suggested_location_id,
      (select json_agg(json_build_object('item_id', i.id, 'name', i.name_km, 'unit', i.unit, 'qty', m.qty::float) order by i.name_km)
         from booking_materials m join catalog_items i on i.id = m.catalog_item_id where m.booking_id = b.id and i.track_stock) as materials
    from bookings b join customers c on c.id = b.customer_id
    where b.company_id = ${user.companyId} and b.materials_confirmed_at is null and b.status = any(${sql.array(FINISHED)}::booking_status[])
      and exists (select 1 from booking_materials m join catalog_items i on i.id = m.catalog_item_id where m.booking_id = b.id and i.track_stock)
    order by b.scheduled_at`;
}

export async function confirmJob(user: SessionUser, ip: string | null, bookingId: string, locationId?: string | null) {
  return tx(user.id, async (t) => {
    const b = (await t<{ id: string; status: string; confirmed: Date | null; vehicle_id: string | null }[]>`select id, status::text, materials_confirmed_at as confirmed, vehicle_id
      from bookings where id = ${bookingId} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (b.confirmed) throw new AppError("ALREADY_CONFIRMED", 400);
    if (!FINISHED.includes(b.status)) throw new AppError("NOT_FINISHED", 400);
    await ensureLocations(t, user.companyId);
    const loc = locationId ?? (await t<{ id: string }[]>`select coalesce((select id from stock_locations where vehicle_id = ${b.vehicle_id} and is_active),
        (select id from stock_locations where company_id = ${user.companyId} and kind = 'warehouse' and is_active order by created_at limit 1)) as id`)[0]!.id;
    const mats = await t<{ item: string; qty: string }[]>`select m.catalog_item_id as item, m.qty::text from booking_materials m join catalog_items i on i.id = m.catalog_item_id
      where m.booking_id = ${bookingId} and i.track_stock`;
    const ids: number[] = [];
    for (const m of mats) ids.push(await move(t, user, { item: m.item, location: loc, kind: "out_job", qty: -Number(m.qty), ref_type: "booking", ref_id: bookingId }));
    await t`update booking_materials set confirmed_at = now(), confirmed_by = ${user.id} where booking_id = ${bookingId}`;
    await t`update bookings set materials_confirmed_at = now() where id = ${bookingId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "stock.job_confirm", table: "bookings", rowId: bookingId, new: { location: loc, moves: ids }, ip });
    await postStock(t, user, ids);
    return { moves: ids.length };
  });
}

// ---------- direct sales (invoice without a job) ----------
/** at issue: tracked product lines leave the sale location (setting) or the main warehouse */
export async function deductSale(t: Db, user: SessionUser, invoiceId: string): Promise<void> {
  if (!featureOn("inventory")) return;
  const lines = await t<{ item: string; qty: string }[]>`select l.catalog_item_id as item, l.qty::text from invoice_lines l join catalog_items i on i.id = l.catalog_item_id
    where l.invoice_id = ${invoiceId} and i.track_stock and i.kind = 'product'`;
  if (!lines.length) return;
  await ensureLocations(t, user.companyId);
  const loc = (await t<{ id: string }[]>`select coalesce((select sale_location_id from company_settings where company_id = ${user.companyId}),
      (select id from stock_locations where company_id = ${user.companyId} and kind = 'warehouse' and is_active order by created_at limit 1)) as id`)[0]!.id;
  const ids: number[] = [];
  for (const l of lines) ids.push(await move(t, user, { item: l.item, location: loc, kind: "out_sale", qty: -Number(l.qty), ref_type: "invoice", ref_id: invoiceId }));
  await postStock(t, user, ids);
}

/** a void puts back exactly what the record took (same quantity and value, same location) */
export async function reverseRef(t: Db, user: SessionUser, refType: "invoice" | "booking", refId: string): Promise<void> {
  const moves = await t<{ id: number; item: string; loc: string; qty: string; value: string }[]>`select m.id, m.item_id as item, m.location_id as loc, m.qty::text, m.value_cents::text as value
    from stock_moves m where m.company_id = ${user.companyId} and m.ref_type = ${refType} and m.ref_id = ${refId} and m.kind <> 'reverse'
      and not exists (select 1 from stock_moves r where r.reversal_of = m.id)`;
  const ids: number[] = [];
  for (const m of moves) ids.push(await move(t, user, { item: m.item, location: m.loc, kind: "reverse", qty: -Number(m.qty), value: -Number(m.value), ref_type: refType, ref_id: refId, reversal_of: m.id }));
  if (ids.length) await postStock(t, user, ids);
}

// ---------- read ----------
export async function items(user: SessionUser) {
  await ensureLocations(sql, user.companyId);
  const rows = await sql<{ item_id: string; name: string; unit: string; qty: string; value: string; reorder: string | null }[]>`
    select i.id as item_id, i.name_km as name, i.unit, coalesce(s.qty, 0)::text as qty, coalesce(s.value_cents, 0)::text as value, i.reorder_level::text as reorder
    from catalog_items i left join stock_items s on s.item_id = i.id where i.company_id = ${user.companyId} and i.track_stock order by i.name_km`;
  const bal = await sql<{ item_id: string; location_id: string; name: string; qty: string }[]>`select b.item_id, b.location_id, l.name, b.qty::text from stock_balances b
    join stock_locations l on l.id = b.location_id where l.company_id = ${user.companyId} and (b.qty <> 0 or l.is_active) order by l.kind desc, l.name`;
  return rows.map((r) => {
    const qty = Number(r.qty), value = Number(r.value);
    return { item_id: r.item_id, name: r.name, unit: r.unit, qty, value, avg_cost: qty > 0 ? Math.round(value / qty) : 0,
      reorder_level: r.reorder == null ? null : Number(r.reorder), low: r.reorder != null && qty < Number(r.reorder),
      by_location: bal.filter((b) => b.item_id === r.item_id).map((b) => ({ location_id: b.location_id, name: b.name, qty: Number(b.qty) })) };
  });
}

/** stock card: opening, every move with running quantity and value, ending (value only for the whole company) */
export async function card(user: SessionUser, itemId: string, from: string, to: string, locationId?: string) {
  if (!(await sql`select 1 from catalog_items where id = ${itemId} and company_id = ${user.companyId}`).length) throw notFound();
  const loc = locationId ? sql`and m.location_id = ${locationId}` : sql``;
  const op = (await sql<{ qty: string; value: string }[]>`select coalesce(sum(m.qty), 0)::text as qty, coalesce(sum(m.value_cents), 0)::text as value from stock_moves m
    where m.item_id = ${itemId} and m.company_id = ${user.companyId} and m.move_date < ${from}::date ${loc}`)[0]!;
  const moves = await sql<{ id: number; date: string; kind: string; qty: string; value: string; ref_type: string | null; ref_id: string | null; reason: string | null; supplier: string | null; location: string; ref_label: string | null; by_name: string | null }[]>`
    select m.id, m.move_date::text as date, m.kind::text, m.qty::text, m.value_cents::text as value, m.ref_type, m.ref_id, m.reason, m.supplier, l.name as location, u.full_name as by_name,
      case m.ref_type when 'booking' then (select number from bookings where id::text = m.ref_id) when 'invoice' then (select number from invoices where id::text = m.ref_id) end as ref_label
    from stock_moves m join stock_locations l on l.id = m.location_id left join users u on u.id = m.created_by
    where m.item_id = ${itemId} and m.company_id = ${user.companyId} and m.move_date between ${from}::date and ${to}::date ${loc} order by m.id`;
  let q = Number(op.qty), v = Number(op.value);
  const opening = { qty: q, value: locationId ? null : v };
  const rows = moves.map((m) => {
    q = Math.round((q + Number(m.qty)) * 1000) / 1000; v += Number(m.value);
    return { ...m, qty: Number(m.qty), value: locationId ? null : Number(m.value), balance_qty: q, balance_value: locationId ? null : v };
  });
  return { opening, rows, ending: { qty: q, value: locationId ? null : v } };
}
