// Bot registry (T1/T2/T6/T7): one bot per shop + the HangKH master bot. Tokens + webhook secrets are encrypted at rest
// (crypto.ts); each bot has its own webhook path /tg/<path> + secret, so the hub knows the shop from the URL alone.
// A new shop bot = paste its token on the Platform page (or `cli hub-bot-set <CODE>` from stdin) — no code change.
import { randomBytes } from "node:crypto";
import type { FastifyBaseLogger } from "fastify";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { open, seal } from "./crypto.js";
import { setCommands, setWebhook, tg, type BotRef, type TgResult } from "./telegram-api.js";

export const MASTER_CODE = "HANGKH";
export type Bot = BotRef & { kind: "master" | "shop"; shop_code: string | null; username: string; path: string; status: "active" | "disabled"; secret: string };
type Row = { code: string; kind: "master" | "shop"; shop_code: string | null; username: string; path: string; status: "active" | "disabled"; token_enc: string; secret_enc: string };

let cache: { at: number; bots: Bot[] } | null = null;
export function invalidateBots(): void { cache = null; }

export async function listBots(): Promise<Bot[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.bots;
  const rows = await sql<Row[]>`select code, kind, shop_code, username, path, status, token_enc, secret_enc from hub_bots order by kind, code`;
  const bots = rows.map((r) => ({ code: r.code, kind: r.kind, shop_code: r.shop_code, username: r.username, path: r.path, status: r.status, token: open(r.token_enc), secret: open(r.secret_enc) }));
  cache = { at: Date.now(), bots };
  return bots;
}
export const botByPath = async (path: string) => (await listBots()).find((b) => b.path === path) ?? null;
export const shopBot = async (shop: string) => (await listBots()).find((b) => b.kind === "shop" && b.shop_code === shop) ?? null;
export const masterBot = async () => (await listBots()).find((b) => b.kind === "master") ?? null;
export const webhookUrl = (b: { path: string }) => `${config.publicUrl}/tg/${b.path}`;
/** public view (never the token or secret) */
export const publicBot = (b: Bot) => ({ code: b.code, kind: b.kind, shop_code: b.shop_code, username: b.username, path: b.path, status: b.status });

const TOKEN_RE = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

/** add or replace the bot of a shop (code = shop code) or the master bot (code = HANGKH). Returns the bot's public view. */
export async function setBot(code: string, rawToken: string, log?: FastifyBaseLogger): Promise<ReturnType<typeof publicBot> & { webhook: TgResult }> {
  code = code.toUpperCase();
  const token = rawToken.replace(/^﻿/, "").trim();
  if (!TOKEN_RE.test(token)) throw new AppError("BAD_TOKEN", 400);
  const kind: "master" | "shop" = code === MASTER_CODE ? "master" : "shop";
  if (kind === "shop" && (await sql`select 1 from hub_shops where code = ${code}`).length === 0) throw new AppError("UNKNOWN_SHOP", 404);
  const me = await tg({ code, token }, "getMe", {});
  if (!me.ok) throw new AppError("TOKEN_REFUSED", 400);
  const username = String((me.result as { username?: string })?.username ?? "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(username)) throw new AppError("TOKEN_REFUSED", 400);
  if (kind === "master" && username.toLowerCase() !== config.hub.masterUsername.toLowerCase()) throw new AppError("NOT_MASTER_BOT", 400, { username });
  const others = (await listBots()).filter((b) => b.code !== code);
  if (others.some((b) => b.username.toLowerCase() === username.toLowerCase() || b.token === token)) throw new AppError("BOT_IN_USE", 409, { username }); // one bot = one shop (T7)
  const old = (await listBots()).find((b) => b.code === code);
  if (old && old.token !== token) await tg(old, "deleteWebhook", {}).catch(() => undefined); // the replaced bot stops receiving
  const path = kind === "master" ? "hangkh" : code.toLowerCase().slice(0, 30);
  const secret = randomBytes(32).toString("base64url");
  await sql`insert into hub_bots (code, kind, shop_code, username, path, token_enc, secret_enc, status)
    values (${code}, ${kind}, ${kind === "shop" ? code : null}, ${username}, ${path}, ${seal(token)}, ${seal(secret)}, 'active')
    on conflict (code) do update set username = excluded.username, token_enc = excluded.token_enc, secret_enc = excluded.secret_enc,
      status = 'active', updated_at = now(), rotated_at = now()`;
  invalidateBots();
  const bot = (await listBots()).find((b) => b.code === code)!;
  const webhook = await connect(bot, log);
  return { ...publicBot(bot), webhook };
}

/** point Telegram at /tg/<path> with the bot's secret, and set its command menu */
export async function connect(bot: Bot, log?: FastifyBaseLogger): Promise<TgResult> {
  if (!config.publicUrl.startsWith("https://")) return { ok: false, error: "PUBLIC_URL is not https", permanent: true };
  let r: TgResult = { ok: false, error: "not tried", permanent: false };
  // right after a deploy both apps boot at once and the first Telegram call can time out (D-63)
  for (let attempt = 1; attempt <= 3; attempt++) {
    r = await setWebhook(bot, webhookUrl(bot), bot.secret);
    log?.info({ bot: bot.code, ok: r.ok, attempt, error: r.ok ? undefined : r.error }, "telegram setWebhook");
    if (r.ok || r.permanent) break;
    await new Promise((res) => setTimeout(res, (config.nodeEnv === "test" ? 1 : 5_000) * attempt));
  }
  await setCommands(bot, bot.kind).catch(() => undefined);
  return r;
}

export async function disableBot(code: string): Promise<void> {
  const b = (await listBots()).find((x) => x.code === code);
  if (!b) throw new AppError("NOT_FOUND", 404);
  await tg(b, "deleteWebhook", {}).catch(() => undefined);
  await sql`update hub_bots set status = 'disabled', updated_at = now() where code = ${code}`;
  invalidateBots();
}
export async function enableBot(code: string): Promise<TgResult> {
  await sql`update hub_bots set status = 'active', updated_at = now() where code = ${code}`;
  invalidateBots();
  const b = (await listBots()).find((x) => x.code === code);
  if (!b) throw new AppError("NOT_FOUND", 404);
  return connect(b);
}
/** new webhook secret (T6 rotate); Telegram gets it at once, so no update is lost between the two */
export async function rotateSecret(code: string): Promise<TgResult> {
  const b = (await listBots()).find((x) => x.code === code);
  if (!b) throw new AppError("NOT_FOUND", 404);
  const secret = randomBytes(32).toString("base64url");
  await sql`update hub_bots set secret_enc = ${seal(secret)}, rotated_at = now(), updated_at = now() where code = ${code}`;
  invalidateBots();
  return connect({ ...b, secret });
}
export async function webhookInfo(b: Bot): Promise<{ url: string; pending: number; last_error: string | null; ok: boolean }> {
  const r = await tg(b, "getWebhookInfo", {});
  const x = (r.ok ? r.result : {}) as { url?: string; pending_update_count?: number; last_error_message?: string };
  return { url: x.url ?? "", pending: x.pending_update_count ?? 0, last_error: r.ok ? (x.last_error_message ?? null) : r.error, ok: r.ok && x.url === webhookUrl(b) };
}

/** start-up: import the legacy single-bot token once (only if it is the master bot), then (re)connect every active bot */
export async function startBots(log: FastifyBaseLogger): Promise<void> {
  if (!(await masterBot()) && config.telegram.botToken) {
    try {
      const r = await setBot(MASTER_CODE, config.telegram.botToken, log);
      log.info({ bot: r.username }, "legacy TELEGRAM_BOT_TOKEN imported as the master bot (encrypted) — remove it from .env");
    } catch (e) {
      log.warn({ error: (e as AppError).code ?? String(e) }, "legacy TELEGRAM_BOT_TOKEN not imported");
    }
  }
  for (const b of await listBots()) if (b.status === "active") await connect(b, log);
}
