// Online booking + quote requests from the public website (D-96).
//  * Slots: 7 days from today, one start per full hour inside the working hours for the length of the service. A slot is
//    offered only while a technician can take it — booking rules R1–R5: not in the past (at least WEB_LEAD_MIN ahead), no
//    overlap with a technician's jobs, approved leave / absence not counted, and every job that still waits for a technician
//    (an online booking that waits for an answer, or a job the staff have not assigned yet) takes one technician.
//  * Submit: the consent tick is required and stored; the slot is checked again under a per-company lock, so two visitors
//    cannot take the last technician at the same moment. The booking is «pending» and holds its slot until Admin / GM
//    confirm or decline (target 30 min). It shows in «customer requests».
//  * The «request sent» screen lives at an unguessable address and carries the single-use Telegram link of the booking.
//  * Quote requests: text + up to 5 photos (type and size checked, metadata stripped) → the GM.
import { createHmac, randomBytes } from "node:crypto";
import { SERVICE_CATEGORIES, SITE_CONSENT_VERSION, WEB_CONFIRM_MIN, WEB_DAYS, WEB_LEAD_MIN, WEB_MAX_PHOTOS, kmDigits, normalizeKhPhone } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { cancelBookingIn, confirmWebBookingIn, nextBookingNumber } from "./bookings.js";
import { issueInitialPassword, passwordMessage, tellSubscriber } from "./customer-auth.js";
import { tellCustomer } from "./customer-notify.js";
import { checkImage, writeImage } from "./jobs.js";
import { customerByPhone, notifyRequestStaff } from "./requests.js";
import { checkFormToken, readUpload, siteCompanyId } from "./site.js";
import { fmtLocal } from "./telegram.js";

/** abuse guard: at most this many online bookings may wait for an answer at the same time (each one holds a technician and
 *  rings Admin + GM); beyond it the visitor is asked to call. An object so the tests can lower it. */
export const webLimits = { maxPending: 30 };

export type WebSlot = { time: string; at: string; free: boolean; why?: "past" | "closed" | "full" };
export type WebDay = { date: string; dow: number; open: boolean; slots: WebSlot[] };
export type Bookable = { id: string; name_km: string; name_en: string | null; category: string; from_price: number; duration_min: number };

/** a service a visitor can book online: an active service of the catalog WITH a «from» price */
export async function bookableService(db: Db, companyId: string, id: string): Promise<Bookable> {
  const r = (await db<Bookable[]>`select id, name_km, name_en, category::text as category, from_price, duration_min from catalog_items
    where id = ${id} and company_id = ${companyId} and kind = 'service' and is_active and from_price is not null`)[0];
  if (!r) throw new AppError("SERVICE_NOT_BOOKABLE", 404);
  return r;
}

/** the slot grid of the next WEB_DAYS days for a job of `minutes`. `exclude` = a booking that is being moved (its own time does
 *  not count); `team` = its assigned crew — then the slot is free when exactly these people are free (the reschedule rule). */
export async function slotGrid(db: Db, companyId: string, minutes: number, o: { exclude?: string | null; team?: string[] } = {}): Promise<WebDay[]> {
  const st = (await db<{ tz: string; today: string; ws: string; we: string; work_days: number[]; holidays: string[] }[]>`
    select c.timezone as tz, (now() at time zone c.timezone)::date::text as today, to_char(s.work_start, 'HH24:MI') as ws, to_char(s.work_end, 'HH24:MI') as we, s.work_days,
      array(select h::text from unnest(s.holidays) h) as holidays
    from companies c join company_settings s on s.company_id = c.id where c.id = ${companyId}`)[0];
  if (!st) throw notFound();
  const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
  const starts: number[] = [];
  for (let m = Math.ceil(toMin(st.ws) / 60) * 60; m + minutes <= toMin(st.we); m += 60) starts.push(m); // the job ends inside the working hours
  const dayRows = await db<{ day: string; dow: number }[]>`select d::date::text as day, extract(isodow from d::date)::int as dow
    from generate_series(${st.today}::date, ${st.today}::date + ${WEB_DAYS - 1}::int, interval '1 day') d order by 1`;
  if (!starts.length) return dayRows.map((d) => ({ date: d.day, dow: d.dow, open: false, slots: [] }));
  const grid = await db<{ day: string; m: number; at: Date }[]>`select d::date::text as day, m, ((d::date + make_interval(mins => m)) at time zone ${st.tz}) as at
    from generate_series(${st.today}::date, ${st.today}::date + ${WEB_DAYS - 1}::int, interval '1 day') d cross join unnest(${db.array(starts)}::int[]) m order by 1, 2`;
  const from = grid[0]!.at, to = new Date(grid.at(-1)!.at.getTime() + minutes * 60_000);
  const skip = o.exclude ? db`and b.id <> ${o.exclude}` : db``;
  const techs = (await db<{ id: string }[]>`select id from users where company_id = ${companyId} and is_active and role = 'tech'`).map((x) => x.id);
  const busy = await db<{ user_id: string; s: Date; e: Date }[]>`select bt.user_id, b.scheduled_at as s, b.ends_at as e from booking_technicians bt join bookings b on b.id = bt.booking_id
    where b.company_id = ${companyId} and b.status <> 'cancelled' and b.scheduled_at is not null ${skip} and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  const away = await db<{ user_id: string; s: Date; e: Date }[]>`select user_id, starts_at as s, ends_at as e from staff_leaves
    where company_id = ${companyId} and status = 'approved' and tstzrange(starts_at, ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  const waiting = await db<{ s: Date; e: Date }[]>`select b.scheduled_at as s, b.ends_at as e from bookings b
    where b.company_id = ${companyId} and b.status in ('new', 'quoted') and b.scheduled_at is not null ${skip}
      and not exists (select 1 from booking_technicians t where t.booking_id = b.id) and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  const earliest = Date.now() + WEB_LEAD_MIN * 60_000;
  const hit = (x: { s: Date; e: Date }, a: number, b: number) => x.s.getTime() < b && x.e.getTime() > a;
  const taken = (id: string, a: number, b: number) => busy.some((x) => x.user_id === id && hit(x, a, b)) || away.some((x) => x.user_id === id && hit(x, a, b));
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return dayRows.map((d) => {
    const open = st.work_days.includes(d.dow) && !st.holidays.includes(d.day);
    return { date: d.day, dow: d.dow, open, slots: grid.filter((g) => g.day === d.day).map((g): WebSlot => {
      const a = g.at.getTime(), b = a + minutes * 60_000;
      const why = !open ? "closed" : a < earliest ? "past"
        : (o.team?.length ? o.team.some((id) => taken(id, a, b)) : techs.filter((id) => !taken(id, a, b)).length - waiting.filter((x) => hit(x, a, b)).length <= 0) ? "full" : undefined;
      return { time: hm(g.m), at: g.at.toISOString(), free: !why, ...(why ? { why } : {}) };
    }) };
  });
}
/** what the public sees of a grid: day, time, free or not */
export const publicDays = (days: WebDay[]) => days.map((d) => ({ date: d.date, dow: d.dow, open: d.open, slots: d.slots.map((s) => ({ time: s.time, at: s.at, free: s.free })) }));

export async function publicSlots(serviceId: string) {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  const svc = await bookableService(sql, companyId, serviceId);
  return { service: { id: svc.id, name_km: svc.name_km, name_en: svc.name_en, from_price: svc.from_price, duration_min: svc.duration_min }, days: publicDays(await slotGrid(sql, companyId, svc.duration_min)) };
}

// ---------- the single-use Telegram link of a booking: t.me/<bot>?start=b-<token> ----------
/** derived from the booking id with the server secret (the page can show it again); the table keeps only its hash + used_at */
const linkToken = (bookingId: string) => `b-${createHmac("sha256", config.sessionSecret).update(`booking-link:${bookingId}`).digest("base64url").slice(0, 20)}`;

/** the hub tells the shop that a subscriber opened a booking link (after the consent tick). The chat is linked to THIS booking;
 *  the customer record itself is linked only once the staff confirmed the booking — a phone number alone opens nobody's history. */
export async function consumeBookingToken(token: string, subscriberId: number) {
  return tx(null, async (t) => {
    const r = (await t<{ booking_id: string; company_id: string; used_at: Date | null; expired: boolean; number: string; web_status: string | null; status: string; customer_id: string }[]>`
      select k.booking_id, k.company_id, k.used_at, k.expires_at < now() as expired, b.number, b.web_status, b.status, b.customer_id
      from booking_link_tokens k join bookings b on b.id = k.booking_id where k.token_hash = ${sha256(token)} for update of k`)[0];
    if (!r || r.expired || r.status === "cancelled") return { ok: false, error: "CODE_INVALID" };
    if (r.used_at) return { ok: false, error: "CODE_USED" };
    await t`update booking_link_tokens set used_at = now(), used_by = ${subscriberId} where booking_id = ${r.booking_id}`;
    await t`update bookings set web_subscriber_id = ${subscriberId} where id = ${r.booking_id}`;
    // The customer RECORD is linked at once only when that is safe: the staff already confirmed the booking, or the record
    // exists only because of this booking (nothing older to see). Else the link waits for the confirmation.
    const fresh = (await t`select 1 from bookings b2 where b2.customer_id = ${r.customer_id} and b2.id <> ${r.booking_id} and b2.status <> 'cancelled' limit 1`).length === 0;
    const linked = r.web_status === "confirmed" || fresh
      ? (await t`update customers set tg_subscriber_id = ${subscriberId} where id = ${r.customer_id} and tg_subscriber_id is null returning id`).length > 0 : false;
    await audit(t, { companyId: r.company_id, userId: null, action: "booking.tg_link", source: "telegram", table: "bookings", rowId: r.booking_id });
    // D-103: a record linked just now gets its first password — the hub sends `after` to that chat as its own message (not logged)
    const password = linked ? await issueInitialPassword(t, r.customer_id) : null;
    const https = config.publicUrl.startsWith("https://");
    return { ok: true, booking: r.number, ...(password ? { after: passwordMessage(password, "initial") } : {}), ...(https ? { menu_url: `${config.publicUrl}/` } : {}) };
  });
}

// ---------- submit ----------
export type WebBookingInput = { service_id: string; at: string; address: string; lat?: number | null; lng?: number | null; name: string; phone: string; note?: string | null;
  consent?: boolean; ts?: string; company_url?: string; lang?: "km" | "en" };

/** honeypot / too-fast → looks like success, nothing stored; a stale page → FORM_EXPIRED */
function botCheck(v: { ts?: string; company_url?: string }): "bot" | "ok" {
  if ((v.company_url ?? "") !== "") return "bot";
  const tok = checkFormToken(v.ts ?? "");
  if (tok === "bad") throw new AppError("FORM_EXPIRED", 400);
  return tok === "fresh" ? "bot" : "ok";
}
function person(v: { name: string; phone: string; consent?: boolean }, afterConsent?: () => void): { name: string; phone: string } {
  if (v.consent !== true) throw new AppError("CONSENT_REQUIRED", 400);
  afterConsent?.();
  const name = v.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new AppError("NAME_REQUIRED", 400);
  const phone = normalizeKhPhone(v.phone);
  if (!phone) throw new AppError("INVALID_PHONE", 400);
  return { name, phone };
}

export async function submitWebBooking(ip: string, v: WebBookingInput): Promise<{ ref: string | null; number?: string }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (botCheck(v) === "bot") return { ref: null };
  const { name, phone } = person(v);
  const address = v.address.trim().replace(/\s+/g, " ").slice(0, 300), gps = v.lat != null && v.lng != null;
  if (address.length < 3 && !gps) throw new AppError("ADDRESS_REQUIRED", 400);
  const svc = await bookableService(sql, companyId, v.service_id);
  const at = new Date(v.at);
  if (Number.isNaN(at.getTime())) throw new AppError("SLOT_INVALID", 400);
  if (!checkRate(`site:book:ip:${ip}`, 5, 3600) || !checkRate(`site:book:phone:${phone}`, 3, 86400)) throw new AppError("RATE_LIMITED", 429);
  const note = v.note?.trim().slice(0, 500) || null;
  return tx(null, async (t) => {
    // one web booking at a time per company: the slot is checked and taken under this lock (race-safe)
    await t`select pg_advisory_xact_lock(hashtextextended(${`web-booking:${companyId}`}, 0))`;
    if ((await t<{ n: number }[]>`select count(*)::int as n from bookings where company_id = ${companyId} and web_status = 'pending' and status <> 'cancelled'`)[0]!.n >= webLimits.maxPending) throw new AppError("TOO_MANY_PENDING", 429);
    const slot = (await slotGrid(t, companyId, svc.duration_min)).flatMap((d) => d.slots).find((s) => s.at === at.toISOString());
    if (!slot || slot.why === "past" || slot.why === "closed") throw new AppError("SLOT_INVALID", 400);
    if (!slot.free) throw new AppError("SLOT_TAKEN", 409);
    // the customer: the one who has this phone number — that record is NOT touched (the visitor is not verified yet) — else a
    // new record with the consent just given. The consent itself is always kept on the request (meta.consent).
    let customerId = await customerByPhone(t, companyId, phone);
    if (!customerId) customerId = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, lat, lng, origin, consent_at, consent_version)
      values (${companyId}, ${name}, ${t.array([phone])}, ${address || null}, ${v.lat ?? null}, ${v.lng ?? null}, 'website', now(), ${SITE_CONSENT_VERSION}) returning id`)[0]!.id;
    const c = (await t<{ address: string | null; zone: string; tz: string }[]>`select cu.address, cu.zone::text as zone, co.timezone as tz from customers cu join companies co on co.id = cu.company_id where cu.id = ${customerId}`)[0]!;
    const number = await nextBookingNumber(t, companyId);
    const end = new Date(at.getTime() + svc.duration_min * 60_000), ref = randomBytes(16).toString("base64url");
    const id = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, service_item_id, scheduled_at, ends_at, address, lat, lng, zone, notes, created_by, origin, web_status, web_ref)
      values (${companyId}, ${number}, ${customerId}, 'A', ${svc.category}::service_category, 'new', ${svc.name_km}, ${svc.id}, ${at}, ${end}, ${address || c.address}, ${v.lat ?? null}, ${v.lng ?? null}, ${c.zone}::zone,
        ${note}, null, 'website', 'pending', ${ref}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, 'new', null)`;
    await t`insert into booking_link_tokens (token_hash, company_id, booking_id, expires_at) values (${sha256(linkToken(id))}, ${companyId}, ${id}, now() + interval '7 days')`;
    await audit(t, { companyId, userId: null, action: "booking.create", source: "system", table: "bookings", rowId: id, new: { number, origin: "website", customer_id: customerId, scheduled_at: at, ends_at: end }, ip });
    const when = fmtLocal(at, c.tz || "Asia/Phnom_Penh");
    const text = [`🛠 ${svc.name_km}`, `🕒 ${when}`, address ? `📍 ${address}` : null, note ? `📝 ${note}` : null].filter(Boolean).join("\n");
    const rid = (await t<{ id: string }[]>`insert into service_requests (company_id, source, kind, booking_id, customer_id, name, phone, text, meta)
      values (${companyId}, 'website', 'booking', ${id}, ${customerId}, ${name}, ${phone}, ${text.slice(0, 1000)},
        ${t.json({ service_item_id: svc.id, service: svc.name_km, at: at.toISOString(), lang: v.lang === "en" ? "en" : "km", consent: { at: new Date().toISOString(), version: SITE_CONSENT_VERSION } } as never)}) returning id`)[0]!.id;
    await notifyRequestStaff(t, companyId, ["admin", "gm"], { km: `🌐 ការកក់ពីគេហទំព័រ · ${number}`, en: `🌐 Website booking · ${number}` },
      { km: `👤 ${name} · 📞 ${phone}\n${text}\n⏱ សូមបញ្ជាក់ក្នុង ${kmDigits(WEB_CONFIRM_MIN)} នាទី`, en: `👤 ${name} · 📞 ${phone}\n${text}\n⏱ Please confirm within ${WEB_CONFIRM_MIN} minutes` }, rid);
    return { ref, number };
  });
}

// ---------- the «request sent» screen ----------
export type CustomerState = "pending" | "confirmed" | "on_the_way" | "working" | "done" | "declined" | "cancelled";
/** what the customer is told about a booking (the staff's own statuses stay inside) */
export function customerState(status: string, webStatus: string | null): CustomerState {
  if (status === "cancelled") return webStatus === "declined" ? "declined" : "cancelled";
  if (webStatus === "pending") return "pending";
  if (status === "en_route") return "on_the_way";
  if (status === "on_site" || status === "working") return "working";
  return ["new", "survey", "quoted", "assigned"].includes(status) ? "confirmed" : "done";
}

export async function doneView(ref: string) {
  const companyId = await siteCompanyId();
  const b = companyId ? (await sql<{ id: string; number: string; status: string; web_status: string | null; service_text: string; name_en: string | null; scheduled_at: Date; linked: boolean; token_live: boolean | null }[]>`
    select b.id, b.number, b.status, b.web_status, b.service_text, i.name_en, b.scheduled_at, b.web_subscriber_id is not null as linked,
      (select k.used_at is null and k.expires_at > now() from booking_link_tokens k where k.booking_id = b.id) as token_live
    from bookings b left join catalog_items i on i.id = b.service_item_id where b.web_ref = ${ref} and b.company_id = ${companyId}`)[0] : null;
  if (!b) throw notFound();
  const state = customerState(b.status, b.web_status);
  return { number: b.number, state, service_km: b.service_text, service_en: b.name_en, at: b.scheduled_at, linked: b.linked,
    token: b.token_live && state !== "cancelled" && state !== "declined" ? linkToken(b.id) : null };
}

// ---------- Admin / GM: confirm or decline ----------
export async function decideWebBooking(user: SessionUser, ip: string | null, requestId: string, decision: "confirm" | "decline", reason = "") {
  const done = await tx(user.id, async (t) => {
    const r = (await t<{ booking_id: string | null; web_status: string | null }[]>`select r.booking_id, b.web_status from service_requests r left join bookings b on b.id = r.booking_id
      where r.id = ${requestId} and r.company_id = ${user.companyId} and r.kind = 'booking' and r.status = 'new' for update of r`)[0];
    if (!r?.booking_id) throw notFound();
    if (r.web_status !== "pending") throw new AppError("NOT_PENDING", 409);
    let account: { subscriber: number; password: string } | null = null;
    if (decision === "confirm") account = await confirmWebBookingIn(t, user.companyId, user.id, r.booking_id, ip);
    else { // cancelled with the reason: the slot is free again; the request closes as «declined» inside
      await cancelBookingIn(t, { companyId: user.companyId, userId: user.id, name: { km: user.fullName, en: user.fullName } }, ip, r.booking_id, reason);
      await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.web_decline", table: "bookings", rowId: r.booking_id, new: { web_status: "declined", reason }, ip });
    }
    return { bookingId: r.booking_id, account };
  });
  await tellCustomer(done.bookingId, (b) => (decision === "confirm"
    ? `✅ ការកក់ ${b.number} បានបញ្ជាក់\n🛠 ${b.service}\n🕒 ${b.when}\nយើងនឹងរំលឹកអ្នក ១ ថ្ងៃមុន ហើយជូនដំណឹងពេលជាងចេញដំណើរ។`
    : `❌ សូមអភ័យទោស — យើងមិនអាចទទួលការកក់ ${b.number} បានទេ\n📝 ${reason}\nសូមជ្រើសម៉ោងផ្សេង៖ ${config.publicUrl}/`));
  // the customer record was linked by this confirmation → its first password, to that chat only (D-103)
  if (done.account) await tellSubscriber(done.account.subscriber, passwordMessage(done.account.password, "initial"));
  return { ok: true };
}

// ---------- quote request ----------
export type QuoteInput = { category: string; description: string; photos?: string[]; name: string; phone: string; location?: string; lat?: number | null; lng?: number | null;
  service_id?: string | null; consent?: boolean; ts?: string; company_url?: string; lang?: "km" | "en" };
const CATEGORY: Record<"km" | "en", Record<string, string>> = {
  km: { mep: "អគ្គិសនី ទឹក ម៉ាស៊ីនត្រជាក់", construction: "សំណង់", decor: "តុបតែង", camera: "កាមេរ៉ា", other: "ផ្សេងៗ" },
  en: { mep: "Electrical, plumbing, AC", construction: "Construction", decor: "Decoration", camera: "Camera", other: "Other" },
};
export const QUOTE_CATEGORIES = [...SERVICE_CATEGORIES, "other"] as const;

export async function submitQuote(ip: string, v: QuoteInput): Promise<{ ok: true }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (botCheck(v) === "bot") return { ok: true };
  const description = v.description.trim().slice(0, 600);
  const { name, phone } = person(v, () => { if (description.length < 5) throw new AppError("DESCRIPTION_REQUIRED", 400); });
  const photos = v.photos ?? [];
  if (photos.length > WEB_MAX_PHOTOS) throw new AppError("TOO_MANY_PHOTOS", 400);
  const category = (QUOTE_CATEGORIES as readonly string[]).includes(v.category) ? v.category : "other";
  const location = (v.location ?? "").trim().replace(/\s+/g, " ").slice(0, 200), gps = v.lat != null && v.lng != null;
  if (location.length < 3 && !gps) throw new AppError("LOCATION_REQUIRED", 400);
  if (!checkRate(`site:quote:ip:${ip}`, 5, 3600) || !checkRate(`site:quote:phone:${phone}`, 3, 86400)) throw new AppError("RATE_LIMITED", 429);
  const images = photos.map((p) => checkImage(p, undefined, "BAD_IMAGE", true)); // every photo is checked and cleaned before anything is stored
  const svc = v.service_id ? (await sql<{ id: string; name_km: string }[]>`select id, name_km from catalog_items where id = ${v.service_id} and company_id = ${companyId} and kind = 'service' and is_active`)[0] : undefined;
  const files: { id: string; rel: string; mime: string; bytes: number }[] = [];
  for (const img of images) files.push(await writeImage(companyId, img));
  // the request keeps what the visitor wrote; the category is a code in meta — every reader sees it in their own language
  const text = [svc ? `🔧 ${svc.name_km}` : null, description, location ? `📍 ${location}` : null, files.length ? `🖼 ${files.length}` : null].filter(Boolean).join("\n");
  const customerId = await customerByPhone(sql, companyId, phone);
  await tx(null, async (t) => {
    const id = (await t<{ id: string }[]>`insert into service_requests (company_id, source, kind, customer_id, name, phone, text, meta)
      values (${companyId}, 'website', 'quote', ${customerId}, ${name}, ${phone}, ${text.slice(0, 1000)},
        ${t.json({ category, service_item_id: svc?.id ?? null, service: svc?.name_km ?? null, location: location || null, lat: v.lat ?? null, lng: v.lng ?? null, lang: v.lang === "en" ? "en" : "km",
          consent: { at: new Date().toISOString(), version: SITE_CONSENT_VERSION } } as never)}) returning id`)[0]!.id;
    for (const f of files) await t`insert into service_request_files (id, company_id, request_id, path, mime, bytes) values (${f.id}, ${companyId}, ${id}, ${f.rel}, ${f.mime}, ${f.bytes})`;
    await audit(t, { companyId, userId: null, action: "service.request", source: "system", table: "service_requests", rowId: id, new: { source: "website", kind: "quote", photos: files.length, customer_id: customerId }, ip });
    await notifyRequestStaff(t, companyId, ["gm"], { km: `🌐 សំណើសុំតម្លៃ · ${name}`, en: `🌐 Quote request · ${name}` },
      { km: `🧩 ${CATEGORY.km[category]}\n📞 ${phone}\n${text}`, en: `🧩 ${CATEGORY.en[category]}\n📞 ${phone}\n${text}` }, id); // a quote goes to the GM
  });
  return { ok: true };
}

/** a photo of a quote request — for the staff who see the requests, never public */
export async function readRequestPhoto(user: SessionUser, requestId: string, fileId: string) {
  return readUpload((await sql<{ path: string }[]>`select f.path from service_request_files f where f.id = ${fileId} and f.request_id = ${requestId} and f.company_id = ${user.companyId}`)[0]?.path);
}
