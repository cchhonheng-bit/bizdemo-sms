// «គម្រោងបុរី» (CEO 12-10, D-137): the shop's own list of borey projects — name + province / khan / sangkat from the official
// gazetteer. CEO / GM / Admin edit it (customer.manage), every change is in the audit log; a borey is never deleted, only turned
// off (its customers keep it). It starts empty: One Team adds theirs.
import type { BoreyInput } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { checkPlace, geoName } from "../lib/gazetteer.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";

type Row = { id: string; name: string; province_code: string; district_code: string; commune_code: string | null; is_active: boolean; customers: number };
const area = (r: { province_code: string; district_code: string; commune_code: string | null }, lang: "km" | "en") =>
  [r.commune_code, r.district_code, r.province_code].map((c) => geoName(c, lang)).filter(Boolean).join(", ");

export async function listBoreys(user: SessionUser, all = false) {
  const rows = await sql<Row[]>`select b.id, b.name, b.province_code, b.district_code, b.commune_code, b.is_active, b.created_at,
      (select count(*)::int from customers c where c.borey_id = b.id and not c.is_test) as customers
    from boreys b where b.company_id = ${user.companyId} ${all ? sql`` : sql`and b.is_active`} order by b.is_active desc, b.name`;
  return rows.map((r) => ({ ...r, area_km: area(r, "km"), area_en: area(r, "en") }));
}

function clean(b: BoreyInput) {
  const commune = b.commune_code || null;
  checkPlace({ province_code: b.province_code, district_code: b.district_code, commune_code: commune, village_code: null });
  return { name: b.name.trim(), province_code: b.province_code, district_code: b.district_code, commune_code: commune };
}
const dupe = (e: unknown) => { if ((e as { code?: string }).code === "23505") throw new AppError("BOREY_EXISTS", 409); throw e; };

export async function saveBorey(user: SessionUser, ip: string | null, id: string | null, input: BoreyInput) {
  const v = clean(input);
  return tx(user.id, async (t) => {
    if (!id) {
      const r = (await t<{ id: string }[]>`insert into boreys (company_id, name, province_code, district_code, commune_code, created_by)
        values (${user.companyId}, ${v.name}, ${v.province_code}, ${v.district_code}, ${v.commune_code}, ${user.id}) returning id`.catch(dupe))[0]!;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "borey.create", table: "boreys", rowId: r.id, new: v, ip });
      return { id: r.id };
    }
    const old = (await t<Row[]>`select name, province_code, district_code, commune_code from boreys where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!old) throw notFound();
    await t`update boreys set name = ${v.name}, province_code = ${v.province_code}, district_code = ${v.district_code}, commune_code = ${v.commune_code} where id = ${id}`.catch(dupe);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "borey.update", table: "boreys", rowId: id, old, new: v, ip });
    return { id };
  });
}

export async function setBoreyActive(user: SessionUser, ip: string | null, id: string, active: boolean) {
  return tx(user.id, async (t) => {
    const r = await t`update boreys set is_active = ${active} where id = ${id} and company_id = ${user.companyId} and is_active <> ${active} returning id`.catch(dupe);
    if (!r.length) { if (!(await t`select 1 from boreys where id = ${id} and company_id = ${user.companyId}`).length) throw notFound(); return { ok: true }; }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "borey.active", table: "boreys", rowId: id, old: { is_active: !active }, new: { is_active: active }, ip });
    return { ok: true };
  });
}

/** a customer's borey: one of this shop's (an inactive one only when the customer already has it) */
export async function boreyFor(companyId: string, id: string | null, current: string | null): Promise<{ id: string; name: string; province_code: string; district_code: string; commune_code: string | null } | null> {
  if (!id) return null;
  const b = (await sql<{ id: string; name: string; province_code: string; district_code: string; commune_code: string | null; is_active: boolean }[]>`
    select id, name, province_code, district_code, commune_code, is_active from boreys where id = ${id} and company_id = ${companyId}`)[0];
  if (!b || (!b.is_active && b.id !== current)) throw new AppError("BOREY_NOT_FOUND", 404);
  return b;
}
