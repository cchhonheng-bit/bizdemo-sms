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

export type Btn = { text: string; callback_data?: string; url?: string };
export type Markup = { inline_keyboard: Btn[][] };

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
type ShopBtn = { text: string; view?: string; id?: string; back?: string; url?: string };
const VIEWS = new Set(["home", "today", "next", "job", "att", "ghome", "gtoday"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function toMarkup(buttons: ShopBtn[][]): Markup {
  const rows = buttons.map((r) => r.flatMap((b): Btn[] => {
    const text = String(b.text ?? "").slice(0, 64);
    if (b.url) return /^https:\/\/[^\s]{3,500}$/.test(b.url) ? [{ text, url: b.url }] : []; // https only (R12)
    if (!b.view || !VIEWS.has(b.view)) return [];
    if (b.view === "job") return b.id && UUID.test(b.id) ? [{ text, callback_data: `v:job:${b.id}:${b.back === "today" ? "today" : "next"}` }] : [];
    return [{ text, callback_data: `v:${b.view}` }];
  })).filter((r) => r.length);
  return { inline_keyboard: rows.slice(0, 20) };
}
/** ask the shop for a staff / group screen; null = this chat is not staff / not the shop's work group */
export async function shopMenu(shop: Shop, chatId: number, view: string, id?: string, back?: string): Promise<{ text: string; markup: Markup } | null> {
  const r = await callShop(shop, "POST", "/internal/tg-menu", { chat_id: chatId, view, ...(id ? { id } : {}), ...(back ? { back } : {}) });
  const m = r && r.status === 200 ? r.json?.menu : null;
  if (!m || typeof m.text !== "string") return null;
  return { text: m.text.slice(0, 4000), markup: toMarkup(Array.isArray(m.buttons) ? m.buttons : []) };
}

export const groupHelp = "🤖 កំណត់ Group ការងារ: /register <កូដពីកម្មវិធី> (ការកំណត់ → Telegram)";

// ---------- master bot ----------
export async function masterMenu(tgUser: number): Promise<{ text: string; markup: Markup }> {
  const f = (await sql<{ stopped_at: Date | null }[]>`select stopped_at from hub_followers where telegram_user_id = ${tgUser}`)[0];
  const following = !!f && !f.stopped_at;
  return {
    text: `🤖 HangKH — ប្រព័ន្ធគ្រប់គ្រងសេវាកម្មសម្រាប់ហាង\n${following ? "⭐ អ្នកកំពុងតាមដាន HangKH" : "តាមដាន HangKH ដើម្បីទទួលដំណឹង Platform ម្តងម្កាល។"}`,
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
export function parseCallback(data: string): { kind: "c" | "v" | "m" | "sub"; action: string; id?: string; back?: string; shop?: string; version?: string } | null {
  let m = data.match(/^c:(home|sub|about|promo_off|promo_on|stop_ask|stop_yes)$/);
  if (m) return { kind: "c", action: m[1]! };
  m = data.match(/^v:(home|today|next|att|ghome|gtoday)$/);
  if (m) return { kind: "v", action: m[1]! };
  m = data.match(/^v:job:([0-9a-f-]{36}):(today|next)$/);
  if (m && UUID.test(m[1]!)) return { kind: "v", action: "job", id: m[1]!, back: m[2]! };
  m = data.match(/^m:(home|follow|unfollow|about)$/);
  if (m) return { kind: "m", action: m[1]! };
  m = data.match(/^sub:([A-Z0-9]{2,20}):([\w-]{1,40})$/);
  if (m) return { kind: "sub", action: "consent", shop: m[1]!, version: m[2]! };
  return null;
}
export { CONSENT_VERSION };
