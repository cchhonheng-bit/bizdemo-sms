// Bot API client (hub only). Every call names the bot it speaks as (T1: one bot per shop + the master bot);
// tokens come decrypted from the bot registry and never leave this module's call. Transport is swappable for tests.
import { config } from "../config.js";

export type TgResult = { ok: true; result?: unknown } | { ok: false; error: string; permanent: boolean; retryAfter?: number };
/** the bot a call is made with: `code` for logs/tests, `token` for Telegram */
export type BotRef = { code: string; token: string };
export type TgTransport = (method: string, payload: Record<string, unknown>, bot: BotRef) => Promise<TgResult>;

const httpTransport: TgTransport = async (method, payload, bot) => {
  if (!bot.token) return { ok: false, error: "NO_BOT_TOKEN", permanent: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${config.telegram.apiBase}/bot${bot.token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal, body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    if (res.ok && json.ok) return { ok: true, result: json.result };
    // 400 (chat not found) and 403 (bot blocked / kicked) never succeed on retry; 401 = token revoked; 429 and 5xx do
    return { ok: false, error: `${res.status} ${json.description ?? ""}`.trim(), permanent: res.status === 400 || res.status === 401 || res.status === 403, retryAfter: json.parameters?.retry_after };
  } catch (e) {
    return { ok: false, error: (e as Error).message, permanent: false };
  } finally {
    clearTimeout(timer);
  }
};

let transport: TgTransport = httpTransport;
export function setTelegramTransport(t: TgTransport | null): void { transport = t ?? httpTransport; }
export const isRealTransport = () => transport === httpTransport;

// per-bot pacing (T7): Telegram allows ~30 messages/s per bot → ≤ HUB_SEND_RATE per bot, bots independent
const nextSlot = new Map<string, number>();
async function pace(bot: string): Promise<void> {
  if (transport !== httpTransport) return;
  const gap = Math.ceil(1000 / Math.max(1, config.hub.sendRate));
  const now = Date.now(), at = Math.max(now, nextSlot.get(bot) ?? 0);
  nextSlot.set(bot, at + gap);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

export const tg = (bot: BotRef, method: string, payload: Record<string, unknown>) => transport(method, payload, bot);

export async function sendMessage(bot: BotRef, chatId: number | string, text: string, replyMarkup?: unknown): Promise<TgResult> {
  await pace(bot.code);
  return tg(bot, "sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup ?? undefined, disable_web_page_preview: true });
}

export function setWebhook(bot: BotRef, url: string, secret: string): Promise<TgResult> {
  return tg(bot, "setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
}

/** Commands shown in the Telegram menu: shop bots (T3) and the master bot (T4) */
export function setCommands(bot: BotRef, kind: "shop" | "master"): Promise<TgResult> {
  const commands = kind === "shop"
    ? [
      { command: "start", description: "Start" },
      { command: "stop", description: "Stop messages (/stop promo = promotions off)" },
      { command: "help", description: "Help" },
      { command: "register", description: "Set the work group (/register <code>)" },
    ]
    : [
      { command: "start", description: "Start / Follow HangKH" },
      { command: "stop", description: "Stop following HangKH" },
      { command: "help", description: "Help" },
    ];
  return tg(bot, "setMyCommands", { commands });
}
