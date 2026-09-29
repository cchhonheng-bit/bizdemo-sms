// Booking flow (port of v1 create_booking / update_booking / assign_booking / technician_availability) + Booking Rules v1.3:
// R1 availability for the booking's window · R2 server-side blocking (the API is the source of truth, not the UI)
// R3 no start in the past, end time, no overlaps — the exclusion constraints of 0003 are the last line under concurrency
// R4 cancel with a reason · R5 lead technician optional, crew ≥ 1.
// Every function takes companyId + the acting user; technicians only see bookings they are assigned to (D-18).
import { CANCELLABLE_STATUSES, DEFAULT_DURATION_MIN, type BookingStatus } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { enqueueBookingCancelled, enqueueBookingConfirmed } from "./telegram.js";

export type BookingRow = Record<string, unknown> & {
  id: string; company_id: string; number: string; status: BookingStatus; type: "A" | "B";
  scheduled_at: Date | null; ends_at: Date | null; vehicle_id: string | null; service_item_id: string | null;
};

/** shared SELECT (same columns as the v1 api.bookings view) */
function baseSelect(db: Db) {
  return db`select b.id, b.company_id, b.number, b.customer_id, c.name as customer_name, c.phones as customer_phones,
         b.type, b.category, b.status, b.service_text, b.service_item_id, b.scheduled_at, b.ends_at, b.address, b.lat, b.lng, b.zone,
         b.vehicle_id, v.code as vehicle_code, b.notes, b.parent_booking_id, b.cancel_reason, b.cancelled_at, b.cancelled_by, b.closed_at,
         b.created_by, b.created_at, b.updated_at,
         (select json_agg(json_build_object('user_id', t.user_id, 'role', t.role, 'full_name', u.full_name) order by t.role, u.full_name)
            from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as technicians
    from bookings b join customers c on c.id = b.customer_id left join vehicles v on v.id = b.vehicle_id`;
}

const techFilter = (db: Db, user: SessionUser) =>
  user.role === "tech" ? db`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${user.id})` : db``;

export async function listBookings(user: SessionUser, o: { statuses?: BookingStatus[]; from?: string; to?: string; limit?: number }) {
  return sql`${baseSelect(sql)}
    where b.company_id = ${user.companyId} ${techFilter(sql, user)}
      ${o.statuses?.length ? sql`and b.status = any(${sql.array(o.statuses)}::booking_status[])` : sql``}
      ${o.from ? sql`and b.scheduled_at >= ${o.from}` : sql``}
      ${o.to ? sql`and b.scheduled_at < ${o.to}` : sql``}
    order by b.scheduled_at asc nulls last, b.created_at desc limit ${Math.min(o.limit ?? 300, 1000)}`;
}

export async function getBooking(user: SessionUser, id: string) {
  const r = await sql`${baseSelect(sql)} where b.id = ${id} and b.company_id = ${user.companyId} ${techFilter(sql, user)}`;
  if (!r[0]) throw notFound();
  return r[0];
}

export async function statusLog(user: SessionUser, id: string) {
  await getBooking(user, id); // visibility check
  return sql`select id, booking_id, from_status, to_status, by, at, note from booking_status_log where booking_id = ${id} order by at`;
}

// ---------- R3 time rules ----------------------------------------------------------------------------
const parseTime = (v: string | null | undefined, code: string): Date | null => {
  if (v == null || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new AppError(code, 400);
  return d;
};
/** a start that is written (create / changed / assign) must not be in the past (absolute instant; UI shows Asia/Phnom_Penh) */
function assertFuture(start: Date): void {
  if (start.getTime() < Date.now()) throw new AppError("START_IN_PAST", 400);
}
async function durationOf(t: Db, companyId: string, serviceItemId: string | null): Promise<number> {
  if (!serviceItemId) return DEFAULT_DURATION_MIN;
  const r = (await t<{ duration_min: number }[]>`select duration_min from catalog_items where id = ${serviceItemId} and company_id = ${companyId}`)[0];
  if (!r) throw new AppError("SERVICE_NOT_FOUND", 404);
  return r.duration_min;
}
/** start + end → [start, end) with end > start; end defaults to start + duration */
function window(start: Date | null, end: Date | null, minutes: number): { start: Date | null; end: Date | null } {
  if (!start) {
    if (end) throw new AppError("START_REQUIRED", 400);
    return { start: null, end: null };
  }
  const e = end ?? new Date(start.getTime() + minutes * 60_000);
  if (e.getTime() <= start.getTime()) throw new AppError("END_BEFORE_START", 400);
  return { start, end: e };
}

// ---------- R1/R2 availability ------------------------------------------------------------------------
type Busy = { number: string; scheduled_at: Date; ends_at: Date };

/** technicians (active tech/gm) on another non-cancelled booking overlapping [from, to) */
async function busyPeople(t: Db, companyId: string, from: Date, to: Date, exclude: string | null, ids?: string[]) {
  return t<(Busy & { user_id: string; full_name: string })[]>`
    select bt.user_id, u.full_name, b.number, b.scheduled_at, b.ends_at from booking_technicians bt
      join bookings b on b.id = bt.booking_id join users u on u.id = bt.user_id
    where b.company_id = ${companyId} and b.status <> 'cancelled' and b.scheduled_at is not null
      ${exclude ? t`and b.id <> ${exclude}` : t``}
      ${ids ? t`and bt.user_id = any(${t.array(ids)}::uuid[])` : t``}
      and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')
    order by b.scheduled_at`;
}
async function busyVehicles(t: Db, companyId: string, from: Date, to: Date, exclude: string | null, vehicleId?: string) {
  return t<(Busy & { vehicle_id: string; code: string })[]>`
    select b.vehicle_id, v.code, b.number, b.scheduled_at, b.ends_at from bookings b join vehicles v on v.id = b.vehicle_id
    where b.company_id = ${companyId} and b.status <> 'cancelled' and b.scheduled_at is not null
      ${exclude ? t`and b.id <> ${exclude}` : t``}
      ${vehicleId ? t`and b.vehicle_id = ${vehicleId}` : t``}
      and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')
    order by b.scheduled_at`;
}

async function assertVehicle(t: Db, companyId: string, vehicleId: string) {
  const v = await t`select 1 from vehicles where id = ${vehicleId} and company_id = ${companyId} and is_active`;
  if (v.length === 0) throw new AppError("VEHICLE_NOT_FOUND", 404);
}
async function assertVehicleFree(t: Db, companyId: string, vehicleId: string, start: Date, end: Date, exclude: string | null) {
  const b = await busyVehicles(t, companyId, start, end, exclude, vehicleId);
  if (b.length) throw new AppError("VEHICLE_UNAVAILABLE", 409, { conflicts: b.map((x) => ({ vehicle_id: x.vehicle_id, code: x.code, number: x.number, scheduled_at: x.scheduled_at, ends_at: x.ends_at })) });
}
async function assertTeamFree(t: Db, companyId: string, team: string[], start: Date, end: Date, exclude: string | null) {
  if (!team.length) return;
  const b = await busyPeople(t, companyId, start, end, exclude, team);
  if (b.length) throw new AppError("TECH_UNAVAILABLE", 409, { conflicts: b.map((x) => ({ user_id: x.user_id, full_name: x.full_name, number: x.number, scheduled_at: x.scheduled_at, ends_at: x.ends_at })) });
}

/** R1: who/what is free for [from, to) — assigners only (F-M2-02). Inactive people are never offered. */
export async function availability(user: SessionUser, fromIso: string, toIso: string, exclude: string | null) {
  const from = parseTime(fromIso, "INVALID_VALUE")!, to = parseTime(toIso, "INVALID_VALUE")!;
  if (to.getTime() <= from.getTime()) throw new AppError("END_BEFORE_START", 400);
  const people = await sql<{ id: string; full_name: string; role: string }[]>`select id, full_name, role from users
    where company_id = ${user.companyId} and is_active and role in ('tech', 'gm') order by role desc, full_name`;
  const vehicles = await sql<{ id: string; code: string; plate: string | null }[]>`select id, code, plate from vehicles where company_id = ${user.companyId} and is_active order by code`;
  const bp = await busyPeople(sql, user.companyId, from, to, exclude);
  const bv = await busyVehicles(sql, user.companyId, from, to, exclude);
  const strip = (b: Busy) => ({ number: b.number, scheduled_at: b.scheduled_at, ends_at: b.ends_at });
  return {
    from, to,
    // absent / on leave: attendance + leave arrive with M4 (no data yet) — reason list is ready for it
    people: people.map((p) => {
      const busy = bp.filter((b) => b.user_id === p.id).map(strip);
      return { user_id: p.id, full_name: p.full_name, role: p.role, available: busy.length === 0, reason: busy.length ? "BUSY" : null, busy };
    }),
    vehicles: vehicles.map((v) => {
      const busy = bv.filter((b) => b.vehicle_id === v.id).map(strip);
      return { id: v.id, code: v.code, plate: v.plate, available: busy.length === 0, reason: busy.length ? "BUSY" : null, busy };
    }),
  };
}

// ---------- create / update ----------------------------------------------------------------------------
export type CreateInput = {
  customer_id: string; type: "A" | "B"; category: string; service_text: string; service_item_id: string | null; scheduled_at: string | null; ends_at: string | null;
  address: string | null; lat: number | null; lng: number | null; zone: string | null; vehicle_id: string | null; notes: string | null;
};

export async function createBooking(user: SessionUser, ip: string | null, b: CreateInput) {
  return tx(user.id, async (t) => {
    const c = (await t<{ id: string; name: string; address: string | null; lat: number | null; lng: number | null; zone: string }[]>`
      select id, name, address, lat, lng, zone from customers where id = ${b.customer_id} and company_id = ${user.companyId} and is_active`)[0];
    if (!c) throw new AppError("CUSTOMER_NOT_FOUND", 404);
    const service = b.service_text.trim();
    if (!service) throw new AppError("SERVICE_REQUIRED", 400);
    const minutes = await durationOf(t, user.companyId, b.service_item_id);
    const w = window(parseTime(b.scheduled_at, "INVALID_VALUE"), parseTime(b.ends_at, "INVALID_VALUE"), minutes);
    if (w.start) assertFuture(w.start);
    if (b.vehicle_id) {
      await assertVehicle(t, user.companyId, b.vehicle_id);
      if (w.start) await assertVehicleFree(t, user.companyId, b.vehicle_id, w.start, w.end!, null);
    }
    const no = (await t<{ last_no: number }[]>`insert into booking_counters (company_id, last_no) values (${user.companyId}, 1)
      on conflict (company_id) do update set last_no = booking_counters.last_no + 1 returning last_no`)[0]!.last_no;
    const number = `BK-${String(no).padStart(4, "0")}`;
    const status: BookingStatus = b.type === "B" ? "survey" : "new";
    const id = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, service_item_id, scheduled_at, ends_at, address, lat, lng, zone, vehicle_id, notes, created_by)
      values (${user.companyId}, ${number}, ${c.id}, ${b.type}::booking_type, ${b.category}::service_category, ${status}::booking_status, ${service}, ${b.service_item_id}, ${w.start}, ${w.end},
              ${b.address?.trim() || c.address}, ${b.lat ?? c.lat}, ${b.lng ?? c.lng}, ${(b.zone ?? c.zone)}::zone, ${b.vehicle_id}, ${b.notes?.trim() || null}, ${user.id}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, ${status}::booking_status, ${user.id})`;
    if (c.lat == null && b.lat != null) await t`update customers set lat = ${b.lat}, lng = ${b.lng} where id = ${c.id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.create", table: "bookings", rowId: id, new: { number, type: b.type, customer_id: c.id, scheduled_at: w.start, ends_at: w.end }, ip });
    if (b.type === "B") {
      await t`insert into notifications (company_id, user_id, kind, title, body, link)
              select ${user.companyId}, u.id, 'booking.survey', ${number + " · ត្រូវការសិក្សាគម្រោង"}, ${c.name + " · " + service.slice(0, 80)}, ${"/bookings/" + id}
              from users u where u.company_id = ${user.companyId} and u.role = 'gm' and u.is_active`;
    }
    return { id, number, status };
  });
}

const EDITABLE: BookingStatus[] = ["new", "survey", "quoted", "assigned"];

export async function updateBooking(user: SessionUser, ip: string | null, id: string, p: Record<string, unknown>) {
  await tx(user.id, async (t) => {
    const old = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!old) throw notFound();
    if (!EDITABLE.includes(old.status)) throw new AppError("BOOKING_LOCKED", 400);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
    const vehicle = has("vehicle_id") ? ((p.vehicle_id as string) || null) : old.vehicle_id;
    if (has("vehicle_id") && vehicle) await assertVehicle(t, user.companyId, vehicle); // F-M2-01
    const serviceItem = has("service_item_id") ? ((p.service_item_id as string) || null) : old.service_item_id;
    // R3: every edit re-runs the time rules. A changed start keeps the job length unless a new end is given.
    const timeTouched = has("scheduled_at") || has("ends_at") || has("service_item_id");
    let start = old.scheduled_at, end = old.ends_at;
    if (timeTouched) {
      const newStart = has("scheduled_at") ? parseTime(p.scheduled_at as string, "INVALID_VALUE") : old.scheduled_at;
      let newEnd = has("ends_at") ? parseTime(p.ends_at as string, "INVALID_VALUE") : null;
      if (!newEnd && !has("ends_at") && newStart && old.scheduled_at && old.ends_at && !has("service_item_id"))
        newEnd = new Date(newStart.getTime() + (old.ends_at.getTime() - old.scheduled_at.getTime()));
      const w = window(newStart, newEnd, await durationOf(t, user.companyId, serviceItem));
      if (w.start && (has("scheduled_at") && w.start.getTime() !== old.scheduled_at?.getTime())) assertFuture(w.start);
      start = w.start; end = w.end;
    }
    if (start && end && (timeTouched || has("vehicle_id"))) {
      const team = (await t<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${id}`).map((r) => r.user_id);
      await assertTeamFree(t, user.companyId, team, start, end, id);
      if (vehicle) await assertVehicleFree(t, user.companyId, vehicle, start, end, id);
    }
    await t`update bookings set
        service_text = coalesce(${(p.service_text as string) ?? null}, service_text),
        category = coalesce(${(p.category as string) ?? null}::service_category, category),
        service_item_id = ${serviceItem}::uuid,
        scheduled_at = ${start}, ends_at = ${end},
        address = case when ${has("address")} then ${(p.address as string) || null} else address end,
        lat = case when ${has("lat")} then ${(p.lat as number) ?? null} else lat end,
        lng = case when ${has("lng")} then ${(p.lng as number) ?? null} else lng end,
        zone = coalesce(${(p.zone as string) ?? null}::zone, zone),
        vehicle_id = ${vehicle}::uuid,
        notes = case when ${has("notes")} then ${(p.notes as string) || null} else notes end
      where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.update", table: "bookings", rowId: id, old, new: p, ip });
  });
}

// ---------- assign (R1/R2/R3/R5) -------------------------------------------------------------------------
const ASSIGNABLE: BookingStatus[] = ["new", "quoted", "assigned"];

export async function assignBooking(user: SessionUser, ip: string | null, id: string, a: { lead: string | null; assistants: string[]; vehicle_id: string | null; scheduled_at: string; ends_at: string | null }) {
  return tx(user.id, async (t) => {
    const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (!ASSIGNABLE.includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    if (b.type === "B" && user.role === "admin") throw new AppError("FORBIDDEN_TYPE_B", 403); // BR-02
    if (!a.scheduled_at) throw new AppError("SCHEDULE_REQUIRED", 400);
    if (a.lead && a.assistants.includes(a.lead)) throw new AppError("LEAD_IN_ASSISTANTS", 400);
    const team = [...(a.lead ? [a.lead] : []), ...a.assistants];
    if (team.length === 0) throw new AppError("TEAM_REQUIRED", 400); // R5: at least one technician
    const ok = await t<{ id: string }[]>`select id from users where id = any(${t.array(team)}::uuid[]) and company_id = ${user.companyId} and is_active and role in ('tech', 'gm')`;
    if (ok.length !== new Set(team).size) throw new AppError("TECH_NOT_FOUND", 404);
    if (a.vehicle_id) await assertVehicle(t, user.companyId, a.vehicle_id);
    // R3: dispatching always needs a future start; the job length stays unless a new end is given
    const start = parseTime(a.scheduled_at, "INVALID_VALUE")!;
    const keep = b.scheduled_at && b.ends_at ? (b.ends_at.getTime() - b.scheduled_at.getTime()) / 60_000 : await durationOf(t, user.companyId, b.service_item_id);
    const w = window(start, parseTime(a.ends_at, "INVALID_VALUE"), keep);
    assertFuture(w.start!);
    // R2: the server decides — busy technicians / vehicle are refused, whatever the UI showed
    await assertTeamFree(t, user.companyId, team, w.start!, w.end!, id);
    if (a.vehicle_id) await assertVehicleFree(t, user.companyId, a.vehicle_id, w.start!, w.end!, id);
    // old crew out → new time → new crew in (the insert trigger copies the new range onto each row)
    await t`delete from booking_technicians where booking_id = ${id}`;
    await t`update bookings set status = 'assigned', vehicle_id = ${a.vehicle_id}, scheduled_at = ${w.start}, ends_at = ${w.end} where id = ${id}`;
    if (a.lead) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${a.lead}, 'lead')`;
    for (const x of a.assistants) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${x}, 'assistant')`;
    const reason = b.status === "assigned" ? `reassigned:${Math.floor(Date.now() / 1000)}` : "assigned";
    await audit(t, { companyId: user.companyId, userId: user.id, action: b.status === "assigned" ? "booking.reassign" : "booking.assign", table: "bookings", rowId: id, old: { status: b.status },
      new: { lead: a.lead, assistants: a.assistants, vehicle_id: a.vehicle_id, scheduled_at: w.start, ends_at: w.end }, ip });
    await enqueueBookingConfirmed(t, id, reason);
    return { id, status: "assigned" as const, conflicts: [] as unknown[] };
  });
}

// ---------- cancel (R4) ------------------------------------------------------------------------------------
export async function cancelBooking(user: SessionUser, ip: string | null, id: string, reason: string) {
  return tx(user.id, async (t) => {
    const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (!CANCELLABLE_STATUSES.includes(b.status)) throw new AppError("BOOKING_NOT_CANCELLABLE", 400);
    // status → cancelled (never deleted); the exclusion constraints stop counting it → technicians + vehicle are free
    await t`update bookings set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by = ${user.id} where id = ${id}`;
    await t`update booking_status_log set note = ${reason} where id = (select max(id) from booking_status_log where booking_id = ${id} and to_status = 'cancelled')`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.cancel", table: "bookings", rowId: id, old: { status: b.status }, new: { status: "cancelled", reason }, ip });
    await enqueueBookingCancelled(t, id, reason);
    return { id, status: "cancelled" as const };
  });
}
