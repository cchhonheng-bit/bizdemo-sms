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
export async function sendViaHub(chatId: number | string, text: string, replyMarkup?: unknown): Promise<SendResult> {
  if (!hubConfigured()) return { ok: false, error: "HUB_NOT_CONFIGURED", permanent: false };
  let r: HubResponse;
  try {
    r = await transport("POST", "/internal/send", { chat_id: String(chatId), text, reply_markup: replyMarkup ?? null });
  } catch (e) {
    return { ok: false, error: `HUB_UNREACHABLE ${(e as Error).message}`, permanent: false };
  }
  if (r.status === 200 && r.json?.ok) return { ok: true };
  const err = String(r.json?.error ?? `HTTP ${r.status}`);
  // CHAT_NOT_ALLOWED / Telegram 400/403 never succeed on retry; hub down / 5xx / 429 do
  const permanent = r.json?.permanent === true || err === "CHAT_NOT_ALLOWED";
  return { ok: false, error: err, permanent, retryAfter: r.json?.retry_after };
}
