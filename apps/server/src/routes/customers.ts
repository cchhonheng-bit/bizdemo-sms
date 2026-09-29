// Customers (customer.manage for writes; technicians never see the list — D-18).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { customerSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { audit } from "../services/audit.js";

const COLS = sql`id, company_id, name, phones, address, zone, lat, lng, notes, is_active, created_at, updated_at`;

export const customersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    const q = z.object({ active: z.enum(["true", "false"]).optional() }).parse(req.query ?? {});
    return sql`select ${COLS} from customers where company_id = ${req.user!.companyId}
               ${q.active === "true" ? sql`and is_active` : sql``} order by name`;
  });

  // POST /api/customers { id?, ...customerSchema } → { id }
  app.post("/", { preHandler: app.requirePerm("customer.manage") }, async (req) => {
    const b = customerSchema.extend({ id: z.string().uuid().nullable().optional() }).parse(req.body);
    const phones = b.phones.filter((p) => /^0[0-9]{8,9}$/.test(p));
    const id = await tx(req.user!.id, async (t) => {
      if (!b.id) {
        const r = await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, lat, lng, notes, created_by)
          values (${req.user!.companyId}, ${b.name}, ${t.array(phones)}, ${b.address || null}, ${b.zone}::zone, ${b.lat ?? null}, ${b.lng ?? null}, ${b.notes || null}, ${req.user!.id}) returning id`;
        await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "customer.create", table: "customers", rowId: r[0]!.id, new: { name: b.name }, ip: req.ip });
        return r[0]!.id;
      }
      const r = await t<{ id: string }[]>`update customers set name = ${b.name}, phones = ${t.array(phones)}, address = ${b.address || null}, zone = ${b.zone}::zone,
          lat = ${b.lat ?? null}, lng = ${b.lng ?? null}, notes = ${b.notes || null}
        where id = ${b.id} and company_id = ${req.user!.companyId} returning id`;
      if (!r[0]) throw notFound();
      await audit(t, { companyId: req.user!.companyId, userId: req.user!.id, action: "customer.update", table: "customers", rowId: b.id, new: { name: b.name }, ip: req.ip });
      return b.id;
    });
    return { id };
  });

  app.post("/:id/active", { preHandler: app.requirePerm("customer.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await sql`update customers set is_active = ${active} where id = ${id} and company_id = ${req.user!.companyId}`;
    if (r.count === 0) throw notFound();
    return { ok: true };
  });
};
