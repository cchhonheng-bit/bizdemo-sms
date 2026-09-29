// @hangkh_bot router (A3): one bot for every shop. The code prefix picks the shop; the shop validates the code.
// Privacy mode ON (BotFather) → in groups the bot only sees commands. Forwarded messages and free text are ignored
// and never stored (the message log keeps the command only).
import type { FastifyBaseLogger } from "fastify";
import { parseLinkCode, parseSubscribe } from "@sms/shared";
import { config } from "../config.js";
import { checkRate, underLimit } from "../lib/rate-limit.js";
import { acceptConsent, consentButton, privacyUrl, stopSubscriptions, type TgFrom } from "./subscribers.js";
import { callShop, getShop, logMessage } from "./shops.js";
import { sql } from "../db.js";
import { consentText } from "@sms/shared";
import { sendMessage, tg } from "./telegram-api.js";

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
export type Message = { message_id: number; chat: Chat; from?: TgFrom & { is_bot?: boolean }; text?: string; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown };
export type CallbackQuery = { id: string; from: TgFrom & { is_bot?: boolean }; message?: { message_id: number; chat: Chat }; data?: string };
export type Update = { update_id: number; message?: Message; callback_query?: CallbackQuery };

const BAD_CODE_LIMIT = 10; // wrong codes per Telegram user per hour (S-11 brute force)

export function parseCommand(text: string, botUsername: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

async function reply(chatId: number, text: string, shop: string | null, kind: string, markup?: unknown): Promise<void> {
  const r = await sendMessage(chatId, text, markup);
  await logMessage({ direction: "out", shop, chatId, kind, text, ok: r.ok, error: r.ok ? null : r.error });
}

const HELP_PRIVATE = [
  "🤖 HangKH bot",
  "• បុគ្គលិក: ចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធីហាង (ទំព័រ ខ្ញុំ)",
  "• អតិថិជន: បើកតំណ/QR របស់ហាង ដើម្បីចុះឈ្មោះ",
  "• /stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទទួលសារទាំងអស់",
  `• គោលការណ៍ឯកជនភាព: ${config.publicUrl}/privacy`,
].join("\n");
const HELP_GROUP = "🤖 HangKH bot · កំណត់ Group ការងារ: /register <កូដពីកម្មវិធី> (ការកំណត់ → Telegram)";

/** forward a staff/group code to the shop that owns the prefix; the shop answers with the reply text */
async function forwardCode(kind: "link" | "group", raw: string, msg: Message, log: FastifyBaseLogger): Promise<void> {
  const from = msg.from!;
  const parsed = parseLinkCode(raw);
  const expected = kind === "link" ? "staff" : "group";
  if (!underLimit(`tg:bad:${from.id}`, BAD_CODE_LIMIT, 3600)) {
    await reply(msg.chat.id, "⏳ ព្យាយាមច្រើនដងពេក។ សូមរង់ចាំ 1 ម៉ោង។", null, "rate_limited");
    return;
  }
  const shop = parsed && parsed.kind === expected ? await getShop(parsed.shop) : null;
  if (!parsed || parsed.kind !== expected || !shop || shop.status !== "active") {
    checkRate(`tg:bad:${from.id}`, BAD_CODE_LIMIT, 3600);
    await reply(msg.chat.id, kind === "link" ? "❌ តំណមិនត្រឹមត្រូវ។ សូមចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធីម្ដងទៀត។" : "❌ កូដក្រុមមិនត្រឹមត្រូវ។ ទម្រង់: /register ONETEAM-G-XXXXXX", parsed?.shop ?? null, `${kind}.invalid`);
    return;
  }
  const r = await callShop(shop, "POST", "/internal/telegram", { kind, code: parsed.code, tg_user: from.id, chat_id: msg.chat.id, chat_title: msg.chat.title ?? "" });
  if (!r || r.status !== 200 || typeof r.json?.reply !== "string") {
    log.warn({ shop: shop.code, status: r?.status }, "shop did not answer");
    await reply(msg.chat.id, "⚠️ ប្រព័ន្ធហាងមិនឆ្លើយតបពេលនេះ។ សូមព្យាយាមម្ដងទៀតក្នុងពេលបន្តិច។", shop.code, `${kind}.shop_down`);
    return;
  }
  if (r.json.ok) {
    // from now on this shop may send to this chat (allowlist for /internal/send)
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values (${shop.code}, ${msg.chat.id}, ${kind === "link" ? "staff" : "group"}) on conflict do nothing`;
  } else {
    checkRate(`tg:bad:${from.id}`, BAD_CODE_LIMIT, 3600);
  }
  await reply(msg.chat.id, r.json.reply.slice(0, 1000), shop.code, `${kind}.${r.json.ok ? "ok" : "fail"}`);
}

async function onMessage(msg: Message, log: FastifyBaseLogger): Promise<void> {
  if (!msg.from || !msg.chat || typeof msg.chat.id !== "number" || msg.from.is_bot || !msg.text) return;
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return; // never act on forwarded text
  const c = parseCommand(msg.text, config.telegram.botUsername);
  if (!c) return; // free text: ignored, not stored
  if (!checkRate(`tg:chat:${msg.chat.id}`, 20, 60)) return; // S-06
  const isPrivate = msg.chat.type === "private";
  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  await logMessage({ direction: "in", chatId: msg.chat.id, tgUser: msg.from.id, kind: `/${c.cmd}`, text: null });

  if (isPrivate && c.cmd === "start") {
    if (!c.arg) return reply(msg.chat.id, HELP_PRIVATE, null, "help");
    const sub = parseSubscribe(c.arg);
    if (sub) {
      const shop = await getShop(sub);
      if (!shop || shop.status !== "active" || !shop.subscribe) return reply(msg.chat.id, "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", shop?.code ?? null, "subscribe.unavailable");
      return reply(msg.chat.id, consentText(shop.name, privacyUrl()), shop.code, "subscribe.prompt", consentButton(shop.code));
    }
    return forwardCode("link", c.arg, msg, log);
  }
  if (isPrivate && c.cmd === "stop") {
    const promoOnly = /^promo\b/i.test(c.arg);
    const names = await stopSubscriptions(msg.from.id, promoOnly);
    const text = names.length === 0
      ? "ℹ️ អ្នកមិនមានការចុះឈ្មោះសកម្មទេ។"
      : promoOnly ? `✅ បិទប្រូម៉ូសិនរួច: ${names.join(", ")}។ អ្នកនៅទទួលដំណឹងសេវាកម្ម។` : `✅ ឈប់ទទួលសាររួច: ${names.join(", ")}។ ចុះឈ្មោះម្ដងទៀតបានតាមតំណរបស់ហាង។`;
    return reply(msg.chat.id, text, null, promoOnly ? "stop.promo" : "stop.all");
  }
  if (isGroup && c.cmd === "register") return forwardCode("group", c.arg, msg, log);
  if (isPrivate && c.cmd === "register") return reply(msg.chat.id, "ℹ️ /register ប្រើក្នុង Group ការងារប៉ុណ្ណោះ។", null, "register.private");
  if (c.cmd === "help") return reply(msg.chat.id, isPrivate ? HELP_PRIVATE : HELP_GROUP, null, "help");
}

async function onCallback(q: CallbackQuery): Promise<void> {
  const m = (q.data ?? "").match(/^sub:([A-Z0-9]{2,20}):([\w-]{1,40})$/);
  const chat = q.message?.chat;
  if (!m || !chat || chat.type !== "private" || q.from.is_bot) {
    await tg("answerCallbackQuery", { callback_query_id: q.id });
    return;
  }
  if (!checkRate(`tg:chat:${chat.id}`, 20, 60)) return;
  const r = await acceptConsent(q.from, chat.id, m[1]!, m[2]!);
  await logMessage({ direction: "in", shop: m[1]!, chatId: chat.id, tgUser: q.from.id, kind: r.ok ? "consent.ok" : `consent.${r.error}` });
  await tg("answerCallbackQuery", { callback_query_id: q.id, text: r.ok ? "✅" : "❌" });
  if (r.ok) {
    await tg("editMessageReplyMarkup", { chat_id: chat.id, message_id: q.message!.message_id, reply_markup: { inline_keyboard: [] } });
    await reply(chat.id, `✅ ចុះឈ្មោះរួច! អ្នកនឹងទទួលដំណឹងពី «${r.shop.name}»។\n/stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទាំងអស់`, r.shop.code, "subscribe.ok");
  } else {
    await reply(chat.id, r.error === "OLD_CONSENT" ? "⚠️ អត្ថបទយល់ព្រមនេះចាស់ហើយ។ សូមបើកតំណរបស់ហាងម្ដងទៀត។" : "❌ ហាងនេះមិនទាន់បើកសេវាចុះឈ្មោះទេ។", m[1]!, "subscribe.fail");
  }
}

export async function handleUpdate(update: Update, log: FastifyBaseLogger): Promise<void> {
  if (update.callback_query) return onCallback(update.callback_query);
  if (update.message) return onMessage(update.message, log);
}
