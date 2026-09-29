// Bot API client — the ONLY place that holds the @hangkh_bot token (hub container). Transport is swappable for tests.
import { config } from "../config.js";

export type TgResult = { ok: true; result?: unknown } | { ok: false; error: string; permanent: boolean; retryAfter?: number };
export type TgTransport = (method: string, payload: Record<string, unknown>) => Promise<TgResult>;

const httpTransport: TgTransport = async (method, payload) => {
  const token = config.telegram.botToken;
  if (!token) return { ok: false, error: "NO_BOT_TOKEN", permanent: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal, body: JSON.stringify(payload),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: unknown; description?: string; parameters?: { retry_after?: number } };
    if (res.ok && json.ok) return { ok: true, result: json.result };
    // 400 (chat not found) and 403 (bot blocked / kicked) never succeed on retry; 429 and 5xx do
    return { ok: false, error: `${res.status} ${json.description ?? ""}`.trim(), permanent: res.status === 400 || res.status === 403, retryAfter: json.parameters?.retry_after };
  } catch (e) {
    return { ok: false, error: (e as Error).message, permanent: false };
  } finally {
    clearTimeout(timer);
  }
};

let transport: TgTransport = httpTransport;
export function setTelegramTransport(t: TgTransport | null): void { transport = t ?? httpTransport; }
export function telegramReady(): boolean { return transport !== httpTransport || !!config.telegram.botToken; }

export const tg = (method: string, payload: Record<string, unknown>) => transport(method, payload);

export function sendMessage(chatId: number | string, text: string, replyMarkup?: unknown): Promise<TgResult> {
  return tg("sendMessage", { chat_id: chatId, text, reply_markup: replyMarkup ?? undefined, disable_web_page_preview: true });
}

export function setWebhook(publicUrl: string, secret: string): Promise<TgResult> {
  return tg("setWebhook", { url: `${publicUrl}/telegram/webhook`, secret_token: secret, allowed_updates: ["message", "callback_query"], drop_pending_updates: false });
}

/** Commands shown in the Telegram menu (A3: /start /stop /help /register) */
export function setCommands(): Promise<TgResult> {
  return tg("setMyCommands", { commands: [
    { command: "start", description: "ចាប់ផ្តើម / Start" },
    { command: "stop", description: "ឈប់ទទួលសារ (/stop promo = បិទប្រូម៉ូសិន)" },
    { command: "help", description: "ជំនួយ / Help" },
    { command: "register", description: "កំណត់ Group ការងារ (/register <កូដ>)" },
  ] });
}
