// D-169: GET /api/export/<report>.xlsx — the Excel export of every report, with the screen's own permission, company-scoped, audited.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { filterList, LIST_REPORTS, LIST_SPECS, PAY_STATUSES, type ListReport } from "@sms/shared";
import { accountFacets, byBookingData, byBookingOptions, exportReport, listExport, previewReport, REPORTS, type Q, type Report } from "../services/excel.js";
import { LIST_DEFS } from "../services/list-exports.js";

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ids = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().uuid()).max(200)).optional();
const words = z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().regex(/^[a-z_]{2,30}$/)).max(20)).optional();
const query = z.object({ from: day.optional(), to: day.optional(), asof: day.optional(), technician: ids, booker: ids, account: ids, status: words,
  customer: z.string().uuid().optional(), method: z.string().regex(/^[a-z_]{2,20}$/).optional(), item: z.string().uuid().optional(), location: z.string().uuid().optional(),
  category: z.string().regex(/^[a-z_]{2,30}$/).optional(), source: z.string().regex(/^[a-z_]{2,30}$/).optional(), kind: z.string().regex(/^[a-z_]{2,30}$/).optional(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(), zone: z.enum(["inside", "outside"]).optional(), q: z.string().max(120).optional(), closed: z.enum(["0", "1"]).optional(),
  cancelled: z.enum(["0", "1"]).optional(), inactive: z.enum(["0", "1"]).optional(), list: z.enum(["draft", "unpaid", "paid", "void", "approval"]).optional(),
  role: z.string().regex(/^[a-z_]{2,20}$/).optional(), all: z.enum(["0", "1"]).optional(), days: z.string().regex(/^\d{1,2}$/).optional(), user: z.string().uuid().optional(),
  type: z.string().regex(/^[a-z_]{2,30}$/).optional(), open: z.enum(["0", "1"]).optional(), paystatus: z.enum(PAY_STATUSES).optional(), // D-183
  dir: z.enum(["in", "out"]).optional(), sources: words, items: ids, // D-185: the account report's filters
  party: z.string().transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean)).pipe(z.array(z.string().regex(/^(?:[cu]\.[0-9a-f-]{36}|s\.[A-Za-z0-9_-]{1,400})$/)).max(200)).optional(),
  bk: ids, mismatch: z.enum(["0", "1"]).optional(), jobtype: z.enum(["A", "B"]).optional() }).strict(); // D-196: the jobs board's type filter // D-189 «By Booking»: the bookings picked · only the mismatches

/** the permission of the screen that shows the report */
const PERM: Record<Report, string | string[]> = {
  "tech-withdrawals": "inventory.view", "stock-balance": "inventory.view", "stock-moves": "inventory.view", payables: ["cost.read", "inventory.manage"], "stock-reconcile": "cost.read",
  "account-report": "accounting.view", coa: "accounting.view", "trial-balance": "accounting.view", "income-statement": "accounting.view", "balance-sheet": "accounting.view", journal: "accounting.view", expenses: "accounting.view",
  "by-booking": "cost.read", // D-189: costs and sales of each job
  bookings: "report.ops", "tech-performance": "report.ops", attendance: "report.ops", invoices: "report.finance", payments: "report.finance", receivables: "report.finance", customers: ["customer.manage", "report.ops"],
};

/** the report and the screen's permission; technicians never export (fixed rule, whatever the settings grant — D-171) */
function allowed(req: FastifyRequest): Report {
  const { report } = z.object({ report: z.enum(REPORTS) }).parse(req.params);
  const need = PERM[report], perms = req.perms as string[];
  if (req.user!.role === "tech" || !(Array.isArray(need) ? need.some((p) => perms.includes(p)) : perms.includes(need))) throw new AppError("FORBIDDEN", 403);
  return report;
}
export const exportsRoutes: FastifyPluginAsync = async (app) => {
  /** D-172: a list screen's rows — its own API read as this user (same rows, same permission), filtered with the screen's filter */
  const listRows = async (req: FastifyRequest, report: ListReport, q: Q) => {
    const def = LIST_DEFS[report];
    const r = await app.inject({ method: "GET", url: def.path(q), headers: { cookie: req.headers.cookie ?? "" } });
    const json = r.json() as Record<string, unknown> | Record<string, unknown>[];
    if (r.statusCode !== 200) throw new AppError(String((json as { error?: string }).error ?? "FORBIDDEN"), r.statusCode);
    const rows = def.pick ? def.pick(json as Record<string, unknown>) : (json as Record<string, unknown>[]);
    return filterList(rows, LIST_SPECS[report], q);
  };
  const isList = (r: string): r is ListReport => (LIST_REPORTS as string[]).includes(r);
  const listOf = (req: FastifyRequest): ListReport | null => {
    const r = String((req.params as { report?: string }).report ?? "");
    if (!isList(r)) return null;
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403); // technicians never export (D-171)
    return r;
  };
  // D-189 «By Booking»: the booking picker · the jobs still to settle (the resolve panel) — the report's permission
  const byBookingGate = (req: FastifyRequest) => { if (req.user!.role === "tech" || !(req.perms as string[]).includes("cost.read")) throw new AppError("FORBIDDEN", 403); };
  app.get("/by-booking/options", { preHandler: app.requireAuth }, async (req) => { byBookingGate(req); return byBookingOptions(req.user!, query.parse(req.query ?? {})); });
  app.get("/by-booking/mismatches", { preHandler: app.requireAuth }, async (req) => {
    byBookingGate(req);
    return (await byBookingData(req.user!, { ...query.parse(req.query ?? {}), mismatch: "1" })).bookings.map((b) => ({ booking_id: b.id, number: b.number, flags: b.flags, notes: b.notes, invoiced: b.invoiced }));
  });
  // D-185: which filters the picked accounts support (the account report's panel shows only those) — the account report's permission
  app.get("/account-report/facets", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech" || !(req.perms as string[]).includes("accounting.view")) throw new AppError("FORBIDDEN", 403);
    return accountFacets(req.user!, query.parse(req.query ?? {}));
  });
  // the on-screen table of a report: the same builder as the file (D-171: file = screen)
  app.get("/:report.json", { preHandler: app.requireAuth }, async (req) => {
    const q = query.parse(req.query ?? {}), list = listOf(req);
    if (list) return listExport(req.user!, null, list, LIST_DEFS[list], await listRows(req, list, q), q, true);
    return previewReport(req.user!, allowed(req), q);
  });
  app.get("/:report.xlsx", { preHandler: app.requireAuth }, async (req, reply) => {
    const q = query.parse(req.query ?? {}), list = listOf(req);
    const file = list ? await listExport(req.user!, req.ip, list, LIST_DEFS[list], await listRows(req, list, q), q, false) as Awaited<ReturnType<typeof exportReport>> : await exportReport(req.user!, req.ip, allowed(req), q);
    return reply.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").header("Content-Disposition", `attachment; filename="${file.name}"`)
      .header("Cache-Control", "no-store").header("X-Rows", String(file.rows)).send(file.buf);
  });
};
