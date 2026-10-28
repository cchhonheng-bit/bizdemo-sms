// Invoices + payments (Flow 4 · M8). Viewing: anyone holding an invoice / payment / discount / void / finance permission;
// every write checks its own permission (BR-10, BR-12, BR-19). Technicians never reach these routes (AC-01).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { PAY_STATUSES } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import {
  assertCanView, createInvoice, uninvoiced, debts, decideDiscount, decideVoid, getInvoice, issueInvoice, listInvoices, prefill, recordPayment, requestVoid, setDiscount, setLineKind, updateInvoice,
} from "../services/invoices.js";
import { invoiceJournal } from "../services/accounting.js";

const line = z.object({
  catalog_item_id: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(1).max(300),
  kind: z.enum(["service", "product"]),
  qty: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(20).default(""), // D-152: optional — blank prints nothing
  unit_price: z.number().int().min(0).max(100_000_000),
}).strict().refine((l) => l.qty * l.unit_price <= 1_000_000_000, "LINE_TOO_LARGE"); // ≤ $10M a line
const lines = z.array(line).min(1).max(100).refine((ls) => ls.reduce((s, l) => s + l.qty * l.unit_price, 0) <= 2_000_000_000, "TOTAL_TOO_LARGE"); // sums stay in int4
const idParam = z.object({ id: z.string().uuid() });
const note = z.object({ note: z.string().max(500).default("") });

export const invoicesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (req, reply) => {
    await app.requireAuth(req, reply);
    assertCanView(req.perms);
  });
  app.get("/", async (req) => {
    const { status, booking } = z.object({ status: z.enum(["draft", "unpaid", "paid", "void", "approval"]).optional(), booking: z.string().uuid().optional() }).parse(req.query ?? {});
    return listInvoices(req.user!, status, booking);
  });
  app.get("/debts", async (req) => debts(req.user!, z.object({ paystatus: z.enum(PAY_STATUSES).optional() }).parse(req.query ?? {}).paystatus)); // D-183
  app.get("/uninvoiced", async (req) => uninvoiced(req.user!.companyId)); // A1
  app.get("/prefill", { preHandler: app.requirePerm("invoice.issue") }, async (req) => prefill(req.user!, z.object({ booking: z.string().uuid() }).parse(req.query ?? {}).booking));
  app.get("/:id", async (req) => getInvoice(req.user!, req.perms, idParam.parse(req.params).id));
  // D-142 «ការកត់ត្រាគណនេយ្យ»: the invoice's entries, line by line (CFO / CEO / Admin — accounting.view)
  app.get("/:id/journal", { preHandler: app.requirePerm("accounting.view") }, async (req) => invoiceJournal(req.user!, idParam.parse(req.params).id));

  app.post("/", { preHandler: app.requirePerm("invoice.issue") }, async (req) => {
    const v = z.object({ booking_id: z.string().uuid().optional(), customer_id: z.string().uuid().optional(), lines, notes: z.string().max(2000).optional().nullable() })
      .strict().refine((x) => !!x.booking_id !== !!x.customer_id, "BOOKING_OR_CUSTOMER").parse(req.body);
    return createInvoice(req.user!, req.ip, v);
  });
  app.put("/:id", { preHandler: app.requirePerm("invoice.issue") }, async (req) => {
    const v = z.object({ lines, notes: z.string().max(2000).optional().nullable() }).strict().parse(req.body);
    return updateInvoice(req.user!, req.ip, idParam.parse(req.params).id, v);
  });
  // D-184: a line's kind (service ↔ goods) corrected — on an issued invoice its revenue moves to the other income account (CFO / CEO)
  app.post("/:id/lines/:line/kind", { preHandler: app.requirePerm("accounting.post") }, async (req) => {
    const p = z.object({ id: z.string().uuid(), line: z.coerce.number().int().positive() }).parse(req.params);
    return setLineKind(req.user!, req.ip, p.id, p.line, z.object({ kind: z.enum(["service", "product"]) }).strict().parse(req.body).kind);
  });
  // D-126: an optional earlier invoice date (unlocked period only; a reason when more than 3 days back)
  app.post("/:id/issue", { preHandler: app.requirePerm("invoice.issue") }, async (req) => issueInvoice(req.user!, req.ip, idParam.parse(req.params).id,
    z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), reason: z.string().max(300).optional() }).strict().parse(req.body ?? {})));

  app.post("/:id/discount", { preHandler: app.requirePerm("discount.give") }, async (req) => {
    const v = z.object({ amount: z.number().int().min(0).max(100_000_000), note: z.string().max(500).optional().nullable() }).strict().parse(req.body);
    return setDiscount(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v);
  });
  app.post("/:id/discount/approve", { preHandler: app.requirePerm("discount.approve") }, async (req) => decideDiscount(req.user!, req.ip, idParam.parse(req.params).id, true, note.parse(req.body ?? {}).note));
  app.post("/:id/discount/reject", { preHandler: app.requirePerm("discount.approve") }, async (req) => decideDiscount(req.user!, req.ip, idParam.parse(req.params).id, false, note.parse(req.body ?? {}).note));

  app.post("/:id/payments", { preHandler: app.requirePerm("payment.record") }, async (req) => {
    // D-161: one part (amount · currency · method) or several in `parts` — one save, one transaction
    const part = { amount: z.number().int().positive().max(100_000_000_000), currency: z.enum(["usd", "khr"]), method: z.enum(["cash_usd", "cash_khr", "aba", "acleda"]) };
    const v = z.object({
      ...Object.fromEntries(Object.entries(part).map(([k, s]) => [k, s.optional()])), parts: z.array(z.object(part).strict()).min(1).max(6).optional(),
      paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), note: z.string().max(500).optional().nullable(),
    }).strict().parse(req.body) as { amount?: number; currency?: "usd" | "khr"; method?: "cash_usd" | "cash_khr" | "aba" | "acleda"; parts?: { amount: number; currency: "usd" | "khr"; method: "cash_usd" | "cash_khr" | "aba" | "acleda" }[]; paid_on?: string | null; note?: string | null };
    const parts = v.parts ?? (v.amount !== undefined && v.currency && v.method ? [{ amount: v.amount, currency: v.currency, method: v.method }] : []);
    if (!parts.length) throw new AppError("AMOUNT_TOO_SMALL", 400);
    return recordPayment(req.user!, req.ip, idParam.parse(req.params).id, { parts, paid_on: v.paid_on, note: v.note });
  });

  app.post("/:id/void", { preHandler: app.requirePerm("void.request") }, async (req) => {
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(req.body ?? {});
    return requestVoid(req.user!, req.ip, idParam.parse(req.params).id, reason);
  });
  app.post("/:id/void/approve", { preHandler: app.requirePerm("void.approve") }, async (req) => decideVoid(req.user!, req.ip, idParam.parse(req.params).id, true, note.parse(req.body ?? {}).note));
  app.post("/:id/void/reject", { preHandler: app.requirePerm("void.approve") }, async (req) => decideVoid(req.user!, req.ip, idParam.parse(req.params).id, false, note.parse(req.body ?? {}).note));
};
