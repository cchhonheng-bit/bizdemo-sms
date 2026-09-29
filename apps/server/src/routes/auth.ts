import type { FastifyPluginAsync } from "fastify";
import { loginSchema } from "@sms/shared";
import { config } from "../config.js";
import { login, logout } from "../services/auth.js";
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
  app.post("/logout", async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
  });
};
