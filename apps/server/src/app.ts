// Fastify app factory: one process serves the web app, /api, the Telegram webhook and cron (Architecture v2 §2).
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import fstatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { type FeatureFlag, type PermissionKey } from "@sms/shared";
import { config, TRUSTED_PROXIES } from "./config.js";
import { features } from "./lib/features.js";
import { hubAlert, shopBotUsername } from "./services/hub-client.js";
import { sql } from "./db.js";
import { AppError, fromPg, unauthenticated } from "./lib/errors.js";
import { resolveSession, type SessionUser } from "./services/auth.js";
import { permissionsFor } from "./services/permissions.js";
import { authRoutes } from "./routes/auth.js";
import { meRoutes } from "./routes/me.js";
import { usersRoutes } from "./routes/users.js";
import { settingsRoutes } from "./routes/settings.js";
import { customersRoutes } from "./routes/customers.js";
import { catalogRoutes } from "./routes/catalog.js";
import { bookingsRoutes } from "./routes/bookings.js";
import { leaveRoutes } from "./routes/leave.js";
import { filesRoutes } from "./routes/files.js";
import { quotesRoutes } from "./routes/quotes.js";
import { invoicesRoutes } from "./routes/invoices.js";
import { attendanceRoutes } from "./routes/attendance.js";
import { reportsRoutes } from "./routes/reports.js";
import { partARoutes } from "./routes/part-a.js";
import { inventoryRoutes } from "./routes/inventory.js";
import { accountingRoutes } from "./routes/accounting.js";
import { notificationsRoutes } from "./routes/notifications.js";
import { telegramRoutes } from "./routes/telegram.js";
import { mapsRoutes } from "./routes/maps.js";
import { internalRoutes } from "./routes/internal.js";
import { subscribeRoutes } from "./routes/subscribe.js";
import { brandRoutes } from "./routes/brand.js";

export const SESSION_COOKIE = "ots";

declare module "fastify" {
  interface FastifyRequest {
    user: SessionUser | null;
    perms: PermissionKey[];
  }
  interface FastifyInstance {
    requireAuth: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePerm: (key: PermissionKey) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requireFeature: (flag: FeatureFlag) => (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

/** routes a user may call while must_change_password is set (F-M2-14: enforced server-side in v2) */
const PASSWORD_CHANGE_ALLOWED = new Set(["/api/me", "/api/me/password", "/api/auth/logout", "/api/config"]);

/** read per call so tests (and a restart after changing FEATURES) see the current value */
export { features } from "./lib/features.js";

export function buildApp(opts: { logger?: boolean } = {}): FastifyInstance {
  const app = Fastify({
    logger: opts.logger === false ? false : { level: config.logLevel },
    // trust exactly one hop (caddy in the same compose network); numeric hop counts are accepted at runtime but not typed
    trustProxy: config.trustProxy ? TRUSTED_PROXIES : false,
    bodyLimit: 1_000_000,
  });

  app.register(cookie, { secret: config.sessionSecret });

  // ---- auth decorators ------------------------------------------------------
  app.decorateRequest("user", null);
  app.decorateRequest("perms", null as unknown as PermissionKey[]);
  app.decorate("requireAuth", async (req: FastifyRequest) => {
    const token = req.cookies[SESSION_COOKIE];
    const user = token ? await resolveSession(token) : null;
    if (!user) throw unauthenticated();
    req.user = user;
    req.perms = await permissionsFor(sql, user.companyId, user.role);
    if (user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(req.routeOptions.url ?? req.url.split("?")[0]!)) {
      throw new AppError("PASSWORD_CHANGE_REQUIRED", 403);
    }
  });
  app.decorate("requirePerm", (key: PermissionKey) => async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!req.perms.includes(key)) throw new AppError("FORBIDDEN", 403);
  });

  // feature flags per shop (A6): a module that is off does not exist (404), whoever asks
  app.decorate("requireFeature", (flag: FeatureFlag) => async () => {
    if (!features().includes(flag)) throw new AppError("NOT_FOUND", 404);
  });

  // ---- errors ----------------------------------------------------------------
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) return reply.status(err.status).send({ error: err.code, details: err.details });
    if (err instanceof ZodError) return reply.status(400).send({ error: err.issues[0]?.message ?? "INVALID_INPUT", details: err.issues.map((i) => ({ path: i.path.join("."), message: i.message })) });
    const pg = fromPg(err);
    if (pg) {
      if (pg.code === "INVALID_VALUE") req.log.warn(err, "pg invalid value");
      return reply.status(pg.status).send({ error: pg.code });
    }
    const e = err as { statusCode?: number; code?: string; message?: string };
    if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.code ?? "BAD_REQUEST" });
    req.log.error(err);
    hubAlert("error", `${req.method} ${req.url.split("?")[0]}: ${(err as Error)?.message ?? "error"}`);
    return reply.status(500).send({ error: "INTERNAL" });
  });
  const hasWeb = existsSync(join(config.webDist, "index.html"));
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api/") || req.url.startsWith("/internal/") || !hasWeb) return reply.status(404).send({ error: "NOT_FOUND" });
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html"); // SPA fallback
  });

  // ---- public ----------------------------------------------------------------
  app.get("/healthz", async () => {
    await sql`select 1`;
    return { ok: true };
  });
  app.get("/api/config", async () => {
    // one company per shop box → its public name fills {{company_name}} in /terms and /privacy (A7)
    const c = (await sql<{ name: string }[]>`select name from companies where is_active order by created_at limit 1`)[0];
    return { appName: config.appName, companyName: c?.name ?? config.appName, telegramBot: await shopBotUsername(), shopCode: config.shop.code, features: features() };
  });

  // ---- api -------------------------------------------------------------------
  app.register(authRoutes, { prefix: "/api/auth" });
  app.register(meRoutes, { prefix: "/api/me" });
  app.register(usersRoutes, { prefix: "/api/users" });
  app.register(settingsRoutes, { prefix: "/api/settings" });
  app.register(customersRoutes, { prefix: "/api/customers" });
  app.register(catalogRoutes, { prefix: "/api/catalog" });
  app.register(bookingsRoutes, { prefix: "/api/bookings" });
  app.register(leaveRoutes, { prefix: "/api/leave" });
  app.register(filesRoutes, { prefix: "/api/files" });
  app.register(quotesRoutes, { prefix: "/api/quotes" });
  app.register(invoicesRoutes, { prefix: "/api/invoices" });
  app.register(attendanceRoutes, { prefix: "/api/attendance" });
  app.register(reportsRoutes, { prefix: "/api/reports" });
  app.register(partARoutes, { prefix: "/api" });
  app.register(inventoryRoutes, { prefix: "/api/inventory" });
  app.register(accountingRoutes, { prefix: "/api/accounting" });
  app.register(notificationsRoutes, { prefix: "/api/notifications" });
  app.register(telegramRoutes, { prefix: "/api/telegram" });
  app.register(mapsRoutes, { prefix: "/api/maps" });
  app.register(subscribeRoutes, { prefix: "/api/subscribe" });
  app.register(brandRoutes, { prefix: "/brand" }); // HangKH brand files (D-90)
  // hub → shop (compose network only; caddy blocks /internal/* from the internet)
  app.register(internalRoutes, { prefix: "/internal" });

  // ---- web app (static; SPA fallback in the not-found handler) ------------------
  if (hasWeb) app.register(fstatic, {
    root: config.webDist, prefix: "/", wildcard: false, index: ["index.html"], maxAge: "1h",
    setHeaders: (res, path) => { if (!/[\\/]assets[\\/]/.test(path)) res.setHeader("Cache-Control", "no-cache"); }, // index.html / sw.js / manifest always revalidate
  });
  return app;
}
