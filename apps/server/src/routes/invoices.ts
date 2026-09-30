// Invoices + payments (Flow 4 · M8). Viewing: anyone holding an invoice / payment / discount / void / finance permission;
// every write checks its own permission (BR-10, BR-12, BR-19). Technicians never reach these routes (AC-01).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import {
  assertCanView, createInvoice, debts, decideDiscount, decideVoid, getInvoice, issueInvoice, listInvoices, prefill, recordPayment, requestVoid, setDiscount, updateInvoice,
} from "../services/invoices.js";

const line = z.object({
  catalog_item_id: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(1).max(300),
  kind: z.enum(["service", "product"]),
  qty: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(20).default("unit"),
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
  app.get("/debts", async (req) => debts(req.user!));
  app.get("/prefill", { preHandler: app.requirePerm("invoice.issue") }, async (req) => prefill(req.user!, z.object({ booking: z.string().uuid() }).parse(req.query ?? {}).booking));
  app.get("/:id", async (req) => getInvoice(req.user!, req.perms, idParam.parse(req.params).id));

  app.post("/", { preHandler: app.requirePerm("invoice.issue") }, async (req) => {
    const v = z.object({ booking_id: z.string().uuid().optional(), customer_id: z.string().uuid().optional(), lines, notes: z.string().max(2000).optional().nullable() })
      .strict().refine((x) => !!x.booking_id !== !!x.customer_id, "BOOKING_OR_CUSTOMER").parse(req.body);
    return createInvoice(req.user!, req.ip, v);
  });
  app.put("/:id", { preHandler: app.requirePerm("invoice.issue") }, async (req) => {
    const v = z.object({ lines, notes: z.string().max(2000).optional().nullable() }).strict().parse(req.body);
    return updateInvoice(req.user!, req.ip, idParam.parse(req.params).id, v);
  });
  app.post("/:id/issue", { preHandler: app.requirePerm("invoice.issue") }, async (req) => issueInvoice(req.user!, req.ip, idParam.parse(req.params).id));

  app.post("/:id/discount", { preHandler: app.requirePerm("discount.give") }, async (req) => {
    const v = z.object({ amount: z.number().int().min(0).max(100_000_000), note: z.string().max(500).optional().nullable() }).strict().parse(req.body);
    return setDiscount(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v);
  });
  app.post("/:id/discount/approve", { preHandler: app.requirePerm("discount.approve") }, async (req) => decideDiscount(req.user!, req.ip, idParam.parse(req.params).id, true, note.parse(req.body ?? {}).note));
  app.post("/:id/discount/reject", { preHandler: app.requirePerm("discount.approve") }, async (req) => decideDiscount(req.user!, req.ip, idParam.parse(req.params).id, false, note.parse(req.body ?? {}).note));

  app.post("/:id/payments", { preHandler: app.requirePerm("payment.record") }, async (req) => {
    const v = z.object({
      amount: z.number().int().positive().max(100_000_000_000), currency: z.enum(["usd", "khr"]), method: z.enum(["cash_usd", "cash_khr", "aba", "acleda"]),
      paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(), note: z.string().max(500).optional().nullable(),
    }).strict().parse(req.body);
    return recordPayment(req.user!, req.ip, idParam.parse(req.params).id, v);
  });

  app.post("/:id/void", { preHandler: app.requirePerm("void.request") }, async (req) => {
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(req.body ?? {});
    return requestVoid(req.user!, req.ip, idParam.parse(req.params).id, reason);
  });
  app.post("/:id/void/approve", { preHandler: app.requirePerm("void.approve") }, async (req) => decideVoid(req.user!, req.ip, idParam.parse(req.params).id, true, note.parse(req.body ?? {}).note));
  app.post("/:id/void/reject", { preHandler: app.requirePerm("void.approve") }, async (req) => decideVoid(req.user!, req.ip, idParam.parse(req.params).id, false, note.parse(req.body ?? {}).note));
};
