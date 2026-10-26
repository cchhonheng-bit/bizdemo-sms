// Inventory (D-87 · D-144): read with inventory.view, change with inventory.manage. Technicians never (fixed rule).
// Stock in = a direct entry (the item is made on its first entry); stock out = the Admin records what a technician collects.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { adjust, card, items, listLocations, monthEnd, payables, reconcile, removeItem, setReorder, stockAccounts, stockIn, stockOut, supplierPay } from "../services/inventory.js";
import { featureOn } from "../lib/features.js";
import { SUPPLIER_KINDS } from "@sms/shared";

const id = z.string().uuid();
const qty = z.number().positive().max(1_000_000).multipleOf(0.001);
const cents = z.number().int().min(0).max(1_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("inventory"));
  const view = { preHandler: app.requirePerm("inventory.view") };
  const manage = { preHandler: app.requirePerm("inventory.manage") };

  app.get("/locations", view, async (req) => listLocations(req.user!));
  app.get("/items", view, async (req) => items(req.user!));
  app.get("/accounts", view, async (req) => stockAccounts(req.user!)); // D-177: the stock part of the chart (headers + every account)
  app.delete("/items/:id", manage, async (req) => removeItem(req.user!, req.ip, z.object({ id }).parse(req.params).id)); // D-179: deleted, or switched off when used
  app.post("/items/:id/reorder", manage, async (req) => setReorder(req.user!, req.ip, z.object({ id }).parse(req.params).id,
    z.object({ reorder_level: z.number().min(0).max(1_000_000).nullable() }).strict().parse(req.body).reorder_level));
  // D-144 stock in: name / model · qty · unit · unit cost · stock account · supplier · date → the item is made (or matched) on the way
  app.post("/in", manage, async (req) => stockIn(req.user!, req.ip, z.object({ item_id: id.nullable().optional(), name: z.string().trim().max(120).nullable().optional(), code: z.string().trim().max(20).nullable().optional(),
    unit: z.string().trim().max(20).nullable().optional(), account_id: id.nullable().optional(), qty, unit_cost: cents.nullable().optional(), total: cents.nullable().optional(),
    pay: z.enum(["cash_usd", "cash_khr", "aba", "acleda", "credit"]).nullable().optional(), supplier: z.string().max(120).nullable().optional(), date: day.nullable().optional(),
    note: z.string().max(300).nullable().optional(), opening: z.boolean().optional(),
    paid: cents.nullable().optional(), supplier_invoice: z.string().trim().max(60).nullable().optional(),
    supplier_kind: z.enum(SUPPLIER_KINDS).nullable().optional() }).strict().parse(req.body))); // D-167 · D-178 the supplier's type
  // D-167: what is owed per supplier, and a payment to one (in $ or ៛, any method)
  app.get("/payables", view, async (req) => payables(req.user!));
  app.post("/supplier-pay", manage, async (req) => supplierPay(req.user!, req.ip, z.object({ supplier: z.string().trim().min(1).max(120), amount: z.number().positive().max(1_000_000_000_000),
    currency: z.enum(["usd", "khr"]), method: z.enum(["cash_usd", "cash_khr", "aba", "acleda"]), date: day.nullable().optional(), note: z.string().max(300).nullable().optional() }).strict().parse(req.body)));
  // D-144 stock out: item · qty · technician · the job (or the project / borey / house no.) · date → the balance left
  app.post("/out", manage, async (req) => stockOut(req.user!, req.ip, z.object({ item_id: id, qty, technician_id: id, booking_id: id.nullable().optional(),
    place: z.string().max(120).nullable().optional(), date: day.nullable().optional(), note: z.string().max(300).nullable().optional() }).strict().parse(req.body)));
  app.post("/adjust", manage, async (req) => adjust(req.user!, req.ip, z.object({ item_id: id,
    qty: z.number().min(-1_000_000).max(1_000_000).multipleOf(0.001).refine((x) => x !== 0, "QTY_ZERO"), reason: z.string().max(300).default(""), unit_cost: cents.nullable().optional(), date: day.nullable().optional() }).strict().parse(req.body)));
  app.get("/card", view, async (req) => {
    const q = z.object({ item: id, from: day, to: day, location: id.optional() }).parse(req.query ?? {});
    return card(req.user!, q.item, q.from, q.to, q.location);
  });
  // D-142 «តម្លៃស្តុកចុងខែ»: stock by account on a day beside the books' stock accounts (the books side needs accounting.view)
  app.get("/month-end", view, async (req) => monthEnd(req.user!, z.object({ to: day }).parse(req.query ?? {}).to, featureOn("accounting") && req.perms.includes("accounting.view")));
  // D-144 «ផ្ទៀងផ្ទាត់សម្ភារៈ»: stock out vs invoiced, per job and per group — Admin / CEO / CFO (cost.read)
  app.get("/reconcile", { preHandler: app.requirePerm("cost.read") }, async (req) => {
    const q = z.object({ from: day, to: day, technician: id.optional(), borey: id.optional() }).parse(req.query ?? {});
    return reconcile(req.user!, q);
  });
};
