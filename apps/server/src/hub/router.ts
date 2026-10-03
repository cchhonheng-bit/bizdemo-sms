// Telegram router (T1/T3/T4/T5). Every update arrives on ONE bot's webhook path, so the hub always knows the context:
//  • a shop bot (@Oneteam_app_bot …): its own staff links, work-group /register, Subscribe + consent, /stop — only for that shop
//  • the master bot (@hangkh_bot): owner alerts link, optional "Follow HangKH", pointers to shop bots for old links
// Privacy mode ON (BotFather) → in groups a bot only sees commands. Forwarded messages and free text are ignored
// and never stored (the message log keeps the command only).
import type { FastifyBaseLogger } from "fastify";
import { GROUP_CODE_LEN, parseLinkCode, parseSubscribe, shopBotCode, SUBSCRIBE_PAYLOAD, consentText } from "@sms/shared";
import { checkRate, refundRate } from "../lib/rate-limit.js";
import { acceptConsent, consentMarkup, privacyUrl, stopSubscriptions, type TgFrom } from "./subscribers.js";
import { callShop, getShop, logMessage, type Shop } from "./shops.js";
import { sql } from "../db.js";
import { masterBot, shopBot, type Bot } from "./bots.js";
import { sendMessage, tg } from "./telegram-api.js";
import { linkAdminChat } from "./alerts.js";
import { customerMenu, groupHelp, masterMenu, onCustomerAction, parseCallback, shopMenu, show, toKeyboard, toScreen, type ShopScreen } from "./menus.js";
import { resumePromo } from "./subscribers.js";

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
export type Message = { message_id: number; date?: number; chat: Chat; from?: TgFrom & { is_bot?: boolean }; text?: string; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown;
  location?: { latitude: number; longitude: number; horizontal_accuracy?: number; live_period?: number } };
export type CallbackQuery = { id: string; from: TgFrom & { is_bot?: boolean }; message?: { message_id: number; chat: Chat }; data?: string };
export type Update = { update_id: number; message?: Message; callback_query?: CallbackQuery };

const BAD_CODE_LIMIT = 10; // wrong codes per Telegram user per hour (S-11 brute force), across all bots

export function parseCommand(text: string, botUsername: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

async function reply(bot: Bot, chatId: number, text: string, shop: string | null, kind: string, markup?: unknown, logText = true): Promise<void> {
  const r = await sendMessage(bot, chatId, text, markup);
  await logMessage({ direction: "out", bot: bot.code, shop, chatId, kind, text: logText ? text : null, ok: r.ok, error: r.ok ? null : r.error });
}

const shopHelp = (name: string) => [
  `🤖 ${name}`,
  "• បុគ្គលិក: ចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធី (ទំព័រ ខ្ញុំ)",
  "• អតិថិជន: បើកតំណ/QR របស់ហាង ដើម្បីចុះឈ្មោះ",
  "• /stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទទួលសារទាំងអស់ពីហាងនេះ",
  `• គោលការណ៍ឯកជនភាព: ${privacyUrl()}`,
].join("\n");
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
    await reply(bot, msg.chat.id, "⚠️ ប្រព័ន្ធហាងមិនឆ្លើយតបពេលនេះ។ សូមព្យាយាមម្ដងទៀតក្នុងពេលបន្តិច។", shop.code, `${kind}.shop_down`);
    return;
  }
  if (r.json.ok) {
    refundRate(badKey);
    // from now on this shop (through its own bot) may send to this chat — the allowlist for /internal/send (T7)
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values (${shop.code}, ${msg.chat.id}, ${kind === "link" ? "staff" : "group"}) on conflict do nothing`;
  }
  await reply(bot, msg.chat.id, r.json.reply.slice(0, 1000), shop.code, `${kind}.${r.json.ok ? "ok" : "fail"}`);
}

async function onShopMessage(bot: Bot, msg: Message, c: { cmd: string; arg: string }, log: FastifyBaseLogger): Promise<void> {
  const isPrivate = msg.chat.type === "private";
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const shop = await getShop(bot.shop_code!);
  if (!shop) return;
  if (isPrivate && c.cmd === "start") {
    if (!c.arg) return startMenu(bot, shop, msg.chat.id, msg.from!.id);
    if (c.arg.toLowerCase() === SUBSCRIBE_PAYLOAD || parseSubscribe(c.arg) === shop.code) {
      if (shop.status !== "active" || !shop.subscribe) return reply(bot, msg.chat.id, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", shop.code, "subscribe.unavailable");
      const master = await masterBot();
      return reply(bot, msg.chat.id, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentMarkup(shop.code, master?.status === "active" ? master.username : null));
    }
    const cust = c.arg.match(/^s_([A-HJ-NP-Z2-9]{8})$/i); // A2: the customer's own subscribe link (service reminders)
    if (cust) {
      if (shop.status !== "active" || !shop.subscribe) return reply(bot, msg.chat.id, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", shop.code, "subscribe.unavailable");
      const master = await masterBot();
      return reply(bot, msg.chat.id, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentMarkup(shop.code, master?.status === "active" ? master.username : null, cust[1]!.toUpperCase()));
    }
    // D-96: the one-click link of a website booking, t.me/<shop bot>?start=b-<token>. Someone who already agreed (a live
    // subscription to this shop) is linked at once; everybody else sees the consent first (A4) and is linked with the tick.
    const web = c.arg.match(/^b-[A-Za-z0-9_-]{20}$/);
    if (web) {
      if (shop.status !== "active" || !shop.subscribe) return reply(bot, msg.chat.id, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", shop.code, "subscribe.unavailable");
      const subscriber = await subscriberOf(msg.from!.id, shop.code);
      if (!subscriber) {
        const master = await masterBot();
        return reply(bot, msg.chat.id, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentMarkup(shop.code, master?.status === "active" ? master.username : null, web[0]));
      }
      if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
      const x = await callShop(shop, "POST", "/internal/customer-subscribed", { code: web[0], subscriber_id: subscriber });
      const ok = !!(x && x.status === 200 && x.json?.ok);
      return reply(bot, msg.chat.id, ok ? `✅ ការកក់ ${String(x!.json.booking ?? "").slice(0, 20)} បានភ្ជាប់ — ការបញ្ជាក់ និងដំណឹងអំពីជាង ពី «${shop.name}» នឹងមកដល់ទីនេះ។`
        : "⚠️ តំណការកក់នេះត្រូវបានប្រើរួចហើយ ឬលែងប្រើបាន។", shop.code, ok ? "booking.linked" : "booking.link_failed", undefined, false);
    }
    return forwardCode(bot, "link", c.arg, msg, log);
  }
  if (isPrivate && c.cmd === "stop") {
    const promoOnly = /^promo\b/i.test(c.arg);
    const names = await stopSubscriptions(msg.from!.id, promoOnly, shop.code); // this shop only (T7)
    // /stop (all) also ends job messages from this shop to this private chat — the person's opt-out (R6)
    const staff = promoOnly ? [] : await sql`delete from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'staff' returning chat_id`;
    const lines: string[] = [];
    if (names.length) lines.push(promoOnly ? `✅ បិទប្រូម៉ូសិនរួច: ${names.join(", ")}។ អ្នកនៅទទួលដំណឹងសេវាកម្ម។` : `✅ ឈប់ទទួលសាររួច: ${names.join(", ")}។ ចុះឈ្មោះម្ដងទៀតបានតាមតំណរបស់ហាង។`);
    if (staff.length) lines.push(`ℹ️ ការងារពី ${shop.name} នឹងលែងផ្ញើមកទីនេះ។ ភ្ជាប់វិញ: កម្មវិធី → ខ្ញុំ → ភ្ជាប់ Telegram។`);
    return reply(bot, msg.chat.id, lines.length ? lines.join("\n") : "ℹ️ អ្នកមិនមានការចុះឈ្មោះសកម្មទេ។", shop.code, promoOnly ? "stop.promo" : "stop.all");
  }
  if (isGroup && c.cmd === "register") return forwardCode(bot, "group", c.arg, msg, log);
  if (isGroup && (c.cmd === "start" || c.cmd === "help")) { // D-91: work groups get notifications only — no menu
    const known = (await sql`select 1 from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'group'`).length > 0;
    return reply(bot, msg.chat.id, known ? `👥 ក្រុមការងារ · ${shop.name}\nការងារថ្មី ការប្ដូរម៉ោង ជំហានការងារ និងការលុបចោល ផ្ញើមកទីនេះដោយស្វ័យប្រវត្តិ។` : groupHelp, shop.code, known ? "group.info" : "help");
  }
  if (isPrivate && c.cmd === "help") return show(bot, msg.chat.id, null, shopHelp(shop.name), { inline_keyboard: [[{ text: "🏠 ម៉ឺនុយ", callback_data: "v:home" }]] }, "help", shop.code);
  if (isPrivate && c.cmd === "register") return reply(bot, msg.chat.id, "ℹ️ /register ប្រើក្នុងក្រុមការងារប៉ុណ្ណោះ។", shop.code, "register.private");
  if (c.cmd === "help") return reply(bot, msg.chat.id, isPrivate ? shopHelp(shop.name) : SHOP_HELP_GROUP, shop.code, "help");
}

/** the hub subscriber id of this Telegram user when they hold a live subscription to THIS shop (the shop maps it to its customer) */
const subscriberOf = async (tgUser: number, shopCode: string): Promise<number | null> =>
  (await sql<{ id: number }[]>`select u.id from hub_subscribers u join hub_subscriptions s on s.subscriber_id = u.id
    where u.telegram_user_id = ${tgUser} and s.shop_code = ${shopCode} and s.stopped_at is null and u.blocked_at is null`)[0]?.id ?? null;
const LOC_ASK = { km: "👇 ចុចប៊ូតុងខាងក្រោម ដើម្បីផ្ញើទីតាំងបច្ចុប្បន្ន (GPS)", en: "👇 Tap the button below to send your current location (GPS)" };
const LOC_BTN = { km: "📍 ផ្ញើទីតាំង", en: "📍 Send location" };
const QUICK = { km: "⚡ មើលរហ័ស", en: "⚡ Quick view" };
/** D-91: deliver a screen the shop rendered — the reply keyboard (role menu) rides on the text, inline buttons get their own message,
 *  a location request is a one-time keyboard. Screens hold the shop's data: never stored in the hub log (R5). */
async function sendScreen(bot: Bot, shop: Shop, chatId: number, s: ShopScreen, kind: string): Promise<void> {
  const inline = s.markup.inline_keyboard.length > 0;
  if (s.keyboard) { await reply(bot, chatId, s.text, shop.code, `${kind}.keyboard`, s.keyboard, false); if (!inline && !s.ask_location) return; }
  if (s.remove_keyboard) return reply(bot, chatId, s.text, shop.code, kind, { remove_keyboard: true }, false);
  if (s.ask_location) {
    if (inline) await show(bot, chatId, null, s.keyboard ? QUICK[s.lang] : s.text, s.markup, kind, shop.code);
    return reply(bot, chatId, inline || s.keyboard ? LOC_ASK[s.lang] : `${s.text}\n${LOC_ASK[s.lang]}`, shop.code, "attendance.ask",
      { keyboard: [[{ text: LOC_BTN[s.lang], request_location: true }]], resize_keyboard: true, one_time_keyboard: true }, false);
  }
  return inline ? show(bot, chatId, null, s.keyboard ? QUICK[s.lang] : s.text, s.markup, kind, shop.code) : reply(bot, chatId, s.text, shop.code, kind, undefined, false);
}
/** /start opens the menu: the shop's role keyboard for linked staff, the customer keyboard for a subscriber linked to a customer, else the hub's customer menu */
async function startMenu(bot: Bot, shop: Shop, chatId: number, tgUser: number): Promise<void> {
  const r = await callShop(shop, "POST", "/internal/tg-start", { chat_id: chatId, tg_user: tgUser, subscriber_id: await subscriberOf(tgUser, shop.code) });
  const s = r && r.status === 200 ? toScreen(r.json) : null;
  if (s && (s.kind === "staff" || s.kind === "customer")) {
    await sendScreen(bot, shop, chatId, s, s.kind === "staff" ? "menu.staff" : "menu.customer");
    if (s.kind === "staff") return;
  }
  const m = await customerMenu(shop, tgUser);
  return show(bot, chatId, null, m.text, m.markup, "menu.customer", shop.code);
}
/** D-91: a keyboard label or free text in a private chat with a shop bot → the shop answers. Only chats the hub knows (linked staff,
 *  subscribers of this shop) reach the shop; a stranger's text is ignored and never stored. */
async function onShopText(bot: Bot, msg: Message): Promise<void> {
  const shop = await getShop(bot.shop_code!);
  if (!shop || shop.status !== "active" || !msg.text || !msg.from) return;
  const staff = (await sql`select 1 from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${msg.chat.id} and kind = 'staff'`).length > 0;
  const subscriber = staff ? null : await subscriberOf(msg.from.id, shop.code);
  if (!staff && !subscriber) return;
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  const r = await callShop(shop, "POST", "/internal/tg-text", { chat_id: msg.chat.id, tg_user: msg.from.id, text: msg.text.slice(0, 1000), subscriber_id: subscriber });
  const kind = r && r.status === 200 ? String(r.json?.kind ?? "") : "";
  const s = r && r.status === 200 ? toScreen(r.json) : null;
  if (kind === "none" || (!s && kind !== "customer_menu")) return; // the shop does not know this chat (any more)
  await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: `text.${kind}`, text: null });
  if (kind === "customer_menu") { const m = await customerMenu(shop, msg.from.id); return show(bot, msg.chat.id, null, m.text, m.markup, "menu.customer", shop.code); }
  return sendScreen(bot, shop, msg.chat.id, s!, `text.${kind}`);
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

/** FR-902: a staff member sends a location to the shop bot (private chat) → the shop records check-in / check-out.
 *  The hub stores no coordinates; the shop refuses unknown chats and old locations and flags points without GPS accuracy. */
async function onLocation(bot: Bot, msg: Message): Promise<void> {
  const shop = await getShop(bot.shop_code!);
  if (!shop || !msg.location || !msg.from) return;
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return;
  await logMessage({ direction: "in", bot: bot.code, shop: shop.code, chatId: msg.chat.id, tgUser: msg.from.id, kind: "location", text: null });
  const l = msg.location;
  const r = await callShop(shop, "POST", "/internal/tg-location", { chat_id: msg.chat.id, tg_user: msg.from.id, lat: l.latitude, lng: l.longitude,
    accuracy: typeof l.horizontal_accuracy === "number" ? l.horizontal_accuracy : null, sent_at: msg.date ?? 0 }); // the shop decides: a job «arrive» step or attendance
  const text = r && r.status === 200 && typeof r.json?.reply === "string" ? String(r.json.reply).slice(0, 1000) : "❌ មិនអាចកត់វត្តមានបានទេ — សូមព្យាយាមម្ដងទៀត ឬប្រើកម្មវិធី។";
  const kb = r && r.status === 200 ? toKeyboard(r.json?.keyboard) : null; // D-91: the role keyboard replaces the one-time location keyboard
  return reply(bot, msg.chat.id, text, shop.code, "attendance.location", kb ?? { remove_keyboard: true });
}

async function onMessage(bot: Bot, msg: Message, log: FastifyBaseLogger): Promise<void> {
  if (!msg.from || !msg.chat || typeof msg.chat.id !== "number" || msg.from.is_bot) return;
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return; // never act on forwarded text or locations
  if (msg.location && !msg.text) return bot.kind === "shop" && msg.chat.type === "private" ? onLocation(bot, msg) : undefined;
  if (!msg.text) return;
  const c = parseCommand(msg.text, bot.username);
  if (!c) return bot.kind === "shop" && msg.chat.type === "private" ? onShopText(bot, msg) : undefined; // free text: only private shop chats the hub knows (keyboard labels)
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return; // S-06, per bot
  await logMessage({ direction: "in", bot: bot.code, shop: bot.shop_code, chatId: msg.chat.id, tgUser: msg.from.id, kind: `/${c.cmd}`, text: null });
  return bot.kind === "shop" ? onShopMessage(bot, msg, c, log) : onMasterMessage(bot, msg, c);
}

async function onCallback(bot: Bot, q: CallbackQuery): Promise<void> {
  const p = parseCallback(q.data ?? "");
  const chat = q.message?.chat;
  if (p && p.kind !== "sub") return onMenuCallback(bot, q, p);
  const m = p ? ([q.data, p.shop, p.version] as const) : null;
  // a consent button counts only on the shop's OWN bot (no cross-shop consent — T7)
  if (!m || !chat || chat.type !== "private" || q.from.is_bot || bot.kind !== "shop" || m[1] !== bot.shop_code) {
    await tg(bot, "answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  if (!checkRate(`tg:chat:${bot.code}:${chat.id}`, 20, 60)) return;
  const r = await acceptConsent(q.from, chat.id, m[1]!, m[2]!);
  await logMessage({ direction: "in", bot: bot.code, shop: m[1]!, chatId: chat.id, tgUser: q.from.id, kind: r.ok ? "consent.ok" : `consent.${r.error}` });
  await tg(bot, "answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? "✅" : "❌" });
  if (r.ok) {
    // keep only the optional "Follow HangKH" link after the tick
    const master = await masterBot();
    await tg(bot, "editMessageReplyMarkup", { chat_id: chat.id, message_id: q.message!.message_id, reply_markup: consentMarkup(null, master?.status === "active" ? master.username : null) });
    // A2: came through the customer's own link → the shop links this subscriber to that customer (service reminders)
    // D-96: came through the link of a website booking (b-<token>) → the shop links this chat to that booking (single use)
    let linked = false, booking = "";
    const web = !!p?.code?.startsWith("b-");
    if (p?.code) {
      const x = await callShop(r.shop, "POST", "/internal/customer-subscribed", { code: p.code, subscriber_id: r.subscriberId });
      linked = !!(x && x.status === 200 && x.json?.ok);
      if (web && linked) booking = String(x!.json.booking ?? "").slice(0, 20);
    }
    const extra = web ? (linked ? `\n🗓 ការកក់ ${booking} បានភ្ជាប់ — ការបញ្ជាក់ និងដំណឹងអំពីជាង នឹងមកដល់ទីនេះ។` : "\n⚠️ តំណការកក់នេះត្រូវបានប្រើរួចហើយ ឬលែងប្រើបាន។") : "";
    // the booking number is the shop's data: it is sent, not kept in the hub log (R5)
    await reply(bot, chat.id, `✅ ចុះឈ្មោះរួច! អ្នកនឹងទទួលដំណឹងពី «${r.shop.name}»${linked && !web ? " (រួមទាំងការរំលឹកថែទាំ)" : ""}។${extra}\n/stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទាំងអស់`, r.shop.code, "subscribe.ok", undefined, !web);
  } else {
    await reply(bot, chat.id, r.error === "OLD_CONSENT" ? "⚠️ អត្ថបទយល់ព្រមនេះចាស់ហើយ។ សូមបើកតំណរបស់ហាងម្ដងទៀត។" : "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", m[1]!, "subscribe.fail");
  }
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
  if (p.kind === "c") {
    if (chat.type !== "private") return;
    return onCustomerAction(bot, chat.id, mid, q.from.id, p.action, {
      stop: async (promoOnly) => {
        const names = await stopSubscriptions(q.from.id, promoOnly, shop.code);
        if (!promoOnly) await sql`delete from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${chat.id} and kind = 'staff'`;
        return names;
      },
      promoOn: () => resumePromo(q.from.id, shop.code),
    });
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
  const cm = await customerMenu(shop, q.from.id); // not staff (any more) → the customer menu, never staff data
  return show(bot, chat.id, mid, cm.text, cm.markup, "menu.customer", shop.code);
}

export async function handleUpdate(bot: Bot, update: Update, log: FastifyBaseLogger): Promise<void> {
  if (update.callback_query) return onCallback(bot, update.callback_query);
  if (update.message) return onMessage(bot, update.message, log);
}
