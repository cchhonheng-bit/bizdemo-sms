import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { sql } from "../db.js";
import { AppError, bad } from "../lib/errors.js";
import { hashPassword, validatePassword, verifyPassword } from "../lib/password.js";
import { audit } from "../services/audit.js";
import { revokeUserSessions } from "../services/auth.js";
import { mePayload } from "../services/me.js";

export const meRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (req) => mePayload(req.user!.id));

  // name only (M1)
  app.patch("/", async (req) => {
    const { full_name } = z.object({ full_name: z.string().trim().min(1, "INVALID_NAME").max(80, "INVALID_NAME") }).parse(req.body);
    await sql`update users set full_name = ${full_name} where id = ${req.user!.id}`;
    return { ok: true };
  });

  app.post("/language", async (req) => {
    const { language } = z.object({ language: z.enum(["km", "en"]) }).parse(req.body);
    await sql`update users set language = ${language} where id = ${req.user!.id}`;
    return { ok: true };
  });

  // change own password. First login (must_change_password) needs no current password; otherwise it does.
  app.post("/password", async (req) => {
    const { current_password, new_password } = z.object({ current_password: z.string().max(72).optional(), new_password: z.string().max(72) }).parse(req.body);
    const err = validatePassword(new_password);
    if (err) throw bad(err);
    const u = (await sql<{ password_hash: string; must_change_password: boolean; company_id: string }[]>`select password_hash, must_change_password, company_id from users where id = ${req.user!.id}`)[0]!;
    if (!u.must_change_password) {
      if (!current_password || !(await verifyPassword(current_password, u.password_hash))) throw new AppError("WRONG_PASSWORD", 400);
    }
    await sql`update users set password_hash = ${await hashPassword(new_password)}, must_change_password = false where id = ${req.user!.id}`;
    await revokeUserSessions(req.user!.id, req.user!.sessionId); // other devices must log in again
    await audit(sql, { companyId: u.company_id, userId: req.user!.id, action: "password.changed", table: "users", rowId: req.user!.id, ip: req.ip });
    return { ok: true };
  });
};
