// Reports (Flow 6 · M11): summary (report.ops; money for report.finance), dashboard, verification + CFO marks (report.verify),
// audit log viewer (audit.read). Read-only except the «verified» mark; the audit log has no write route at all (FR-1202).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { auditLog, dashboard, summary, verification, verify } from "../services/reports.js";

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
  app.get("/audit", { preHandler: app.requirePerm("audit.read") }, async (req) => {
    const q = z.object({ action: z.string().max(60).optional(), from: day.optional(), to: day.optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query ?? {});
    return auditLog(req.user!, q);
  });
};
