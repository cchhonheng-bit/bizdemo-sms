// Telegram Bot API helper (server-side only — the bot token never leaves Edge Functions).
const TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const API = `https://api.telegram.org/bot${TOKEN}`;

export type SendResult =
  | { ok: true }
  | { ok: false; error: string; permanent: boolean; retryAfter?: number };

export function telegramConfigured(): boolean {
  return TOKEN.length > 0;
}

/** sendMessage with a 10s timeout. 400/403 (chat not found / bot blocked) are permanent. */
export async function sendMessage(chatId: number, text: string, replyMarkup?: unknown): Promise<SendResult> {
  if (!TOKEN) return { ok: false, error: "TELEGRAM_BOT_TOKEN missing", permanent: false };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: replyMarkup ?? undefined,
        disable_web_page_preview: true,
      }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    const body = await res.json().catch(() => ({})) as { description?: string; parameters?: { retry_after?: number } };
    const desc = body.description ?? `HTTP ${res.status}`;
    if (res.status === 429) return { ok: false, error: desc, permanent: false, retryAfter: body.parameters?.retry_after };
    // 400 "chat not found", 403 "bot was blocked by the user" / "bot was kicked" → do not retry
    const permanent = res.status === 400 || res.status === 403;
    return { ok: false, error: `${res.status} ${desc}`.slice(0, 200), permanent };
  } catch (e) {
    return { ok: false, error: (e as Error).message.slice(0, 200), permanent: false };
  } finally {
    clearTimeout(t);
  }
}
