// Customers (customer.manage for writes; technicians never see the list — D-18).
// D-137: the address is structured — house no., street no., borey, province → khan → sangkat → village (official gazetteer
// codes) + GPS; a customer the staff make needs province + khan + sangkat (website / Telegram customers may come in incomplete:
// the list marks them until the staff complete it). `address` is the composed one-line text everything else shows.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { addressComplete, composeAddress, customerSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { checkPlace } from "../lib/gazetteer.js";
import { audit } from "../services/audit.js";
import { boreyFor } from "../services/boreys.js";
import { unlockCustomerLogin } from "../services/customer-auth.js";
import { customerHistory } from "../services/customers.js";

export const CUSTOMER_COLS = sql`c.id, c.company_id, c.name, c.phones, c.address, c.zone, c.lat, c.lng, c.notes, c.is_active, c.created_at, c.updated_at, c.origin,
  c.house_no, c.street, c.borey_id, bo.name as borey_name, c.province_code, c.district_code, c.commune_code, c.village_code,
  (c.province_code is not null and c.district_code is not null and c.commune_code is not null) as address_complete`;

export const customersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    const q = z.object({ active: z.enum(["true", "false"]).optional() }).parse(req.query ?? {});
    // D-120: test customers (made by the CEO's test phones) never appear in the list
    return sql`select ${CUSTOMER_COLS} from customers c left join boreys bo on bo.id = c.borey_id where c.company_id = ${req.user!.companyId} and not c.is_test
               ${q.active === "true" ? sql`and c.is_active` : sql``} order by c.name`;
  });

  // FR-203: bookings, invoices, debt, running warranties of one customer
  app.get("/:id/history", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    return customerHistory(req.user!, req.perms, z.object({ id: z.string().uuid() }).parse(req.params).id);
  });

  // POST /api/customers { id?, ...customerSchema } → { id }
  app.post("/", { preHandler: app.requirePerm("customer.manage") }, async (req) => {
    const b = customerSchema.extend({ id: z.string().uuid().nullable().optional() }).parse(req.body);
    const cid = req.user!.companyId;
    const old = b.id ? (await sql<{ origin: string; borey_id: string | null; address: string | null }[]>`select origin, borey_id, address from customers where id = ${b.id} and company_id = ${cid}`)[0] : null;
    if (b.id && !old) throw notFound();
    const place = { province_code: b.province_code || null, district_code: b.district_code || null, commune_code: b.commune_code || null, village_code: b.village_code || null };
    const units = checkPlace(place);
    const borey = await boreyFor(cid, b.borey_id || null, old?.borey_id ?? null);
    // D-137: the staff's own customers need province + khan + sangkat; website / Telegram ones may stay incomplete (a badge)
    if ((!old || old.origin === "staff") && !addressComplete(place)) throw new AppError("ADDRESS_INCOMPLETE", 400);
    const house = b.house_no?.trim() || null, street = b.street?.trim() || null;
    const address = place.province_code ? composeAddress({ house_no: house, street, borey: borey?.name, units }) : (b.address || old?.address || null);
    const id = await tx(req.user!.id, async (t) => {
      if (!b.id) {
        const r = await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, lat, lng, notes, created_by,
            house_no, street, borey_id, province_code, district_code, commune_code, village_code)
          values (${cid}, ${b.name}, ${t.array(b.phones)}, ${address}, ${b.zone}::zone, ${b.lat ?? null}, ${b.lng ?? null}, ${b.notes || null}, ${req.user!.id},
            ${house}, ${street}, ${borey?.id ?? null}, ${place.province_code}, ${place.district_code}, ${place.commune_code}, ${place.village_code}) returning id`;
        await audit(t, { companyId: cid, userId: req.user!.id, action: "customer.create", table: "customers", rowId: r[0]!.id, new: { name: b.name, address }, ip: req.ip });
        return r[0]!.id;
      }
      const r = await t<{ id: string }[]>`update customers set name = ${b.name}, phones = ${t.array(b.phones)}, address = ${address}, zone = ${b.zone}::zone,
          lat = ${b.lat ?? null}, lng = ${b.lng ?? null}, notes = ${b.notes || null}, house_no = ${house}, street = ${street}, borey_id = ${borey?.id ?? null},
          province_code = ${place.province_code}, district_code = ${place.district_code}, commune_code = ${place.commune_code}, village_code = ${place.village_code}
        where id = ${b.id} and company_id = ${cid} returning id`;
      if (!r[0]) throw notFound();
      await audit(t, { companyId: cid, userId: req.user!.id, action: "customer.update", table: "customers", rowId: b.id, old: { address: old!.address }, new: { name: b.name, address }, ip: req.ip });
      return b.id;
    });
    return { id };
  });

  /** D-104: clear the wrong-password lock of this customer's website login (Admin / GM); written to the audit log */
  app.post("/:id/unlock-login", { preHandler: app.requirePerm("customer.manage") }, async (req) => unlockCustomerLogin(req.user!, req.ip, z.object({ id: z.string().uuid() }).parse(req.params).id));

  app.post("/:id/active", { preHandler: app.requirePerm("customer.manage") }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const { active } = z.object({ active: z.boolean() }).parse(req.body);
    const r = await sql`update customers set is_active = ${active} where id = ${id} and company_id = ${req.user!.companyId}`;
    if (r.count === 0) throw notFound();
    return { ok: true };
  });
};
