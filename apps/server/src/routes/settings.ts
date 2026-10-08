// Company settings, FX rate, vehicles, permission matrix (port of v1 M1 RPCs).
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { ROLES, PERMISSION_KEYS } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { MIME_BY_EXT } from "../services/jobs.js";
import { matrix, setPermission } from "../services/permissions.js";
import { saveCompanyImage } from "../services/site.js";
import { getTestPhones, saveTestPhones } from "../services/test-mode.js";
import { lastChange } from "../services/reports.js";
import { rateInfo, setRate } from "../services/fx.js";

const settingsPatch = z.object({
  work_start: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  work_end: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  work_days: z.array(z.number().int().min(1).max(7)).min(1).optional(),
  office_lat: z.number().min(-90).max(90).nullable().optional(),
  office_lng: z.number().min(-180).max(180).nullable().optional(),
  geofence_m: z.number().int().min(20).max(2000).optional(),
  out_of_range_m: z.number().int().min(50).max(5000).optional(),
  fx_rate_khr: z.number().min(1000).max(20000).optional(),
  discount_approval_limit: z.number().int().min(0).optional(),
  late_alert_min: z.number().int().min(0).max(240).optional(),
  telegram_group_chat_id: z.union([z.string().regex(/^-?\d+$/), z.number().int(), z.literal(""), z.null()]).optional(),
  holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(),
  invoice_prefix: z.string().regex(/^[A-Z]{2,5}$/).optional(),
  reminder_default_months: z.number().int().min(1).max(60).optional(),
  reminder_daily_limit: z.number().int().min(0).max(1000).optional(),
  company_info: z.record(z.unknown()).optional(),
});

export const settingsRoutes: FastifyPluginAsync = async (app) => {
  // technicians do not need the settings row (review F1)
  app.get("/company", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    const r = await sql`select * from company_settings where company_id = ${req.user!.companyId}`;
    if (!r[0]) return null;
    const row: Record<string, unknown> = { ...r[0] };
    delete row.test_phones; // D-120: the test phones are the CEO's (/test-phones)
    return row;
  });

  // D-120 (CEO): «លេខទូរស័ព្ទសាកល្បង» — bookings / quotes from these phones are tests (the CEO only, hidden, cancelled after 24 h)
  app.get("/test-phones", { preHandler: app.requireAuth }, async (req) => getTestPhones(req.user!));
  /** «កែប្រែចុងក្រោយ៖ name · time» for Settings / Website (settings.manage) and Users (user.manage) — CEO 04-10 */
  app.get("/last-change", { preHandler: app.requireAuth }, async (req) => {
    const { scope } = z.object({ scope: z.enum(["settings", "website", "users"]) }).parse(req.query ?? {});
    if (!req.perms.includes(scope === "users" ? "user.manage" : "settings.manage")) throw new AppError("FORBIDDEN", 403);
    return { last: await lastChange(req.user!, scope) };
  });
  app.put("/test-phones", { preHandler: app.requireAuth }, async (req) => {
    const { phones } = z.object({ phones: z.array(z.string().max(40)).max(50) }).strict().parse(req.body);
    return saveTestPhones(req.user!, req.ip, phones);
  });

  app.patch("/company", { preHandler: app.requirePerm("settings.manage") }, async (req) => {
    const p = settingsPatch.parse(req.body);
    await tx(req.user!.id, async (t) => {
      const old = (await t`select * from company_settings where company_id = ${req.user!.companyId} for update`)[0];
      if (!old) throw notFound();
      const tg = p.telegram_group_chat_id;
      if (p.fx_rate_khr !== undefined) await setRate(t, req.user!, p.fx_rate_khr, null, req.ip); // same history + audit as /fx
      const r = await t`update company_settings set
          work_start = coalesce(${p.work_start ?? null}::time, work_start),
          work_end = coalesce(${p.work_end ?? null}::time, work_end),
          work_days = coalesce(${p.work_days ? t.array(p.work_days) : null}::int[], work_days),
          office_lat = case when ${p.office_lat !== undefined} then ${p.office_lat ?? null} else office_lat end,
          office_lng = case when ${p.office_lng !== undefined} then ${p.office_lng ?? null} else office_lng end,
          geofence_m = coalesce(${p.geofence_m ?? null}, geofence_m),
          out_of_range_m = coalesce(${p.out_of_range_m ?? null}, out_of_range_m),
          fx_rate_khr = coalesce(${p.fx_rate_khr ?? null}, fx_rate_khr),
          discount_approval_limit = coalesce(${p.discount_approval_limit ?? null}, discount_approval_limit),
          late_alert_min = coalesce(${p.late_alert_min ?? null}, late_alert_min),
          telegram_group_chat_id = case when ${tg !== undefined} then ${tg === "" || tg === null || tg === undefined ? null : String(tg)}::bigint else telegram_group_chat_id end,
          holidays = coalesce(${p.holidays ? t.array(p.holidays) : null}::date[], holidays),
          invoice_prefix = coalesce(${p.invoice_prefix ?? null}, invoice_prefix),
          reminder_default_months = coalesce(${p.reminder_default_months ?? null}, reminder_default_months),
          reminder_daily_limit = coalesce(${p.reminder_daily_limit ?? null}, reminder_daily_limit),
          company_info = coalesce(${p.company_info ? t.json(p.company_info as never) : null}, company_info),
          updated_by = ${req.user!.id}
        where company_id = ${req.user!.companyId} returning *`;
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "settings.update", table: "company_settings", rowId: req.user!.companyId, old, new: r[0], ip: req.ip });
    });
    return { ok: true };
  });

  // A3: CEO + CFO set the rate (fx.set) — audited, history kept; every money row keeps its own snapshot
  app.post("/fx", { preHandler: app.requirePerm("fx.set") }, async (req) => {
    const { rate, note } = z.object({ rate: z.number().min(1000, "INVALID_RATE").max(20000, "INVALID_RATE"), note: z.string().trim().max(200).optional() }).parse(req.body);
    await tx(req.user!.id, (t) => setRate(t, req.user!, rate, note || null, req.ip));
    return { ok: true };
  });
  app.get("/fx", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    return rateInfo(req.user!);
  });

  // ---- invoice logo + ACLEDA QR (FR-803 · BR-16): PNG / JPEG / WebP, printed on every invoice ----
  app.post("/image/:kind", { preHandler: app.requirePerm("settings.manage"), bodyLimit: 3_000_000 }, async (req) => {
    const { kind } = z.object({ kind: z.enum(["logo", "qr"]) }).parse(req.params);
    const { data } = z.object({ data: z.string().min(10).max(2_800_000) }).parse(req.body);
    return saveCompanyImage(req.user!, req.ip, kind, data);
  });
  app.get("/image/:kind", { preHandler: app.requireAuth }, async (req, reply) => {
    const { kind } = z.object({ kind: z.enum(["logo", "qr"]) }).parse(req.params);
    const path = (await sql<{ path: string | null }[]>`select ${kind === "logo" ? sql`logo_path` : sql`qr_image_path`} as path from company_settings where company_id = ${req.user!.companyId}`)[0]?.path;
    if (!path) throw notFound();
    const data = await readFile(join(config.uploadsDir, path)).catch(() => null);
    if (!data) throw notFound();
    return reply.type(MIME_BY_EXT[extname(path).slice(1)] ?? "application/octet-stream").header("Cache-Control", "private, max-age=300").header("X-Content-Type-Options", "nosniff").send(data);
  });

  // ---- vehicles ----
  app.get("/vehicles", { preHandler: app.requireAuth }, async (req) => {
    return sql`select id, company_id, code, plate, owner_user_id, is_active from vehicles where company_id = ${req.user!.companyId} order by code`;
  });
  app.post("/vehicles", { preHandler: app.requirePerm("settings.manage") }, async (req) => {
    const b = z.object({
      id: z.string().uuid().nullable().optional(), code: z.string().trim().min(1).max(10), plate: z.string().trim().max(20).nullable().optional(),
      owner_user_id: z.string().uuid().nullable().optional(), is_active: z.boolean().optional(),
    }).parse(req.body);
    const id = await tx(req.user!.id, async (t) => {
      if (b.owner_user_id) {
        const o = await t`select 1 from users where id = ${b.owner_user_id} and company_id = ${req.user!.companyId}`;
        if (o.length === 0) throw new AppError("OWNER_NOT_IN_COMPANY", 400);
      }
      let id: string;
      if (!b.id) {
        id = (await t<{ id: string }[]>`insert into vehicles (company_id, code, plate, owner_user_id, is_active)
              values (${req.user!.companyId}, ${b.code}, ${b.plate || null}, ${b.owner_user_id ?? null}, ${b.is_active ?? true}) returning id`)[0]!.id;
      } else {
        const r = await t<{ id: string }[]>`update vehicles set code = ${b.code}, plate = ${b.plate || null}, owner_user_id = ${b.owner_user_id ?? null}, is_active = coalesce(${b.is_active ?? null}, is_active)
              where id = ${b.id} and company_id = ${req.user!.companyId} returning id`;
        if (!r[0]) throw notFound();
        id = r[0].id;
      }
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "vehicle.upsert", table: "vehicles", rowId: id, new: { code: b.code, plate: b.plate, owner: b.owner_user_id, active: b.is_active }, ip: req.ip });
      return id;
    });
    return { id };
  });

  // ---- permissions matrix (settings.manage; UI in M6, API ready) ----
  app.get("/permissions", { preHandler: app.requirePerm("settings.manage") }, async (req) => matrix(sql, req.user!.companyId));
  app.post("/permissions", { preHandler: app.requirePerm("settings.manage") }, async (req) => {
    const b = z.object({ role: z.enum(ROLES), key: z.enum(PERMISSION_KEYS), allowed: z.boolean() }).parse(req.body);
    await tx(req.user!.id, (t) => setPermission(t, req.user!.companyId, req.user!.id, b.role, b.key, b.allowed));
    return { ok: true };
  });

  // ---- audit log (audit.read) ----
  app.get("/audit", { preHandler: app.requirePerm("audit.read") }, async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) }).parse(req.query ?? {});
    return sql`select id, user_id, action, source, table_name, row_id, old_data, new_data, at from audit_log
               where company_id = ${req.user!.companyId} order by at desc limit ${q.limit}`;
  });
};
