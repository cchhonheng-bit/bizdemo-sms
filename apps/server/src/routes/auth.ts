import type { FastifyPluginAsync } from "fastify";
import { loginSchema } from "@sms/shared";
import { config } from "../config.js";
import { z } from "zod";
import { createSession, login, logout } from "../services/auth.js";
import { hubCall, hubConfigured } from "../services/hub-client.js";
import { AppError } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { sql } from "../db.js";
import { mePayload } from "../services/me.js";
import { SESSION_COOKIE } from "../app.js";

export const cookieOpts = () => ({
  path: "/", httpOnly: true, sameSite: "lax" as const, secure: config.publicUrl.startsWith("https://"),
  maxAge: config.sessionDays * 86400,
});

export const authRoutes: FastifyPluginAsync = async (app) => {
  // POST /api/auth/login { identifier, password, company? } → { me }
  app.post("/login", async (req, reply) => {
    const body = loginSchema.parse(req.body);
    const r = await login(body.identifier, body.password, body.company || undefined, req.ip, req.headers["user-agent"]);
    reply.setCookie(SESSION_COOKIE, r.token, cookieOpts());
    return { me: await mePayload(r.userId), must_change_password: r.mustChangePassword };
  });
  // D-91: Telegram Mini App login — the hub checks the WebApp initData signature with the shop bot's token; a linked, active
  // staff member gets a normal session (same cookie). Customers never log in this way.
  app.post("/telegram", async (req, reply) => {
    const { init_data } = z.object({ init_data: z.string().min(1).max(4000) }).strict().parse(req.body);
    if (!checkRate(`tg:login:ip:${req.ip}`, 10, 60)) throw new AppError("RATE_LIMITED", 429);
    if (!hubConfigured()) throw new AppError("HUB_NOT_CONFIGURED", 503);
    const v = await hubCall("POST", "/internal/tg-verify", { init_data });
    if (!v || v.status !== 200 || !v.json?.ok || typeof v.json.tg_user !== "number") throw new AppError("INVALID_CREDENTIALS", 401);
    const u = (await sql<{ id: string }[]>`select u.id from users u join companies c on c.id = u.company_id where u.telegram_user_id = ${v.json.tg_user} and u.is_active and c.is_active limit 1`)[0];
    if (!u) throw new AppError("INVALID_CREDENTIALS", 401);
    const r = await createSession(u.id, req.ip, req.headers["user-agent"], "telegram");
    reply.setCookie(SESSION_COOKIE, r.token, cookieOpts());
    return { me: await mePayload(r.userId), must_change_password: r.mustChangePassword };
  });
  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
};
