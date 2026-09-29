// Booking flow (port of v1 create_booking / update_booking / assign_booking / technician_availability).
// Every function takes companyId + the acting user; technicians only see bookings they are assigned to (D-18).
import type { BookingStatus } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { enqueueBookingConfirmed } from "./telegram.js";

const ACTIVE: BookingStatus[] = ["assigned", "en_route", "on_site", "working"];

export type BookingRow = Record<string, unknown> & { id: string; company_id: string; status: BookingStatus; type: "A" | "B" };

/** shared SELECT (same columns as the v1 api.bookings view) */
function baseSelect(db: Db) {
  return db`select b.id, b.company_id, b.number, b.customer_id, c.name as customer_name, c.phones as customer_phones,
         b.type, b.category, b.status, b.service_text, b.scheduled_at, b.address, b.lat, b.lng, b.zone,
         b.vehicle_id, v.code as vehicle_code, b.notes, b.parent_booking_id, b.cancel_reason, b.closed_at,
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

/** technicians may see the customer of their bookings only (D-18) */
export async function customerVisibleToTech(user: SessionUser, customerId: string): Promise<boolean> {
  const r = await sql`select 1 from bookings b join booking_technicians t on t.booking_id = b.id where b.customer_id = ${customerId} and b.company_id = ${user.companyId} and t.user_id = ${user.id} limit 1`;
  return r.length > 0;
}

export type CreateInput = {
  customer_id: string; type: "A" | "B"; category: string; service_text: string; scheduled_at: string | null; address: string | null;
  lat: number | null; lng: number | null; zone: string | null; vehicle_id: string | null; notes: string | null;
};

export async function createBooking(user: SessionUser, ip: string | null, b: CreateInput) {
  return tx(user.id, async (t) => {
    const c = (await t<{ id: string; name: string; address: string | null; lat: number | null; lng: number | null; zone: string }[]>`
      select id, name, address, lat, lng, zone from customers where id = ${b.customer_id} and company_id = ${user.companyId} and is_active`)[0];
    if (!c) throw new AppError("CUSTOMER_NOT_FOUND", 404);
    const service = b.service_text.trim();
    if (!service) throw new AppError("SERVICE_REQUIRED", 400);
    if (b.vehicle_id) await assertVehicle(t, user.companyId, b.vehicle_id);
    const no = (await t<{ last_no: number }[]>`insert into booking_counters (company_id, last_no) values (${user.companyId}, 1)
      on conflict (company_id) do update set last_no = booking_counters.last_no + 1 returning last_no`)[0]!.last_no;
    const number = `BK-${String(no).padStart(4, "0")}`;
    const status: BookingStatus = b.type === "B" ? "survey" : "new";
    const id = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, scheduled_at, address, lat, lng, zone, vehicle_id, notes, created_by)
      values (${user.companyId}, ${number}, ${c.id}, ${b.type}::booking_type, ${b.category}::service_category, ${status}::booking_status, ${service}, ${b.scheduled_at},
              ${b.address?.trim() || c.address}, ${b.lat ?? c.lat}, ${b.lng ?? c.lng}, ${(b.zone ?? c.zone)}::zone, ${b.vehicle_id}, ${b.notes?.trim() || null}, ${user.id}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, ${status}::booking_status, ${user.id})`;
    if (c.lat == null && b.lat != null) await t`update customers set lat = ${b.lat}, lng = ${b.lng} where id = ${c.id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.create", table: "bookings", rowId: id, new: { number, type: b.type, customer_id: c.id }, ip });
    if (b.type === "B") {
      await t`insert into notifications (company_id, user_id, kind, title, body, link)
              select ${user.companyId}, u.id, 'booking.survey', ${number + " · ត្រូវការសិក្សាគម្រោង"}, ${c.name + " · " + service.slice(0, 80)}, ${"/bookings/" + id}
              from users u where u.company_id = ${user.companyId} and u.role = 'gm' and u.is_active`;
    }
    return { id, number, status };
  });
}

async function assertVehicle(t: Db, companyId: string, vehicleId: string) {
  const v = await t`select 1 from vehicles where id = ${vehicleId} and company_id = ${companyId} and is_active`;
  if (v.length === 0) throw new AppError("VEHICLE_NOT_FOUND", 404);
}

const EDITABLE: BookingStatus[] = ["new", "survey", "quoted", "assigned"];

export async function updateBooking(user: SessionUser, ip: string | null, id: string, p: Record<string, unknown>) {
  await tx(user.id, async (t) => {
    const old = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!old) throw notFound();
    if (!EDITABLE.includes(old.status)) throw new AppError("BOOKING_LOCKED", 400);
    const has = (k: string) => Object.prototype.hasOwnProperty.call(p, k);
    const vehicle = has("vehicle_id") ? ((p.vehicle_id as string) || null) : undefined;
    if (vehicle) await assertVehicle(t, user.companyId, vehicle); // F-M2-01
    await t`update bookings set
        service_text = coalesce(${(p.service_text as string) ?? null}, service_text),
        category = coalesce(${(p.category as string) ?? null}::service_category, category),
        scheduled_at = case when ${has("scheduled_at")} then ${(p.scheduled_at as string) || null}::timestamptz else scheduled_at end,
        address = case when ${has("address")} then ${(p.address as string) || null} else address end,
        lat = case when ${has("lat")} then ${(p.lat as number) ?? null} else lat end,
        lng = case when ${has("lng")} then ${(p.lng as number) ?? null} else lng end,
        zone = coalesce(${(p.zone as string) ?? null}::zone, zone),
        vehicle_id = case when ${vehicle !== undefined} then ${vehicle ?? null}::uuid else vehicle_id end,
        notes = case when ${has("notes")} then ${(p.notes as string) || null} else notes end
      where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.update", table: "bookings", rowId: id, old, new: p, ip });
  });
}

const ASSIGNABLE: BookingStatus[] = ["new", "quoted", "assigned"];

export async function assignBooking(user: SessionUser, ip: string | null, id: string, a: { lead: string; assistants: string[]; vehicle_id: string | null; scheduled_at: string }) {
  return tx(user.id, async (t) => {
    const b = (await t<BookingRow[]>`select * from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (!ASSIGNABLE.includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    if (b.type === "B" && user.role === "admin") throw new AppError("FORBIDDEN_TYPE_B", 403); // BR-02
    if (!a.lead) throw new AppError("LEAD_REQUIRED", 400);
    if (!a.scheduled_at) throw new AppError("SCHEDULE_REQUIRED", 400);
    if (a.assistants.includes(a.lead)) throw new AppError("LEAD_IN_ASSISTANTS", 400);
    const team = [a.lead, ...a.assistants];
    const ok = await t<{ id: string }[]>`select id from users where id = any(${t.array(team)}::uuid[]) and company_id = ${user.companyId} and is_active and role in ('tech', 'gm')`;
    if (ok.length !== new Set(team).size) throw new AppError("TECH_NOT_FOUND", 404);
    if (a.vehicle_id) await assertVehicle(t, user.companyId, a.vehicle_id);
    // FR-402: other active bookings of these technicians within ±2h — informational
    const conflicts = await t`select t.user_id, b2.number, b2.scheduled_at from booking_technicians t join bookings b2 on b2.id = t.booking_id
      where b2.company_id = ${user.companyId} and b2.id <> ${id} and b2.status = any(${t.array(ACTIVE)}::booking_status[])
        and t.user_id = any(${t.array(team)}::uuid[]) and b2.scheduled_at between ${a.scheduled_at}::timestamptz - interval '2 hours' and ${a.scheduled_at}::timestamptz + interval '2 hours'`;
    await t`delete from booking_technicians where booking_id = ${id}`;
    await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${a.lead}, 'lead')`;
    for (const x of a.assistants) await t`insert into booking_technicians (booking_id, user_id, role) values (${id}, ${x}, 'assistant')`;
    const reason = b.status === "assigned" ? `reassigned:${Math.floor(Date.now() / 1000)}` : "assigned";
    await t`update bookings set status = 'assigned', vehicle_id = ${a.vehicle_id}, scheduled_at = ${a.scheduled_at}::timestamptz where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.assign", table: "bookings", rowId: id, old: { status: b.status }, new: { lead: a.lead, assistants: a.assistants, vehicle_id: a.vehicle_id, scheduled_at: a.scheduled_at }, ip });
    await enqueueBookingConfirmed(t, id, reason);
    return { id, status: "assigned" as const, conflicts };
  });
}

/** F-M2-02: only assigners see the team schedule */
export async function availability(user: SessionUser, at: string) {
  const people = await sql<{ id: string; full_name: string; role: string }[]>`select id, full_name, role from users where company_id = ${user.companyId} and is_active and role in ('tech', 'gm') order by role, full_name`;
  const busy = await sql<{ user_id: string; number: string; scheduled_at: Date }[]>`select t.user_id, b.number, b.scheduled_at from booking_technicians t join bookings b on b.id = t.booking_id
    where b.company_id = ${user.companyId} and b.status = any(${sql.array(ACTIVE)}::booking_status[])
      and b.scheduled_at between ${at}::timestamptz - interval '2 hours' and ${at}::timestamptz + interval '2 hours'`;
  return people.map((p) => ({ user_id: p.id, full_name: p.full_name, role: p.role, busy: busy.filter((b) => b.user_id === p.id).map((b) => ({ number: b.number, scheduled_at: b.scheduled_at })) }));
}
