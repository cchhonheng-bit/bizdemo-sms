// Telegram: link code (app), webhook (Telegram → us, S-11), manual flush.
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { checkRate } from "../lib/rate-limit.js";
import { consumeLinkCode, createLinkCode, flushOutbox, registerGroup, safeEqual, sendMessage } from "../services/telegram.js";

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
type Message = { message_id: number; chat: Chat; from?: { id: number; is_bot?: boolean }; text?: string; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown };
type Update = { update_id: number; message?: Message };

function command(text: string, botUsername: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== botUsername.toLowerCase()) return null; // addressed to another bot
  return { cmd: m[1]!.toLowerCase(), arg: (m[3] ?? "").trim() };
}

export const telegramRoutes: FastifyPluginAsync = async (app) => {
  // app → deep link t.me/<bot>?start=<code>
  app.post("/link-code", { preHandler: app.requireAuth }, async (req) => ({ code: await createLinkCode(req.user!.id), bot: config.telegram.botUsername || null }));

  // any authenticated user may trigger delivery (harmless; nothing but counts returned — F-M2-08)
  app.post("/flush", { preHandler: app.requireAuth }, async () => flushOutbox());

  // Telegram → us. Always 200 so Telegram does not retry forever; secret header checked first (empty secret ⇒ always 403).
  app.post("/webhook", { config: { rawBody: false } }, async (req, reply) => {
    const secret = config.telegram.webhookSecret;
    const given = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    if (!secret || !safeEqual(given, secret)) return reply.status(403).send("forbidden");
    const update = (req.body ?? {}) as Update;
    const msg = update.message;
    if (!msg?.from || msg.from.is_bot || !msg.text) return "ok";
    if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return "ok"; // never act on forwarded text
    const c = command(msg.text, config.telegram.botUsername);
    if (!c) return "ok";
    if (!checkRate(`tg:chat:${msg.chat.id}`, 20, 60)) return "ok"; // S-06
    try {
      if (msg.chat.type === "private" && c.cmd === "start") {
        if (!/^[a-f0-9]{32}$/.test(c.arg)) {
          await sendMessage(msg.chat.id, "សូមចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធី (ទំព័រ ខ្ញុំ) រួចបើកតំណដែលបង្ហាញ។");
          return "ok";
        }
        const r = await consumeLinkCode(c.arg, msg.from.id, msg.chat.id);
        await sendMessage(msg.chat.id, r.ok
          ? `✅ ភ្ជាប់រួចរាល់ ${r.fullName}។ អ្នកនឹងទទួលការងារថ្មីនៅទីនេះ។`
          : "❌ កូដមិនត្រឹមត្រូវ ឬផុតកំណត់ (10 នាទី)។ សូមចុច «ភ្ជាប់ Telegram» ម្ដងទៀតក្នុងកម្មវិធី។");
        return "ok";
      }
      if ((msg.chat.type === "group" || msg.chat.type === "supergroup") && c.cmd === "register") {
        const r = await registerGroup(msg.from.id, msg.chat.id, (msg.chat.title ?? "").slice(0, 120));
        await sendMessage(msg.chat.id, r.ok
          ? "✅ ក្រុមនេះត្រូវបានកំណត់ជាបណ្ដាញការងាររបស់ក្រុមហ៊ុន។ Booking ថ្មីនឹងផ្ញើមកទីនេះ។"
          : r.error === "NOT_LINKED"
            ? "❌ សូមភ្ជាប់គណនី Telegram របស់អ្នកក្នុងកម្មវិធីជាមុនសិន (ទំព័រ ខ្ញុំ → ភ្ជាប់ Telegram)។"
            : "❌ មានតែ CEO (settings.manage) ទេដែលអាចកំណត់ក្រុមនេះបាន។");
        return "ok";
      }
      if (msg.chat.type === "private" && c.cmd === "help") {
        await sendMessage(msg.chat.id, "One Team bot\n/start <code> — ភ្ជាប់គណនី\nក្នុងក្រុម: /register — កំណត់ក្រុមការងារ");
      }
    } catch (e) {
      req.log.error(e, "telegram webhook");
    }
    return "ok";
  });
};
