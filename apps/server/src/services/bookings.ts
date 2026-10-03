// Booking flow (port of v1 create_booking / update_booking / assign_booking / technician_availability) + Booking Rules v1.3:
// R1 availability for the booking's window · R2 server-side blocking (the API is the source of truth, not the UI)
// R3 no start in the past, end time, no overlaps — the exclusion constraints of 0003 are the last line under concurrency
// R4 cancel with a reason · R5 lead technician optional, crew ≥ 1.
// Every function takes companyId + the acting user; technicians only see bookings they are assigned to (D-18).
import { CANCELLABLE_STATUSES, DEFAULT_DURATION_MIN, type BookingStatus, type RescheduleRequester } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { tellCustomerTechnician } from "./customer-notify.js";
import { assertQuoteAccepted } from "./quotes.js";
import { enqueueBookingCancelled, enqueueBookingConfirmed, enqueueBookingRescheduled, notifyUser } from "./telegram.js";

export type BookingRow = Record<string, unknown> & {
  id: string; company_id: string; number: string; status: BookingStatus; type: "A" | "B";
  scheduled_at: Date | null; ends_at: Date | null; vehicle_id: string | null; service_item_id: string | null;
};

/** shared SELECT (same columns as the v1 api.bookings view) */
function baseSelect(db: Db) {
  return db`select b.id, b.company_id, b.number, b.customer_id, c.name as customer_name, c.phones as customer_phones,
         b.type, b.category, b.status, b.service_text, b.service_item_id, b.scheduled_at, b.ends_at, b.address, b.lat, b.lng, b.zone,
         b.vehicle_id, v.code as vehicle_code, b.notes, b.survey_notes, b.surveyed_at, b.parent_booking_id, b.cancel_reason, b.cancelled_at, b.cancelled_by, b.closed_at, b.origin, b.web_status,
         b.created_by, b.created_at, b.updated_at, b.parent_booking_id as warranty_of, pb.number as warranty_of_number,
         ${warrantyJson(db)} as warranty,
         (select json_agg(json_build_object('id', cu.id, 'label', cu.label) order by cu.label) from booking_units bu join customer_units cu on cu.id = bu.unit_id where bu.booking_id = b.id) as units,
         (select json_agg(json_build_object('user_id', t.user_id, 'role', t.role, 'full_name', u.full_name) order by t.role, u.full_name)
            from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as technicians
    from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id left join vehicles v on v.id = b.vehicle_id
      left join bookings pb on pb.id = b.parent_booking_id`;
}

/** FR-1201 · AC-14: 30 days from the closing day (company time zone), last day included; null while the job is open */
export const WARRANTY_DAYS = 30;
export function warrantyJson(db: Db) {
  const closed = db`(b.closed_at at time zone co.timezone)::date`, today = db`(now() at time zone co.timezone)::date`;
  return db`case when b.status = 'closed' and b.closed_at is not null then json_build_object(
    'until', (${closed} + ${WARRANTY_DAYS}::int)::text, 'days_left', greatest(0, (${closed} + ${WARRANTY_DAYS}::int) - ${today}), 'active', ${today} <= ${closed} + ${WARRANTY_DAYS}::int) end`;
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
/** D3: approved leave / absence overlapping [from, to) */
async function awayPeople(t: Db, companyId: string, from: Date, to: Date, ids?: string[]) {
  return t<{ user_id: string; full_name: string; kind: "leave" | "absent"; starts_at: Date; ends_at: Date }[]>`
    select l.user_id, u.full_name, l.kind, l.starts_at, l.ends_at from staff_leaves l join users u on u.id = l.user_id
    where l.company_id = ${companyId} and l.status = 'approved'
      ${ids ? t`and l.user_id = any(${t.array(ids)}::uuid[])` : t``}
      and tstzrange(l.starts_at, l.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
}
async function assertTeamFree(t: Db, companyId: string, team: string[], start: Date, end: Date, exclude: string | null) {
  if (!team.length) return;
  const away = await awayPeople(t, companyId, start, end, team);
  const b = await busyPeople(t, companyId, start, end, exclude, team);
  if (away.length || b.length) throw new AppError("TECH_UNAVAILABLE", 409, { conflicts: [
    ...away.map((x) => ({ user_id: x.user_id, full_name: x.full_name, reason: x.kind === "leave" ? "LEAVE" : "ABSENT", number: null, scheduled_at: x.starts_at, ends_at: x.ends_at })),
    ...b.map((x) => ({ user_id: x.user_id, full_name: x.full_name, reason: "BUSY", number: x.number, scheduled_at: x.scheduled_at, ends_at: x.ends_at })),
  ] });
}

/** R1: who/what is free for [from, to) — assigners only (F-M2-02). Inactive people are never offered. */
export async function availability(user: SessionUser, fromIso: string, toIso: string, exclude: string | null) {
  const from = parseTime(fromIso, "INVALID_VALUE")!, to = parseTime(toIso, "INVALID_VALUE")!;
  if (to.getTime() <= from.getTime()) throw new AppError("END_BEFORE_START", 400);
  const people = await sql<{ id: string; full_name: string; role: string }[]>`select id, full_name, role from users
    where company_id = ${user.companyId} and is_active and role in ('tech', 'gm') order by role desc, full_name`;
  const vehicles = await sql<{ id: string; code: string; plate: string | null }[]>`select id, code, plate from vehicles where company_id = ${user.companyId} and is_active order by code`;
  const bp = await busyPeople(sql, user.companyId, from, to, exclude);
  const away = await awayPeople(sql, user.companyId, from, to);
  const bv = await busyVehicles(sql, user.companyId, from, to, exclude);
  const strip = (b: Busy) => ({ number: b.number, scheduled_at: b.scheduled_at, ends_at: b.ends_at });
  return {
    from, to,
    // D3: approved leave / absence first (LEAVE / ABSENT), then another job (BUSY)
    people: people.map((p) => {
      const busy = bp.filter((b) => b.user_id === p.id).map(strip);
      const off = away.find((a) => a.user_id === p.id);
      const reason = off ? (off.kind === "leave" ? "LEAVE" : "ABSENT") : busy.length ? "BUSY" : null;
      return { user_id: p.id, full_name: p.full_name, role: p.role, available: !reason, reason, busy, away: off ? { kind: off.kind, starts_at: off.starts_at, ends_at: off.ends_at } : null };
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
  warranty_of?: string | null;
  unit_ids?: string[];
};

/** A2: the customer's units this job serves (reminders per unit) — only units of the same customer */
async function setUnits(t: Db, companyId: string, bookingId: string, customerId: string, unitIds: string[]): Promise<void> {
  const ids = [...new Set(unitIds)];
  if (ids.length && (await t`select id from customer_units where id = any(${t.array(ids)}::uuid[]) and company_id = ${companyId} and customer_id = ${customerId} and is_active`).length !== ids.length) throw new AppError("UNIT_NOT_FOUND", 404);
  await t`delete from booking_units where booking_id = ${bookingId}`;
  for (const u of ids) await t`insert into booking_units (booking_id, unit_id) values (${bookingId}, ${u})`;
}

/** the next booking number of the company (BK-0001 …) — one counter for bookings made by the staff and on the website */
export async function nextBookingNumber(t: Db, companyId: string): Promise<string> {
  const no = (await t<{ last_no: number }[]>`insert into booking_counters (company_id, last_no) values (${companyId}, 1)
    on conflict (company_id) do update set last_no = booking_counters.last_no + 1 returning last_no`)[0]!.last_no;
  return `BK-${String(no).padStart(4, "0")}`;
}

export async function createBooking(user: SessionUser, ip: string | null, b: CreateInput) {
  return tx(user.id, async (t) => {
    const c = (await t<{ id: string; name: string; address: string | null; lat: number | null; lng: number | null; zone: string }[]>`
      select id, name, address, lat, lng, zone from customers where id = ${b.customer_id} and company_id = ${user.companyId} and is_active`)[0];
    if (!c) throw new AppError("CUSTOMER_NOT_FOUND", 404);
    const service = b.service_text.trim();
    if (!service) throw new AppError("SERVICE_REQUIRED", 400);
    if (b.warranty_of) { // FR-1201: only for a closed job of the same customer, while the warranty runs
      const o = (await t<{ customer_id: string; status: string; warranty: { active: boolean } | null }[]>`select b.customer_id, b.status, ${warrantyJson(t)} as warranty
        from bookings b join companies co on co.id = b.company_id where b.id = ${b.warranty_of} and b.company_id = ${user.companyId}`)[0];
      if (!o) throw notFound();
      if (o.status !== "closed") throw new AppError("NOT_CLOSED", 400);
      if (o.customer_id !== c.id) throw new AppError("WARRANTY_OTHER_CUSTOMER", 400);
      if (!o.warranty?.active) throw new AppError("WARRANTY_EXPIRED", 400);
    }
    const minutes = await durationOf(t, user.companyId, b.service_item_id);
    const w = window(parseTime(b.scheduled_at, "INVALID_VALUE"), parseTime(b.ends_at, "INVALID_VALUE"), minutes);
    if (!w.start) throw new AppError("SCHEDULE_REQUIRED", 400); // D2: every booking has the agreed appointment time
    assertFuture(w.start);
    if (b.vehicle_id) {
      await assertVehicle(t, user.companyId, b.vehicle_id);
      if (w.start) await assertVehicleFree(t, user.companyId, b.vehicle_id, w.start, w.end!, null);
    }
    const number = await nextBookingNumber(t, user.companyId);
    const status: BookingStatus = b.type === "B" ? "survey" : "new";
    const id = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, service_item_id, scheduled_at, ends_at, address, lat, lng, zone, vehicle_id, notes, created_by, parent_booking_id)
      values (${user.companyId}, ${number}, ${c.id}, ${b.type}::booking_type, ${b.category}::service_category, ${status}::booking_status, ${service}, ${b.service_item_id}, ${w.start}, ${w.end},
              ${b.address?.trim() || c.address}, ${b.lat ?? c.lat}, ${b.lng ?? c.lng}, ${(b.zone ?? c.zone)}::zone, ${b.vehicle_id}, ${b.notes?.trim() || null}, ${user.id}, ${b.warranty_of ?? null}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, ${status}::booking_status, ${user.id})`;
    if (b.unit_ids?.length) await setUnits(t, user.companyId, id, c.id, b.unit_ids);
    if (c.lat == null && b.lat != null) await t`update customers set lat = ${b.lat}, lng = ${b.lng} where id = ${c.id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.create", table: "bookings", rowId: id, new: { number, type: b.type, customer_id: c.id, scheduled_at: w.start, ends_at: w.end }, ip });
    if (b.type === "B") {
      await t`insert into notifications (company_id, user_id, kind, title, body, link)
              select ${user.companyId}, u.id, 'booking.survey', case when u.language = 'en' then ${number + " · Project survey needed"} else ${number + " · ត្រូវការសិក្សាគម្រោង"} end, ${c.name + " · " + service.slice(0, 80)}, ${"/bookings/" + id}
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
    if (has("unit_ids")) await setUnits(t, user.companyId, id, old.customer_id as string, (p.unit_ids as string[]) ?? []);
    // D2: the agreed appointment only moves through reschedule (who asked + why + history)
    if (has("scheduled_at") || has("ends_at")) {
      const sameStart = (p.scheduled_at === undefined || p.scheduled_at === "" ? null : new Date(p.scheduled_at as string).getTime()) === (old.scheduled_at?.getTime() ?? null);
      const sameEnd = !has("ends_at") || (p.ends_at === "" ? null : new Date(p.ends_at as string).getTime()) === (old.ends_at?.getTime() ?? null);
      if (!(has("scheduled_at") ? sameStart : true) || !sameEnd) throw new AppError("USE_RESCHEDULE", 400);
    }
    const start = old.scheduled_at, end = old.ends_at;
    if (start && end && has("vehicle_id") && vehicle) await assertVehicleFree(t, user.companyId, vehicle, start, end, id);
    await t`update bookings set
        service_text = coalesce(${(p.service_text as string) ?? null}, service_text),
        category = coalesce(${(p.category as string) ?? null}::service_category, category),
        service_item_id = ${serviceItem}::uuid,
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

export async function assignBooking(user: SessionUser, ip: string | null, id: string, a: { lead: string | null; assistants: string[]; vehicle_id: string | null; scheduled_at: string | null; ends_at: string | null }) {
  const out = await assignIn(user, ip, id, a);
  if (out.website) await tellCustomerTechnician(id); // D-96: the customer of a website booking hears who is coming
  return { id: out.id, status: out.status, conflicts: out.conflicts };
}
async function assignIn(user: SessionUser, ip: string | null, id: string, a: { lead: string | null; assistants: string[]; vehicle_id: string | null; scheduled_at: string | null; ends_at: string | null }) {
  return tx(user.id, async (t) => {
    const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (!ASSIGNABLE.includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    if (b.type === "B" && user.role === "admin") throw new AppError("FORBIDDEN_TYPE_B", 403); // BR-02
    await assertQuoteAccepted(t, id, b.type);                                                 // BR-02: accepted quote first
    if (!b.scheduled_at || !b.ends_at) throw new AppError("SCHEDULE_REQUIRED", 400);
    // D2: assigning keeps the agreed time — a different time must go through reschedule
    if ((a.scheduled_at && new Date(a.scheduled_at).getTime() !== b.scheduled_at.getTime()) || (a.ends_at && new Date(a.ends_at).getTime() !== b.ends_at.getTime())) throw new AppError("USE_RESCHEDULE", 400);
    if (a.lead && a.assistants.includes(a.lead)) throw new AppError("LEAD_IN_ASSISTANTS", 400);
    const team = [...(a.lead ? [a.lead] : []), ...a.assistants];
    if (team.length === 0) throw new AppError("TEAM_REQUIRED", 400); // R5: at least one technician
    const ok = await t<{ id: string }[]>`select id from users where id = any(${t.array(team)}::uuid[]) and company_id = ${user.companyId} and is_active and role in ('tech', 'gm')`;
    if (ok.length !== new Set(team).size) throw new AppError("TECH_NOT_FOUND", 404);
    if (a.vehicle_id) await assertVehicle(t, user.companyId, a.vehicle_id);
    // R3: dispatching needs a future appointment (an overdue booking is rescheduled first)
    const w = { start: b.scheduled_at, end: b.ends_at };
    assertFuture(w.start);
    // R2: the server decides — busy technicians / vehicle are refused, whatever the UI showed
    await assertTeamFree(t, user.companyId, team, w.start, w.end, id);
    if (a.vehicle_id) await assertVehicleFree(t, user.companyId, a.vehicle_id, w.start, w.end, id);
    // old crew out → new time → new crew in (the insert trigger copies the new range onto each row)
    await t`delete from booking_technicians where booking_id = ${id}`;
    await t`update bookings set status = 'assigned', vehicle_id = ${a.vehicle_id} where id = ${id}`;
    if (a.lead) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${a.lead}, 'lead')`;
    for (const x of a.assistants) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${x}, 'assistant')`;
    const reason = b.status === "assigned" ? `reassigned:${Math.floor(Date.now() / 1000)}` : "assigned";
    await audit(t, { companyId: user.companyId, userId: user.id, action: b.status === "assigned" ? "booking.reassign" : "booking.assign", table: "bookings", rowId: id, old: { status: b.status },
      new: { lead: a.lead, assistants: a.assistants, vehicle_id: a.vehicle_id, scheduled_at: w.start, ends_at: w.end }, ip });
    await enqueueBookingConfirmed(t, id, reason);
    // D-96: sending a technician to a website booking that still waits for an answer IS the confirmation
    if (b.origin === "website" && b.web_status === "pending") await confirmWebBookingIn(t, user.companyId, user.id, id, ip);
    return { id, status: "assigned" as const, conflicts: [] as unknown[], website: b.origin === "website" };
  });
}

/** D-96: a website booking is confirmed — its request is done, and the Telegram chat that holds the booking's link becomes the
 *  customer's own link when the customer has none yet (the staff called the number before confirming). */
export async function confirmWebBookingIn(t: Db, companyId: string, userId: string, bookingId: string, ip: string | null): Promise<void> {
  const b = (await t<{ customer_id: string; web_subscriber_id: string | null }[]>`update bookings set web_status = 'confirmed', web_decided_by = ${userId}, web_decided_at = now()
    where id = ${bookingId} and company_id = ${companyId} and web_status = 'pending' returning customer_id, web_subscriber_id::text`)[0];
  if (!b) return;
  if (b.web_subscriber_id) await t`update customers set tg_subscriber_id = ${b.web_subscriber_id}::bigint where id = ${b.customer_id} and tg_subscriber_id is null`;
  await t`update service_requests set status = 'done', outcome = 'confirmed', handled_by = ${userId}, handled_at = now() where booking_id = ${bookingId} and kind = 'booking' and status = 'new'`;
  await audit(t, { companyId, userId, action: "booking.web_confirm", table: "bookings", rowId: bookingId, new: { web_status: "confirmed" }, ip });
}

// ---------- reschedule (D2) ------------------------------------------------------------------------------
export async function rescheduleBooking(user: SessionUser, ip: string | null, id: string, r: { scheduled_at: string; ends_at: string | null; requested_by: RescheduleRequester | undefined; reason: string }) {
  return tx(user.id, async (t) => {
    const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (!EDITABLE.includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    if (!r.requested_by) throw new AppError("REQUESTER_REQUIRED", 400);
    if (r.reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
    const start = parseTime(r.scheduled_at, "INVALID_VALUE")!;
    const keep = b.scheduled_at && b.ends_at ? (b.ends_at.getTime() - b.scheduled_at.getTime()) / 60_000 : await durationOf(t, user.companyId, b.service_item_id);
    const w = window(start, parseTime(r.ends_at, "INVALID_VALUE"), keep);
    assertFuture(w.start!);
    if (w.start!.getTime() === b.scheduled_at?.getTime() && w.end!.getTime() === b.ends_at?.getTime()) throw new AppError("SAME_TIME", 400);
    // every availability rule again: crew (jobs + leave/absence) and vehicle
    const team = (await t<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${id}`).map((x) => x.user_id);
    await assertTeamFree(t, user.companyId, team, w.start!, w.end!, id);
    if (b.vehicle_id) await assertVehicleFree(t, user.companyId, b.vehicle_id, w.start!, w.end!, id);
    await t`update bookings set scheduled_at = ${w.start}, ends_at = ${w.end}, late_alerted_at = null where id = ${id}`;
    await t`insert into booking_reschedules (booking_id, company_id, old_start, old_end, new_start, new_end, requested_by, reason, by_user)
      values (${id}, ${user.companyId}, ${b.scheduled_at}, ${b.ends_at}, ${w.start}, ${w.end}, ${r.requested_by}::reschedule_requester, ${r.reason.trim()}, ${user.id})`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.reschedule", table: "bookings", rowId: id,
      old: { scheduled_at: b.scheduled_at, ends_at: b.ends_at }, new: { scheduled_at: w.start, ends_at: w.end, requested_by: r.requested_by, reason: r.reason.trim() }, ip });
    if (team.length) await enqueueBookingRescheduled(t, id, { oldStart: b.scheduled_at, requestedBy: r.requested_by, reason: r.reason.trim() });
    return { id, scheduled_at: w.start, ends_at: w.end };
  });
}

export async function rescheduleHistory(user: SessionUser, id: string) {
  await getBooking(user, id); // visibility (technicians: own bookings only)
  return sql`select r.id, r.old_start, r.old_end, r.new_start, r.new_end, r.requested_by, r.reason, r.at, u.full_name as by_name
    from booking_reschedules r left join users u on u.id = r.by_user where r.booking_id = ${id} order by r.at, r.id`;
}

// ---------- cancel (R4) ------------------------------------------------------------------------------------
export async function cancelBooking(user: SessionUser, ip: string | null, id: string, reason: string) {
  return tx(user.id, (t) => cancelBookingIn(t, { companyId: user.companyId, userId: user.id, name: { km: user.fullName, en: user.fullName } }, ip, id, reason));
}

/** who cancels: a staff member, or (D-96, customer home) the customer — then userId is null and Admin + GM are told as well */
export type CancelActor = { companyId: string; userId: string | null; name: { km: string; en: string } };
export async function cancelBookingIn(t: Db, actor: CancelActor, ip: string | null, id: string, reason: string) {
  const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${actor.companyId} for update`)[0];
  if (!b) throw notFound();
  if (!CANCELLABLE_STATUSES.includes(b.status)) throw new AppError("BOOKING_NOT_CANCELLABLE", 400);
  // status → cancelled (never deleted); the exclusion constraints stop counting it → technicians + vehicle are free
  await t`update bookings set status = 'cancelled', cancel_reason = ${reason}, cancelled_at = now(), cancelled_by = ${actor.userId} where id = ${id}`;
  await t`update booking_status_log set note = ${reason} where id = (select max(id) from booking_status_log where booking_id = ${id} and to_status = 'cancelled')`;
  // D-96: a website booking the staff cancel before answering = declined; open requests about this booking are closed with it
  if (b.origin === "website" && b.web_status === "pending" && actor.userId) await t`update bookings set web_status = 'declined', web_decided_by = ${actor.userId}, web_decided_at = now() where id = ${id}`;
  await t`update service_requests set status = 'done', outcome = case when kind = 'booking' and ${actor.userId !== null} then 'declined' when kind = 'reschedule' then 'rejected' else outcome end,
      note = coalesce(note, ${reason.slice(0, 300)}), handled_by = ${actor.userId}, handled_at = now() where booking_id = ${id} and status = 'new'`;
  await audit(t, { companyId: actor.companyId, userId: actor.userId, action: "booking.cancel", source: actor.userId ? "app" : "system", table: "bookings", rowId: id, old: { status: b.status }, new: { status: "cancelled", reason }, ip });
  await enqueueBookingCancelled(t, id, reason);
  // BR-21 · FR-1002: CEO + CFO hear about every deletion (never the person who did it); a customer's own cancellation also reaches Admin + GM
  const cname = (await t<{ name: string }[]>`select name from customers where id = ${b.customer_id as string}`)[0]?.name ?? "";
  const roles = actor.userId ? ["ceo", "cfo"] : ["ceo", "cfo", "admin", "gm"];
  for (const u of await t<{ id: string }[]>`select id from users where company_id = ${actor.companyId} and is_active and role::text = any(${t.array(roles)}) and id::text <> ${actor.userId ?? ""}`)
    await notifyUser(t, actor.companyId, u.id, "booking.cancelled", { km: `❌ លុបចោលការងារ · ${b.number}`, en: `❌ Booking cancelled · ${b.number}` }, { km: `👤 ${cname}\nដោយ ${actor.name.km}\n📝 ${reason}`, en: `👤 ${cname}\nby ${actor.name.en}\n📝 ${reason}` }, `/bookings/${id}`, `cancel-boss:${id}:${u.id}`);
  return { id, status: "cancelled" as const };
}
