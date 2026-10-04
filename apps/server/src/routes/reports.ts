// Reports (Flow 6 · M11): summary (report.ops; money for report.finance), dashboard, verification + CFO marks (report.verify),
// audit log viewer (audit.read). Read-only except the «verified» mark; the audit log has no write route at all (FR-1202).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { cashCloses, closeCash, exportCsv, verifyCash } from "../services/reports-extra.js";
import { AUDIT_GROUP_KEYS } from "@sms/shared";
import { auditLog, auditPeople, dashboard, summary, verification, verify } from "../services/reports.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const range = z.object({ from: day, to: day });

export const reportsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/summary", { preHandler: app.requirePerm("report.ops") }, async (req) => {
    const q = range.parse(req.query ?? {});
    return summary(req.user!, req.perms, q.from, q.to);
  });
  app.get("/dashboard", { preHandler: app.requirePerm("report.ops") }, async (req) => dashboard(req.user!, req.perms));
  app.get("/verification", { preHandler: app.requirePerm("report.verify") }, async (req) => {
    const q = range.extend({ unverified: z.enum(["0", "1"]).optional() }).parse(req.query ?? {});
    return verification(req.user!, q.from, q.to, q.unverified === "1");
  });
  app.post("/verify", { preHandler: app.requirePerm("report.verify") }, async (req) => {
    const v = z.object({ type: z.enum(["void", "discount", "cancel", "payment"]), id: z.string().uuid(), note: z.string().max(500).default("") }).strict().parse(req.body);
    return verify(req.user!, req.ip, v.type, v.id, v.note);
  });
  // FR-1105: Excel opens the UTF-8 CSV (BOM) with Khmer intact
  app.get("/export", { preHandler: app.requirePerm("report.ops") }, async (req, reply) => {
    const q = range.extend({ kind: z.enum(["invoices", "payments", "jobs", "attendance"]) }).parse(req.query ?? {});
    const body = await exportCsv(req.user!, req.perms, q.kind, q.from, q.to);
    return reply.type("text/csv; charset=utf-8").header("Content-Disposition", `attachment; filename="${q.kind}_${q.from}_${q.to}.csv"`).header("Cache-Control", "no-store").send(body);
  });
  // FR-1107: daily cash close — Admin counts (payment.record), CFO verifies (report.verify)
  app.get("/cash-close", { preHandler: app.requireAuth }, async (req) => {
    if (!req.perms.includes("payment.record") && !req.perms.includes("report.verify")) throw new AppError("FORBIDDEN", 403);
    const q = range.parse(req.query ?? {});
    return cashCloses(req.user!, q.from, q.to);
  });
  app.post("/cash-close", { preHandler: app.requirePerm("payment.record") }, async (req) => {
    const v = z.object({ day, counted_usd: z.number().int().min(0).max(1_000_000_000), counted_khr: z.number().int().min(0).max(100_000_000_000), note: z.string().max(500).optional().nullable() }).strict().parse(req.body);
    return closeCash(req.user!, req.ip, v);
  });
  app.post("/cash-close/:day/verify", { preHandler: app.requirePerm("report.verify") }, async (req) => verifyCash(req.user!, req.ip, z.object({ day }).parse(req.params).day));
  app.get("/audit", { preHandler: app.requirePerm("audit.read") }, async (req) => {
    const q = z.object({ action: z.string().max(60).optional(), type: z.enum(AUDIT_GROUP_KEYS).optional(), user: z.string().uuid().optional(),
      from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query ?? {});
    return auditLog(req.user!, q);
  });
  app.get("/audit/people", { preHandler: app.requirePerm("audit.read") }, async (req) => auditPeople(req.user!));
};
