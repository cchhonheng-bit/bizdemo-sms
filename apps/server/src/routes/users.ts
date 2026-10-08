// Users administration (permission user.manage) — port of v1 admin-users + api.update_user.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createUserSchema, updateUserSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, bad, notFound } from "../lib/errors.js";
import { hashPassword, tempPassword, validatePassword } from "../lib/password.js";
import { audit } from "../services/audit.js";
import { revokeUserSessions } from "../services/auth.js";
import { PLATFORM_LOCKED, updateUser, USER_COLS } from "../services/users.js";

export const usersRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/users/basic — every authenticated user (names for assign dialogs, vehicle owners)
  app.get("/basic", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403); // technicians get names through their bookings only
    return sql`select id, company_id, full_name, role, is_active from users where company_id = ${req.user!.companyId} order by full_name`;
  });

  app.get("/", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    return sql`select ${USER_COLS} from users where company_id = ${req.user!.companyId} order by is_platform, role, full_name`; // HangKH Support last
  });

  // POST /api/users { username, full_name, role, phone?, email?, password? } → { id, temp_password? }
  app.post("/", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    const b = createUserSchema.parse(req.body);
    if (b.role === "ceo" && req.user!.role !== "ceo") throw new AppError("FORBIDDEN", 403); // only a CEO may create a CEO
    let password = b.password || "";
    const generated = !password;
    if (generated) password = tempPassword();
    const pwErr = validatePassword(password);
    if (pwErr) throw bad(pwErr);
    const id = await tx(req.user!.id, async (t) => {
      const r = await t<{ id: string }[]>`
        insert into users (company_id, username, phone, email, full_name, role, password_hash)
        values (${req.user!.companyId}, ${b.username}, ${b.phone || null}, ${b.email || null}, ${b.full_name}, ${b.role}::user_role, ${await hashPassword(password)})
        returning id`;
      const id = r[0]!.id;
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "user.create", table: "users", rowId: id, new: { username: b.username, role: b.role, full_name: b.full_name }, ip: req.ip });
      return id;
    });
    return { id, temp_password: generated ? password : undefined };
  });

  // PATCH /api/users/:id { full_name?, username?, phone?, email?, role?, is_active?, tracks_attendance?, language? }
  app.patch("/:id", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return updateUser(req.user!, req.ip, id, updateUserSchema.extend({ is_active: z.boolean().optional() }).parse(req.body));
  });

  // POST /api/users/:id/reset-password { password? } → { temp_password? }
  app.post("/:id/reset-password", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const b = z.object({ password: z.string().max(72).optional() }).parse(req.body ?? {});
    let password = b.password || "";
    const generated = !password;
    if (generated) password = tempPassword();
    const pwErr = validatePassword(password);
    if (pwErr) throw bad(pwErr);
    const target = (await sql<{ role: string; is_platform: boolean }[]>`select role, is_platform from users where id = ${id} and company_id = ${req.user!.companyId}`)[0];
    if (!target) throw notFound();
    if (target.is_platform) throw PLATFORM_LOCKED();
    if (target.role === "ceo" && req.user!.role !== "ceo") throw new AppError("FORBIDDEN", 403);
    const r = await sql`update users set password_hash = ${await hashPassword(password)}, must_change_password = true
                        where id = ${id} and company_id = ${req.user!.companyId}`;
    if (r.count === 0) throw notFound();
    await revokeUserSessions(id);
    await audit(sql, { companyId: req.user!.companyId, userId: req.user!.id, action: "password.reset", table: "users", rowId: id, ip: req.ip });
    return { temp_password: generated ? password : undefined };
  });
};
