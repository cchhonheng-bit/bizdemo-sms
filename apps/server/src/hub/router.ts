// Telegram router (T1/T3/T4/T5 · customers D-106). Every update arrives on ONE bot's webhook path, so the hub always knows the
// context:
//  • a shop bot (@Oneteam_app_bot …): its own staff links, work-group /register, and its customers — the website link
//    (start=b-<token>: the website button was the consent, linked at once), the direct path (consent ☑ → «share my phone» →
//    linked or made, first password), the keyboard grid the shop renders, «🔕 stop notifications» (the hub owns subscriptions)
//  • the master bot (@hangkh_bot): owner alerts link, optional "Follow HangKH", pointers to shop bots for old links
// Privacy mode ON (BotFather) → in groups a bot only sees commands. Forwarded messages are ignored; free text reaches the shop
// only from chats the hub knows (staff, people who subscribed to that shop — also after «stop all»: replies to their own button
// presses still come), and is never stored. Messages that carry a password are never kept in the hub log.
import type { FastifyBaseLogger } from "fastify";
import { consentText, CUSTOMER_BTN, CUSTOMER_MENU, customerText, GROUP_CODE_LEN, parseLinkCode, parseSubscribe, shopBotCode, SUBSCRIBE_PAYLOAD } from "@sms/shared";
import { checkRate, refundRate } from "../lib/rate-limit.js";
import { acceptConsent, consentMarkup, ensureSubscriber, privacyUrl, resumeAll, resumePromo, stopSubscriptions, subscribe, subscriptionOf, type TgFrom } from "./subscribers.js";
import { callShop, getShop, logMessage, type Shop } from "./shops.js";
import { sql } from "../db.js";
import { shopBot, type Bot } from "./bots.js";
import { sendMessage, tg } from "./telegram-api.js";
import { linkAdminChat } from "./alerts.js";
import { groupHelp, masterMenu, parseCallback, shopMenu, show, stopMenu, stopResult, toKeyboard, toScreen, type ShopScreen } from "./menus.js";

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
export type Message = { message_id: number; date?: number; chat: Chat; from?: TgFrom & { is_bot?: boolean }; text?: string; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown;
  location?: { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number }; contact?: { phone_number: string; first_name?: string; user_id?: number } };
export type CallbackQuery = { id: string; from: TgFrom & { is_bot?: boolean }; message?: { message_id: number; chat: Chat; text?: string }; data?: string };
export type Update = { update_id: number; message?: Message; callback_query?: CallbackQuery };

const BAD_CODE_LIMIT = 10; // wrong codes per Telegram user per hour (S-11 brute force), across all bots

export function parseCommand(text: string, botUsername: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

async function reply(bot: Bot, chatId: number, text: string, shop: string | null, kind: string, markup?: unknown, logText = true, silent = false): Promise<void> {
  const r = await sendMessage(bot, chatId, text, markup, { silent });
  await logMessage({ direction: "out", bot: bot.code, shop, chatId, kind, text: logText ? text : null, ok: r.ok, error: r.ok ? null : r.error });
}
const setMenu = (bot: Bot, chatId: number, url: string) => tg(bot, "setChatMenuButton", { chat_id: chatId, menu_button: { type: "web_app", text: "ការកក់", web_app: { url } } });
const CONTACT_KB = { keyboard: [[{ text: CUSTOMER_BTN.share, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };
const SHOP_DOWN = "⚠️ ប្រព័ន្ធហាងមិនឆ្លើយតបពេលនេះ។ សូមព្យាយាមម្ដងទៀតក្នុងពេលបន្តិច។";
const SHOP_HELP_GROUP = "🤖 កំណត់ក្រុមការងារ: /register <កូដពីកម្មវិធី> (ការកំណត់ → Telegram)";

/** a staff/group code received by a shop bot → that shop validates it (never another shop) */
async function forwardCode(bot: Bot, kind: "link" | "group", raw: string, msg: Message, log: FastifyBaseLogger): Promise<void> {
  const from = msg.from!;
  // count the attempt BEFORE any await (concurrent updates cannot slip through — R7); refunded when the code was good
  const badKey = `tg:bad:${from.id}`;
  if (!checkRate(badKey, BAD_CODE_LIMIT, 3600)) {
    await reply(bot, msg.chat.id, "⏳ ព្យាយាមច្រើនដងពេក។ សូមរង់ចាំ 1 ម៉ោង។", bot.shop_code, "rate_limited");
    return;
  }
  const shop = bot.shop_code ? await getShop(bot.shop_code) : null;
  const code = shop ? shopBotCode(raw, shop.code, kind === "link" ? "staff" : "group") : null;
  if (!shop || shop.status !== "active" || !code) {
    await reply(bot, msg.chat.id, kind === "link" ? "❌ តំណមិនត្រឹមត្រូវ ឬផុតកំណត់។ សូមចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធីម្ដងទៀត។" : `❌ កូដក្រុមមិនត្រឹមត្រូវ។ ទម្រង់: /register XXXXXX (${GROUP_CODE_LEN} តួ ពី ការកំណត់ → Telegram)`, bot.shop_code, `${kind}.invalid`);
    return;
  }
  const r = await callShop(shop, "POST", "/internal/telegram", { kind, code, tg_user: from.id, chat_id: msg.chat.id, chat_title: msg.chat.title ?? "" });
  if (!r || r.status !== 200 || typeof r.json?.reply !== "string") {
    log.warn({ shop: shop.code, status: r?.status }, "shop did not answer");
    await reply(bot, msg.chat.id, SHOP_DOWN, shop.code, `${kind}.shop_down`);
    return;
  }
  if (r.json.ok) {
    refundRate(badKey);
    // from now on this shop (through its own bot) may send to this chat — the allowlist for /internal/send (T7)
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values (${shop.code}, ${msg.chat.id}, ${kind === "link" ? "staff" : "group"}) on conflict do nothing`;
  }
  await reply(bot, msg.chat.id, r.json.reply.slice(0, 1000), shop.code, `${kind}.${r.json.ok ? "ok" : "fail"}`);
}

// ---------- customers ----------
async function consentPrompt(bot: Bot, shop: Shop, chatId: number, code?: string): Promise<void> {
  if (shop.status !== "active" || !shop.subscribe) return reply(bot, chatId, customerText.unavailable, shop.code, "subscribe.unavailable");
  return reply(bot, chatId, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentMarkup(shop.code, code));
}
const askContact = (bot: Bot, shop: Shop, chatId: number) => reply(bot, chatId, customerText.askContact, shop.code, "contact.ask", CONTACT_KB);

/** D-91: deliver a screen the shop rendered — the reply keyboard (role menu / customer grid) rides on the text, inline buttons
 *  get their own message, a location request is a one-time keyboard; `after` follows silently, `menu_url` sets the chat's menu
 *  button. Screens hold the shop's data: never stored in the hub log (R5). */
async function sendScreen(bot: Bot, shop: Shop, chatId: number, s: ShopScreen, kind: string): Promise<void> {
  await screenBody(bot, shop, chatId, s, kind);
  if (s.after) await reply(bot, chatId, s.after, shop.code, `${kind}.after`, undefined, false, true);
  if (s.menu_url) await setMenu(bot, chatId, s.menu_url);
}
const LOC_ASK = { km: "👇 ចុចប៊ូតុងខាងក្រោម ដើម្បីផ្ញើទីតាំងបច្ចុប្បន្ន (GPS)", en: "👇 Tap the button below to send your current location (GPS)" };
const LOC_BTN = { km: "📍 ផ្ញើទីតាំង", en: "📍 Send location" };
const QUICK = { km: "⚡ មើលរហ័ស", en: "⚡ Quick view" };
async function screenBody(bot: Bot, shop: Shop, chatId: number, s: ShopScreen, kind: string): Promise<void> {
  const inline = s.markup.inline_keyboard.length > 0;
  if (s.keyboard) { await reply(bot, chatId, s.text, shop.code, `${kind}.keyboard`, s.keyboard, false); if (!inline && !s.ask_location) return; }
  if (s.remove_keyboard) return reply(bot, chatId, s.text, shop.code, kind, { remove_keyboard: true }, false);
  if (s.ask_location) {
    if (inline) await show(bot, chatId, null, s.keyboard ? QUICK[s.lang] : s.text, s.markup, kind, shop.code);
    return reply(bot, chatId, inline || s.keyboard ? LOC_ASK[s.lang] : `${s.text}\n${LOC_ASK[s.lang]}`, shop.code, "attendance.ask",
      { keyboard: [[{ text: LOC_BTN[s.lang], request_location: true }]], resize_keyboard: true, one_time_keyboard: true }, false);
  }
  if (inline && s.keyboard) return show(bot, chatId, null, QUICK[s.lang], s.markup, kind, shop.code);
  return reply(bot, chatId, s.text, shop.code, kind, inline ? s.markup : undefined, false);
}

/** the shop's answer to a link (website link, own code, shared phone) IS the message: sent once, never kept (it may carry the
 *  password), with the keyboard grid; the hint follows silently; the chat's menu button opens the shop site */
async function sendLinked(bot: Bot, shop: Shop, chatId: number, tgUser: number, json: unknown, kind: string): Promise<void> {
  const s = toScreen(json);
  if (!s) return;
  if (!s.keyboard && !s.markup.inline_keyboard.length) { // a shop without the website module: its own customer keyboard
    const sub = await subscriptionOf(tgUser, shop.code);
    const r = await callShop(shop, "POST", "/internal/tg-start", { chat_id: chatId, tg_user: tgUser, subscriber_id: sub?.id ?? null });
    s.keyboard = r && r.status === 200 ? toScreen(r.json)?.keyboard ?? null : null;
  }
  await sendScreen(bot, shop, chatId, s, kind);
}

/** /start (and /help, the subscribe link): staff → their role keyboard; a customer → the grid; someone who agreed but has not
 *  shared the phone yet → the phone button; anybody else → the consent (one ☑) */
async function startMenu(bot: Bot, shop: Shop, chatId: number, from: TgFrom): Promise<void> {
  const sub = await subscriptionOf(from.id, shop.code);
  const r = await callShop(shop, "POST", "/internal/tg-start", { chat_id: chatId, tg_user: from.id, subscriber_id: sub?.id ?? null });
  const s = r && r.status === 200 ? toScreen(r.json) : null;
  if (s && (s.kind === "staff" || s.kind === "customer")) return sendScreen(bot, shop, chatId, s, s.kind === "staff" ? "menu.staff" : "menu.customer");
  const menu = r && r.status === 200 && typeof r.json?.menu_url === "string" && /^https:\/\//.test(r.json.menu_url) ? String(r.json.menu_url) : null;
  if (menu) await setMenu(bot, chatId, menu);
  if (sub?.live) return askContact(bot, shop, chatId);
  return consentPrompt(bot, shop, chatId);
}

/** D-106: t.me/<shop bot>?start=b-<token> — the website button was the consent (same three purposes, same version): no second
 *  tap here. The shop links the chat (single use) and its answer is the message; the subscription starts with source «web». */
async function linkFromWeb(bot: Bot, shop: Shop, msg: Message, tok: string): Promise<void> {
  if (shop.status !== "active" || !shop.subscribe) return reply(bot, msg.chat.id, customerText.unavailable, shop.code, "subscribe.unavailable");
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  const from = msg.from!;
  const subId = await ensureSubscriber(sql, from, msg.chat.id);
  const x = await callShop(shop, "POST", "/internal/customer-subscribed", { code: tok, subscriber_id: subId });
  if (!x || x.status !== 200) return reply(bot, msg.chat.id, SHOP_DOWN, shop.code, "booking.shop_down");
  if (x.json?.ok) await subscribe(from, msg.chat.id, shop, "web");
  return sendLinked(bot, shop, msg.chat.id, from.id, x.json, x.json?.ok ? "booking.linked" : "booking.link_failed");
}

/** «🔕 stop notifications»: the choices for the state the person is in */
async function showStop(bot: Bot, shop: Shop, chatId: number, tgUser: number, messageId: number | null): Promise<void> {
  const st = await subscriptionOf(tgUser, shop.code);
  const m = stopMenu(st ? { live: st.live, promo: st.promo } : null);
  return show(bot, chatId, messageId, m.text, m.markup, "notify.menu", shop.code);
}

async function onShopMessage(bot: Bot, msg: Message, c: { cmd: string; arg: string }, log: FastifyBaseLogger): Promise<void> {
  const isPrivate = msg.chat.type === "private";
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const shop = await getShop(bot.shop_code!);
  if (!shop) return;
  if (isPrivate && c.cmd === "start") {
    if (!c.arg || c.arg.toLowerCase() === SUBSCRIBE_PAYLOAD || parseSubscribe(c.arg) === shop.code) return startMenu(bot, shop, msg.chat.id, msg.from!);
    const cust = c.arg.match(/^s_([A-HJ-NP-Z2-9]{8})$/i); // A2: the customer's own subscribe link (staff gave it): consent with the code
    if (cust) return consentPrompt(bot, shop, msg.chat.id, cust[1]!.toUpperCase());
    const web = c.arg.match(/^b-[A-Za-z0-9_-]{20}$/);
    if (web) return linkFromWeb(bot, shop, msg, web[0]);
    return forwardCode(bot, "link", c.arg, msg, log);
  }
  if (isPrivate && c.cmd === "stop") { // typed /stop still works (the grid has 🔕); /stop all also ends job messages to a staff chat (R6)
    const promoOnly = /^promo\b/i.test(c.arg);
    const names = await stopSubscriptions(msg.from!.id, promoOnly, shop.code);
    const staff = promoOnly ? [] : await sql`delete from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'staff' returning chat_id`;
    const lines: string[] = [];
    if (names.length) lines.push(customerText.unsubscribed(promoOnly ? "promo" : "all"));
    if (staff.length) lines.push(`ℹ️ ការងារពី ${shop.name} នឹងលែងផ្ញើមកទីនេះ។ ភ្ជាប់វិញ: កម្មវិធី → ខ្ញុំ → ភ្ជាប់ Telegram។`);
    return reply(bot, msg.chat.id, lines.length ? lines.join("\n") : customerText.unchanged, shop.code, promoOnly ? "stop.promo" : "stop.all");
  }
  if (isGroup && c.cmd === "register") return forwardCode(bot, "group", c.arg, msg, log);
  if (isGroup && (c.cmd === "start" || c.cmd === "help")) { // D-91: work groups get notifications only — no menu
    const known = (await sql`select 1 from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'group'`).length > 0;
    return reply(bot, msg.chat.id, known ? `👥 ក្រុមការងារ · ${shop.name}\nការងារថ្មី ការប្ដូរម៉ោង ជំហានការងារ និងការលុបចោល ផ្ញើមកទីនេះដោយស្វ័យប្រវត្តិ។` : groupHelp, shop.code, known ? "group.info" : "help");
  }
  if (isPrivate && c.cmd === "help") return startMenu(bot, shop, msg.chat.id, msg.from!);
  if (isPrivate && c.cmd === "register") return reply(bot, msg.chat.id, "ℹ️ /register ប្រើក្នុងក្រុមការងារប៉ុណ្ណោះ។", shop.code, "register.private");
  if (c.cmd === "help") return reply(bot, msg.chat.id, SHOP_HELP_GROUP, shop.code, "help");
}

/** a keyboard label or free text in a private chat with a shop bot → the shop answers. Only chats the hub knows (linked staff,
 *  people who subscribed to this shop — also after «stop all») reach the shop; a stranger's text is ignored and never stored. */
async function onShopText(bot: Bot, msg: Message): Promise<void> {
  const shop = await getShop(bot.shop_code!);
  if (!shop || shop.status !== "active" || !msg.text || !msg.from) return;
  const staff = (await sql`select 1 from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'staff'`).length > 0;
  const sub = staff ? null : await subscriptionOf(msg.from.id, shop.code);
  if (!staff && !sub) return;
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  if (!staff && msg.text.trim() === CUSTOMER_MENU.stop) {
    await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: "text.notify", text: null });
    return showStop(bot, shop, msg.chat.id, msg.from.id, null);
  }
  const r = await callShop(shop, "POST", "/internal/tg-text", { chat_id: msg.chat.id, tg_user: msg.from.id, text: msg.text.slice(0, 1000), subscriber_id: sub?.id ?? null });
  const kind = r && r.status === 200 ? String(r.json?.kind ?? "") : "";
  const s = r && r.status === 200 ? toScreen(r.json) : null;
  await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: `text.${kind || "unknown"}`, text: null });
  if (kind === "customer_menu") return showStop(bot, shop, msg.chat.id, msg.from.id, null);
  if (kind === "none" || !s) { if (!staff && sub?.live) await askContact(bot, shop, msg.chat.id); return; } // agreed, phone not shared yet
  return sendScreen(bot, shop, msg.chat.id, s, `text.${kind}`);
}

/** D-106: «share my phone» — only the sender's OWN contact counts (a forwarded card could claim anyone's number) */
async function onContact(bot: Bot, msg: Message): Promise<void> {
  const shop = await getShop(bot.shop_code!);
  if (!shop || shop.status !== "active" || !msg.contact || !msg.from) return;
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: "contact", text: null }); // the number is never kept here
  if (msg.contact.user_id !== msg.from.id) return reply(bot, msg.chat.id, customerText.ownContact, shop.code, "contact.foreign", CONTACT_KB);
  const sub = await subscriptionOf(msg.from.id, shop.code);
  if (!sub?.live) return consentPrompt(bot, shop, msg.chat.id); // the consent comes first
  const r = await callShop(shop, "POST", "/internal/tg-contact", { subscriber_id: sub.id, tg_user: msg.from.id, phone: msg.contact.phone_number.slice(0, 40),
    first_name: (msg.contact.first_name ?? msg.from.first_name ?? "").slice(0, 100) || null });
  if (!r || r.status !== 200) return reply(bot, msg.chat.id, SHOP_DOWN, shop.code, "contact.shop_down");
  if (!r.json?.ok) return reply(bot, msg.chat.id, String(r.json?.text ?? customerText.notKhPhone).slice(0, 500), shop.code, "contact.fail", { remove_keyboard: true });
  return sendLinked(bot, shop, msg.chat.id, msg.from.id, r.json, "contact.linked");
}

async function onMasterMessage(bot: Bot, msg: Message, c: { cmd: string; arg: string }): Promise<void> {
  if (msg.chat.type !== "private") {
    if (c.cmd === "register" || c.cmd === "help") return reply(bot, msg.chat.id, "ℹ️ ក្រុមការងារ ត្រូវកំណត់ជាមួយ bot របស់ហាង (កម្មវិធី: ការកំណត់ → Telegram)។", null, "master.group");
    return;
  }
  const from = msg.from!;
  if (c.cmd === "start" && /^a-/i.test(c.arg)) {
    if (!checkRate(`tg:bad:${from.id}`, BAD_CODE_LIMIT, 3600)) return reply(bot, msg.chat.id, "⏳ ព្យាយាមច្រើនដងពេក។ សូមរង់ចាំ 1 ម៉ោង។", null, "rate_limited");
    const ok = await linkAdminChat(c.arg.slice(2), msg.chat.id);
    return reply(bot, msg.chat.id, ok ? "✅ Platform alerts will come to this chat (deploy, backup, errors)." : "❌ Link not valid or expired (10 minutes). Open it again from the Platform page.", null, ok ? "admin.link.ok" : "admin.link.fail");
  }
  if (c.cmd === "start" && c.arg.toLowerCase() === "follow") {
    await sql`insert into hub_followers (telegram_user_id, chat_id, first_name) values (${from.id}, ${msg.chat.id}, ${from.first_name?.slice(0, 100) ?? null})
              on conflict (telegram_user_id) do update set chat_id = excluded.chat_id, stopped_at = null`;
    return reply(bot, msg.chat.id, "✅ អ្នកកំពុងតាមដាន HangKH។ /stop ដើម្បីឈប់។", null, "follow.ok");
  }
  if (c.cmd === "start" && c.arg) {
    // links printed before per-shop bots (t.me/hangkh_bot?start=s-ONETEAM / ONETEAM-S-…) → send people to the shop's own bot
    const shopCode = parseSubscribe(c.arg) ?? parseLinkCode(c.arg)?.shop ?? null;
    const sb = shopCode ? await shopBot(shopCode) : null;
    if (sb && sb.status === "active") {
      const payload = parseSubscribe(c.arg) ? SUBSCRIBE_PAYLOAD : "";
      return reply(bot, msg.chat.id, `➡️ សូមបន្តជាមួយ bot របស់ហាង: @${sb.username}`, shopCode, "master.redirect",
        { inline_keyboard: [[{ text: `បើក @${sb.username}`, url: `https://t.me/${sb.username}${payload ? `?start=${payload}` : ""}` }]] });
    }
  }
  if (c.cmd === "stop") {
    const r = await sql`update hub_followers set stopped_at = now() where telegram_user_id = ${from.id} and stopped_at is null returning 1`;
    return reply(bot, msg.chat.id, r.length ? "✅ ឈប់តាមដាន HangKH រួច។" : "ℹ️ អ្នកមិនបានតាមដាន HangKH ទេ។", null, "follow.stop");
  }
  if (c.cmd === "start" || c.cmd === "help") { const m = await masterMenu(from.id); return show(bot, msg.chat.id, null, m.text, m.markup, "menu.master", null); }
}

/** FR-902: a staff member sends a location to the shop bot (private chat) → the shop records check-in / check-out; a customer
 *  gets a short pointer to the booking button (D-106). The hub stores no coordinates. */
async function onLocation(bot: Bot, msg: Message): Promise<void> {
  const shop = await getShop(bot.shop_code!);
  if (!shop || !msg.location || !msg.from) return;
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: "location", text: null });
  const l = msg.location, sub = await subscriptionOf(msg.from.id, shop.code);
  const r = await callShop(shop, "POST", "/internal/tg-location", { chat_id: msg.chat.id, tg_user: msg.from.id, lat: l.latitude, lng: l.longitude,
    accuracy: typeof l.horizontal_accuracy === "number" ? l.horizontal_accuracy : null, sent_at: msg.date ?? 0, subscriber_id: sub?.id ?? null }); // the shop decides: a job «arrive» step, attendance, or a customer
  const text = r && r.status === 200 && typeof r.json?.reply === "string" ? String(r.json.reply).slice(0, 1000) : "❌ មិនអាចកត់វត្តមានបានទេ — សូមព្យាយាមម្ដងទៀត ឬប្រើកម្មវិធី។";
  const kb = r && r.status === 200 ? toKeyboard(r.json?.keyboard) : null; // D-91: the role keyboard replaces the one-time location keyboard
  return reply(bot, msg.chat.id, text, shop.code, "attendance.location", kb ?? { remove_keyboard: true });
}

async function onMessage(bot: Bot, msg: Message, log: FastifyBaseLogger): Promise<void> {
  if (!msg.from || !msg.chat || typeof msg.chat.id !== "number" || msg.from.is_bot) return;
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return; // never act on forwarded text, locations or contacts
  const shopPrivate = bot.kind === "shop" && msg.chat.type === "private";
  if (msg.contact) return shopPrivate ? onContact(bot, msg) : undefined;
  if (msg.location && !msg.text) return shopPrivate ? onLocation(bot, msg) : undefined;
  if (!msg.text) return;
  const c = parseCommand(msg.text, bot.username);
  if (!c) return shopPrivate ? onShopText(bot, msg) : undefined; // free text: only private shop chats the hub knows (keyboard labels)
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return; // S-06, per bot
  await logMessage({ direction: "in", bot: bot.code, shop: bot.shop_code, chatId: msg.chat.id, tgUser: msg.from.id, kind: `/${c.cmd}`, text: null });
  return bot.kind === "shop" ? onShopMessage(bot, msg, c, log) : onMasterMessage(bot, msg, c);
}

async function onCallback(bot: Bot, q: CallbackQuery): Promise<void> {
  const p = parseCallback(q.data ?? "");
  const chat = q.message?.chat;
  if (p && p.kind !== "sub") return onMenuCallback(bot, q, p);
  // a consent button counts only on the shop's OWN bot (no cross-shop consent — T7)
  if (!p || !chat || chat.type !== "private" || q.from.is_bot || bot.kind !== "shop" || p.shop !== bot.shop_code) {
    await tg(bot, "answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  if (!checkRate(`tg:chat:${bot.code}:${chat.id}`, 20, 60)) return;
  const r = await acceptConsent(q.from, chat.id, p.shop!, p.version!);
  await logMessage({ direction: "in", bot: bot.code, shop: p.shop!, chatId: chat.id, tgUser: q.from.id, kind: r.ok ? "consent.ok" : `consent.${r.error}` });
  await tg(bot, "answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? "✅" : "❌" });
  if (!r.ok) return reply(bot, chat.id, r.error === "OLD_CONSENT" ? "⚠️ អត្ថបទយល់ព្រមនេះចាស់ហើយ។ សូមចុច /start ម្ដងទៀត។" : customerText.unavailable, p.shop!, "subscribe.fail");
  await tg(bot, "editMessageReplyMarkup", { chat_id: chat.id, message_id: q.message!.message_id, reply_markup: { inline_keyboard: [] } }); // one tap only
  if (p.code) { // A2: the customer's own link (or a booking link of an older prompt) → the shop links that customer / booking
    const x = await callShop(r.shop, "POST", "/internal/customer-subscribed", { code: p.code, subscriber_id: r.subscriberId });
    if (!x || x.status !== 200) return reply(bot, chat.id, SHOP_DOWN, r.shop.code, "subscribe.shop_down");
    return sendLinked(bot, r.shop, chat.id, q.from.id, x.json, x.json?.ok ? "subscribe.linked" : "subscribe.link_failed");
  }
  // the direct path: a customer already → the grid; else the phone button
  const s = await callShop(r.shop, "POST", "/internal/tg-start", { chat_id: chat.id, tg_user: q.from.id, subscriber_id: r.subscriberId });
  const screen = s && s.status === 200 ? toScreen(s.json) : null;
  if (screen && (screen.kind === "customer" || screen.kind === "staff")) return sendScreen(bot, r.shop, chat.id, screen, `menu.${screen.kind}`);
  return askContact(bot, r.shop, chat.id);
}

/** owner I1: menu buttons (edit in place). Who pressed and where comes from Telegram; the shop checks staff/group data. */
async function onMenuCallback(bot: Bot, q: CallbackQuery, p: NonNullable<ReturnType<typeof parseCallback>>): Promise<void> {
  const chat = q.message?.chat;
  await tg(bot, "answerCallbackQuery", { callback_query_id: q.id });
  if (!chat || q.from.is_bot || !q.message) return;
  if (!checkRate(`tg:chat:${bot.code}:${chat.id}`, 20, 60)) return;
  await logMessage({ direction: "in", bot: bot.code, shop: bot.shop_code, chatId: chat.id, tgUser: q.from.id, kind: `cb.${p.kind}.${p.action}` });
  const mid = q.message.message_id;
  if (p.kind === "m") {
    if (bot.kind !== "master" || chat.type !== "private") return;
    if (p.action === "follow") await sql`insert into hub_followers (telegram_user_id, chat_id, first_name) values (${q.from.id}, ${chat.id}, ${q.from.first_name?.slice(0, 100) ?? null})
      on conflict (telegram_user_id) do update set chat_id = excluded.chat_id, stopped_at = null`;
    if (p.action === "unfollow") await sql`update hub_followers set stopped_at = now() where telegram_user_id = ${q.from.id} and stopped_at is null`;
    if (p.action === "about") return show(bot, chat.id, mid, "ℹ️ HangKH ជួយហាងគ្រប់គ្រងការងារ ជាង និងអតិថិជន តាមកម្មវិធី និង Telegram។", { inline_keyboard: [[{ text: "⬅️ ត្រឡប់", callback_data: "m:home" }]] }, "about", null);
    const mm = await masterMenu(q.from.id);
    return show(bot, chat.id, mid, mm.text, mm.markup, "menu.master", null);
  }
  const shop = bot.kind === "shop" && bot.shop_code ? await getShop(bot.shop_code) : null;
  if (!shop) return;
  if (p.kind === "c") { // D-106: «🔕 stop notifications» — the customer's own subscription with this shop only
    if (chat.type !== "private") return;
    const who = q.from.id, action = p.action as "menu" | "stop_promo" | "stop_all" | "resume_promo" | "resume_all" | "cancel";
    if (action === "menu") return showStop(bot, shop, chat.id, who, mid);
    if ((action === "resume_promo" || action === "resume_all") && !(await subscriptionOf(who, shop.code))) return consentPrompt(bot, shop, chat.id);
    if (action === "stop_promo") await stopSubscriptions(who, true, shop.code);
    if (action === "stop_all") await stopSubscriptions(who, false, shop.code);
    if (action === "resume_promo") await resumePromo(who, shop.code);
    if (action === "resume_all") await resumeAll(who, shop.code);
    const m = stopResult(action);
    if ((q.message.text ?? "").startsWith("🎁")) { // pressed under a promotion: the promotion stays, its button goes; the answer is a new message
      await tg(bot, "editMessageReplyMarkup", { chat_id: chat.id, message_id: mid, reply_markup: { inline_keyboard: [] } });
      return show(bot, chat.id, null, m.text, m.markup, `notify.${action}`, shop.code);
    }
    return show(bot, chat.id, mid, m.text, m.markup, `notify.${action}`, shop.code);
  }
  // v: staff views (private chats only — groups get notifications, D-91), rendered by the shop from its own data
  if (chat.type !== "private") return;
  const v = await shopMenu(shop, chat.id, p.action, p.id, p.back);
  if (v && v.keyboard) { // language changed → the role keyboard is sent again (a reply keyboard needs a new message)
    await show(bot, chat.id, mid, QUICK[v.lang], v.markup, `menu.${p.action}`, shop.code);
    return reply(bot, chat.id, v.text, shop.code, "menu.keyboard", v.keyboard, false);
  }
  if (v && v.remove_keyboard) return reply(bot, chat.id, v.text, shop.code, `menu.${p.action}`, { remove_keyboard: true }, false);
  if (v && v.ask_location) { // FR-902 / job «arrive»: a reply keyboard can only come with a new message
    await show(bot, chat.id, mid, v.text, v.markup, `menu.${p.action}`, shop.code);
    return reply(bot, chat.id, LOC_ASK[v.lang], shop.code, "attendance.ask", { keyboard: [[{ text: LOC_BTN[v.lang], request_location: true }]], resize_keyboard: true, one_time_keyboard: true }, false);
  }
  if (v) return show(bot, chat.id, mid, v.text, v.markup, `menu.${p.action}`, shop.code);
  return show(bot, chat.id, mid, customerText.useButtons, { inline_keyboard: [] }, "menu.none", shop.code); // not staff (any more): never staff data
}

export async function handleUpdate(bot: Bot, update: Update, log: FastifyBaseLogger): Promise<void> {
  if (update.callback_query) return onCallback(bot, update.callback_query);
  if (update.message) return onMessage(bot, update.message, log);
}
