// Booking flow (port of v1 create_booking / update_booking / assign_booking / technician_availability) + Booking Rules v1.3:
// R1 availability for the booking's window · R2 server-side blocking (the API is the source of truth, not the UI)
// R3 no start in the past, end time, no overlaps — the exclusion constraints of 0003 are the last line under concurrency
// R4 cancel with a reason · R5 lead technician optional, crew ≥ 1.
// Every function takes companyId + the acting user; technicians only see bookings they are assigned to (D-18).
import { CANCELLABLE_STATUSES, customerText, DEFAULT_DURATION_MIN, type BookingStatus, type RescheduleRequester } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { issueInitialPassword } from "./customer-auth.js";
import { btn, row, tellSubscriber } from "./customer-bot.js";
import { assertQuoteAccepted } from "./quotes.js";
import { enqueueBookingCancelled, enqueueBookingConfirmed, enqueueBookingRescheduled, notifyUser } from "./telegram.js";
import { seesTests, testTitle } from "./test-mode.js";

export type BookingRow = Record<string, unknown> & {
  id: string; company_id: string; number: string; status: BookingStatus; type: "A" | "B";
  scheduled_at: Date | null; ends_at: Date | null; vehicle_id: string | null; service_item_id: string | null;
};

/** shared SELECT (same columns as the v1 api.bookings view) */
function baseSelect(db: Db) {
  return db`select b.id, b.company_id, b.number, b.customer_id, c.name as customer_name, c.phones as customer_phones,
         b.type, b.category, b.status, b.service_text, b.service_item_id, b.scheduled_at, b.ends_at, b.address, b.lat, b.lng, b.zone,
         b.vehicle_id, v.code as vehicle_code, b.notes, b.survey_notes, b.surveyed_at, b.parent_booking_id, b.cancel_reason, b.cancelled_at, b.cancelled_by, b.closed_at, b.origin, b.web_status, b.is_test, b.web_lines,
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
/** D-120: test bookings are listed for the CEO only */
const testFilter = (db: Db, user: SessionUser) => (seesTests(user) ? db`` : db`and not b.is_test`);

export async function listBookings(user: SessionUser, o: { statuses?: BookingStatus[]; from?: string; to?: string; limit?: number }) {
  return sql`${baseSelect(sql)}
    where b.company_id = ${user.companyId} ${techFilter(sql, user)} ${testFilter(sql, user)}
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
/** D-157 (owner 21-10): the staff may write a start that has passed — an appointment agreed by phone and already done; a booking
 *  set in the past raises no late alert (see lateAlerts: created after its start, or late_alerted_at set when moved there).
 *  Customers on the website keep their own rule (slots from now + WEB_LEAD_MIN). */
function assertFuture(_start: Date): void { /* allowed since D-157 */ }
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
/** D-139: the busy window ends at the earliest of the planned end, the actual finish and a release (ends_at = that end); the state
 *  says what staff see: finished (at finished_at), in progress (checked in, no finish — never overridden) or simply booked */
type Busy = { booking_id: string; number: string; scheduled_at: Date; ends_at: Date; planned_end: Date; finished_at: Date | null; state: "finished" | "in_progress" | "booked" };
const BUSY_STATE = (t: Db) => t`case when b.finished_at is not null then 'finished' when b.status in ('on_site', 'working') then 'in_progress' else 'booked' end`;

/** technicians (active tech/gm) on another non-cancelled booking whose busy window overlaps [from, to) */
async function busyPeople(t: Db, companyId: string, from: Date, to: Date, exclude: string | null, ids?: string[]) {
  return t<(Busy & { user_id: string; full_name: string })[]>`
    select bt.user_id, u.full_name, b.id as booking_id, b.number, b.scheduled_at, upper(bt.during) as ends_at, b.ends_at as planned_end, b.finished_at, ${BUSY_STATE(t)} as state
    from booking_technicians bt join bookings b on b.id = bt.booking_id join users u on u.id = bt.user_id
    where b.company_id = ${companyId} and bt.blocking and bt.during is not null and not isempty(bt.during)
      ${exclude ? t`and b.id <> ${exclude}` : t``}
      ${ids ? t`and bt.user_id = any(${t.array(ids)}::uuid[])` : t``}
      and bt.during && tstzrange(${from}, ${to}, '[)')
    order by b.scheduled_at`;
}
async function busyVehicles(t: Db, companyId: string, from: Date, to: Date, exclude: string | null, vehicleId?: string) {
  return t<(Busy & { vehicle_id: string; code: string })[]>`
    select b.vehicle_id, v.code, b.id as booking_id, b.number, b.scheduled_at, upper(booking_busy_range(b.scheduled_at, b.ends_at, b.finished_at, null)) as ends_at,
      b.ends_at as planned_end, b.finished_at, ${BUSY_STATE(t)} as state
    from bookings b join vehicles v on v.id = b.vehicle_id
    where b.company_id = ${companyId} and b.status <> 'cancelled' and b.scheduled_at is not null
      ${exclude ? t`and b.id <> ${exclude}` : t``}
      ${vehicleId ? t`and b.vehicle_id = ${vehicleId}` : t``}
      and not isempty(booking_busy_range(b.scheduled_at, b.ends_at, b.finished_at, null))
      and booking_busy_range(b.scheduled_at, b.ends_at, b.finished_at, null) && tstzrange(${from}, ${to}, '[)')
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
/** D-140 F: work added on site makes the job longer — up to the next job of a crew member or of the vehicle (the overlap rules
 *  never break); what does not fit comes back as the clash so Admin / GM move or reassign that next job */
export async function extendJob(t: Db, companyId: string, id: string, minutes: number): Promise<{ ends_at: Date | null; wanted: Date | null; clash: { booking_id: string; number: string; scheduled_at: Date; who: string } | null }> {
  const b = (await t<{ scheduled_at: Date | null; ends_at: Date | null; vehicle_id: string | null }[]>`select scheduled_at, ends_at, vehicle_id from bookings where id = ${id} and company_id = ${companyId} for update`)[0];
  if (!b?.scheduled_at || !b.ends_at || minutes <= 0) return { ends_at: b?.ends_at ?? null, wanted: null, clash: null };
  const wanted = new Date(b.ends_at.getTime() + minutes * 60_000);
  const team = (await t<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${id}`).map((x) => x.user_id);
  const people = team.length ? await busyPeople(t, companyId, b.ends_at, wanted, id, team) : [];
  const cars = b.vehicle_id ? await busyVehicles(t, companyId, b.ends_at, wanted, id, b.vehicle_id) : [];
  const clash = [...people.map((p) => ({ booking_id: p.booking_id, number: p.number, scheduled_at: p.scheduled_at, who: p.full_name })),
    ...cars.map((c) => ({ booking_id: c.booking_id, number: c.number, scheduled_at: c.scheduled_at, who: c.code }))].sort((x, y) => x.scheduled_at.getTime() - y.scheduled_at.getTime())[0] ?? null;
  const end = clash ? new Date(Math.max(b.ends_at.getTime(), Math.min(wanted.getTime(), clash.scheduled_at.getTime()))) : wanted;
  if (end.getTime() !== b.ends_at.getTime()) await t`update bookings set ends_at = ${end} where id = ${id}`;
  return { ends_at: end, wanted, clash };
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
    ...b.map((x) => ({ user_id: x.user_id, full_name: x.full_name, reason: "BUSY", number: x.number, scheduled_at: x.scheduled_at, ends_at: x.ends_at, state: x.state, finished_at: x.finished_at })),
  ] });
}

/** D-139: Admin / GM confirm «ជាងនេះបញ្ចប់ការងារមុនហើយ» (with a reason) for a technician busy on an EARLIER job → that job stops
 *  holding him at this job's start (released_at, audited). Never for leave / absence, a later job, or a job he is on right now
 *  (checked in, no finish: finish it first — «បញ្ចប់ជំនួសជាង»). */
async function releaseForOverride(t: Db, user: SessionUser, ip: string | null, forBooking: { id: string; number: string }, start: Date, end: Date,
  o: { user_id: string; reason: string }): Promise<void> {
  if (o.reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
  if ((await awayPeople(t, user.companyId, start, end, [o.user_id])).length) throw new AppError("TECH_UNAVAILABLE", 409);
  const busy = await busyPeople(t, user.companyId, start, end, forBooking.id, [o.user_id]);
  const conflicts = busy.map((x) => ({ user_id: x.user_id, full_name: x.full_name, reason: "BUSY", number: x.number, scheduled_at: x.scheduled_at, ends_at: x.ends_at, state: x.state, finished_at: x.finished_at }));
  if (busy.some((x) => x.state === "in_progress")) throw new AppError("TECH_IN_PROGRESS", 409, { conflicts });
  if (busy.some((x) => x.scheduled_at.getTime() >= start.getTime())) throw new AppError("TECH_UNAVAILABLE", 409, { conflicts }); // only an earlier job can be «finished early»
  for (const x of busy) {
    await t`update booking_technicians set released_at = ${start} where booking_id = ${x.booking_id} and user_id = ${o.user_id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.release", table: "bookings", rowId: x.booking_id,
      old: { ends_at: x.ends_at }, new: { user_id: o.user_id, released_at: start, reason: o.reason.trim(), for_booking: forBooking.number }, ip });
  }
}

/** R1: who/what is free for [from, to) — assigners only (F-M2-02). Inactive people are never offered. */
export async function availability(user: SessionUser, fromIso: string, toIso: string, exclude: string | null) {
  const from = parseTime(fromIso, "INVALID_VALUE")!, to = parseTime(toIso, "INVALID_VALUE")!;
  if (to.getTime() <= from.getTime()) throw new AppError("END_BEFORE_START", 400);
  const people = await sql<{ id: string; full_name: string; role: string }[]>`select id, full_name, role from users
    where company_id = ${user.companyId} and is_active and role = 'tech' order by full_name`;
  const vehicles = await sql<{ id: string; code: string; plate: string | null }[]>`select id, code, plate from vehicles where company_id = ${user.companyId} and is_active order by code`;
  const bp = await busyPeople(sql, user.companyId, from, to, exclude);
  const away = await awayPeople(sql, user.companyId, from, to);
  const bv = await busyVehicles(sql, user.companyId, from, to, exclude);
  const strip = (b: Busy) => ({ booking_id: b.booking_id, number: b.number, scheduled_at: b.scheduled_at, ends_at: b.ends_at, finished_at: b.finished_at, state: b.state });
  return {
    from, to,
    // D3: approved leave / absence first (LEAVE / ABSENT), then another job (BUSY)
    people: people.map((p) => {
      const busy = bp.filter((b) => b.user_id === p.id).map(strip);
      const off = away.find((a) => a.user_id === p.id);
      const reason = off ? (off.kind === "leave" ? "LEAVE" : "ABSENT") : busy.length ? "BUSY" : null;
      // D-139: Admin / GM may confirm he finished an EARLIER job early (not one he is on right now, not leave)
      const can_override = reason === "BUSY" && busy.every((b) => b.state !== "in_progress" && b.scheduled_at.getTime() < from.getTime());
      return { user_id: p.id, full_name: p.full_name, role: p.role, available: !reason, reason, busy, can_override, away: off ? { kind: off.kind, starts_at: off.starts_at, ends_at: off.ends_at } : null };
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
  /** D-140: the service lines (catalog service + quantity) */
  lines?: { item_id: string; qty: number }[];
};

/** D-140: a job's service lines — stored like a website booking's (web_lines): name, quantity, length; the job length = their sum */
export type JobLine = { id: string; code: string | null; name_km: string; name_en: string | null; qty: number; minutes: number; from_price: number | null; quote_only: boolean };
export async function resolveJobLines(t: Db, companyId: string, lines: { item_id: string; qty: number }[]): Promise<(JobLine & { category: string })[]> {
  const ids = [...new Set(lines.map((l) => l.item_id))];
  const items = new Map((await t<(Omit<JobLine, "qty" | "minutes"> & { duration_min: number; category: string })[]>`select id, code, name_km, name_en, duration_min, from_price, quote_only, category::text as category
    from catalog_items where company_id = ${companyId} and kind = 'service' and is_active and id = any(${t.array(ids)}::uuid[])`).map((i) => [i.id, i]));
  return lines.map((l) => {
    const i = items.get(l.item_id);
    if (!i) throw new AppError("SERVICE_NOT_FOUND", 404);
    return { id: i.id, code: i.code, name_km: i.name_km, name_en: i.name_en, qty: l.qty, minutes: i.duration_min, from_price: i.from_price, quote_only: i.quote_only, category: i.category };
  });
}
export const jobLinesText = (lines: Pick<JobLine, "name_km" | "qty">[]) => lines.map((l) => (l.qty > 1 ? `${l.name_km} ×${l.qty}` : l.name_km)).join(" · ");
const storedLines = (lines: (JobLine & { category?: string })[]): JobLine[] => lines.map((l) => ({ id: l.id, code: l.code, name_km: l.name_km, name_en: l.name_en, qty: l.qty, minutes: l.minutes, from_price: l.from_price, quote_only: l.quote_only }));

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
    const lines = b.lines?.length ? await resolveJobLines(t, user.companyId, b.lines) : null; // D-140
    const service = b.service_text.trim() || (lines ? jobLinesText(lines) : "");
    if (!service) throw new AppError("SERVICE_REQUIRED", 400);
    const serviceItemId = lines ? lines[0]!.id : b.service_item_id;
    if (b.warranty_of) { // FR-1201: only for a closed job of the same customer, while the warranty runs
      const o = (await t<{ customer_id: string; status: string; warranty: { active: boolean } | null }[]>`select b.customer_id, b.status, ${warrantyJson(t)} as warranty
        from bookings b join companies co on co.id = b.company_id where b.id = ${b.warranty_of} and b.company_id = ${user.companyId}`)[0];
      if (!o) throw notFound();
      if (o.status !== "closed") throw new AppError("NOT_CLOSED", 400);
      if (o.customer_id !== c.id) throw new AppError("WARRANTY_OTHER_CUSTOMER", 400);
      if (!o.warranty?.active) throw new AppError("WARRANTY_EXPIRED", 400);
    }
    const minutes = lines ? lines.reduce((s, l) => s + l.minutes, 0) : await durationOf(t, user.companyId, b.service_item_id);
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
      values (${user.companyId}, ${number}, ${c.id}, ${b.type}::booking_type, ${b.category}::service_category, ${status}::booking_status, ${service}, ${serviceItemId}, ${w.start}, ${w.end},
              ${b.address?.trim() || c.address}, ${b.lat ?? c.lat}, ${b.lng ?? c.lng}, ${(b.zone ?? c.zone)}::zone, ${b.vehicle_id}, ${b.notes?.trim() || null}, ${user.id}, ${b.warranty_of ?? null}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, ${status}::booking_status, ${user.id})`;
    if (lines) await t`update bookings set web_lines = ${t.json(storedLines(lines) as never)} where id = ${id}`;
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

export type AssignInput = { lead: string | null; assistants: string[]; vehicle_id: string | null; scheduled_at: string | null; ends_at: string | null;
  /** D-139: busy technicians Admin / GM confirmed as «finished the earlier job early» — with the reason */
  overrides?: { user_id: string; reason: string }[] };
export async function assignBooking(user: SessionUser, ip: string | null, id: string, a: AssignInput) {
  const out = await tx(user.id, (t) => assignWithin(t, user, ip, id, a));
  if (out.account) await tellSubscriber(out.account.subscriber, { text: customerText.password(out.account.password), hint: customerText.hint, buttons: row(btn.login()) }); // the customer record was linked just now
  return { id: out.id, status: out.status, conflicts: out.conflicts };
}
/** the assignment inside the caller's transaction — also «confirm» of a website request (CEO 04-10: confirm = confirmed + assigned) */
export async function assignWithin(t: Db, user: SessionUser, ip: string | null, id: string, a: AssignInput) {
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
  const ok = await t<{ id: string }[]>`select id from users where id = any(${t.array(team)}::uuid[]) and company_id = ${user.companyId} and is_active and role = 'tech'`; // CEO 04-10: technicians only — never GM, Admin, CEO, CFO
  if (ok.length !== new Set(team).size) throw new AppError("TECH_NOT_FOUND", 404);
  if (a.vehicle_id) await assertVehicle(t, user.companyId, a.vehicle_id);
  // R3: dispatching needs a future appointment (an overdue booking is rescheduled first)
  const w = { start: b.scheduled_at, end: b.ends_at };
  assertFuture(w.start);
  // R2: the server decides — busy technicians / vehicle are refused, whatever the UI showed
  for (const o of a.overrides ?? []) if (team.includes(o.user_id)) await releaseForOverride(t, user, ip, { id, number: b.number }, w.start, w.end, o); // D-139
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
  const account = b.origin === "website" && b.web_status === "pending" ? await confirmWebBookingIn(t, user.companyId, user.id, id, ip) : null;
  return { id, status: "assigned" as const, conflicts: [] as unknown[], account };
}

/** D-96: a website booking is confirmed — its request is done, and the Telegram chat that holds the booking's link becomes the
 *  customer's own link when the customer has none yet (the staff called the number before confirming). A record linked here gets
 *  its first password (D-103): returned so the caller sends it to that chat AFTER the transaction — never stored in plain. */
export async function confirmWebBookingIn(t: Db, companyId: string, userId: string, bookingId: string, ip: string | null): Promise<{ subscriber: number; password: string } | null> {
  const b = (await t<{ customer_id: string; web_subscriber_id: string | null }[]>`update bookings set web_status = 'confirmed', web_decided_by = ${userId}, web_decided_at = now()
    where id = ${bookingId} and company_id = ${companyId} and web_status = 'pending' returning customer_id, web_subscriber_id::text`)[0];
  if (!b) return null;
  const linked = b.web_subscriber_id ? (await t`update customers set tg_subscriber_id = ${b.web_subscriber_id}::bigint where id = ${b.customer_id} and tg_subscriber_id is null returning id`).length > 0 : false;
  await t`update service_requests set status = 'done', outcome = 'confirmed', handled_by = ${userId}, handled_at = now() where booking_id = ${bookingId} and kind = 'booking' and status = 'new'`;
  await audit(t, { companyId, userId, action: "booking.web_confirm", table: "bookings", rowId: bookingId, new: { web_status: "confirmed" }, ip });
  const password = linked ? await issueInitialPassword(t, b.customer_id) : null;
  return password ? { subscriber: Number(b.web_subscriber_id), password } : null;
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
    await t`update bookings set scheduled_at = ${w.start}, ends_at = ${w.end}, late_alerted_at = case when ${w.start} < now() then now() else null end where id = ${id}`; // D-157: moved into the past → no late alert
    await t`update booking_technicians set released_at = null where booking_id = ${id} and released_at is not null`; // D-139: a release was for the old time
    await t`insert into booking_reschedules (booking_id, company_id, old_start, old_end, new_start, new_end, requested_by, reason, by_user)
      values (${id}, ${user.companyId}, ${b.scheduled_at}, ${b.ends_at}, ${w.start}, ${w.end}, ${r.requested_by}::reschedule_requester, ${r.reason.trim()}, ${user.id})`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.reschedule", table: "bookings", rowId: id,
      old: { scheduled_at: b.scheduled_at, ends_at: b.ends_at }, new: { scheduled_at: w.start, ends_at: w.end, requested_by: r.requested_by, reason: r.reason.trim() }, ip });
    if (team.length) await enqueueBookingRescheduled(t, id, { oldStart: b.scheduled_at, requestedBy: r.requested_by, reason: r.reason.trim() });
    return { id, scheduled_at: w.start, ends_at: w.end };
  });
}

// ---------- edit everything in one save (D-140) --------------------------------------------------------------
export type EditInput = {
  customer_id?: string; category?: string; service_text?: string; lines?: { item_id: string; qty: number }[];
  scheduled_at?: string; ends_at?: string; requested_by?: RescheduleRequester; reason?: string;
  address?: string | null; lat?: number | null; lng?: number | null; zone?: string;
  team?: { lead: string | null; assistants: string[]; overrides?: { user_id: string; reason: string }[] };
  vehicle_id?: string | null; notes?: string | null; unit_ids?: string[]; confirm_in_progress?: boolean;
};
const IN_PROGRESS: BookingStatus[] = ["en_route", "on_site", "working"];
const FINISHED: BookingStatus[] = ["work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];

/** D-140: the «កែ» screen saves customer, service lines, time, place, crew + lead, vehicle, units and note at once. Only the fields
 *  that really changed count. A new time follows the reschedule rules in the same save (who asked + reason, future start, crew +
 *  vehicle free, history, technicians + customer told); a new crew follows the assign rules (busy refused, «finished early»
 *  overrides). Locks: cancelled = nothing · finished = the note only (prices then go through the invoice) · in progress = time /
 *  crew / vehicle only with confirm_in_progress · the customer only before the job starts. Every changed field is audited old → new. */
export async function editBooking(user: SessionUser, ip: string | null, id: string, e: EditInput, canAssign: boolean) {
  const out = await tx(user.id, async (t) => {
    const b = (await t<(BookingRow & { customer_id: string; category: string; service_text: string; address: string | null; lat: number | null; lng: number | null; zone: string; notes: string | null;
      web_lines: (JobLine & { id: string })[] | null })[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (b.status === "cancelled") throw new AppError("BOOKING_LOCKED", 400);
    const crew = await t<{ user_id: string; role: string }[]>`select user_id, role::text as role from booking_technicians where booking_id = ${id}`;
    const units = (await t<{ unit_id: string }[]>`select unit_id from booking_units where booking_id = ${id}`).map((x) => x.unit_id);
    const same = (a: unknown, c: unknown) => JSON.stringify(a ?? null) === JSON.stringify(c ?? null);
    const sorted = (x: string[]) => [...new Set(x)].sort();
    const oldLead = crew.find((x) => x.role === "lead")?.user_id ?? null, oldHelp = sorted(crew.filter((x) => x.role !== "lead").map((x) => x.user_id));
    const oldLines = (b.web_lines ?? (b.service_item_id ? [{ id: b.service_item_id, qty: 1 }] : [])).map((l) => ({ id: l.id, qty: l.qty }));

    // what changed
    const start = e.scheduled_at !== undefined ? parseTime(e.scheduled_at, "INVALID_VALUE") : b.scheduled_at;
    if (e.scheduled_at !== undefined && !start) throw new AppError("SCHEDULE_REQUIRED", 400);
    const endIn = e.ends_at !== undefined ? parseTime(e.ends_at, "INVALID_VALUE") : null;
    const timeChanged = (e.scheduled_at !== undefined && start!.getTime() !== b.scheduled_at?.getTime()) || (endIn != null && endIn.getTime() !== b.ends_at?.getTime());
    const lead = e.team ? e.team.lead || null : oldLead, help = e.team ? sorted(e.team.assistants) : oldHelp;
    const teamChanged = !!e.team && (lead !== oldLead || !same(help, oldHelp));
    const vehicle = e.vehicle_id !== undefined ? e.vehicle_id || null : b.vehicle_id;
    const vehicleChanged = vehicle !== b.vehicle_id;
    const customerChanged = !!e.customer_id && e.customer_id !== b.customer_id;
    const linesChanged = !!e.lines?.length && !same(e.lines.map((l) => ({ id: l.item_id, qty: l.qty })), oldLines);
    const text = e.service_text?.trim();
    const textChanged = text !== undefined && text !== "" && text !== b.service_text;
    const categoryChanged = !!e.category && e.category !== b.category;
    const addressChanged = e.address !== undefined && (e.address?.trim() || null) !== b.address;
    const latChanged = (e.lat !== undefined && (e.lat ?? null) !== b.lat) || (e.lng !== undefined && (e.lng ?? null) !== b.lng);
    const zoneChanged = !!e.zone && e.zone !== b.zone;
    const notesChanged = e.notes !== undefined && (e.notes?.trim() || null) !== b.notes;
    const unitsChanged = !!e.unit_ids && !same(sorted(e.unit_ids), sorted(units));
    const any = timeChanged || teamChanged || vehicleChanged || customerChanged || linesChanged || textChanged || categoryChanged || addressChanged || latChanged || zoneChanged || unitsChanged;

    // locks
    if (FINISHED.includes(b.status) && any) throw new AppError("FINISHED_NOTE_ONLY", 400);
    if (IN_PROGRESS.includes(b.status) && (timeChanged || teamChanged || vehicleChanged) && !e.confirm_in_progress) throw new AppError("IN_PROGRESS_CONFIRM", 409);
    if (customerChanged && !EDITABLE.includes(b.status)) throw new AppError("CUSTOMER_LOCKED", 400);
    if (teamChanged && !canAssign) throw new AppError("FORBIDDEN", 403);
    if (!any && !notesChanged) return { id, changed: [] as string[], rescheduled: false, account: null };

    const oldV: Record<string, unknown> = {}, newV: Record<string, unknown> = {};
    const note = (k: string, o: unknown, n: unknown) => { oldV[k] = o ?? null; newV[k] = n ?? null; };

    // customer (+ its place when the screen kept the old one)
    let customerId = b.customer_id;
    if (customerChanged) {
      const c = (await t<{ id: string; address: string | null; lat: number | null; lng: number | null; zone: string }[]>`select id, address, lat, lng, zone::text as zone from customers
        where id = ${e.customer_id!} and company_id = ${user.companyId} and is_active`)[0];
      if (!c) throw new AppError("CUSTOMER_NOT_FOUND", 404);
      note("customer_id", b.customer_id, c.id);
      customerId = c.id;
      await t`update bookings set customer_id = ${c.id} where id = ${id}`;
      if (e.address === undefined) await t`update bookings set address = ${c.address}, lat = ${c.lat}, lng = ${c.lng}, zone = ${c.zone}::zone where id = ${id}`;
      if (!e.unit_ids) await t`delete from booking_units where booking_id = ${id}`; // the old customer's units never follow
    }

    // service lines → length hint, first item, text, category
    if (linesChanged) {
      const lines = await resolveJobLines(t, user.companyId, e.lines!);
      note("lines", oldLines, lines.map((l) => ({ id: l.id, qty: l.qty })));
      await t`update bookings set web_lines = ${t.json(storedLines(lines) as never)}, service_item_id = ${lines[0]!.id},
        service_text = ${textChanged ? text! : jobLinesText(lines)}, category = ${(e.category ?? lines[0]!.category)}::service_category where id = ${id}`;
      if (!textChanged) note("service_text", b.service_text, jobLinesText(lines));
      if (!categoryChanged && lines[0]!.category !== b.category) note("category", b.category, lines[0]!.category);
    }
    if (textChanged) { note("service_text", b.service_text, text); await t`update bookings set service_text = ${text!} where id = ${id}`; }
    if (categoryChanged) { note("category", b.category, e.category); await t`update bookings set category = ${e.category!}::service_category where id = ${id}`; }
    if (addressChanged) { note("address", b.address, e.address?.trim() || null); await t`update bookings set address = ${e.address?.trim() || null} where id = ${id}`; }
    if (latChanged) { note("lat", b.lat, e.lat ?? null); note("lng", b.lng, e.lng ?? null); await t`update bookings set lat = ${e.lat ?? null}, lng = ${e.lng ?? null} where id = ${id}`; }
    if (zoneChanged) { note("zone", b.zone, e.zone); await t`update bookings set zone = ${e.zone!}::zone where id = ${id}`; }
    if (notesChanged) { note("notes", b.notes, e.notes?.trim() || null); await t`update bookings set notes = ${e.notes?.trim() || null} where id = ${id}`; }
    if (unitsChanged) { note("unit_ids", sorted(units), sorted(e.unit_ids!)); await setUnits(t, user.companyId, id, customerId, e.unit_ids!); }

    // time + crew + vehicle: every check first, then the writes in an order the overlap rules of the database accept (old crew out
    // before the new time, the new vehicle before the new time, the new crew last)
    let w = { start: b.scheduled_at, end: b.ends_at };
    if (timeChanged) {
      if (!e.requested_by) throw new AppError("REQUESTER_REQUIRED", 400);
      if ((e.reason ?? "").trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
      const keep = b.scheduled_at && b.ends_at ? (b.ends_at.getTime() - b.scheduled_at.getTime()) / 60_000 : await durationOf(t, user.companyId, b.service_item_id);
      const nw = window(start, endIn ?? (e.scheduled_at === undefined ? b.ends_at : null), keep);
      if (start!.getTime() !== b.scheduled_at?.getTime()) assertFuture(nw.start!);
      w = nw;
      note("scheduled_at", b.scheduled_at, w.start); note("ends_at", b.ends_at, w.end);
    }
    const oldTeam = crew.map((x) => x.user_id);
    if (teamChanged) {
      note("lead", oldLead, lead); note("assistants", oldHelp, help);
      if (EDITABLE.includes(b.status) && !ASSIGNABLE.includes(b.status)) throw new AppError("BOOKING_LOCKED", 400); // a survey is assigned after its quote
      await t`delete from booking_technicians where booking_id = ${id}`;
    } else if (timeChanged && oldTeam.length && w.start && w.end) {
      for (const o of e.team?.overrides ?? []) if (oldTeam.includes(o.user_id)) await releaseForOverride(t, user, ip, { id, number: b.number }, w.start, w.end, o);
      await assertTeamFree(t, user.companyId, oldTeam, w.start, w.end, id);
    }
    if (vehicleChanged || timeChanged) {
      if (vehicleChanged && vehicle) await assertVehicle(t, user.companyId, vehicle);
      if (vehicle && w.start && w.end) await assertVehicleFree(t, user.companyId, vehicle, w.start, w.end, id);
      if (vehicleChanged) { note("vehicle_id", b.vehicle_id, vehicle); await t`update bookings set vehicle_id = ${vehicle} where id = ${id}`; }
    }
    if (timeChanged) {
      await t`update bookings set scheduled_at = ${w.start}, ends_at = ${w.end}, late_alerted_at = case when ${w.start} < now() then now() else null end where id = ${id}`; // D-157: moved into the past → no late alert
      await t`update booking_technicians set released_at = null where booking_id = ${id} and released_at is not null`; // D-139: a release was for the old time
      await t`insert into booking_reschedules (booking_id, company_id, old_start, old_end, new_start, new_end, requested_by, reason, by_user)
        values (${id}, ${user.companyId}, ${b.scheduled_at}, ${b.ends_at}, ${w.start}, ${w.end}, ${e.requested_by!}::reschedule_requester, ${e.reason!.trim()}, ${user.id})`;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.reschedule", table: "bookings", rowId: id,
        old: { scheduled_at: b.scheduled_at, ends_at: b.ends_at }, new: { scheduled_at: w.start, ends_at: w.end, requested_by: e.requested_by, reason: e.reason!.trim() }, ip });
    }
    let account: { subscriber: number; password: string } | null = null;
    if (teamChanged && EDITABLE.includes(b.status)) {
      account = (await assignWithin(t, user, ip, id, { lead, assistants: help, vehicle_id: vehicle, scheduled_at: null, ends_at: null, overrides: e.team!.overrides })).account;
    } else if (teamChanged) { // in progress (confirmed): the new crew takes over, the status stays
      if (lead && help.includes(lead)) throw new AppError("LEAD_IN_ASSISTANTS", 400);
      const team = [...(lead ? [lead] : []), ...help];
      if (!team.length) throw new AppError("TEAM_REQUIRED", 400);
      if ((await t`select id from users where id = any(${t.array(team)}::uuid[]) and company_id = ${user.companyId} and is_active and role = 'tech'`).length !== team.length) throw new AppError("TECH_NOT_FOUND", 404);
      for (const o of e.team!.overrides ?? []) if (team.includes(o.user_id)) await releaseForOverride(t, user, ip, { id, number: b.number }, w.start!, w.end!, o);
      await assertTeamFree(t, user.companyId, team, w.start!, w.end!, id);
      if (lead) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${lead}, 'lead')`;
      for (const x of help) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${x}, 'assistant')`;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.reassign", table: "bookings", rowId: id, old: { status: b.status },
        new: { lead, assistants: help, vehicle_id: vehicle, scheduled_at: w.start, ends_at: w.end }, ip });
      await enqueueBookingConfirmed(t, id, `reassigned:${Math.floor(Date.now() / 1000)}`);
    }
    // the technicians hear the new time (a new crew already got the job with its time)
    if (timeChanged && (!teamChanged ? oldTeam.length > 0 : !EDITABLE.includes(b.status))) await enqueueBookingRescheduled(t, id, { oldStart: b.scheduled_at, requestedBy: e.requested_by!, reason: e.reason!.trim() });

    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.update", table: "bookings", rowId: id, old: oldV, new: newV, ip });
    return { id, changed: Object.keys(newV), rescheduled: timeChanged, account };
  });
  if (out.account) await tellSubscriber(out.account.subscriber, { text: customerText.password(out.account.password), hint: customerText.hint, buttons: row(btn.login()) });
  return { id: out.id, changed: out.changed, rescheduled: out.rescheduled };
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

/** a customer record that exists only because of a website booking the staff never accepted (declined, or expired unanswered)
 *  loses its Telegram link and login — nobody keeps an account on a phone number nobody checked; a new booking links again */
export async function dropUnacceptedAccount(t: Db, bookingId: string): Promise<void> {
  const gone = await t<{ id: string }[]>`update customers c set tg_subscriber_id = null, password_hash = null, password_set_at = null
    from bookings b where b.id = ${bookingId} and c.id = b.customer_id and c.origin = 'website' and c.tg_subscriber_id is not null
      and not exists (select 1 from bookings b2 where b2.customer_id = c.id and b2.id <> ${bookingId} and b2.status <> 'cancelled') returning c.id`;
  if (gone.length) await t`delete from customer_sessions where customer_id = ${gone[0]!.id}`;
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
  if (b.origin === "website" && b.web_status === "pending" && actor.userId) {
    await t`update bookings set web_status = 'declined', web_decided_by = ${actor.userId}, web_decided_at = now() where id = ${id}`;
    await dropUnacceptedAccount(t, id);
  }
  await t`update service_requests set status = 'done', outcome = case when kind = 'booking' and ${actor.userId !== null} then 'declined' when kind = 'reschedule' then 'rejected' else outcome end,
      note = coalesce(note, ${reason.slice(0, 300)}), handled_by = ${actor.userId}, handled_at = now() where booking_id = ${id} and status = 'new'`;
  await audit(t, { companyId: actor.companyId, userId: actor.userId, action: "booking.cancel", source: actor.userId ? "app" : "system", table: "bookings", rowId: id, old: { status: b.status }, new: { status: "cancelled", reason }, ip });
  await enqueueBookingCancelled(t, id, reason);
  // BR-21 · FR-1002: CEO + CFO hear about every deletion (never the person who did it); a customer's own cancellation also reaches Admin + GM
  const cname = (await t<{ name: string }[]>`select name from customers where id = ${b.customer_id as string}`)[0]?.name ?? "";
  const test = b.is_test === true; // D-120: a test reaches the CEO only
  const roles = test ? ["ceo"] : actor.userId ? ["ceo", "cfo"] : ["ceo", "cfo", "admin", "gm"];
  const title = { km: `❌ បោះបង់ការងារ · ${b.number}`, en: `❌ Booking cancelled · ${b.number}` };
  for (const u of await t<{ id: string }[]>`select id from users where company_id = ${actor.companyId} and is_active and role::text = any(${t.array(roles)}) and id::text <> ${actor.userId ?? ""}`)
    await notifyUser(t, actor.companyId, u.id, "booking.cancelled", test ? testTitle(title) : title, { km: `👤 ${cname}\nដោយ ${actor.name.km}\n📝 ${reason}`, en: `👤 ${cname}\nby ${actor.name.en}\n📝 ${reason}` }, `/bookings/${id}`, `cancel-boss:${id}:${u.id}`);
  return { id, status: "cancelled" as const };
}
