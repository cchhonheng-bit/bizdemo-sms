// Inventory (D-87 · flag "inventory"): read with inventory.view, change with inventory.manage. Technicians never (fixed rule).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { adjust, card, confirmJob, items, listLocations, opening, pendingJobs, saveLocation, stockIn, trackItem, transfer } from "../services/inventory.js";

const id = z.string().uuid();
const qty = z.number().positive().max(1_000_000).multipleOf(0.001);
const cents = z.number().int().min(0).max(1_000_000_000);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("inventory"));
  const view = { preHandler: app.requirePerm("inventory.view") };
  const manage = { preHandler: app.requirePerm("inventory.manage") };

  app.get("/locations", view, async (req) => listLocations(req.user!));
  app.post("/locations", manage, async (req) => saveLocation(req.user!, req.ip, z.object({ id: id.optional(), name: z.string().trim().min(1).max(60),
    kind: z.enum(["warehouse", "vehicle"]), vehicle_id: id.nullable().optional(), is_active: z.boolean().optional() }).strict().parse(req.body)));
  app.get("/items", view, async (req) => items(req.user!));
  app.post("/items/:id/track", manage, async (req) => {
    const b = z.object({ track: z.boolean(), reorder_level: z.number().min(0).max(1_000_000).nullable().optional() }).strict().parse(req.body);
    return trackItem(req.user!, req.ip, z.object({ id }).parse(req.params).id, b.track, b.reorder_level);
  });
  app.post("/opening", manage, async (req) => opening(req.user!, req.ip, z.object({ item_id: id, location_id: id, qty, unit_cost: cents }).strict().parse(req.body)));
  app.post("/in", manage, async (req) => stockIn(req.user!, req.ip, z.object({ item_id: id, location_id: id, qty, unit_cost: cents.optional(), total: cents.optional(),
    pay: z.enum(["cash_usd", "cash_khr", "aba", "acleda", "credit"]), supplier: z.string().max(120).nullable().optional(), note: z.string().max(300).nullable().optional() }).strict().parse(req.body)));
  app.post("/adjust", manage, async (req) => adjust(req.user!, req.ip, z.object({ item_id: id, location_id: id,
    qty: z.number().min(-1_000_000).max(1_000_000).multipleOf(0.001).refine((x) => x !== 0, "QTY_ZERO"), reason: z.string().max(300).default(""), unit_cost: cents.nullable().optional() }).strict().parse(req.body)));
  app.post("/transfer", manage, async (req) => transfer(req.user!, req.ip, z.object({ item_id: id, from: id, to: id, qty }).strict().parse(req.body)));
  app.get("/card", view, async (req) => {
    const q = z.object({ item: id, from: day, to: day, location: id.optional() }).parse(req.query ?? {});
    return card(req.user!, q.item, q.from, q.to, q.location);
  });
  app.get("/jobs/pending", manage, async (req) => pendingJobs(req.user!));
  app.post("/jobs/:id/confirm", manage, async (req) => confirmJob(req.user!, req.ip, z.object({ id }).parse(req.params).id, z.object({ location_id: id.nullable().optional() }).parse(req.body ?? {}).location_id));
};
