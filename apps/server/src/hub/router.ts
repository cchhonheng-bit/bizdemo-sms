// Telegram router (T1/T3/T4/T5). Every update arrives on ONE bot's webhook path, so the hub always knows the context:
//  • a shop bot (@Oneteam_app_bot …): its own staff links, work-group /register, Subscribe + consent, /stop — only for that shop
//  • the master bot (@hangkh_bot): owner alerts link, optional "Follow HangKH", pointers to shop bots for old links
// Privacy mode ON (BotFather) → in groups a bot only sees commands. Forwarded messages and free text are ignored
// and never stored (the message log keeps the command only).
import type { FastifyBaseLogger } from "fastify";
import { GROUP_CODE_LEN, parseLinkCode, parseSubscribe, shopBotCode, SUBSCRIBE_PAYLOAD, consentText } from "@sms/shared";
import { config } from "../config.js";
import { checkRate, refundRate } from "../lib/rate-limit.js";
import { acceptConsent, consentMarkup, privacyUrl, stopSubscriptions, type TgFrom } from "./subscribers.js";
import { callShop, getShop, logMessage } from "./shops.js";
import { sql } from "../db.js";
import { masterBot, shopBot, type Bot } from "./bots.js";
import { sendMessage, tg } from "./telegram-api.js";
import { linkAdminChat } from "./alerts.js";

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
export type Message = { message_id: number; chat: Chat; from?: TgFrom & { is_bot?: boolean }; text?: string; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown };
export type CallbackQuery = { id: string; from: TgFrom & { is_bot?: boolean }; message?: { message_id: number; chat: Chat }; data?: string };
export type Update = { update_id: number; message?: Message; callback_query?: CallbackQuery };

const BAD_CODE_LIMIT = 10; // wrong codes per Telegram user per hour (S-11 brute force), across all bots

export function parseCommand(text: string, botUsername: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

async function reply(bot: Bot, chatId: number, text: string, shop: string | null, kind: string, markup?: unknown): Promise<void> {
  const r = await sendMessage(bot, chatId, text, markup);
  await logMessage({ direction: "out", bot: bot.code, shop, chatId, kind, text, ok: r.ok, error: r.ok ? null : r.error });
}

const shopHelp = (name: string) => [
  `🤖 ${name}`,
  "• បុគ្គលិក: ចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធី (ទំព័រ ខ្ញុំ)",
  "• អតិថិជន: បើកតំណ/QR របស់ហាង ដើម្បីចុះឈ្មោះ",
  "• /stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទទួលសារទាំងអស់ពីហាងនេះ",
  `• គោលការណ៍ឯកជនភាព: ${privacyUrl()}`,
].join("\n");
const SHOP_HELP_GROUP = "🤖 កំណត់ Group ការងារ: /register <កូដពីកម្មវិធី> (ការកំណត់ → Telegram)";
const MASTER_HELP = ["🤖 HangKH", "• តាមដានដំណឹង HangKH: /start follow", "• /stop — ឈប់តាមដាន", `• គោលការណ៍ឯកជនភាព: ${config.publicUrl}/privacy`].join("\n");

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
    if (!c.arg) return reply(bot, msg.chat.id, shopHelp(shop.name), shop.code, "help");
    if (c.arg.toLowerCase() === SUBSCRIBE_PAYLOAD || parseSubscribe(c.arg) === shop.code) {
      if (shop.status !== "active" || !shop.subscribe) return reply(bot, msg.chat.id, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", shop.code, "subscribe.unavailable");
      const master = await masterBot();
      return reply(bot, msg.chat.id, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentMarkup(shop.code, master?.status === "active" ? master.username : null));
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
    if (staff.length) lines.push(`ℹ️ ការងារពី ${shop.name} នឹងលែងផ្ញើមកទីនេះ។ ភ្ជាប់វិញ: App → ខ្ញុំ → ភ្ជាប់ Telegram។`);
    return reply(bot, msg.chat.id, lines.length ? lines.join("\n") : "ℹ️ អ្នកមិនមានការចុះឈ្មោះសកម្មទេ។", shop.code, promoOnly ? "stop.promo" : "stop.all");
  }
  if (isGroup && c.cmd === "register") return forwardCode(bot, "group", c.arg, msg, log);
  if (isPrivate && c.cmd === "register") return reply(bot, msg.chat.id, "ℹ️ /register ប្រើក្នុង Group ការងារប៉ុណ្ណោះ។", shop.code, "register.private");
  if (c.cmd === "help") return reply(bot, msg.chat.id, isPrivate ? shopHelp(shop.name) : SHOP_HELP_GROUP, shop.code, "help");
}

async function onMasterMessage(bot: Bot, msg: Message, c: { cmd: string; arg: string }): Promise<void> {
  if (msg.chat.type !== "private") {
    if (c.cmd === "register" || c.cmd === "help") return reply(bot, msg.chat.id, "ℹ️ Group ការងារ ត្រូវកំណត់ជាមួយ bot របស់ហាង (កម្មវិធី: ការកំណត់ → Telegram)។", null, "master.group");
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
  if (c.cmd === "start" || c.cmd === "help") return reply(bot, msg.chat.id, MASTER_HELP, null, "help");
}

async function onMessage(bot: Bot, msg: Message, log: FastifyBaseLogger): Promise<void> {
  if (!msg.from || !msg.chat || typeof msg.chat.id !== "number" || msg.from.is_bot || !msg.text) return;
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return; // never act on forwarded text
  const c = parseCommand(msg.text, bot.username);
  if (!c) return; // free text: ignored, not stored
  if (!checkRate(`tg:chat:${bot.code}:${msg.chat.id}`, 20, 60)) return; // S-06, per bot
  await logMessage({ direction: "in", bot: bot.code, shop: bot.shop_code, chatId: msg.chat.id, tgUser: msg.from.id, kind: `/${c.cmd}`, text: null });
  return bot.kind === "shop" ? onShopMessage(bot, msg, c, log) : onMasterMessage(bot, msg, c);
}

async function onCallback(bot: Bot, q: CallbackQuery): Promise<void> {
  const m = (q.data ?? "").match(/^sub:([A-Z0-9]{2,20}):([\w-]{1,40})$/);
  const chat = q.message?.chat;
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
    await reply(bot, chat.id, `✅ ចុះឈ្មោះរួច! អ្នកនឹងទទួលដំណឹងពី «${r.shop.name}»។\n/stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទាំងអស់`, r.shop.code, "subscribe.ok");
  } else {
    await reply(bot, chat.id, r.error === "OLD_CONSENT" ? "⚠️ អត្ថបទយល់ព្រមនេះចាស់ហើយ។ សូមបើកតំណរបស់ហាងម្ដងទៀត។" : "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", m[1]!, "subscribe.fail");
  }
}

export async function handleUpdate(bot: Bot, update: Update, log: FastifyBaseLogger): Promise<void> {
  if (update.callback_query) return onCallback(bot, update.callback_query);
  if (update.message) return onMessage(bot, update.message, log);
}
