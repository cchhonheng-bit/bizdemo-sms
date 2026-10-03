// Customer home (D-101 · login D-103): in a browser the customer signs in with phone + password (services/customer-auth.ts);
// opened inside Telegram as a Mini App the launch data signs in — the hub checks its signature with the shop bot's token (the
// shop never holds it), not older than 24 hours, and says which subscriber of THIS shop it is. A session maps to bookings: the
// ones whose Telegram link the chat holds, and every booking of a customer record linked to it. Every function here takes the
// session and filters by it — a customer only ever reads or changes own data (IDOR tests in 210_website).
import { customerText, DEFAULT_DURATION_MIN, EDITABLE_STATUSES, webLinesParam, type BookingStatus } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { cancelBookingIn, rescheduleBooking, warrantyJson } from "./bookings.js";
import { newCustomerSession } from "./customer-auth.js";
import { btn, row } from "./customer-bot.js";
import { tellCustomer } from "./customer-notify.js";
import { hubCall, hubConfigured } from "./hub-client.js";
import { notifyRequestStaff } from "./requests.js";
import { siteCompanyId } from "./site.js";
import { fmtLocal } from "./telegram.js";
import { customerState, publicDays, slotGrid } from "./web-booking.js";

export const CUSTOMER_COOKIE = "otc";
/** customerId: the account of a phone + password login; null for a login from inside Telegram (the chat is the identity) */
export type CustomerSession = { id: string; companyId: string; subscriberId: number; customerId: string | null; name: string | null };
/** Telegram launch data may be this old (final brief: reject auth_date older than 24 h) */
const MINI_APP_MAX_AGE = 86_400;

/** opened inside Telegram: the launch data says who it is (checked by the hub with the shop bot's token); only someone the hub
 *  knows as a subscriber of this shop gets a session */
export async function customerLogin(v: { init_data: string }): Promise<{ token: string } | { error: "auth" | "nolink" }> {
  const companyId = await siteCompanyId();
  if (!companyId || !hubConfigured()) return { error: "auth" };
  const r = await hubCall("POST", "/internal/tg-verify", { init_data: v.init_data, max_age: MINI_APP_MAX_AGE }).catch(() => null);
  if (!r || r.status !== 200 || r.json?.ok !== true || typeof r.json.tg_user !== "number") return { error: "auth" };
  if (typeof r.json.subscriber_id !== "number") return { error: "nolink" };
  return { token: await newCustomerSession({ companyId, subscriberId: r.json.subscriber_id, customerId: null, tgUser: r.json.tg_user,
    name: typeof r.json.first_name === "string" ? r.json.first_name : null, via: "telegram" }) };
}
/** a password session lives only while its customer record is active and linked to a Telegram chat (that chat decides what it sees) */
export async function resolveCustomerSession(token: string | undefined): Promise<CustomerSession | null> {
  if (!token) return null;
  const r = (await sql<{ id: string; company_id: string; sub: string | null; name: string | null; customer_id: string | null; stale: boolean }[]>`
    select s.id, s.company_id, s.name, s.customer_id, s.last_seen_at < now() - interval '1 hour' as stale,
      (case when s.customer_id is null then s.subscriber_id else c.tg_subscriber_id end)::text as sub
    from customer_sessions s left join customers c on c.id = s.customer_id and c.is_active where s.token_hash = ${sha256(token)} and s.expires_at > now()`)[0];
  if (!r?.sub) return null;
  if (r.stale) await sql`update customer_sessions set last_seen_at = now() where id = ${r.id}`;
  return { id: r.id, companyId: r.company_id, subscriberId: Number(r.sub), customerId: r.customer_id, name: r.name };
}
export async function customerLogout(token: string | undefined): Promise<void> {
  if (token) await sql`delete from customer_sessions where token_hash = ${sha256(token)}`;
}

/** THE rule: a booking belongs to this session when the chat holds the booking's own link, or the customer record is linked to it */
const mine = (s: CustomerSession) => sql`b.company_id = ${s.companyId} and (b.web_subscriber_id = ${s.subscriberId} or c.tg_subscriber_id = ${s.subscriberId})`;
const OPEN = ["new", "survey", "quoted", "assigned", "en_route", "on_site", "working"];
const movable = (status: string) => EDITABLE_STATUSES.includes(status as BookingStatus); // before the technician is on the way

type Row = { id: string; number: string; status: string; web_status: string | null; service_text: string; service_item_id: string | null; name_en: string | null; bookable: boolean; web_lines: { id: string; qty: number; name_en: string | null }[] | null;
  scheduled_at: Date | null; ends_at: Date | null; closed_at: Date | null; warranty: { until: string; active: boolean } | null; technician: string | null; reschedule_pending: boolean };

export async function myHome(s: CustomerSession) {
  const cust = (await sql<{ name: string; tz: string }[]>`select c.name, co.timezone as tz from customers c join companies co on co.id = c.company_id
    where c.company_id = ${s.companyId} and c.tg_subscriber_id = ${s.subscriberId} and c.is_active order by c.created_at limit 1`)[0];
  const rows = await sql<Row[]>`select b.id, b.number, b.status, b.web_status, b.service_text, b.service_item_id, i.name_en,
      coalesce(i.is_active and i.kind = 'service' and i.show_on_website and not i.quote_only, false) as bookable, b.web_lines, b.scheduled_at, b.ends_at, b.closed_at, ${warrantyJson(sql)} as warranty,
      (select u.full_name from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id order by (t.role = 'lead') desc, u.full_name limit 1) as technician,
      exists (select 1 from service_requests r where r.booking_id = b.id and r.kind = 'reschedule' and r.status = 'new') as reschedule_pending
    from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id left join catalog_items i on i.id = b.service_item_id
    where ${mine(s)} and b.status <> 'cancelled' order by b.scheduled_at nulls last`;
  return {
    // the customer record's name once it is linked; before that the Telegram first name (a phone number alone reveals no name)
    name: cust?.name ?? s.name ?? "",
    upcoming: rows.filter((r) => OPEN.includes(r.status)).map((r) => ({ id: r.id, number: r.number, service_km: r.service_text, service_en: enText(r), scheduled_at: r.scheduled_at, ends_at: r.ends_at,
      status: customerState(r.status, r.web_status), technician: r.technician, can_cancel: movable(r.status), can_reschedule: movable(r.status), reschedule_pending: r.reschedule_pending })),
    past: rows.filter((r) => !OPEN.includes(r.status)).reverse().slice(0, 10).map((r) => ({ id: r.id, number: r.number, service_km: r.service_text, service_en: enText(r), date: r.closed_at ?? r.scheduled_at,
      warranty: r.warranty ? { until: r.warranty.until, active: r.warranty.active } : null, rebook: rebookOf(r) })),
  };
}
export type MyHome = Awaited<ReturnType<typeof myHome>>;
/** the English name of a booking: from its lines (website), else from its catalog item */
const enText = (r: Row) => (r.web_lines?.length ? r.web_lines.map((l) => (l.name_en ? (l.qty > 1 ? `${l.name_en} ×${l.qty}` : l.name_en) : null)).filter(Boolean).join(" · ") || null : r.name_en);
/** «book again»: the same lines (website booking) or the same service — the booking screen checks them again */
const rebookOf = (r: Row) => (r.web_lines?.length ? `/book?items=${webLinesParam(r.web_lines.map((l) => ({ id: l.id, qty: l.qty })))}` : r.bookable && r.service_item_id ? `/book?items=${r.service_item_id}:1` : "/");

// ---------- notification settings (customer home): the hub keeps the subscription; every change is in its consent log ----------
export type NotifyPrefs = { service: boolean; promo: boolean };
export async function myPrefs(s: CustomerSession): Promise<NotifyPrefs | null> {
  if (!hubConfigured()) return null;
  const r = await hubCall("GET", `/internal/subscriber-prefs?subscriber_id=${s.subscriberId}`).catch(() => null);
  return r && r.status === 200 && r.json?.ok ? { service: !!r.json.service, promo: !!r.json.promo } : null;
}
export async function setMyPrefs(s: CustomerSession, ip: string | null, p: NotifyPrefs): Promise<NotifyPrefs> {
  if (!hubConfigured()) throw new AppError("HUB_DOWN", 503);
  const r = await hubCall("POST", "/internal/subscriber-prefs", { subscriber_id: s.subscriberId, service: p.service, promo: p.service && p.promo }).catch(() => null);
  if (!r || r.status !== 200 || !r.json?.ok) throw new AppError("HUB_DOWN", 503);
  await audit(sql, { companyId: s.companyId, userId: null, action: "customer.notify_prefs", source: "system", table: "customers", rowId: s.customerId, new: { service: !!r.json.service, promo: !!r.json.promo }, ip });
  return { service: !!r.json.service, promo: !!r.json.promo };
}

async function myBooking(s: CustomerSession, id: string) {
  const b = (await sql<{ id: string; number: string; status: string; scheduled_at: Date | null; ends_at: Date | null; customer_id: string; cname: string; tz: string }[]>`
    select b.id, b.number, b.status, b.scheduled_at, b.ends_at, b.customer_id, c.name as cname, co.timezone as tz
    from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id where b.id = ${id} and ${mine(s)}`)[0];
  if (!b) throw notFound(); // not yours = does not exist
  return b;
}
const minutesOf = (b: { scheduled_at: Date | null; ends_at: Date | null }) => (b.scheduled_at && b.ends_at ? Math.round((b.ends_at.getTime() - b.scheduled_at.getTime()) / 60_000) : DEFAULT_DURATION_MIN);
const teamOf = async (id: string) => (await sql<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${id}`).map((x) => x.user_id);

/** the times this booking could move to: the assigned crew must be free (or, not assigned yet, any technician) */
export async function mySlots(s: CustomerSession, id: string) {
  const b = await myBooking(s, id);
  if (!movable(b.status)) throw new AppError("BOOKING_LOCKED", 400);
  return { days: publicDays(await slotGrid(sql, s.companyId, minutesOf(b), { exclude: id, team: await teamOf(id) })) };
}

/** a reschedule REQUEST (requested_by = customer): nothing moves until Admin / GM approve; one open request per booking */
export async function requestReschedule(s: CustomerSession, ip: string | null, id: string, atIso: string, reason: string) {
  const b = await myBooking(s, id);
  if (!movable(b.status)) throw new AppError("BOOKING_LOCKED", 400);
  const at = new Date(atIso);
  if (Number.isNaN(at.getTime())) throw new AppError("SLOT_INVALID", 400);
  const minutes = minutesOf(b);
  const slot = (await slotGrid(sql, s.companyId, minutes, { exclude: id, team: await teamOf(id) })).flatMap((d) => d.slots).find((x) => x.at === at.toISOString());
  if (!slot || slot.why === "past" || slot.why === "closed") throw new AppError("SLOT_INVALID", 400);
  if (!slot.free) throw new AppError("SLOT_TAKEN", 409);
  if (b.scheduled_at?.getTime() === at.getTime()) throw new AppError("SAME_TIME", 400);
  if (!checkRate(`site:resched:${s.subscriberId}`, 10, 3600)) throw new AppError("RATE_LIMITED", 429);
  const why = reason.trim().length >= 3 ? reason.trim().slice(0, 300) : "អតិថិជនស្នើប្ដូរម៉ោង";
  return tx(null, async (t) => {
    await t`select 1 from bookings where id = ${id} for update`;
    if ((await t`select 1 from service_requests where booking_id = ${id} and kind = 'reschedule' and status = 'new'`).length) throw new AppError("ALREADY_REQUESTED", 409);
    const tz = b.tz || "Asia/Phnom_Penh";
    const text = [`🔁 ${b.number}`, `❌ ${b.scheduled_at ? fmtLocal(b.scheduled_at, tz) : "—"}`, `✅ ${fmtLocal(at, tz)}`, `📝 ${why}`].join("\n");
    const rid = (await t<{ id: string }[]>`insert into service_requests (company_id, source, kind, booking_id, customer_id, subscriber_id, name, text, meta)
      values (${s.companyId}, 'website', 'reschedule', ${id}, ${b.customer_id}, ${s.subscriberId}, ${b.cname.slice(0, 120)}, ${text},
        ${t.json({ requested_by: "customer", old_start: b.scheduled_at?.toISOString() ?? null, new_start: at.toISOString(), new_end: new Date(at.getTime() + minutes * 60_000).toISOString(), reason: why } as never)}) returning id`)[0]!.id;
    await audit(t, { companyId: s.companyId, userId: null, action: "booking.reschedule_request", source: "system", table: "bookings", rowId: id, new: { new_start: at, requested_by: "customer", reason: why }, ip });
    await notifyRequestStaff(t, s.companyId, ["admin", "gm"], { km: `🔁 សំណើប្ដូរម៉ោង · ${b.number}`, en: `🔁 Reschedule request · ${b.number}` }, `👤 ${b.cname}\n${text}`, rid);
    return { ok: true };
  });
}

/** Admin / GM answer a reschedule request. Approve = the normal reschedule (every availability rule again, history row with
 *  requested_by = customer, crew told); when the time is no longer possible the error comes back and the request stays open. */
export async function decideReschedule(user: SessionUser, ip: string | null, requestId: string, decision: "approve" | "reject", reason = "") {
  const r = (await sql<{ id: string; booking_id: string | null; meta: { new_start?: string; reason?: string } }[]>`select id, booking_id, meta from service_requests
    where id = ${requestId} and company_id = ${user.companyId} and kind = 'reschedule' and status = 'new'`)[0];
  if (!r?.booking_id || !r.meta?.new_start) throw notFound();
  if (decision === "approve") await rescheduleBooking(user, ip, r.booking_id, { scheduled_at: r.meta.new_start, ends_at: null, requested_by: "customer", reason: r.meta.reason ?? "អតិថិជនស្នើប្ដូរម៉ោង" });
  await sql`update service_requests set status = 'done', outcome = ${decision === "approve" ? "approved" : "rejected"}, note = ${reason.trim().slice(0, 300) || null}, handled_by = ${user.id}, handled_at = now()
    where id = ${r.id} and status = 'new'`;
  await audit(sql, { companyId: user.companyId, userId: user.id, action: `booking.reschedule_${decision}`, table: "service_requests", rowId: r.id, new: { booking_id: r.booking_id }, ip });
  await tellCustomer(r.booking_id, (b) => ({ text: decision === "approve" ? customerText.rescheduled(b.number, b.day, b.time) : customerText.rescheduleKept(b.number, b.day, b.time), buttons: row(btn.track()) }));
  return { ok: true };
}

/** the customer cancels (with a reason) before the technician is on the way: status cancelled — never deleted —, crew and staff told */
export async function cancelByCustomer(s: CustomerSession, ip: string | null, id: string, reason: string) {
  const b = await myBooking(s, id);
  if (!movable(b.status)) throw new AppError("BOOKING_NOT_CANCELLABLE", 400);
  await tx(null, (t) => cancelBookingIn(t, { companyId: s.companyId, userId: null, name: { km: "អតិថិជន", en: "the customer" } }, ip, id, `អតិថិជនបោះបង់៖ ${reason.trim().slice(0, 200)}`));
  return { ok: true };
}
