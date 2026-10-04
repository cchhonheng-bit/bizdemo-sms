// Telegram (shop side, v2.1): outbox (queue in DB, retry ≤ 5, blocked chat → failed at once — D-15) delivered
// THROUGH THE HUB (the shop has no bot token — D-51), "Booking Confirmed" text (Architecture §8.1),
// staff/group codes ONETEAM-S-xxxxxx / ONETEAM-G-xxxxxx (A3, S-11) validated when the hub forwards them.
import { deepLink, GROUP_CODE_LEN, STAFF_CODE_LEN, TEST_MARK } from "@sms/shared";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { randomCode } from "../lib/secure.js";
import { appUrl } from "../lib/app-url.js";
import { asLang, LEAD, pick, tx, ZONE, type Lang, type Tx } from "../lib/i18n.js";
import { audit } from "./audit.js";
import { hubCall, hubConfigured, sendViaHub, shopBotUsername } from "./hub-client.js";
import { ceoIds, isTestBooking } from "./test-mode.js";

export type SendResult = { ok: true } | { ok: false; error: string; permanent: boolean; retryAfter?: number };

// ---------- outbox --------------------------------------------------------------
/** silent (D-119): delivered without sound — staff alerts of customer requests made 20:00–08:00 */
export async function enqueue(db: Db, companyId: string, chatId: number | string, text: string, replyMarkup: unknown, dedupeKey: string, o: { silent?: boolean } = {}): Promise<void> {
  await db`insert into telegram_outbox (company_id, chat_id, text, reply_markup, dedupe_key, silent)
           values (${companyId}, ${String(chatId)}::bigint, ${text}, ${replyMarkup ? db.json(replyMarkup as never) : null}, ${dedupeKey}, ${o.silent === true})
           on conflict (dedupe_key) do nothing`;
}

let flushing = false;
/** Deliver pending outbox rows (called after assign and by the cron every 30 s). Returns counts. */
export async function flushOutbox(limit = 20, send: (chatId: number | string, text: string, markup?: unknown, silent?: boolean) => Promise<SendResult> = sendViaHub): Promise<{ taken: number; sent: number; failed: number; retry: number }> {
  if (flushing) return { taken: 0, sent: 0, failed: 0, retry: 0 };
  if (send === sendViaHub && !hubConfigured()) return { taken: 0, sent: 0, failed: 0, retry: 0 }; // no hub configured → keep rows pending
  flushing = true;
  const out = { taken: 0, sent: 0, failed: 0, retry: 0 };
  try {
    const rows = await sql<{ id: number; chat_id: string; text: string; reply_markup: unknown; attempts: number; silent: boolean }[]>`
      update telegram_outbox o set attempts = attempts + 1
      where o.id in (select id from telegram_outbox where status = 'pending' and attempts < 5 order by created_at limit ${Math.max(1, Math.min(limit, 50))} for update skip locked)
      returning o.id, o.chat_id, o.text, o.reply_markup, o.attempts, o.silent`;
    out.taken = rows.length;
    for (const r of rows) {
      const res = r.silent ? await send(r.chat_id, r.text, r.reply_markup ?? undefined, true) : await send(r.chat_id, r.text, r.reply_markup ?? undefined);
      if (res.ok) {
        out.sent++;
        await sql`update telegram_outbox set status = 'sent', sent_at = now(), last_error = null where id = ${r.id}`;
      } else if (res.retryAfter && !res.permanent) {
        // Telegram 429: this attempt does not count; stop the batch, the rest is retried by the next run (R8)
        out.retry++;
        const rest = rows.slice(rows.indexOf(r)).map((x) => x.id);
        await sql`update telegram_outbox set attempts = greatest(attempts - 1, 0), last_error = ${res.error} where id in ${sql(rest)}`;
        break;
      } else {
        const failed = res.permanent || r.attempts >= 5;
        if (failed) out.failed++; else out.retry++;
        await sql`update telegram_outbox set status = ${failed ? "failed" : "pending"}::outbox_status, last_error = ${res.error} where id = ${r.id}`;
      }
    }
  } finally {
    flushing = false;
  }
  return out;
}

// ---------- buttons under job messages (owner I1) --------------------------------------------
type Row = { text: string; url: string }[];
/** 📱 open the job in the app — technicians on their job page, the group on the booking page (https only, R12) */
function appRow(bookingId: string, forTech: boolean, lang: Lang): Row[] {
  if (!config.publicUrl.startsWith("https://")) return [];
  return [[{ text: pick(tx("📱 មើលក្នុងកម្មវិធី", "📱 Open in the app"), lang), url: appUrl(`${forTech ? "/tech/job/" : "/bookings/"}${bookingId}`) }]];
}
function withApp(markup: unknown, bookingId: string, forTech: boolean, lang: Lang): unknown {
  const rows = [...(((markup as { inline_keyboard?: Row[] } | null)?.inline_keyboard) ?? []), ...appRow(bookingId, forTech, lang)];
  return rows.length ? { inline_keyboard: rows } : null;
}

// ---------- Booking Confirmed text -----------------------------------------------------
export async function bookingConfirmedText(db: Db, bookingId: string, lang: Lang = "km"): Promise<{ text: string; markup: unknown | null; companyId: string; number: string }> {
  const b = (await db<{
    number: string; service_text: string; scheduled_at: Date | null; ends_at: Date | null; address: string | null; zone: string; notes: string | null; lat: number | null; lng: number | null;
    cname: string; phones: string[]; vcode: string | null; timezone: string; company_id: string;
  }[]>`select bk.number, bk.service_text, bk.scheduled_at, bk.ends_at, bk.address, bk.zone, bk.notes, bk.lat, bk.lng, bk.company_id,
              c.name as cname, c.phones, v.code as vcode, co.timezone
       from bookings bk join customers c on c.id = bk.customer_id left join vehicles v on v.id = bk.vehicle_id join companies co on co.id = bk.company_id
       where bk.id = ${bookingId}`)[0]!;
  const techs = await db<{ full_name: string; role: string }[]>`select u.full_name, t.role from booking_technicians t join users u on u.id = t.user_id
       where t.booking_id = ${bookingId} order by t.role, u.full_name`;
  const tz = b.timezone || "Asia/Phnom_Penh";
  const dt = b.scheduled_at ? fmtLocal(b.scheduled_at, tz) + (b.ends_at ? `–${fmtLocal(b.ends_at, tz).slice(-5)}` : "") : "—";
  const techLine = techs.length ? techs.map((t, i) => `${i + 1}. ${t.full_name}${t.role === "lead" ? ` (${pick(LEAD, lang)})` : ""}`).join("  ") : "—";
  const L = (km: string, en: string) => pick(tx(km, en), lang);
  const text = [
    L(`✅ បញ្ជាក់ការងារ (${b.number})`, `✅ Booking confirmed (${b.number})`),
    `📅 ${dt}`,
    `👤 ${L("អតិថិជន", "Customer")}: ${b.cname}${b.phones?.[0] ? ` · 📞 ${b.phones[0]}` : ""}`,
    `📍 ${b.address ?? "—"} (${pick(ZONE[b.zone] ?? ZONE.outside!, lang)})`,
    `🔧 ${L("សេវាកម្ម", "Service")}: ${b.service_text}`,
    `👷 ${L("ជាង", "Technicians")}: ${techLine}${b.vcode ? ` · 🚐 ${b.vcode}` : ""}`,
    `📝 ${L("ចំណាំ", "Notes")}: ${b.notes ?? "—"}`,
  ].join("\n");
  const markup = b.lat != null && b.lng != null
    ? { inline_keyboard: [[{ text: L("🗺 ផ្លូវទៅ", "🗺 Directions"), url: `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving` }]] }
    : null;
  return { text, markup, companyId: b.company_id, number: b.number };
}

export function fmtLocal(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")} · ${g("hour")}:${g("minute")}`;
}

/** D-120: a test booking never reaches the group or the technicians — the CEO gets the same message, marked 🧪 */
async function toCeoInstead(db: Db, companyId: string, bookingId: string, number: string, textIn: (lang: Lang) => string, key: string): Promise<boolean> {
  if (!(await isTestBooking(db, bookingId))) return false;
  for (const id of await ceoIds(db, companyId))
    await notifyUser(db, companyId, id, "booking.test", `${TEST_MARK} ${number}`, { km: textIn("km"), en: textIn("en") }, `/bookings/${bookingId}`, `${key}:ceo:${id}`);
  return true;
}

/** Group + every linked technician of the team get the message; every technician gets an in-app notification. */
export async function enqueueBookingConfirmed(db: Db, bookingId: string, reason: string): Promise<void> {
  const km = await bookingConfirmedText(db, bookingId, "km"), en = await bookingConfirmedText(db, bookingId, "en");
  const { companyId, number } = km;
  if (await toCeoInstead(db, companyId, bookingId, number, (l) => (l === "en" ? en : km).text, `booking:${bookingId}:${reason}`)) return;
  const group = (await db<{ telegram_group_chat_id: string | null }[]>`select telegram_group_chat_id from company_settings where company_id = ${companyId}`)[0]?.telegram_group_chat_id;
  if (group) await enqueue(db, companyId, group, km.text, withApp(km.markup, bookingId, false, "km"), `booking:${bookingId}:${reason}:group`);
  const team = await db<{ id: string; telegram_chat_id: string | null; language: string }[]>`select u.id, u.telegram_chat_id, u.language from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${bookingId}`;
  for (const m of team) {
    const lang = asLang(m.language), msg = lang === "en" ? en : km;
    await db`insert into notifications (company_id, user_id, kind, title, body, link)
             values (${companyId}, ${m.id}, 'booking.assigned', ${number + " · " + pick(tx("ការងារថ្មី", "New job"), lang)}, ${msg.text.slice(0, 200)}, ${"/tech/job/" + bookingId})`;
    if (m.telegram_chat_id) await enqueue(db, companyId, m.telegram_chat_id, msg.text, withApp(msg.markup, bookingId, true, lang), `booking:${bookingId}:${reason}:${m.id}`);
  }
}

const REQUESTER: Record<string, Tx> = { customer: tx("អតិថិជន", "customer"), creator: tx("អ្នកបង្កើតការងារ", "booking creator"), technician: tx("ជាង", "technician"),
  lead: tx("មេជាង", "lead technician"), gm: tx("អ្នកគ្រប់គ្រង", "GM") };

/** D2: the group + every linked technician of the team get «Booking Rescheduled» (old → new, who asked, why) + in-app notice. */
export async function enqueueBookingRescheduled(db: Db, bookingId: string, r: { oldStart: Date | null; requestedBy: string; reason: string }): Promise<void> {
  const b = (await db<{ number: string; company_id: string; scheduled_at: Date; ends_at: Date; cname: string; timezone: string }[]>`
    select bk.number, bk.company_id, bk.scheduled_at, bk.ends_at, c.name as cname, co.timezone from bookings bk join customers c on c.id = bk.customer_id join companies co on co.id = bk.company_id
    where bk.id = ${bookingId}`)[0]!;
  const tz = b.timezone || "Asia/Phnom_Penh";
  const textIn = (lang: Lang) => { const L = (km: string, en: string) => pick(tx(km, en), lang); return [
    L(`🔁 ប្ដូរម៉ោងការងារ (${b.number})`, `🔁 Booking rescheduled (${b.number})`),
    `❌ ${L("ពីមុន", "Before")}: ${r.oldStart ? fmtLocal(r.oldStart, tz) : "—"}`,
    `✅ ${L("ថ្មី", "New")}: ${fmtLocal(b.scheduled_at, tz)}–${fmtLocal(b.ends_at, tz).slice(-5)}`,
    `👤 ${L("អតិថិជន", "Customer")}: ${b.cname}`,
    `🙋 ${L("ស្នើដោយ", "Requested by")}: ${REQUESTER[r.requestedBy] ? pick(REQUESTER[r.requestedBy]!, lang) : r.requestedBy}`,
    `📝 ${L("មូលហេតុ", "Reason")}: ${r.reason}`,
  ].join("\n"); };
  const text = textIn("km");
  const key = `resched:${bookingId}:${Date.now()}`;
  if (await toCeoInstead(db, b.company_id, bookingId, b.number, textIn, key)) return;
  const group = (await db<{ telegram_group_chat_id: string | null }[]>`select telegram_group_chat_id from company_settings where company_id = ${b.company_id}`)[0]?.telegram_group_chat_id;
  if (group) await enqueue(db, b.company_id, group, text, withApp(null, bookingId, false, "km"), `${key}:group`);
  const team = await db<{ id: string; telegram_chat_id: string | null; language: string }[]>`select u.id, u.telegram_chat_id, u.language from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${bookingId}`;
  for (const m of team) {
    const lang = asLang(m.language), mine = textIn(lang);
    await db`insert into notifications (company_id, user_id, kind, title, body, link)
             values (${b.company_id}, ${m.id}, 'booking.rescheduled', ${b.number + " · " + pick(tx("ប្ដូរម៉ោង", "Rescheduled"), lang)}, ${mine.slice(0, 200)}, ${"/tech/job/" + bookingId})`;
    if (m.telegram_chat_id) await enqueue(db, b.company_id, m.telegram_chat_id, mine, withApp(null, bookingId, true, lang), `${key}:${m.id}`);
  }
}

/** a personal Telegram message + in-app notification to one user, in that user's language (a plain string = the same in both) */
export async function notifyUser(db: Db, companyId: string, userId: string, kind: string, title: string | Tx, body: string | Tx, link: string | null, dedupe: string, markup: unknown = null, o: { silent?: boolean } = {}): Promise<void> {
  const u = (await db<{ chat: string | null; active: boolean; language: string }[]>`select telegram_chat_id as chat, is_active as active, language from users where id = ${userId}`)[0];
  const lang = asLang(u?.language), t = pick(title, lang), b = pick(body, lang);
  await db`insert into notifications (company_id, user_id, kind, title, body, link) values (${companyId}, ${userId}, ${kind}, ${t}, ${b.slice(0, 300)}, ${link})`;
  if (u?.chat && u.active) await enqueue(db, companyId, u.chat, `${t}\n${b}`, markup, dedupe, o);
}

/** R4: the group + every linked technician of the (former) team get a cancel notice; technicians an in-app notification. */
export async function enqueueBookingCancelled(db: Db, bookingId: string, reason: string): Promise<void> {
  const b = (await db<{ number: string; company_id: string; scheduled_at: Date | null; cname: string; timezone: string }[]>`
    select bk.number, bk.company_id, bk.scheduled_at, c.name as cname, co.timezone from bookings bk join customers c on c.id = bk.customer_id join companies co on co.id = bk.company_id
    where bk.id = ${bookingId}`)[0]!;
  const textIn = (lang: Lang) => { const L = (km: string, en: string) => pick(tx(km, en), lang); return [
    L(`❌ បោះបង់ការងារ (${b.number})`, `❌ Booking cancelled (${b.number})`),
    `📅 ${b.scheduled_at ? fmtLocal(b.scheduled_at, b.timezone || "Asia/Phnom_Penh") : "—"}`,
    `👤 ${L("អតិថិជន", "Customer")}: ${b.cname}`,
    `📝 ${L("មូលហេតុ", "Reason")}: ${reason}`,
    L("ការងារនេះត្រូវបានបោះបង់ — មិនចាំបាច់ចុះទីតាំងទេ។", "This job is cancelled — no need to go on site."),
  ].join("\n"); };
  const text = textIn("km");
  if (await toCeoInstead(db, b.company_id, bookingId, b.number, textIn, `cancel:${bookingId}`)) return;
  const group = (await db<{ telegram_group_chat_id: string | null }[]>`select telegram_group_chat_id from company_settings where company_id = ${b.company_id}`)[0]?.telegram_group_chat_id;
  if (group) await enqueue(db, b.company_id, group, text, null, `cancel:${bookingId}:group`);
  const team = await db<{ id: string; telegram_chat_id: string | null; language: string }[]>`select u.id, u.telegram_chat_id, u.language from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${bookingId}`;
  for (const m of team) {
    const lang = asLang(m.language);
    await db`insert into notifications (company_id, user_id, kind, title, body, link)
             values (${b.company_id}, ${m.id}, 'booking.cancelled', ${b.number + " · " + pick(tx("បានបោះបង់", "Cancelled"), lang)}, ${reason.slice(0, 200)}, ${"/tech/job/" + bookingId})`;
    if (m.telegram_chat_id) await enqueue(db, b.company_id, m.telegram_chat_id, textIn(lang), null, `cancel:${bookingId}:${m.id}`);
  }
}

// ---------- codes (A3 · S-11) ---------------------------------------------------------------
const STAFF_TTL = "10 minutes", GROUP_TTL = "24 hours";

async function newCode(kind: "staff" | "group", companyId: string, createdBy: string, userId: string | null): Promise<{ code: string; expires_at: Date }> {
  return sql.begin(async (t) => {
    // one live code per user (staff) / per company (group); expired rows are swept here too
    if (kind === "staff") await t`delete from telegram_link_codes where (kind = 'staff' and user_id = ${userId} and used_at is null) or expires_at < now() - interval '1 day'`;
    else await t`delete from telegram_link_codes where (kind = 'group' and company_id = ${companyId} and used_at is null) or expires_at < now() - interval '1 day'`;
    for (let i = 0; i < 5; i++) {
      // T3: plain random codes inside the shop's own bot (staff 8 chars in a deep link, group 6 chars typed after /register)
      const code = randomCode(kind === "staff" ? STAFF_CODE_LEN : GROUP_CODE_LEN);
      const r = await t<{ expires_at: Date }[]>`insert into telegram_link_codes (code, kind, company_id, user_id, created_by, expires_at)
        values (${code}, ${kind}, ${companyId}, ${userId}, ${createdBy}, now() + ${kind === "staff" ? STAFF_TTL : GROUP_TTL}::interval)
        on conflict (code) do nothing returning expires_at`;
      if (r[0]) return { code, expires_at: r[0].expires_at };
    }
    throw new Error("could not allocate a code");
  }) as Promise<{ code: string; expires_at: Date }>;
}

/** App button «ភ្ជាប់ Telegram» → deep link t.me/<shop bot>?start=XXXXXXXX (10 min, single use — T3). */
export async function createLinkCode(userId: string, companyId: string): Promise<{ code: string; link: string | null; expires_at: Date; bot: string | null }> {
  const bot = await shopBotUsername();
  const c = await newCode("staff", companyId, userId, userId);
  return { ...c, bot, link: bot ? deepLink(bot, c.code) : null };
}

/** Settings → group code for "/register XXXXXX" in the company's Telegram group, typed to the shop's own bot (24 h, single use). */
export async function createGroupCode(userId: string, companyId: string): Promise<{ code: string; command: string; expires_at: Date; bot: string | null }> {
  const bot = await shopBotUsername();
  const c = await newCode("group", companyId, userId, null);
  await audit(sql, { companyId, userId, action: "telegram.group_code", table: "telegram_link_codes", new: { expires_at: c.expires_at } });
  return { ...c, bot, command: `/register ${c.code}` };
}

type Consumed = { ok: true; reply: string } | { ok: false; reply: string; error: string };

/** Hub forwards "/start XXXXXXXX" (sent to this shop's bot) from a private chat. A Telegram account links to one user of this shop (F-M2-03). */
export async function consumeLinkCode(code: string, tgUser: number, chatId: number): Promise<Consumed> {
  const forgetLater: string[] = [];
  const result = await sql.begin(async (t) => {
    const row = (await t<{ user_id: string; company_id: string }[]>`select user_id, company_id from telegram_link_codes
      where code = ${code} and kind = 'staff' and used_at is null and expires_at > now() for update`)[0];
    if (!row) return { ok: false as const, error: "INVALID_CODE", reply: "❌ កូដមិនត្រឹមត្រូវ ឬផុតកំណត់ (10 នាទី)។ សូមចុច «ភ្ជាប់ Telegram» ម្ដងទៀតក្នុងកម្មវិធី។" };
    await t`update telegram_link_codes set used_at = now() where code = ${code}`;
    const prev = await t<{ id: string; company_id: string }[]>`update users set telegram_user_id = null, telegram_chat_id = null where telegram_user_id = ${tgUser} and id <> ${row.user_id} returning id, company_id`;
    for (const p of prev) await audit(t, { companyId: p.company_id, userId: p.id, action: "telegram.unlink", source: "telegram", table: "users", rowId: p.id, new: { reason: "relinked_to_other_user" } });
    const before = (await t<{ telegram_chat_id: string | null }[]>`select telegram_chat_id from users where id = ${row.user_id}`)[0]?.telegram_chat_id;
    if (before && String(before) !== String(chatId)) forgetLater.push(String(before));
    const u = (await t<{ full_name: string; is_active: boolean; language: string }[]>`update users set telegram_user_id = ${tgUser}, telegram_chat_id = ${chatId} where id = ${row.user_id} returning full_name, is_active, language`)[0]!;
    const lang = asLang(u.language);
    await audit(t, { companyId: row.company_id, userId: row.user_id, action: "telegram.link", source: "telegram", table: "users", rowId: row.user_id, new: { telegram_user_id: tgUser } });
    await t`insert into notifications (company_id, user_id, kind, title) values (${row.company_id}, ${row.user_id}, 'telegram.linked', ${pick(tx("Telegram ភ្ជាប់រួច", "Telegram linked"), lang)})`;
    return { ok: true as const, reply: pick(tx(`✅ ភ្ជាប់រួចរាល់ ${u.full_name}។ អ្នកនឹងទទួលការងារថ្មីនៅទីនេះ។`, `✅ Linked, ${u.full_name}. New jobs will arrive here.`), lang) };
  }) as Consumed;
  for (const c of forgetLater) void hubForgetChat(c);
  return result;
}

/** The shop no longer writes to this private chat (user deactivated / moved to another Telegram account) — R6. Best effort. */
export async function hubForgetChat(chatId: string | number): Promise<void> {
  if (!hubConfigured()) return;
  await hubCall("POST", "/internal/chat-forget", { chat_id: String(chatId) }).catch(() => undefined);
}

/** Hub forwards "/register XXXXXX" (sent to this shop's bot) from a group/supergroup → the company's work group. */
export async function consumeGroupCode(code: string, chatId: number, title: string): Promise<Consumed> {
  return sql.begin(async (t) => {
    const row = (await t<{ company_id: string; created_by: string }[]>`select company_id, created_by from telegram_link_codes
      where code = ${code} and kind = 'group' and used_at is null and expires_at > now() for update`)[0];
    if (!row) return { ok: false as const, error: "INVALID_CODE", reply: "❌ កូដក្រុមមិនត្រឹមត្រូវ ឬផុតកំណត់ (24 ម៉ោង)។ សូមបង្កើតកូដថ្មីក្នុង ការកំណត់ → Telegram។" };
    // the creator must still hold settings.manage (permissions may have changed since the code was made)
    const allowed = await t`select 1 from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = 'settings.manage' and rp.allowed
                            where u.id = ${row.created_by} and u.is_active`;
    if (allowed.length === 0) return { ok: false as const, error: "FORBIDDEN", reply: "❌ អ្នកបង្កើតកូដនេះលែងមានសិទ្ធិ។ សូមបង្កើតកូដថ្មី។" };
    await t`update telegram_link_codes set used_at = now() where code = ${code}`;
    const old = (await t<{ telegram_group_chat_id: string | null }[]>`select telegram_group_chat_id from company_settings where company_id = ${row.company_id}`)[0];
    await t`update company_settings set telegram_group_chat_id = ${chatId}, telegram_group_title = ${title || null}, updated_by = ${row.created_by} where company_id = ${row.company_id}`;
    await audit(t, { companyId: row.company_id, userId: row.created_by, action: "telegram.group_registered", source: "telegram", table: "company_settings", rowId: row.company_id,
      old: { chat_id: old?.telegram_group_chat_id ?? null }, new: { chat_id: chatId, title } });
    const lang = asLang((await t<{ language: string }[]>`select language from users where id = ${row.created_by}`)[0]?.language);
    await t`insert into notifications (company_id, user_id, kind, title, body) values (${row.company_id}, ${row.created_by}, 'telegram.group', ${pick(tx("ក្រុម Telegram កំណត់រួច", "Telegram group set"), lang)}, ${title || null})`;
    return { ok: true as const, reply: "✅ ក្រុមនេះត្រូវបានកំណត់ជាក្រុមការងាររបស់ក្រុមហ៊ុន។ ការងារថ្មីនឹងផ្ញើមកទីនេះ។" };
  }) as Promise<Consumed>;
}
