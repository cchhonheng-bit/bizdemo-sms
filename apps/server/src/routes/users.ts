// Users administration (permission user.manage) — port of v1 admin-users + api.update_user.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { createUserSchema, updateUserSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, bad, notFound } from "../lib/errors.js";
import { hashPassword, tempPassword, validatePassword } from "../lib/password.js";
import { audit } from "../services/audit.js";
import { revokeUserSessions } from "../services/auth.js";
import { hubForgetChat } from "../services/telegram.js";

const USER_COLS = sql`id, company_id, username, phone, email, full_name, role, language, is_active, must_change_password, tracks_attendance,
  telegram_user_id is not null as telegram_linked, created_at, updated_at`;

export const usersRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/users/basic — every authenticated user (names for assign dialogs, vehicle owners)
  app.get("/basic", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403); // technicians get names through their bookings only
    return sql`select id, company_id, full_name, role, is_active from users where company_id = ${req.user!.companyId} order by full_name`;
  });

  app.get("/", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    return sql`select ${USER_COLS} from users where company_id = ${req.user!.companyId} order by role, full_name`;
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
    const patch = updateUserSchema.extend({ is_active: z.boolean().optional() }).parse(req.body);
    if (id === req.user!.id && (patch.role !== undefined || patch.is_active !== undefined)) throw new AppError("CANNOT_CHANGE_SELF_ROLE", 400);
    if (patch.role === "ceo" && req.user!.role !== "ceo") throw new AppError("FORBIDDEN", 403);
    const result = await tx(req.user!.id, async (t) => {
      const old = (await t<Record<string, unknown>[]>`select ${USER_COLS} from users where id = ${id} and company_id = ${req.user!.companyId} for update`)[0];
      if (!old) throw notFound();
      if (old.role === "ceo" && req.user!.role !== "ceo") throw new AppError("FORBIDDEN", 403); // no one below the CEO may touch a CEO account
      const r = await t<Record<string, unknown>[]>`update users set
          full_name = coalesce(${patch.full_name ?? null}, full_name),
          username = coalesce(${patch.username ?? null}, username),
          phone = case when ${patch.phone !== undefined} then ${patch.phone || null} else phone end,
          email = case when ${patch.email !== undefined} then ${patch.email || null} else email end,
          role = coalesce(${patch.role ?? null}::user_role, role),
          is_active = coalesce(${patch.is_active ?? null}, is_active),
          tracks_attendance = coalesce(${patch.tracks_attendance ?? null}, tracks_attendance),
          language = coalesce(${patch.language ?? null}, language)
        where id = ${id} returning ${USER_COLS}`;
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "user.update", table: "users", rowId: id, old, new: r[0], ip: req.ip });
      return r[0]!;
    });
    if (patch.is_active === false || patch.role !== undefined) await revokeUserSessions(id); // S-05: deactivate / role change ends sessions now
    if (patch.is_active === false) {
      // a deactivated person stops receiving job messages: unlink Telegram here and at the hub (R6)
      const tgRow = (await sql<{ telegram_chat_id: string | null }[]>`update users u set telegram_user_id = null, telegram_chat_id = null from users old
        where u.id = ${id} and old.id = u.id returning old.telegram_chat_id`)[0];
      if (tgRow?.telegram_chat_id) {
        await audit(sql, { companyId: req.user!.companyId, userId: req.user!.id, action: "telegram.unlink", table: "users", rowId: id, new: { reason: "deactivated" }, ip: req.ip });
        await hubForgetChat(tgRow.telegram_chat_id);
      }
    }
    return { ok: true, user: { id: result.id, role: result.role, is_active: result.is_active } };
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
    const target = (await sql<{ role: string }[]>`select role from users where id = ${id} and company_id = ${req.user!.companyId}`)[0];
    if (!target) throw notFound();
    if (target.role === "ceo" && req.user!.role !== "ceo") throw new AppError("FORBIDDEN", 403);
    const r = await sql`update users set password_hash = ${await hashPassword(password)}, must_change_password = true
                        where id = ${id} and company_id = ${req.user!.companyId}`;
    if (r.count === 0) throw notFound();
    await revokeUserSessions(id);
    await audit(sql, { companyId: req.user!.companyId, userId: req.user!.id, action: "password.reset", table: "users", rowId: id, ip: req.ip });
    return { temp_password: generated ? password : undefined };
  });
};
