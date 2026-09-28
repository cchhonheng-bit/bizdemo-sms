// POST /functions/v1/telegram-webhook   (Telegram → us; verify_jwt = false)
// Security (S-11): the request must carry X-Telegram-Bot-Api-Secret-Token == TELEGRAM_WEBHOOK_SECRET
// (set the same secret in setWebhook). Forwarded messages are ignored. Always answers 200 so Telegram
// does not retry forever; real errors are logged.
// Commands:
//   private chat  /start <code>   → link this Telegram account to the app user (code from Me page, 10 min)
//   group chat    /register       → set this group as the company's job channel (settings.manage only)
import { checkRate, serviceClient } from "../_shared/supabase.ts";
import { sendMessage } from "../_shared/telegram.ts";

const SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET") ?? "";
const BOT_USERNAME = (Deno.env.get("TELEGRAM_BOT_USERNAME") ?? "Oneteam_app_bot").toLowerCase();

type Chat = { id: number; type: "private" | "group" | "supergroup" | "channel"; title?: string };
type From = { id: number; is_bot?: boolean; first_name?: string };
type Message = {
  message_id: number;
  chat: Chat;
  from?: From;
  text?: string;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
};
type Update = { update_id: number; message?: Message };

const ok = () => new Response("ok", { status: 200 });

function command(text: string): { cmd: string; arg: string } | null {
  const m = text.trim().match(/^\/([a-z_]+)(?:@([a-z0-9_]+))?(?:\s+(.*))?$/i);
  if (!m) return null;
  if (m[2] && m[2].toLowerCase() !== BOT_USERNAME) return null; // command addressed to another bot
  return { cmd: m[1].toLowerCase(), arg: (m[3] ?? "").trim() };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  if (!SECRET || req.headers.get("x-telegram-bot-api-secret-token") !== SECRET) {
    return new Response("forbidden", { status: 403 });
  }
  let update: Update;
  try {
    update = await req.json();
  } catch {
    return ok();
  }
  const msg = update.message;
  if (!msg?.from || msg.from.is_bot || !msg.text) return ok();
  if (msg.forward_origin || msg.forward_from || msg.forward_from_chat) return ok(); // never act on forwarded text
  const c = command(msg.text);
  if (!c) return ok();

  const svc = serviceClient();
  // S-06: 20 commands / minute / chat
  if (!(await checkRate(svc, `tg:chat:${msg.chat.id}`, 20, 60))) return ok();

  try {
    if (msg.chat.type === "private" && c.cmd === "start") {
      const code = c.arg;
      if (!/^[a-f0-9]{32}$/.test(code)) {
        await sendMessage(msg.chat.id, "សូមចុច «ភ្ជាប់ Telegram» ក្នុងកម្មវិធី (ទំព័រ ខ្ញុំ) រួចបើកតំណដែលបង្ហាញ។");
        return ok();
      }
      const { data, error } = await svc.rpc("consume_telegram_link", { p_code: code, p_tg_user: msg.from.id, p_chat: msg.chat.id });
      if (error) {
        console.error("consume_telegram_link", error.message);
        await sendMessage(msg.chat.id, "មានបញ្ហាបច្ចេកទេស សូមព្យាយាមម្ដងទៀត។");
        return ok();
      }
      const r = data as { ok: boolean; full_name?: string; error?: string };
      await sendMessage(
        msg.chat.id,
        r.ok
          ? `✅ ភ្ជាប់រួចរាល់ ${r.full_name ?? ""}។ អ្នកនឹងទទួលការងារថ្មីនៅទីនេះ។`
          : "❌ កូដមិនត្រឹមត្រូវ ឬផុតកំណត់ (10 នាទី)។ សូមចុច «ភ្ជាប់ Telegram» ម្ដងទៀតក្នុងកម្មវិធី។",
      );
      return ok();
    }

    if ((msg.chat.type === "group" || msg.chat.type === "supergroup") && c.cmd === "register") {
      const { data, error } = await svc.rpc("register_telegram_group", {
        p_tg_user: msg.from.id,
        p_chat: msg.chat.id,
        p_title: (msg.chat.title ?? "").slice(0, 120),
      });
      if (error) {
        console.error("register_telegram_group", error.message);
        return ok();
      }
      const r = data as { ok: boolean; error?: string };
      await sendMessage(
        msg.chat.id,
        r.ok
          ? "✅ ក្រុមនេះត្រូវបានកំណត់ជាបណ្ដាញការងាររបស់ក្រុមហ៊ុន។ Booking ថ្មីនឹងផ្ញើមកទីនេះ។"
          : r.error === "NOT_LINKED"
          ? "❌ សូមភ្ជាប់គណនី Telegram របស់អ្នកក្នុងកម្មវិធីជាមុនសិន (ទំព័រ ខ្ញុំ → ភ្ជាប់ Telegram)។"
          : "❌ មានតែ CEO (settings.manage) ទេដែលអាចកំណត់ក្រុមនេះបាន។",
      );
      return ok();
    }

    if (msg.chat.type === "private" && c.cmd === "help") {
      await sendMessage(msg.chat.id, "One Team bot\n/start <code> — ភ្ជាប់គណនី\nក្នុងក្រុម: /register — កំណត់ក្រុមការងារ");
    }
  } catch (e) {
    console.error("telegram-webhook", (e as Error).message);
  }
  return ok();
});
