// Online booking + quote requests from the public website (D-96 · final combined brief D-106…).
//  * The website catalog: active services «shown on the website», grouped by website category. A visitor books one or more lines
//    (item × quantity). The job takes the sum of the line durations — one duration per line, not × quantity (CEO). The «from»
//    price is Σ from_price × quantity when every line has one; an item without a price is still bookable — the price is told on
//    contact (CEO). Items marked «quote only» go to the quote screen.
//  * Slots: 7 days from today, one start per full hour inside the booking hours (Settings → Website; default 08:00–17:00, lunch
//    12:00–13:00): the job ends by closing time and never touches lunch. A slot is offered only while a technician can take it
//    (R1–R5): not in the past (at least WEB_LEAD_MIN ahead), no overlap with a technician's jobs, approved leave not counted,
//    and every job that waits for a technician (an online booking waiting for an answer, a job not assigned yet) takes one.
//  * Submit = ONE tap: the booking is saved «pending» (the slot is held), the consent is recorded (version, time, source) and the
//    visitor goes to the shop bot with a single-use link t.me/<bot>?start=b-<token>. Inside Telegram (Mini App) or signed in, the
//    chat is known and linked at once — no link at all.
//  * Admin + GM are told and confirm (they may change the job length — CEO) or decline. Nobody answers: 30 min → Admin + GM are
//    reminded, 60 min → the CEO; never declined by itself, the customer gets no extra message; once the appointment time has
//    passed the hold ends and the booking is «expired» (Admin + GM told).
//  * Quote requests: the same lines + a description + up to 5 photos (type and size checked, metadata stripped) → the GM; the same
//    one-tap link.
import { createHmac, randomBytes } from "node:crypto";
import { customerText, kmDigits, normalizeKhPhone, parseWebLines, pinUrl, SITE_CONSENT_VERSION, WEB_CATEGORY_GROUP, WEB_CONFIRM_MIN, WEB_DAYS, WEB_ESCALATE_MIN,
  WEB_LEAD_MIN, WEB_MAX_PHOTOS, webHours, webSlotStarts, type ConsentSource, type ServiceCategory, type WebCategory, type WebLineRef } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { featureOn } from "../lib/features.js";
import { AppError, notFound } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { cancelBookingIn, confirmWebBookingIn, dropUnacceptedAccount, nextBookingNumber } from "./bookings.js";
import { issueInitialPassword } from "./customer-auth.js";
import { btn, customerGrid, menuUrl, row, tellSubscriber, type CustomerMsg } from "./customer-bot.js";
import type { CustomerSession } from "./customer-home.js";
import { tellCustomer } from "./customer-notify.js";
import { hubCall, hubConfigured, shopBotUsername } from "./hub-client.js";
import { checkImage, writeImage } from "./jobs.js";
import { customerByPhone, notifyRequestStaff } from "./requests.js";
import { checkFormToken, readUpload, siteCompanyId } from "./site.js";
import { fmtLocal, flushOutbox, notifyUser } from "./telegram.js";

/** abuse guard: at most this many online bookings may wait for an answer at the same time (each one holds a technician and
 *  rings Admin + GM); beyond it the visitor is asked to call. An object so the tests can lower it. */
export const webLimits = { maxPending: 30 };

export type WebSlot = { time: string; at: string; free: boolean; why?: "past" | "closed" | "full" };
export type WebDay = { date: string; dow: number; open: boolean; slots: WebSlot[] };

// ---------- the website catalog ----------
export type WebItem = { id: string; code: string | null; name_km: string; name_en: string | null; category: ServiceCategory; web_category: WebCategory | null; unit: string;
  from_price: number | null; duration_min: number; quote_only: boolean };
const ITEM = (db: Db) => db`id, code, name_km, name_en, category::text as category, web_category, unit, from_price, duration_min, quote_only`;
/** what a visitor can choose: active services shown on the website */
export async function websiteItems(db: Db, companyId: string): Promise<WebItem[]> {
  return db<WebItem[]>`select ${ITEM(db)} from catalog_items where company_id = ${companyId} and kind = 'service' and is_active and show_on_website
    order by web_category nulls last, quote_only, (from_price is null), code nulls last, name_km limit 120`;
}
export type Line = { id: string; code: string | null; name_km: string; name_en: string | null; qty: number; minutes: number; from_price: number | null; quote_only: boolean };
export type Lines = { lines: Line[]; minutes: number; price: number | null; quote: boolean; category: ServiceCategory; text_km: string; text_en: string };
const lineText = (l: { name: string; qty: number }) => (l.qty > 1 ? `${l.name} ×${l.qty}` : l.name);
export const linesText = (lines: Pick<Line, "name_km" | "name_en" | "qty">[], lang: "km" | "en") => lines.map((l) => lineText({ name: lang === "en" && l.name_en ? l.name_en : l.name_km, qty: l.qty })).join(" · ");
/** the lines a visitor chose → items of the website catalog (else SERVICE_NOT_BOOKABLE), the job length, the price, quote or booking */
export async function resolveLines(db: Db, companyId: string, refs: WebLineRef[] | null): Promise<Lines> {
  if (!refs?.length) throw new AppError("SERVICE_NOT_BOOKABLE", 404);
  const items = new Map((await db<WebItem[]>`select ${ITEM(db)} from catalog_items where company_id = ${companyId} and kind = 'service' and is_active and show_on_website
    and id = any(${db.array(refs.map((r) => r.id))}::uuid[])`).map((i) => [i.id, i]));
  const lines = refs.map((r): Line => {
    const i = items.get(r.id);
    if (!i) throw new AppError("SERVICE_NOT_BOOKABLE", 404);
    return { id: i.id, code: i.code, name_km: i.name_km, name_en: i.name_en, qty: r.qty, minutes: i.duration_min, from_price: i.from_price, quote_only: i.quote_only };
  });
  const first = items.get(refs[0]!.id)!;
  return { lines, minutes: lines.reduce((s, l) => s + l.minutes, 0), price: lines.every((l) => l.from_price != null) ? lines.reduce((s, l) => s + l.from_price! * l.qty, 0) : null,
    quote: lines.some((l) => l.quote_only), category: first.web_category ? WEB_CATEGORY_GROUP[first.web_category] : first.category, text_km: linesText(lines, "km"), text_en: linesText(lines, "en") };
}

// ---------- capacity + slots ----------
type Span = { s: Date; e: Date };
type Load = { techs: string[]; busy: (Span & { user_id: string })[]; away: (Span & { user_id: string })[]; waiting: Span[] };
async function loadCapacity(db: Db, companyId: string, from: Date, to: Date, exclude?: string | null): Promise<Load> {
  const skip = exclude ? db`and b.id <> ${exclude}` : db``;
  const techs = (await db<{ id: string }[]>`select id from users where company_id = ${companyId} and is_active and role = 'tech'`).map((x) => x.id);
  const busy = await db<(Span & { user_id: string })[]>`select bt.user_id, b.scheduled_at as s, b.ends_at as e from booking_technicians bt join bookings b on b.id = bt.booking_id
    where b.company_id = ${companyId} and b.status <> 'cancelled' and b.scheduled_at is not null ${skip} and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  const away = await db<(Span & { user_id: string })[]>`select user_id, starts_at as s, ends_at as e from staff_leaves
    where company_id = ${companyId} and status = 'approved' and tstzrange(starts_at, ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  const waiting = await db<Span[]>`select b.scheduled_at as s, b.ends_at as e from bookings b
    where b.company_id = ${companyId} and b.status in ('new', 'quoted') and b.scheduled_at is not null ${skip}
      and not exists (select 1 from booking_technicians t where t.booking_id = b.id) and tstzrange(b.scheduled_at, b.ends_at, '[)') && tstzrange(${from}, ${to}, '[)')`;
  return { techs, busy, away, waiting };
}
const hit = (x: Span, a: number, b: number) => x.s.getTime() < b && x.e.getTime() > a;
/** a technician can take [a, b): the crew is free (a booking that already has one), else one technician more than the waiting jobs */
function freeFor(L: Load, a: number, b: number, team?: string[]): boolean {
  const taken = (id: string) => L.busy.some((x) => x.user_id === id && hit(x, a, b)) || L.away.some((x) => x.user_id === id && hit(x, a, b));
  if (team?.length) return !team.some(taken);
  return L.techs.filter((id) => !taken(id)).length - L.waiting.filter((x) => hit(x, a, b)).length > 0;
}

/** the slot grid of the next WEB_DAYS days for a job of `minutes`. `exclude` = a booking that is being moved (its own time does
 *  not count); `team` = its assigned crew — then the slot is free when exactly these people are free (the reschedule rule). */
export async function slotGrid(db: Db, companyId: string, minutes: number, o: { exclude?: string | null; team?: string[] } = {}): Promise<WebDay[]> {
  const st = (await db<{ tz: string; today: string; work_days: number[]; holidays: string[]; hours: unknown }[]>`
    select c.timezone as tz, (now() at time zone c.timezone)::date::text as today, s.work_days, array(select h::text from unnest(s.holidays) h) as holidays, s.website->'hours' as hours
    from companies c join company_settings s on s.company_id = c.id where c.id = ${companyId}`)[0];
  if (!st) throw notFound();
  const starts = webSlotStarts(webHours(st.hours as never), minutes);
  const dayRows = await db<{ day: string; dow: number }[]>`select d::date::text as day, extract(isodow from d::date)::int as dow
    from generate_series(${st.today}::date, ${st.today}::date + ${WEB_DAYS - 1}::int, interval '1 day') d order by 1`;
  if (!starts.length) return dayRows.map((d) => ({ date: d.day, dow: d.dow, open: false, slots: [] }));
  const grid = await db<{ day: string; m: number; at: Date }[]>`select d::date::text as day, m, ((d::date + make_interval(mins => m)) at time zone ${st.tz}) as at
    from generate_series(${st.today}::date, ${st.today}::date + ${WEB_DAYS - 1}::int, interval '1 day') d cross join unnest(${db.array(starts)}::int[]) m order by 1, 2`;
  const L = await loadCapacity(db, companyId, grid[0]!.at, new Date(grid.at(-1)!.at.getTime() + minutes * 60_000), o.exclude);
  const earliest = Date.now() + WEB_LEAD_MIN * 60_000;
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return dayRows.map((d) => {
    const open = st.work_days.includes(d.dow) && !st.holidays.includes(d.day);
    return { date: d.day, dow: d.dow, open, slots: grid.filter((g) => g.day === d.day).map((g): WebSlot => {
      const a = g.at.getTime(), b = a + minutes * 60_000;
      const why = !open ? "closed" : a < earliest ? "past" : !freeFor(L, a, b, o.team) ? "full" : undefined;
      return { time: hm(g.m), at: g.at.toISOString(), free: !why, ...(why ? { why } : {}) };
    }) };
  });
}
/** what the public sees of a grid: day, time, free or not */
export const publicDays = (days: WebDay[]) => days.map((d) => ({ date: d.date, dow: d.dow, open: d.open, slots: d.slots.map((s) => ({ time: s.time, at: s.at, free: s.free })) }));

export async function publicSlots(items: string) {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  const r = await resolveLines(sql, companyId, parseWebLines(items));
  if (r.quote) throw new AppError("QUOTE_ONLY", 400);
  return { minutes: r.minutes, price: r.price, days: publicDays(await slotGrid(sql, companyId, r.minutes)) };
}

// ---------- the single-use Telegram link: t.me/<bot>?start=b-<token> (a booking or a quote request) ----------
/** derived from the id with the server secret (the page can show it again); the table keeps only its hash + used_at */
const token = (key: string) => `b-${createHmac("sha256", config.sessionSecret).update(key).digest("base64url").slice(0, 20)}`;
const bookingToken = (id: string) => token(`booking-link:${id}`);
const requestToken = (id: string) => token(`request-link:${id}`);
export const botLink = async (tok: string) => { const bot = await shopBotUsername().catch(() => null); return bot ? `https://t.me/${bot}?start=${tok}` : null; };

type Linked = { number: string | null; quote: boolean; password: string | null; already: boolean };
/** the chat `sub` takes the booking: the booking-level link at once; the customer RECORD only when that is safe — the staff
 *  already confirmed it, or the record exists only because of this booking (a phone number alone opens nobody's history) */
async function linkBookingIn(t: Db, bookingId: string, sub: number, via: "token" | "miniapp" | "session"): Promise<Linked> {
  const b = (await t<{ number: string; company_id: string; web_status: string | null; customer_id: string; csub: string | null }[]>`select b.number, b.company_id, b.web_status, b.customer_id,
      c.tg_subscriber_id::text as csub from bookings b join customers c on c.id = b.customer_id where b.id = ${bookingId} for update of b`)[0]!;
  await t`update bookings set web_subscriber_id = ${sub} where id = ${bookingId}`;
  await t`update booking_link_tokens set used_at = now(), used_by = ${sub} where booking_id = ${bookingId} and used_at is null`;
  const already = b.csub === String(sub);
  const fresh = (await t`select 1 from bookings b2 where b2.customer_id = ${b.customer_id} and b2.id <> ${bookingId} and b2.status <> 'cancelled' limit 1`).length === 0;
  const linked = !already && (b.web_status === "confirmed" || fresh) && (await t`update customers set tg_subscriber_id = ${sub} where id = ${b.customer_id} and tg_subscriber_id is null returning id`).length > 0;
  await audit(t, { companyId: b.company_id, userId: null, action: "booking.tg_link", source: via === "session" ? "system" : "telegram", table: "bookings", rowId: bookingId, new: { via, customer_linked: linked } });
  return { number: b.number, quote: false, password: linked ? await issueInitialPassword(t, b.customer_id) : null, already };
}
async function linkRequestIn(t: Db, requestId: string, sub: number, via: "token" | "miniapp" | "session"): Promise<Linked> {
  const r = (await t<{ company_id: string; customer_id: string | null; made: boolean; csub: string | null }[]>`select r.company_id, r.customer_id, coalesce((r.meta->>'new_customer')::boolean, false) as made,
      c.tg_subscriber_id::text as csub from service_requests r left join customers c on c.id = r.customer_id where r.id = ${requestId} for update of r`)[0]!;
  await t`update service_requests set subscriber_id = ${sub} where id = ${requestId}`;
  await t`update booking_link_tokens set used_at = now(), used_by = ${sub} where request_id = ${requestId} and used_at is null`;
  const already = !!r.customer_id && r.csub === String(sub);
  const linked = !already && r.made && !!r.customer_id && (await t`update customers set tg_subscriber_id = ${sub} where id = ${r.customer_id} and tg_subscriber_id is null returning id`).length > 0;
  await audit(t, { companyId: r.company_id, userId: null, action: "service.request_tg_link", source: via === "session" ? "system" : "telegram", table: "service_requests", rowId: requestId, new: { via, customer_linked: linked } });
  return { number: null, quote: true, password: linked ? await issueInitialPassword(t, r.customer_id!) : null, already };
}
/** the bot's answer after a link: «linked» (+ the first password) with the keyboard grid; a customer who was linked before just
 *  hears that the booking arrived */
function linkedMsg(l: Linked): CustomerMsg {
  const text = l.already && !l.password ? (l.quote ? customerText.quoteReceived : customerText.received(l.number!)) : l.quote ? customerText.linkedQuote(l.password) : customerText.linked(l.number, l.password);
  return { text, keyboard: customerGrid(), hint: l.password ? customerText.hint : null, menu_url: menuUrl() };
}

/** the hub: somebody opened t.me/<bot>?start=b-<token> (the website button was the consent). Single use. */
export async function consumeBookingToken(tok: string, subscriberId: number) {
  return tx(null, async (t) => {
    const k = (await t<{ booking_id: string | null; request_id: string | null; used_at: Date | null; expired: boolean; status: string | null }[]>`
      select k.booking_id, k.request_id, k.used_at, k.expires_at < now() as expired, b.status from booking_link_tokens k left join bookings b on b.id = k.booking_id
      where k.token_hash = ${sha256(tok)} for update of k`)[0];
    if (!k || k.expired || k.status === "cancelled") return { ok: false, error: "CODE_INVALID", text: customerText.linkUsed, buttons: row(btn.book()) };
    if (k.used_at) return { ok: false, error: "CODE_USED", text: customerText.linkUsed, buttons: row(btn.book()) };
    const l = k.booking_id ? await linkBookingIn(t, k.booking_id, subscriberId, "token") : await linkRequestIn(t, k.request_id!, subscriberId, "token");
    return { ok: true, booking: l.number, ...linkedMsg(l) };
  });
}

/** inside Telegram: the launch data says who it is (the hub checks it with the shop bot's token) and subscribes that person — the
 *  website button was the consent. Returns the hub subscriber id, or null. */
async function miniAppSubscriber(initData: string): Promise<number | null> {
  if (!hubConfigured()) return null;
  const r = await hubCall("POST", "/internal/web-subscribe", { init_data: initData, source: "miniapp" }).catch(() => null);
  return r && r.status === 200 && r.json?.ok === true && typeof r.json.subscriber_id === "number" ? r.json.subscriber_id : null;
}
/** after the save: link at once when the chat is known (signed in, or inside Telegram) and tell it; else the bot link */
async function linkAfterSave(target: { bookingId?: string; requestId?: string }, tok: string, who: { session: CustomerSession | null; initData?: string | null }) {
  const sub = who.session?.subscriberId ?? (who.initData ? await miniAppSubscriber(who.initData) : null);
  if (!sub) return { linked: false, link: await botLink(tok) };
  const via = who.session ? "session" : "miniapp";
  const l = await tx(null, (t) => (target.bookingId ? linkBookingIn(t, target.bookingId, sub, via) : linkRequestIn(t, target.requestId!, sub, via)));
  const m = linkedMsg(l);
  await tellSubscriber(sub, l.already ? { text: m.text, buttons: row(btn.track()), hint: m.hint } : m);
  return { linked: true, link: null };
}

// ---------- submit ----------
export type WebBookingInput = { items: string; at: string; address: string; lat?: number | null; lng?: number | null; accuracy?: number | null; name: string; phone: string; note?: string | null;
  consent?: boolean; ts?: string; company_url?: string; lang?: "km" | "en"; init_data?: string | null };

/** honeypot / too-fast → looks like success, nothing stored; a stale page → FORM_EXPIRED */
function botCheck(v: { ts?: string; company_url?: string }): "bot" | "ok" {
  if ((v.company_url ?? "") !== "") return "bot";
  const tok = checkFormToken(v.ts ?? "");
  if (tok === "bad") throw new AppError("FORM_EXPIRED", 400);
  return tok === "fresh" ? "bot" : "ok";
}
/** the button carries the consent (its text is above it); the page sends consent: true with it */
function person(v: { name: string; phone: string; consent?: boolean }, afterConsent?: () => void): { name: string; phone: string } {
  if (v.consent !== true) throw new AppError("CONSENT_REQUIRED", 400);
  afterConsent?.();
  const name = v.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) throw new AppError("NAME_REQUIRED", 400);
  const phone = normalizeKhPhone(v.phone);
  if (!phone) throw new AppError("INVALID_PHONE", 400);
  return { name, phone };
}
const consentSource = (who: { session: CustomerSession | null; initData?: string | null }): ConsentSource => (who.initData ? "miniapp" : "web");
const place = (v: { address?: string; location?: string; lat?: number | null; lng?: number | null; accuracy?: number | null }, text: string) => [
  text ? `📍 ${text}` : null, v.lat != null && v.lng != null ? `🗺 ${pinUrl(v.lat, v.lng)}${v.accuracy != null ? ` (±${Math.round(v.accuracy)} m)` : ""}` : null];

export async function submitWebBooking(ip: string, v: WebBookingInput, who: { session: CustomerSession | null }): Promise<{ ref: string | null; number?: string; linked?: boolean; link?: string | null }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (botCheck(v) === "bot") return { ref: null };
  const { name, phone } = person(v);
  const address = v.address.trim().replace(/\s+/g, " ").slice(0, 300), gps = v.lat != null && v.lng != null;
  if (address.length < 3 && !gps) throw new AppError("ADDRESS_REQUIRED", 400);
  const r = await resolveLines(sql, companyId, parseWebLines(v.items));
  if (r.quote) throw new AppError("QUOTE_ONLY", 400);
  const at = new Date(v.at);
  if (Number.isNaN(at.getTime())) throw new AppError("SLOT_INVALID", 400);
  if (!checkRate(`site:book:ip:${ip}`, 5, 3600) || !checkRate(`site:book:phone:${phone}`, 3, 86400)) throw new AppError("RATE_LIMITED", 429);
  const note = v.note?.trim().slice(0, 500) || null, source = consentSource({ ...who, initData: v.init_data });
  const accuracy = gps && v.accuracy != null ? Math.min(100_000, Math.max(0, Math.round(v.accuracy))) : null;
  const saved = await tx(null, async (t) => {
    // one web booking at a time per company: the slot is checked and taken under this lock (race-safe)
    await t`select pg_advisory_xact_lock(hashtextextended(${`web-booking:${companyId}`}, 0))`;
    if ((await t<{ n: number }[]>`select count(*)::int as n from bookings where company_id = ${companyId} and web_status = 'pending' and status <> 'cancelled'`)[0]!.n >= webLimits.maxPending) throw new AppError("TOO_MANY_PENDING", 429);
    const slot = (await slotGrid(t, companyId, r.minutes)).flatMap((d) => d.slots).find((s) => s.at === at.toISOString());
    if (!slot || slot.why === "past" || slot.why === "closed") throw new AppError("SLOT_INVALID", 400);
    if (!slot.free) throw new AppError("SLOT_TAKEN", 409);
    // the customer: the one who has this phone number — that record is NOT touched (the visitor is not verified yet) — else a
    // new record with the consent just given. The consent itself is always kept on the request (meta.consent).
    let customerId = await customerByPhone(t, companyId, phone);
    if (!customerId) customerId = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, lat, lng, origin, consent_at, consent_version, consent_source)
      values (${companyId}, ${name}, ${t.array([phone])}, ${address || null}, ${v.lat ?? null}, ${v.lng ?? null}, 'website', now(), ${SITE_CONSENT_VERSION}, ${source}) returning id`)[0]!.id;
    const c = (await t<{ address: string | null; zone: string; tz: string }[]>`select cu.address, cu.zone::text as zone, co.timezone as tz from customers cu join companies co on co.id = cu.company_id where cu.id = ${customerId}`)[0]!;
    const number = await nextBookingNumber(t, companyId);
    const end = new Date(at.getTime() + r.minutes * 60_000), ref = randomBytes(16).toString("base64url");
    const id = (await t<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, service_item_id, scheduled_at, ends_at, address, lat, lng, loc_accuracy, zone, notes,
        created_by, origin, web_status, web_ref, web_lines)
      values (${companyId}, ${number}, ${customerId}, 'A', ${r.category}::service_category, 'new', ${r.text_km.slice(0, 1000)}, ${r.lines[0]!.id}, ${at}, ${end}, ${address || c.address}, ${v.lat ?? null}, ${v.lng ?? null},
        ${accuracy}, ${c.zone}::zone, ${note}, null, 'website', 'pending', ${ref}, ${t.json(r.lines as never)}) returning id`)[0]!.id;
    await t`insert into booking_status_log (booking_id, from_status, to_status, by) values (${id}, null, 'new', null)`;
    await t`insert into booking_link_tokens (token_hash, company_id, booking_id, expires_at) values (${sha256(bookingToken(id))}, ${companyId}, ${id}, now() + interval '7 days')`;
    const consent = { at: new Date().toISOString(), version: SITE_CONSENT_VERSION, source };
    await audit(t, { companyId, userId: null, action: "booking.create", source: "system", table: "bookings", rowId: id, new: { number, origin: "website", customer_id: customerId, scheduled_at: at, ends_at: end, lines: r.lines.length }, ip });
    await audit(t, { companyId, userId: null, action: "customer.consent", source: "system", table: "customers", rowId: customerId, new: consent, ip });
    const text = [`🛠 ${r.text_km}`, `🕒 ${fmtLocal(at, c.tz || "Asia/Phnom_Penh")} · ${kmDigits(Math.round(r.minutes / 6) / 10)} ម៉ោង`, ...place(v, address), note ? `📝 ${note}` : null].filter(Boolean).join("\n");
    const textEn = [`🛠 ${r.text_en}`, `🕒 ${fmtLocal(at, c.tz || "Asia/Phnom_Penh")} · ${Math.round(r.minutes / 6) / 10} h`, ...place(v, address), note ? `📝 ${note}` : null].filter(Boolean).join("\n");
    const rid = (await t<{ id: string }[]>`insert into service_requests (company_id, source, kind, booking_id, customer_id, name, phone, text, meta)
      values (${companyId}, 'website', 'booking', ${id}, ${customerId}, ${name}, ${phone}, ${text.slice(0, 1000)},
        ${t.json({ service_item_id: r.lines[0]!.id, service: r.text_km, lines: r.lines, at: at.toISOString(), minutes: r.minutes, lat: v.lat ?? null, lng: v.lng ?? null, accuracy,
          lang: v.lang === "en" ? "en" : "km", consent } as never)}) returning id`)[0]!.id;
    await notifyRequestStaff(t, companyId, ["admin", "gm"], { km: `🌐 ការកក់ពីគេហទំព័រ · ${number}`, en: `🌐 Website booking · ${number}` },
      { km: `👤 ${name} · 📞 ${phone}\n${text}\n⏱ សូមបញ្ជាក់ក្នុង ${kmDigits(WEB_CONFIRM_MIN)} នាទី`, en: `👤 ${name} · 📞 ${phone}\n${textEn}\n⏱ Please confirm within ${WEB_CONFIRM_MIN} minutes` }, rid);
    return { id, ref, number };
  });
  const l = await linkAfterSave({ bookingId: saved.id }, bookingToken(saved.id), { session: who.session, initData: v.init_data });
  return { ref: saved.ref, number: saved.number, ...l };
}

// ---------- the «request sent» screen ----------
export type CustomerState = "pending" | "confirmed" | "on_the_way" | "working" | "done" | "declined" | "cancelled" | "expired";
/** what the customer is told about a booking (the staff's own statuses stay inside) */
export function customerState(status: string, webStatus: string | null): CustomerState {
  if (status === "cancelled") return webStatus === "declined" ? "declined" : webStatus === "expired" ? "expired" : "cancelled";
  if (webStatus === "pending") return "pending";
  if (status === "en_route") return "on_the_way";
  if (status === "on_site" || status === "working") return "working";
  return ["new", "survey", "quoted", "assigned"].includes(status) ? "confirmed" : "done";
}
type StoredLine = { name_km: string; name_en: string | null; qty: number };
export async function doneView(ref: string) {
  const companyId = await siteCompanyId();
  const b = companyId ? (await sql<{ id: string; number: string; status: string; web_status: string | null; service_text: string; web_lines: StoredLine[] | null; name_en: string | null; scheduled_at: Date; linked: boolean; token_live: boolean | null }[]>`
    select b.id, b.number, b.status, b.web_status, b.service_text, b.web_lines, i.name_en, b.scheduled_at, b.web_subscriber_id is not null as linked,
      (select k.used_at is null and k.expires_at > now() from booking_link_tokens k where k.booking_id = b.id) as token_live
    from bookings b left join catalog_items i on i.id = b.service_item_id where b.web_ref = ${ref} and b.company_id = ${companyId}`)[0] : null;
  if (!b) throw notFound();
  const state = customerState(b.status, b.web_status);
  const lines = b.web_lines ?? [{ name_km: b.service_text, name_en: b.name_en, qty: 1 }];
  return { number: b.number, state, service_km: linesText(lines, "km"), service_en: linesText(lines, "en"), at: b.scheduled_at, linked: b.linked,
    link: b.token_live && !b.linked && (state === "pending" || state === "confirmed") ? await botLink(bookingToken(b.id)) : null };
}

// ---------- Admin / GM: confirm (the job length may change) or decline ----------
/** a technician can still take [start, start + minutes) when the booking keeps its place in the queue (its own time excluded) */
async function stillFree(db: Db, companyId: string, bookingId: string, start: Date, minutes: number): Promise<boolean> {
  const end = new Date(start.getTime() + minutes * 60_000);
  const team = (await db<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${bookingId}`).map((x) => x.user_id);
  return freeFor(await loadCapacity(db, companyId, start, end, bookingId), start.getTime(), end.getTime(), team);
}
export async function decideWebBooking(user: SessionUser, ip: string | null, requestId: string, decision: "confirm" | "decline", reason = "", minutes?: number) {
  const done = await tx(user.id, async (t) => {
    const r = (await t<{ booking_id: string | null; web_status: string | null; scheduled_at: Date | null; ends_at: Date | null }[]>`select r.booking_id, b.web_status, b.scheduled_at, b.ends_at
      from service_requests r left join bookings b on b.id = r.booking_id where r.id = ${requestId} and r.company_id = ${user.companyId} and r.kind = 'booking' and r.status = 'new' for update of r`)[0];
    if (!r?.booking_id) throw notFound();
    if (r.web_status !== "pending") throw new AppError("NOT_PENDING", 409);
    let account: { subscriber: number; password: string } | null = null;
    if (decision === "confirm") {
      // CEO: Admin / GM may change the job length while confirming — only while a technician can still take the longer job
      const now = r.scheduled_at && r.ends_at ? Math.round((r.ends_at.getTime() - r.scheduled_at.getTime()) / 60_000) : null;
      if (minutes && r.scheduled_at && minutes !== now) {
        if (!(await stillFree(t, user.companyId, r.booking_id, r.scheduled_at, minutes))) throw new AppError("TECH_NOT_FREE", 409);
        await t`update bookings set ends_at = ${new Date(r.scheduled_at.getTime() + minutes * 60_000)} where id = ${r.booking_id}`;
        await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.web_duration", table: "bookings", rowId: r.booking_id, old: { minutes: now }, new: { minutes }, ip });
      }
      account = await confirmWebBookingIn(t, user.companyId, user.id, r.booking_id, ip);
    } else { // cancelled with the reason: the slot is free again; the request closes as «declined» inside
      await cancelBookingIn(t, { companyId: user.companyId, userId: user.id, name: { km: user.fullName, en: user.fullName } }, ip, r.booking_id, reason);
      await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.web_decline", table: "bookings", rowId: r.booking_id, new: { web_status: "declined", reason }, ip });
    }
    return { bookingId: r.booking_id, account };
  });
  await tellCustomer(done.bookingId, (b) => (decision === "confirm"
    ? { text: customerText.confirmed(b.number, b.day, b.time, b.technician), buttons: row(btn.track()) }
    : { text: customerText.declined(b.number, reason), buttons: row(btn.rebook()) }));
  // the customer record was linked by this confirmation → its first password, to that chat only (D-103)
  if (done.account) await tellSubscriber(done.account.subscriber, { text: customerText.password(done.account.password), hint: customerText.hint, buttons: row(btn.login()) });
  return { ok: true };
}

// ---------- nobody answered (CEO): reminders, then «expired» once the time has passed ----------
const EXPIRED_REASON = "ផុតពេល — មិនបានបញ្ជាក់មុនម៉ោងណាត់";
export async function webBookingAlerts(): Promise<{ reminded: number; escalated: number; expired: number }> {
  const out = { reminded: 0, escalated: 0, expired: 0 };
  if (!featureOn("website")) return out;
  const due = await sql<{ id: string; company_id: string; number: string; past: boolean; m30: boolean; m60: boolean; reminded: boolean; escalated: boolean }[]>`
    select b.id, b.company_id, b.number, b.scheduled_at <= now() as past, b.created_at <= now() - ${WEB_CONFIRM_MIN}::int * interval '1 minute' as m30,
      b.created_at <= now() - ${WEB_ESCALATE_MIN}::int * interval '1 minute' as m60,
      exists (select 1 from web_booking_alerts a where a.booking_id = b.id and a.kind = 'remind') as reminded,
      exists (select 1 from web_booking_alerts a where a.booking_id = b.id and a.kind = 'escalate') as escalated
    from bookings b where b.origin = 'website' and b.web_status = 'pending' and b.status <> 'cancelled'
      and (b.scheduled_at <= now() or b.created_at <= now() - ${WEB_CONFIRM_MIN}::int * interval '1 minute') order by b.created_at limit 100`;
  for (const b of due) {
    if (b.past) {
      const ok = await tx(null, async (t) => {
        const x = (await t<{ id: string }[]>`update bookings set status = 'cancelled', web_status = 'expired', cancel_reason = ${EXPIRED_REASON}, cancelled_at = now(), web_decided_at = now()
          where id = ${b.id} and web_status = 'pending' and status <> 'cancelled' returning id`)[0];
        if (!x) return false;
        await t`update service_requests set status = 'done', outcome = 'expired', note = ${EXPIRED_REASON}, handled_at = now() where booking_id = ${b.id} and status = 'new'`;
        await dropUnacceptedAccount(t, b.id);
        await t`insert into web_booking_alerts (booking_id, kind) values (${b.id}, 'expired') on conflict do nothing`;
        await audit(t, { companyId: b.company_id, userId: null, action: "booking.web_expired", source: "system", table: "bookings", rowId: b.id, new: { web_status: "expired" } });
        await notifyRequestStaff(t, b.company_id, ["admin", "gm"], { km: `⌛ ការកក់ ${b.number} ផុតពេល`, en: `⌛ Booking ${b.number} expired` },
          { km: "ម៉ោងណាត់បានកន្លងហើយ មុនពេលបញ្ជាក់។ ម៉ោងនោះទំនេរវិញ។", en: "The appointment time passed before anyone confirmed. The slot is free again." }, `expired:${b.id}`);
        return true;
      });
      if (ok) out.expired++;
      continue;
    }
    if (b.m30 && !b.reminded) {
      await tx(null, async (t) => {
        if ((await t`insert into web_booking_alerts (booking_id, kind) values (${b.id}, 'remind') on conflict do nothing returning 1`).length === 0) return;
        await notifyRequestStaff(t, b.company_id, ["admin", "gm"], { km: `⏰ ការកក់ ${b.number} រង់ចាំ ${kmDigits(WEB_CONFIRM_MIN)} នាទីហើយ`, en: `⏰ Booking ${b.number} has waited ${WEB_CONFIRM_MIN} minutes` },
          { km: "សូមបញ្ជាក់ ឬបដិសេធ", en: "Please confirm or decline" }, `remind:${b.id}`);
        out.reminded++;
      });
    }
    if (b.m60 && !b.escalated) {
      await tx(null, async (t) => {
        if ((await t`insert into web_booking_alerts (booking_id, kind) values (${b.id}, 'escalate') on conflict do nothing returning 1`).length === 0) return;
        for (const u of await t<{ id: string }[]>`select id from users where company_id = ${b.company_id} and is_active and role = 'ceo'`)
          await notifyUser(t, b.company_id, u.id, "service.request", { km: `🚨 ការកក់ ${b.number} មិនទាន់បញ្ជាក់ ${kmDigits(WEB_ESCALATE_MIN)} នាទី`, en: `🚨 Booking ${b.number} not confirmed after ${WEB_ESCALATE_MIN} minutes` },
            { km: "Admin និង GM មិនទាន់ឆ្លើយតប", en: "Admin and GM have not answered yet" }, "/requests", `escalate:${b.id}:${u.id}`);
        out.escalated++;
      });
    }
  }
  if (out.reminded || out.escalated || out.expired) void flushOutbox().catch(() => undefined);
  return out;
}

// ---------- quote request ----------
export type QuoteInput = { items?: string | null; category: string; description: string; photos?: string[]; name: string; phone: string; location?: string; lat?: number | null; lng?: number | null;
  accuracy?: number | null; consent?: boolean; ts?: string; company_url?: string; lang?: "km" | "en"; init_data?: string | null };
const CATEGORY: Record<"km" | "en", Record<string, string>> = {
  km: { ac: "ម៉ាស៊ីនត្រជាក់", water: "ទឹក", electric: "ភ្លើង", cctv: "កាមេរ៉ា CCTV", construction: "សំណង់", decor: "តុបតែង", other: "ផ្សេងៗ" },
  en: { ac: "Air conditioner", water: "Water", electric: "Electrical", cctv: "CCTV camera", construction: "Construction", decor: "Decoration", other: "Other" },
};
export const QUOTE_CATEGORIES = ["ac", "water", "electric", "cctv", "construction", "decor", "other"] as const;

export async function submitQuote(ip: string, v: QuoteInput, who: { session: CustomerSession | null }): Promise<{ ok: true; ref?: string; linked?: boolean; link?: string | null }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (botCheck(v) === "bot") return { ok: true };
  const description = v.description.trim().slice(0, 600);
  const refs = parseWebLines(v.items);
  const { name, phone } = person(v, () => { if (description.length < 5 && !refs) throw new AppError("DESCRIPTION_REQUIRED", 400); });
  const photos = v.photos ?? [];
  if (photos.length > WEB_MAX_PHOTOS) throw new AppError("TOO_MANY_PHOTOS", 400);
  const lines = refs ? await resolveLines(sql, companyId, refs) : null;
  const category = (QUOTE_CATEGORIES as readonly string[]).includes(v.category) ? v.category : "other";
  const location = (v.location ?? "").trim().replace(/\s+/g, " ").slice(0, 200), gps = v.lat != null && v.lng != null;
  if (location.length < 3 && !gps) throw new AppError("LOCATION_REQUIRED", 400);
  if (!checkRate(`site:quote:ip:${ip}`, 5, 3600) || !checkRate(`site:quote:phone:${phone}`, 3, 86400)) throw new AppError("RATE_LIMITED", 429);
  const images = photos.map((p) => checkImage(p, undefined, "BAD_IMAGE", true)); // every photo is checked and cleaned before anything is stored
  const files: { id: string; rel: string; mime: string; bytes: number }[] = [];
  for (const img of images) files.push(await writeImage(companyId, img));
  const source = consentSource({ ...who, initData: v.init_data }), consent = { at: new Date().toISOString(), version: SITE_CONSENT_VERSION, source };
  const accuracy = gps && v.accuracy != null ? Math.min(100_000, Math.max(0, Math.round(v.accuracy))) : null;
  // the request keeps what the visitor wrote; the category is a code in meta — every reader sees it in their own language
  const text = [lines ? `🔧 ${lines.text_km}` : null, description || null, ...place(v, location), files.length ? `🖼 ${files.length}` : null].filter(Boolean).join("\n");
  const ref = randomBytes(16).toString("base64url");
  const saved = await tx(null, async (t) => {
    let customerId = await customerByPhone(t, companyId, phone), made = false;
    if (!customerId) { // a new customer with the consent just given — the chat is linked to it when the link is opened
      customerId = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, lat, lng, origin, consent_at, consent_version, consent_source)
        values (${companyId}, ${name}, ${t.array([phone])}, ${location || null}, ${v.lat ?? null}, ${v.lng ?? null}, 'website', now(), ${SITE_CONSENT_VERSION}, ${source}) returning id`)[0]!.id;
      made = true;
    }
    const id = (await t<{ id: string }[]>`insert into service_requests (company_id, source, kind, customer_id, name, phone, text, meta)
      values (${companyId}, 'website', 'quote', ${customerId}, ${name}, ${phone}, ${text.slice(0, 1000)},
        ${t.json({ category, ref, new_customer: made, lines: lines?.lines ?? [], service_item_id: lines?.lines[0]?.id ?? null, service: lines?.text_km ?? null, location: location || null, lat: v.lat ?? null, lng: v.lng ?? null,
          accuracy, lang: v.lang === "en" ? "en" : "km", consent } as never)}) returning id`)[0]!.id;
    for (const f of files) await t`insert into service_request_files (id, company_id, request_id, path, mime, bytes) values (${f.id}, ${companyId}, ${id}, ${f.rel}, ${f.mime}, ${f.bytes})`;
    await t`insert into booking_link_tokens (token_hash, company_id, request_id, expires_at) values (${sha256(requestToken(id))}, ${companyId}, ${id}, now() + interval '7 days')`;
    await audit(t, { companyId, userId: null, action: "service.request", source: "system", table: "service_requests", rowId: id, new: { source: "website", kind: "quote", photos: files.length, customer_id: customerId }, ip });
    await audit(t, { companyId, userId: null, action: "customer.consent", source: "system", table: "customers", rowId: customerId, new: consent, ip });
    await notifyRequestStaff(t, companyId, ["gm"], { km: `🌐 សំណើសុំតម្លៃ · ${name}`, en: `🌐 Quote request · ${name}` },
      { km: `🧩 ${CATEGORY.km[category]}\n📞 ${phone}\n${text}`, en: `🧩 ${CATEGORY.en[category]}\n📞 ${phone}\n${text}` }, id); // a quote goes to the GM
    return { id };
  });
  const l = await linkAfterSave({ requestId: saved.id }, requestToken(saved.id), { session: who.session, initData: v.init_data });
  return { ok: true, ref, ...l };
}
/** the «quote sent» screen: linked yet, else the link (as long as it works) */
export async function quoteDoneView(ref: string) {
  const companyId = await siteCompanyId();
  const r = companyId ? (await sql<{ id: string; linked: boolean; live: boolean | null }[]>`select r.id, r.subscriber_id is not null as linked,
      (select k.used_at is null and k.expires_at > now() from booking_link_tokens k where k.request_id = r.id) as live
    from service_requests r where r.company_id = ${companyId} and r.kind = 'quote' and r.meta->>'ref' = ${ref}`)[0] : null;
  if (!r) throw notFound();
  return { linked: r.linked, link: r.live && !r.linked ? await botLink(requestToken(r.id)) : null };
}

/** a photo of a quote request — for the staff who see the requests, never public */
export async function readRequestPhoto(user: SessionUser, requestId: string, fileId: string) {
  return readUpload((await sql<{ path: string }[]>`select f.path from service_request_files f where f.id = ${fileId} and f.request_id = ${requestId} and f.company_id = ${user.companyId}`)[0]?.path);
}
