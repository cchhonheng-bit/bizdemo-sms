// Inline-button menus (owner I1 · D-106): staff views and work groups (rendered by the shop), the master bot, and the customer's
// «🔕 stop notifications» choices. Callback data (≤ 64 bytes, strictly parsed): c:<action> customer notifications ·
// v:<view>[:<uuid>:<back>] staff/group · m:<action> master · sub:<SHOP>:<version>[:<code>] consent (subscribers.ts).
// The customer menu itself is the shop's reply keyboard grid (D-106) — no inline customer menu any more.
import { CONSENT_VERSION, CUSTOMER_BTN, customerText } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { type Bot } from "./bots.js";
import { callShop, logMessage, type Shop } from "./shops.js";
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

// ---------- customers: «🔕 stop notifications» (the hub owns the subscription) ----------
export type SubState = { live: boolean; promo: boolean } | null;
/** the choices for the state the person is in: stop promotions only / stop all / cancel — and the way back */
export function stopMenu(s: SubState): { text: string; markup: Markup } {
  const b = (text: string, data: string): Btn => ({ text, callback_data: data });
  if (!s || !s.live) return { text: customerText.stopAskAll, markup: { inline_keyboard: [[b(CUSTOMER_BTN.resumeAll, "c:resume_all")], [b(CUSTOMER_BTN.cancel, "c:cancel")]] } };
  if (!s.promo) return { text: customerText.stopAskPromoOff, markup: { inline_keyboard: [[b(CUSTOMER_BTN.stopAll, "c:stop_all")], [b(CUSTOMER_BTN.resumePromo, "c:resume_promo")], [b(CUSTOMER_BTN.cancel, "c:cancel")]] } };
  return { text: customerText.stopAsk, markup: { inline_keyboard: [[b(CUSTOMER_BTN.stopPromoOnly, "c:stop_promo")], [b(CUSTOMER_BTN.stopAll, "c:stop_all")], [b(CUSTOMER_BTN.cancel, "c:cancel")]] } };
}
/** after a choice: the exact message, with the way back as the next step */
export function stopResult(action: "stop_promo" | "stop_all" | "resume_promo" | "resume_all" | "cancel"): { text: string; markup: Markup } {
  if (action === "stop_promo") return { text: customerText.unsubscribed("promo"), markup: { inline_keyboard: [[{ text: CUSTOMER_BTN.resume, callback_data: "c:resume_promo" }]] } };
  if (action === "stop_all") return { text: customerText.unsubscribed("all"), markup: { inline_keyboard: [[{ text: CUSTOMER_BTN.resume, callback_data: "c:resume_all" }]] } };
  if (action === "resume_promo") return { text: customerText.resumed("promo"), markup: { inline_keyboard: [] } };
  if (action === "resume_all") return { text: customerText.resumed("all"), markup: { inline_keyboard: [] } };
  return { text: customerText.unchanged, markup: { inline_keyboard: [] } };
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
export type ShopScreen = { text: string; markup: Markup; keyboard: ReplyKb | null; lang: "km" | "en"; ask_location: boolean; remove_keyboard: boolean; kind: string; after: string | null; menu_url: string | null };
/** a screen the shop rendered (menu view, start, text, link) → Telegram markup; null = not for this chat */
export function toScreen(m: unknown): ShopScreen | null {
  const x = m as { text?: unknown; buttons?: unknown; keyboard?: unknown; lang?: unknown; ask_location?: unknown; remove_keyboard?: unknown; kind?: unknown; after?: unknown; hint?: unknown; menu_url?: unknown } | null;
  if (!x || typeof x.text !== "string") return null;
  const after = typeof x.after === "string" ? x.after : typeof x.hint === "string" ? x.hint : null;
  return { text: x.text.slice(0, 4000), markup: toMarkup(Array.isArray(x.buttons) ? x.buttons : []), keyboard: toKeyboard(x.keyboard), lang: x.lang === "en" ? "en" : "km",
    ask_location: x.ask_location === true, remove_keyboard: x.remove_keyboard === true, kind: typeof x.kind === "string" ? x.kind : "", after: after ? after.slice(0, 300) : null,
    menu_url: typeof x.menu_url === "string" && HTTPS.test(x.menu_url) ? x.menu_url : null };
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

const LEGACY_C: Record<string, string> = { promo_off: "stop_promo", stop_yes: "stop_all", promo_on: "resume_promo", stop_ask: "menu", home: "menu", sub: "menu", about: "menu" };
/** parse callback data; null = unknown/forged → only answered. Old customer buttons (before D-106) map to the new choices. */
export function parseCallback(data: string): { kind: "c" | "v" | "m" | "sub"; action: string; id?: string; back?: string; shop?: string; version?: string; code?: string } | null {
  let m = data.match(/^c:(menu|stop_promo|stop_all|resume_promo|resume_all|cancel|home|sub|about|promo_off|promo_on|stop_ask|stop_yes)$/);
  if (m) return { kind: "c", action: LEGACY_C[m[1]!] ?? m[1]! };
  m = data.match(/^v:([a-z_]{2,20})$/);
  if (m) return { kind: "v", action: m[1]! };
  m = data.match(/^v:(job|step|review|req):([0-9a-f-]{36}):([a-z_]{1,12})$/);
  if (m && UUID.test(m[2]!)) return { kind: "v", action: m[1]!, id: m[2]!, back: m[3]! };
  m = data.match(/^m:(home|follow|unfollow|about)$/);
  if (m) return { kind: "m", action: m[1]! };
  // the optional tail: a customer's own subscribe code (A2) or the link token of a website booking (D-96, older prompts)
  m = data.match(/^sub:([A-Z0-9]{2,20}):([\w-]{1,40})(?::([A-HJ-NP-Z2-9]{8}|b-[A-Za-z0-9_-]{20}))?$/);
  if (m) return { kind: "sub", action: "consent", shop: m[1]!, version: m[2]!, code: m[3] };
  return null;
}
export { CONSENT_VERSION };
