// D-169: GET /api/export/<report>.xlsx — the Excel export of every report, with the screen's own permission, company-scoped, audited.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { exportReport, REPORTS, type Report } from "../services/excel.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).max(200)).optional();
const words = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(20)).optional();
const query = z.object({ from: day.optional(), to: day.optional(), asof: day.optional(), technician: ids, booker: ids, account: ids, status: words,
  customer: z.string().uuid().optional(), method: z.string().regex(/^[a-z_]{2,20}$/).optional(), item: z.string().uuid().optional(), location: z.string().uuid().optional(),
  category: z.string().regex(/^[a-z_]{2,30}$/).optional(), source: z.string().regex(/^[a-z_]{2,30}$/).optional(), kind: z.string().regex(/^[a-z_]{2,30}$/).optional() }).strict();

/** the permission of the screen that shows the report */
const PERM: Record<Report, string | string[]> = {
  "tech-withdrawals": "inventory.view", "stock-balance": "inventory.view", "stock-moves": "inventory.view", payables: "inventory.view", "stock-reconcile": "cost.read",
  "account-report": "accounting.view", coa: "accounting.view", "trial-balance": "accounting.view", "income-statement": "accounting.view", "balance-sheet": "accounting.view", journal: "accounting.view", expenses: "accounting.view",
  bookings: "report.ops", "tech-performance": "report.ops", attendance: "report.ops", invoices: "report.finance", payments: "report.finance", receivables: "report.finance", customers: ["customer.manage", "report.ops"],
};

export const exportsRoutes: FastifyPluginAsync = async (app) => {
  app.get("/:report.xlsx", { preHandler: app.requireAuth }, async (req, reply) => {
    const { report } = z.object({ report: z.enum(REPORTS) }).parse(req.params);
    const need = PERM[report], perms = req.perms as string[];
    if (!(Array.isArray(need) ? need.some((p) => perms.includes(p)) : perms.includes(need))) throw new AppError("FORBIDDEN", 403);
    const q = query.parse(req.query ?? {});
    const file = await exportReport(req.user!, req.ip, report, q);
    return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("Content-Disposition", `attachment; filename="${file.name}"`)
      .header("Cache-Control", "no-store").header("X-Rows", String(file.rows)).send(file.buf);
  });
};
