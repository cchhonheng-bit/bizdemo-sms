// Shop → hub calls over the internal network (D-51). The shop never holds the bot token:
// every Telegram message goes through POST hub/internal/send, authenticated by the shop's own key.
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import type { SendResult } from "./telegram.js";

export type HubResponse = { status: number; json: any };
export type HubTransport = (method: "GET" | "POST", path: string, body?: unknown) => Promise<HubResponse>;

const fetchTransport: HubTransport = async (method, path, body) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${config.shop.hubUrl}${path}`, {
      method, signal: ctrl.signal,
      headers: { "x-shop-code": config.shop.code, "x-hub-key": config.shop.hubKey, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: await res.json().catch(() => null) };
  } finally {
    clearTimeout(timer);
  }
};

let transport: HubTransport = fetchTransport;
/** tests: route hub calls to an in-process hub app */
export function setHubTransport(t: HubTransport | null): void { transport = t ?? fetchTransport; }
export function hubConfigured(): boolean { return transport !== fetchTransport || (!!config.shop.hubUrl && !!config.shop.hubKey); }

export async function hubCall(method: "GET" | "POST", path: string, body?: unknown): Promise<HubResponse> {
  if (!hubConfigured()) throw new AppError("HUB_NOT_CONFIGURED", 503);
  try {
    return await transport(method, path, body);
  } catch {
    throw new AppError("HUB_UNREACHABLE", 503);
  }
}

/** Outbox delivery through the hub (same result shape as the old direct Bot API sender). */
/** silent (D-119): Telegram delivers it without sound */
export async function sendViaHub(chatId: number | string, text: string, replyMarkup?: unknown, silent = false): Promise<SendResult> {
  if (!hubConfigured()) return { ok: false, error: "HUB_NOT_CONFIGURED", permanent: false };
  let r: HubResponse;
  try {
    r = await transport("POST", "/internal/send", { chat_id: String(chatId), text, reply_markup: replyMarkup ?? null, ...(silent ? { silent: true } : {}) });
  } catch (e) {
    return { ok: false, error: `HUB_UNREACHABLE ${(e as Error).message}`, permanent: false };
  }
  if (r.status === 200 && r.json?.ok) return { ok: true };
  const err = String(r.json?.error ?? `HTTP ${r.status}`);
  // CHAT_NOT_ALLOWED / Telegram 400/403 never succeed on retry; hub down / 5xx / 429 do
  const permanent = r.json?.permanent === true || err === "CHAT_NOT_ALLOWED";
  return { ok: false, error: err, permanent, retryAfter: r.json?.retry_after };
}

/** T6: this shop's own bot username, asked from the hub (so a new/replaced bot needs no shop redeploy). 60 s cache;
 *  falls back to TELEGRAM_BOT_USERNAME when the hub cannot be reached. */
let botCache: { at: number; username: string | null } | null = null;
export function resetBotCache(): void { botCache = null; }
export async function shopBotUsername(): Promise<string | null> {
  if (botCache && Date.now() - botCache.at < 60_000) return botCache.username;
  let username: string | null = config.telegram.botUsername || null;
  if (hubConfigured()) {
    try {
      const r = await transport("GET", "/internal/bot");
      if (r.status === 200) username = r.json?.username ?? null;
    } catch { /* hub down: keep the fallback */ }
  }
  botCache = { at: Date.now(), username };
  return username;
}

/** T4: tell the owner (through the hub's master bot). Fire-and-forget, never throws; the hub throttles per kind. */
export function hubAlert(kind: "outbox" | "error", text: string): void {
  if (!hubConfigured()) return;
  void transport("POST", "/internal/alert", { kind, text: text.slice(0, 900) }).catch(() => undefined);
}
