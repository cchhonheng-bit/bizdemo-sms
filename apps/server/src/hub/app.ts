// Hub (MODE=hub, hub.hangkh.com): webhooks of every bot (/tg/<path> — one bot per shop + the master bot), router,
// shop internal API, subscriber/consent, owner alerts, platform page.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import cookie from "@fastify/cookie";
import { z, ZodError } from "zod";
import { config, TRUSTED_PROXIES } from "../config.js";
import { sql } from "../db.js";
import { AppError, fromPg } from "../lib/errors.js";
import { safeEqual } from "../lib/secure.js";
import { handleUpdate, type Update } from "./router.js";
import { authShop, logMessage } from "./shops.js";
import { broadcastsOf, createBroadcast, subscribersOf } from "./subscribers.js";
import { sendMessage } from "./telegram-api.js";
import { botByPath, invalidateBots, masterBot, shopBot } from "./bots.js";
import { ALERT_KINDS, sendAlert } from "./alerts.js";
import { platformRoutes } from "./platform.js";
import { landingPage, legalPage } from "./pages.js";
import { brandRoutes } from "../routes/brand.js";

// shops may attach link / Mini App buttons and reply keyboards — never callback buttons (a forged "sub:" consent button — R12)
const https = z.string().url().max(512).refine((u) => u.startsWith("https://"), "HTTPS_ONLY");
const urlButton = z.object({ text: z.string().min(1).max(64), url: https.optional(), web_app: z.object({ url: https }).strict().optional() }).strict().refine((b) => !!b.url !== !!b.web_app, "ONE_TARGET");
const kbButton = z.object({ text: z.string().min(1).max(64), web_app: z.object({ url: https }).strict().optional(), request_location: z.literal(true).optional() }).strict();
const replyMarkup = z.union([
  z.object({ inline_keyboard: z.array(z.array(urlButton).max(4)).max(6) }).strict(),
  z.object({ keyboard: z.array(z.array(kbButton).max(2)).min(1).max(8), resize_keyboard: z.boolean().optional(), is_persistent: z.boolean().optional(), one_time_keyboard: z.boolean().optional() }).strict(),
  z.object({ remove_keyboard: z.literal(true) }).strict(),
]);
const sendSchema = z.object({ chat_id: z.string().regex(/^-?\d{1,20}$/), text: z.string().min(1).max(4096), reply_markup: replyMarkup.optional().nullable() }).strict();
const broadcastSchema = z.object({ kind: z.enum(["service", "promo"]), text: z.string().trim().min(1).max(1000), created_by_name: z.string().max(120).optional().nullable() }).strict();

/** Telegram WebApp initData check (HMAC-SHA256, key = HMAC("WebAppData", bot token)); auth_date at most 10 min old */
export function verifyWebAppData(initData: string, token: string): { ok: true; tg_user: number; auth_date: number; first_name: string | null } | { ok: false; error: string } {
  const p = new URLSearchParams(initData);
  const hash = p.get("hash"); if (!hash) return { ok: false, error: "NO_HASH" };
  p.delete("hash");
  const check = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  const expect = createHmac("sha256", secret).update(check).digest("hex");
  if (expect.length !== hash.length || !timingSafeEqual(Buffer.from(expect), Buffer.from(hash))) return { ok: false, error: "BAD_SIGNATURE" };
  const authDate = Number(p.get("auth_date") ?? 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 600) return { ok: false, error: "EXPIRED" };
  let user: { id?: unknown; first_name?: unknown } = {};
  try { user = JSON.parse(p.get("user") ?? "{}") as { id?: unknown; first_name?: unknown }; } catch { /* no user */ }
  if (typeof user.id !== "number") return { ok: false, error: "NO_USER" };
  return { ok: true, tg_user: user.id, auth_date: authDate, first_name: typeof user.first_name === "string" ? user.first_name.slice(0, 100) : null };
}

/** Telegram Login Widget check (D-96, customer home of a shop's website): hash = HMAC-SHA256(data-check-string, SHA256(bot token)),
 *  the data-check-string being every received field except hash as "key=value", sorted, joined by \n; auth_date at most a day old */
export function verifyLoginWidget(data: Record<string, string>, token: string): { ok: true; tg_user: number; auth_date: number; first_name: string | null } | { ok: false; error: string } {
  const { hash, ...rest } = data;
  if (!hash) return { ok: false, error: "NO_HASH" };
  const check = Object.keys(rest).sort().map((k) => `${k}=${rest[k]}`).join("\n");
  const expect = Buffer.from(createHmac("sha256", createHash("sha256").update(token).digest()).update(check).digest("hex")), given = Buffer.from(hash);
  if (expect.length !== given.length || !timingSafeEqual(expect, given)) return { ok: false, error: "BAD_SIGNATURE" };
  const authDate = Number(rest.auth_date ?? 0);
  if (!authDate || Math.abs(Date.now() / 1000 - authDate) > 86400) return { ok: false, error: "EXPIRED" };
  const id = Number(rest.id);
  if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, error: "NO_USER" };
  return { ok: true, tg_user: id, auth_date: authDate, first_name: rest.first_name ? rest.first_name.slice(0, 100) : null };
}

/** who a Telegram user is for ONE shop: the hub subscriber id when that person ever subscribed to this shop. Identity, not
 *  consent (a stopped subscription still says who it is; messages stay bound to a live one) — and never across shops (T7). */
async function subscriberIdentity(tgUser: number, shopCode: string): Promise<number | null> {
  const r = (await sql<{ id: string }[]>`select u.id::text as id from hub_subscribers u join hub_subscriptions s on s.subscriber_id = u.id
    where u.telegram_user_id = ${tgUser} and s.shop_code = ${shopCode} limit 1`)[0];
  return r ? Number(r.id) : null;
}

export function buildHubApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    trustProxy: config.trustProxy ? TRUSTED_PROXIES : false,
    bodyLimit: 256_000,
  });
  app.register(cookie);

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code });
    if (err instanceof ZodError) return reply.status(400).send({ error: "INVALID_INPUT" });
    const pg = fromPg(err);
    if (pg) return reply.status(pg.status).send({ error: pg.code });
    const e = err as { statusCode?: number; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? "BAD_REQUEST" });
    req.log.error(err);
    void sendAlert("error", `hub ${req.method} ${req.url.split("?")[0]}: ${(err as Error)?.message ?? "error"}`.slice(0, 500)).catch(() => undefined);
    return reply.status(500).send({ error: "INTERNAL" });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: "NOT_FOUND" }));

  // ---- public ----------------------------------------------------------------
  app.get("/healthz", async () => { await sql`select 1`; return { ok: true, mode: "hub" }; });
  app.register(brandRoutes, { prefix: "/brand" }); // HangKH brand files (D-90)
  app.get("/", async (req, reply) => reply.type("text/html; charset=utf-8").send(landingPage((await masterBot())?.username ?? config.hub.masterUsername,
    (req.query as { lang?: string } | undefined)?.lang === "en" ? "en" : "km")));
  for (const which of ["terms", "privacy"] as const) {
    app.get(`/${which}`, async (_req, reply) => reply.type("text/html; charset=utf-8").header("Cache-Control", "public, max-age=3600").send(legalPage(which)));
  }

  let lastReread = 0;
  // ---- Telegram → hub: one webhook path per bot (T2). The path names the bot (and so the shop); the bot's own secret
  //      header is checked first (wrong/missing ⇒ 403). Always 200 afterwards so Telegram does not retry forever. ----
  app.post("/tg/:path", async (req, reply) => {
    const path = String((req.params as { path?: string }).path ?? "");
    if (!/^[a-z0-9-]{2,30}$/.test(path)) return reply.status(403).send("forbidden");
    const given = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    let bot = await botByPath(path);
    // a bot added/rotated by the CLI (another process) is not in this process' 30 s cache yet → re-read once
    if ((!bot || !safeEqual(given, bot.secret)) && Date.now() - lastReread > 10_000) { lastReread = Date.now(); invalidateBots(); bot = await botByPath(path); } // ≤ 1 re-read / 10 s (no DB amplification from forged posts)
    if (!bot || bot.status !== "active" || !safeEqual(given, bot.secret)) return reply.status(403).send("forbidden");
    try {
      await handleUpdate(bot, (req.body ?? {}) as Update, req.log);
    } catch (e) {
      req.log.error(e, "telegram update");
    }
    return "ok";
  });
  // legacy single-bot webhook (before D-68): answered as the master bot until Telegram is re-pointed to /tg/hangkh at start-up
  app.post("/telegram/webhook", async (req, reply) => {
    const secret = config.telegram.webhookSecret;
    const given = String(req.headers["x-telegram-bot-api-secret-token"] ?? "");
    const bot = await masterBot();
    if (!secret || !safeEqual(given, secret) || !bot) return reply.status(403).send("forbidden");
    try { await handleUpdate(bot, (req.body ?? {}) as Update, req.log); } catch (e) { req.log.error(e, "telegram update"); }
    return "ok";
  });

  // ---- shop → hub (compose network only; caddy answers 404 for /internal/*) --------
  // D-91: Telegram Mini App login — the shop asks the hub to check WebApp initData with the shop's own bot token (never shared)
  app.post("/internal/tg-verify", async (req) => {
    const shop = await authShop(req);
    const { init_data } = z.object({ init_data: z.string().min(1).max(4000) }).strict().parse(req.body);
    const bot = await shopBot(shop.code);
    if (!bot || bot.status !== "active") return { ok: false, error: "NO_SHOP_BOT" };
    const v = verifyWebAppData(init_data, bot.token);
    return v.ok ? { ...v, subscriber_id: await subscriberIdentity(v.tg_user, shop.code) } : v; // D-96: customers sign in to the shop's website the same way
  });
  // D-96: Telegram Login Widget on the shop's website — the fields Telegram signed, checked with the shop's own bot token
  app.post("/internal/tg-login-verify", async (req) => {
    const shop = await authShop(req);
    const { data } = z.object({ data: z.record(z.string().max(40), z.string().max(400)).refine((d) => Object.keys(d).length <= 10, "TOO_MANY_FIELDS") }).strict().parse(req.body);
    const bot = await shopBot(shop.code);
    if (!bot || bot.status !== "active") return { ok: false, error: "NO_SHOP_BOT" };
    const v = verifyLoginWidget(data, bot.token);
    return v.ok ? { ...v, subscriber_id: await subscriberIdentity(v.tg_user, shop.code) } : v;
  });
  app.post("/internal/send", async (req) => {
    const shop = await authShop(req);
    const b = sendSchema.parse(req.body);
    // a shop may only write to chats that linked to it (staff) or registered with it (group) — D-51 / T7
    const allowed = await sql`select 1 from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${b.chat_id}::bigint`;
    if (allowed.length === 0) {
      await logMessage({ direction: "out", shop: shop.code, chatId: b.chat_id, kind: "shop.send", text: null, ok: false, error: "CHAT_NOT_ALLOWED" });
      return { ok: false, error: "CHAT_NOT_ALLOWED", permanent: true };
    }
    // …and only through ITS OWN bot (T1/T7). No active bot yet → retry later (the shop outbox keeps the row).
    const bot = await shopBot(shop.code);
    if (!bot || bot.status !== "active") return { ok: false, error: "NO_SHOP_BOT", permanent: false };
    const r = await sendMessage(bot, b.chat_id, b.text, b.reply_markup ?? undefined);
    // metadata only: shop messages contain the shop's customer data, which stays in the shop (A4 · R5)
    await logMessage({ direction: "out", bot: bot.code, shop: shop.code, chatId: b.chat_id, kind: "shop.send", text: `[${b.text.length} chars]`, ok: r.ok, error: r.ok ? null : r.error });
    return r.ok ? { ok: true } : { ok: false, error: r.error, permanent: r.permanent, retry_after: r.retryAfter };
  });

  /** A2: a service reminder to ONE subscriber of this shop — only while that subscription is active with service messages on */
  app.post("/internal/notify-subscriber", async (req) => {
    const shop = await authShop(req);
    const b = z.object({ subscriber_id: z.number().int().positive(), text: z.string().min(1).max(1000) }).strict().parse(req.body);
    const sub = (await sql<{ chat_id: string }[]>`select u.chat_id::text from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id
      where s.shop_code = ${shop.code} and s.subscriber_id = ${b.subscriber_id} and s.stopped_at is null and s.service and u.blocked_at is null`)[0];
    if (!sub) return { ok: false, error: "NOT_SUBSCRIBED" };
    const bot = await shopBot(shop.code);
    if (!bot || bot.status !== "active") return { ok: false, error: "NO_SHOP_BOT" };
    const r = await sendMessage(bot, Number(sub.chat_id), b.text);
    await logMessage({ direction: "out", bot: bot.code, shop: shop.code, chatId: Number(sub.chat_id), kind: "reminder", text: `[${b.text.length} chars]`, ok: r.ok, error: r.ok ? null : r.error });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  });

  /** the shop's own bot username (deep links, QR) — so a new or replaced shop bot needs no shop redeploy (T6) */
  app.get("/internal/bot", async (req) => {
    const shop = await authShop(req);
    const bot = await shopBot(shop.code);
    return { username: bot && bot.status === "active" ? bot.username : null };
  });

  /** a shop reports a problem for the owner (failed outbox, server errors) — throttled, master bot (T4) */
  app.post("/internal/alert", async (req) => {
    const shop = await authShop(req);
    const b = z.object({ kind: z.enum(ALERT_KINDS), text: z.string().min(1).max(1000) }).strict().parse(req.body);
    return { ok: true, sent: await sendAlert(b.kind, `[${shop.code}] ${b.text}`) };
  });

  // the shop unlinked/deactivated a staff member → it may no longer write to that private chat (R6)
  app.post("/internal/chat-forget", async (req) => {
    const shop = await authShop(req);
    const b = z.object({ chat_id: z.string().regex(/^-?\d{1,20}$/) }).strict().parse(req.body);
    const r = await sql`delete from hub_shop_chats where shop_code = ${shop.code} and chat_id = ${b.chat_id}::bigint and kind = 'staff'`;
    return { ok: true, removed: r.count };
  });

  app.get("/internal/subscribers", async (req) => subscribersOf(await authShop(req)));
  app.get("/internal/broadcasts", async (req) => broadcastsOf(await authShop(req)));
  app.post("/internal/broadcast", async (req) => {
    const shop = await authShop(req);
    const b = broadcastSchema.parse(req.body);
    return createBroadcast(shop, b.kind, b.text, b.created_by_name ?? null);
  });

  // ---- owner --------------------------------------------------------------------
  app.register(platformRoutes, { prefix: "/platform" });
  return app;
}
