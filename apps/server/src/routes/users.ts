// Users administration (permission user.manage) — port of v1 admin-users + api.update_user.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { createUserSchema, salaryInputSchema, updateUserSchema, type SalaryInput } from "@sms/shared";
import { canSeeSalary, getSalary, saveSalary } from "../services/payroll.js";
import { sql } from "../db.js";
import { AppError, bad, notFound } from "../lib/errors.js";
import { hashPassword, tempPassword, validatePassword } from "../lib/password.js";
import { audit } from "../services/audit.js";
import { revokeUserSessions } from "../services/auth.js";
import { insertUser, PLATFORM_LOCKED, updateUser, USER_COLS } from "../services/users.js";

/** D-187: the form's «ប្រាក់ខែ» part, when sent — only from someone who may see salaries */
function salaryOf(req: FastifyRequest): SalaryInput | null {
  const raw = (req.body as { salary?: unknown } | null)?.salary;
  if (raw == null) return null;
  if (!canSeeSalary(req.user!, req.perms)) throw new AppError("FORBIDDEN", 403);
  return salaryInputSchema.parse(raw);
}

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
    const salary = salaryOf(req); // checked before the user is made
    const id = await insertUser(req.user!, req.ip, b, await hashPassword(password));
    if (salary) await saveSalary(req.user!, req.ip, id, salary);
    return { id, temp_password: generated ? password : undefined };
  });

  // D-187: the salary on the user form — only the CEO / CFO / GM / payroll; a technician never (fixed); not in the user list
  app.get("/:id/salary", { preHandler: app.requireAuth }, async (req) => {
    if (!canSeeSalary(req.user!, req.perms)) throw new AppError("FORBIDDEN", 403);
    return getSalary(req.user!, z.object({ id: z.string().uuid() }).parse(req.params).id);
  });

  // PATCH /api/users/:id { full_name?, username?, phone?, email?, role?, is_active?, tracks_attendance?, language? }
  app.patch("/:id", { preHandler: app.requirePerm("user.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const salary = salaryOf(req);
    const r = await updateUser(req.user!, req.ip, id, updateUserSchema.extend({ is_active: z.boolean().optional() }).parse(req.body));
    if (salary) await saveSalary(req.user!, req.ip, id, salary);
    return r;
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
