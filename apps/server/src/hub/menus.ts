// Inline-button menus (owner I1): edit-in-place navigation with back/home for customers, staff, work groups and the master bot.
// Callback data (≤ 64 bytes, strictly parsed): c:<action> customer · v:<view>[:<uuid>:<back>] staff/group (rendered by the shop)
// · m:<action> master · sub:<SHOP>:<version> consent (subscribers.ts). Commands keep working as the fallback.
import { CONSENT_VERSION, consentText } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { masterBot, type Bot } from "./bots.js";
import { callShop, getShop, logMessage, type Shop } from "./shops.js";
import { consentMarkup, privacyUrl } from "./subscribers.js";
import { sendMessage, tg } from "./telegram-api.js";

export type Btn = { text: string; callback_data?: string; url?: string; web_app?: { url: string } };
export type Markup = { inline_keyboard: Btn[][] };
/** D-91: a reply keyboard (persistent role menu) built from the shop's screen; https only (R12) */
export type ReplyKb = { keyboard: { text: string; web_app?: { url: string } }[][]; resize_keyboard: true; is_persistent: true };
const HTTPS = /^https:\/\/[^\s]{3,500}$/;
export function toKeyboard(rows: unknown): ReplyKb | null {
  if (!Array.isArray(rows)) return null;
  const kb = rows.slice(0, 8).map((r) => (Array.isArray(r) ? r : []).slice(0, 2).flatMap((b: { text?: unknown; web_app?: unknown }) => {
    const text = String(b?.text ?? "").slice(0, 64); if (!text) return [];
    const wa = typeof b.web_app === "string" && HTTPS.test(b.web_app) ? { web_app: { url: b.web_app } } : {};
    return [{ text, ...wa }];
  })).filter((r) => r.length);
  return kb.length ? { keyboard: kb, resize_keyboard: true, is_persistent: true } : null;
}

/** show a screen: edit the pressed message in place (callbacks) or send a new one (commands) */
export async function show(bot: Bot, chatId: number, messageId: number | null, text: string, markup: Markup, kind: string, shop: string | null): Promise<void> {
  if (messageId) {
    const r = await tg(bot, "editMessageText", { chat_id: chatId, message_id: messageId, text, reply_markup: markup, disable_web_page_preview: true });
    if (r.ok || /not modified/i.test(r.ok ? "" : r.error)) { await logMessage({ direction: "out", bot: bot.code, shop, chatId, kind: `edit.${kind}`, text: null, ok: true }); return; }
  }
  const r = await sendMessage(bot, chatId, text, markup);
  await logMessage({ direction: "out", bot: bot.code, shop, chatId, kind, text: null, ok: r.ok, error: r.ok ? null : r.error });
}

// ---------- customers (shop bot, private chat) ----------
async function subscription(shop: string, tgUser: number) {
  return (await sql<{ promo: boolean; stopped: boolean }[]>`select s.promo, (s.stopped_at is not null or u.blocked_at is not null) as stopped
    from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where s.shop_code = ${shop} and u.telegram_user_id = ${tgUser}`)[0] ?? null;
}
export async function customerMenu(shop: Shop, tgUser: number): Promise<{ text: string; markup: Markup }> {
  const s = await subscription(shop.code, tgUser);
  const master = await masterBot();
  const rows: Btn[][] = [];
  let text: string;
  if (s && !s.stopped) {
    text = `✅ អ្នកបានចុះឈ្មោះទទួលដំណឹងពី «${shop.name}»\n${s.promo ? "🔔 ប្រូម៉ូសិន: បើក" : "🔕 ប្រូម៉ូសិន: បិទ"}`;
    rows.push([s.promo ? { text: "🔕 បិទប្រូម៉ូសិន", callback_data: "c:promo_off" } : { text: "🔔 បើកប្រូម៉ូសិន", callback_data: "c:promo_on" }]);
    rows.push([{ text: "⛔ ឈប់ទទួលសារទាំងអស់", callback_data: "c:stop_ask" }]);
  } else {
    text = `👋 សូមស្វាគមន៍មកកាន់ «${shop.name}»\nចុះឈ្មោះ ដើម្បីទទួលដំណឹងសេវាកម្ម និងប្រូម៉ូសិន។`;
    if (shop.subscribe && shop.status === "active") rows.push([{ text: "📢 ចុះឈ្មោះទទួលដំណឹង", callback_data: "c:sub" }]);
  }
  rows.push([{ text: "ℹ️ អំពីយើង", callback_data: "c:about" }, { text: "🔒 ឯកជនភាព", url: privacyUrl() }]);
  if (master?.status === "active") rows.push([{ text: "⭐ Follow HangKH", url: `https://t.me/${master.username}?start=follow` }]);
  return { text, markup: { inline_keyboard: rows } };
}

// ---------- staff + work groups (rendered by the shop) ----------
type ShopBtn = { text: string; view?: string; id?: string; arg?: string; back?: string; url?: string; web_app?: string };
const VIEW = /^[a-z_]{2,20}$/, ARG = /^[a-z_]{1,12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WITH_ID = new Set(["job", "step", "review", "req"]);
export function toMarkup(buttons: ShopBtn[][]): Markup {
  const rows = buttons.map((r) => r.flatMap((b): Btn[] => {
    const text = String(b.text ?? "").slice(0, 64);
    if (b.web_app) return HTTPS.test(b.web_app) ? [{ text, web_app: { url: b.web_app } }] : []; // Mini App (https only, R12)
    if (b.url) return HTTPS.test(b.url) ? [{ text, url: b.url }] : [];
    if (!b.view || !VIEW.test(b.view)) return [];
    const arg = b.arg ?? b.back;
    if (WITH_ID.has(b.view)) return b.id && UUID.test(b.id) && arg && ARG.test(arg) ? [{ text, callback_data: `v:${b.view}:${b.id}:${arg}` }] : [];
    return [{ text, callback_data: `v:${b.view}` }];
  })).filter((r) => r.length);
  return { inline_keyboard: rows.slice(0, 20) };
}
export type ShopScreen = { text: string; markup: Markup; keyboard: ReplyKb | null; lang: "km" | "en"; ask_location: boolean; remove_keyboard: boolean; kind: string };
/** a screen the shop rendered (menu view, start, text) → Telegram markup; null = not for this chat */
export function toScreen(m: unknown): ShopScreen | null {
  const x = m as { text?: unknown; buttons?: unknown; keyboard?: unknown; lang?: unknown; ask_location?: unknown; remove_keyboard?: unknown; kind?: unknown } | null;
  if (!x || typeof x.text !== "string") return null;
  return { text: x.text.slice(0, 4000), markup: toMarkup(Array.isArray(x.buttons) ? x.buttons : []), keyboard: toKeyboard(x.keyboard), lang: x.lang === "en" ? "en" : "km",
    ask_location: x.ask_location === true, remove_keyboard: x.remove_keyboard === true, kind: typeof x.kind === "string" ? x.kind : "" };
}
/** ask the shop for a staff screen (inline callback view); null = this chat is not staff */
export async function shopMenu(shop: Shop, chatId: number, view: string, id?: string, arg?: string): Promise<ShopScreen | null> {
  const r = await callShop(shop, "POST", "/internal/tg-menu", { chat_id: chatId, view, ...(id ? { id } : {}), ...(arg ? { arg } : {}) });
  return r && r.status === 200 ? toScreen(r.json?.menu) : null;
}

export const groupHelp = "🤖 កំណត់ក្រុមការងារ: /register <កូដពីកម្មវិធី> (ការកំណត់ → Telegram)";

// ---------- master bot ----------
export async function masterMenu(tgUser: number): Promise<{ text: string; markup: Markup }> {
  const f = (await sql<{ stopped_at: Date | null }[]>`select stopped_at from hub_followers where telegram_user_id = ${tgUser}`)[0];
  const following = !!f && !f.stopped_at;
  return {
    text: `🤖 HangKH — ប្រព័ន្ធគ្រប់គ្រងសេវាកម្មសម្រាប់ហាង\n${following ? "⭐ អ្នកកំពុងតាមដាន HangKH" : "តាមដាន HangKH ដើម្បីទទួលដំណឹងពីវេទិកាម្តងម្កាល។"}`,
    markup: { inline_keyboard: [
      [following ? { text: "🔕 ឈប់តាមដាន", callback_data: "m:unfollow" } : { text: "⭐ តាមដាន HangKH", callback_data: "m:follow" }],
      [{ text: "ℹ️ អំពី HangKH", callback_data: "m:about" }, { text: "🔒 ឯកជនភាព", url: `${config.publicUrl}/privacy` }],
    ] },
  };
}

// ---------- callback handlers ----------
export async function onCustomerAction(bot: Bot, chatId: number, messageId: number, tgUser: number, action: string, fns: {
  stop: (promoOnly: boolean) => Promise<string[]>; promoOn: () => Promise<boolean>;
}): Promise<void> {
  const shop = bot.shop_code ? await getShop(bot.shop_code) : null;
  if (!shop) return;
  const back: Btn[] = [{ text: "⬅️ ត្រឡប់", callback_data: "c:home" }];
  if (action === "sub") {
    if (!shop.subscribe || shop.status !== "active") return show(bot, chatId, messageId, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", { inline_keyboard: [back] }, "subscribe.unavailable", shop.code);
    const master = await masterBot();
    const m = consentMarkup(shop.code, master?.status === "active" ? master.username : null) as Markup;
    return show(bot, chatId, messageId, consentText(shop.name, privacyUrl()), { inline_keyboard: [...m.inline_keyboard, back] }, "subscribe.prompt", shop.code);
  }
  if (action === "about") return show(bot, chatId, messageId, `ℹ️ ${shop.name}\n\nសារនេះមកពី bot ផ្លូវការរបស់ហាង (តាមរយៈ HangKH)។\nគោលការណ៍ឯកជនភាព: ${privacyUrl()}`, { inline_keyboard: [back] }, "about", shop.code);
  if (action === "promo_off") await fns.stop(true);
  if (action === "promo_on") await fns.promoOn();
  if (action === "stop_ask") return show(bot, chatId, messageId, `⛔ ឈប់ទទួលសារទាំងអស់ពី «${shop.name}»?\nអ្នកអាចចុះឈ្មោះម្ដងទៀតបានគ្រប់ពេល។`,
    { inline_keyboard: [[{ text: "✅ បាទ/ចាស ឈប់", callback_data: "c:stop_yes" }], back] }, "stop.ask", shop.code);
  if (action === "stop_yes") await fns.stop(false);
  const m = await customerMenu(shop, tgUser);
  return show(bot, chatId, messageId, m.text, m.markup, "menu.customer", shop.code);
}

/** parse callback data; null = unknown/forged → only answered */
export function parseCallback(data: string): { kind: "c" | "v" | "m" | "sub"; action: string; id?: string; back?: string; shop?: string; version?: string; code?: string } | null {
  let m = data.match(/^c:(home|sub|about|promo_off|promo_on|stop_ask|stop_yes)$/);
  if (m) return { kind: "c", action: m[1]! };
  m = data.match(/^v:([a-z_]{2,20})$/);
  if (m) return { kind: "v", action: m[1]! };
  m = data.match(/^v:(job|step|review|req):([0-9a-f-]{36}):([a-z_]{1,12})$/);
  if (m && UUID.test(m[2]!)) return { kind: "v", action: m[1]!, id: m[2]!, back: m[3]! };
  m = data.match(/^m:(home|follow|unfollow|about)$/);
  if (m) return { kind: "m", action: m[1]! };
  m = data.match(/^sub:([A-Z0-9]{2,20}):([\w-]{1,40})(?::([A-HJ-NP-Z2-9]{8}))?$/);
  if (m) return { kind: "sub", action: "consent", shop: m[1]!, version: m[2]!, code: m[3] };
  return null;
}
export { CONSENT_VERSION };
