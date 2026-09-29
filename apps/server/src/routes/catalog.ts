// Catalog (services/products). S-02: technicians never see prices; cost_price only with cost.read.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { catalogItemSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireAuth }, async (req) => {
    const isTech = req.user!.role === "tech";
    const withCost = req.perms.includes("cost.read");
    const rows = await sql<Record<string, unknown>[]>`select id, company_id, name_km, name_en, kind, category, unit, sell_price, cost_price, duration_min, is_active, created_at, updated_at
      from catalog_items where company_id = ${req.user!.companyId} ${isTech ? sql`and is_active` : sql``} order by category, name_km`;
    return rows.map((r) => ({ ...r, sell_price: isTech ? null : r.sell_price, cost_price: withCost ? r.cost_price : null }));
  });

  app.post("/", { preHandler: app.requirePerm("catalog.manage") }, async (req) => {
    const b = catalogItemSchema.extend({ id: z.string().uuid().nullable().optional() }).parse(req.body);
    const withCost = req.perms.includes("cost.read");
    if (b.cost_price != null && !withCost) throw new AppError("FORBIDDEN_COST", 403);
    const id = await tx(req.user!.id, async (t) => {
      let id: string;
      if (!b.id) {
        id = (await t<{ id: string }[]>`insert into catalog_items (company_id, name_km, name_en, kind, category, unit, sell_price, cost_price, duration_min, created_by)
          values (${req.user!.companyId}, ${b.name_km}, ${b.name_en || null}, ${b.kind}::item_kind, ${b.category}::service_category, ${b.unit || "unit"}, ${b.sell_price}, ${b.cost_price ?? null}, ${b.duration_min ?? 120}, ${req.user!.id}) returning id`)[0]!.id;
      } else {
        const r = await t<{ id: string }[]>`update catalog_items set name_km = ${b.name_km}, name_en = ${b.name_en || null}, kind = ${b.kind}::item_kind, category = ${b.category}::service_category,
            unit = coalesce(${b.unit || null}, unit), sell_price = ${b.sell_price}, duration_min = coalesce(${b.duration_min ?? null}, duration_min),
            cost_price = case when ${withCost && b.cost_price !== undefined} then ${b.cost_price ?? null} else cost_price end
          where id = ${b.id} and company_id = ${req.user!.companyId} returning id`;
        if (!r[0]) throw notFound();
        id = r[0].id;
      }
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "catalog.upsert", table: "catalog_items", rowId: id, new: { name_km: b.name_km, sell_price: b.sell_price }, ip: req.ip });
      return id;
    });
    return { id };
  });

  app.post("/:id/active", { preHandler: app.requirePerm("catalog.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await sql`update catalog_items set is_active = ${active} where id = ${id} and company_id = ${req.user!.companyId}`;
    if (r.count === 0) throw notFound();
    return { ok: true };
  });
};
