// Customer service requests (D-91 Telegram · D-95 website): one table for both sources. Admin / GM are told (in the app and on
// Telegram) and handle them from the app («Customer requests») or the bot: call back, create the job, mark as done.
import { sql, type Db } from "../db.js";
import { notFound } from "../lib/errors.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { notifyUser } from "./telegram.js";

export type RequestSource = "telegram" | "website";

/** an existing customer with this phone number (digits compared, +855 = leading 0) */
export async function customerByPhone(db: Db, companyId: string, phone: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, "").replace(/^855/, "0");
  if (digits.length < 8) return null;
  return (await db<{ id: string }[]>`select c.id from customers c where c.company_id = ${companyId} and c.is_active
    and exists (select 1 from unnest(c.phones) p where regexp_replace(regexp_replace(p, '[^0-9]', '', 'g'), '^855', '0') = ${digits})
    order by c.created_at limit 1`)[0]?.id ?? null;
}

export async function createRequest(v: { companyId: string; source: RequestSource; name: string | null; phone?: string | null; text: string;
  customerId?: string | null; subscriberId?: number | null; meta?: Record<string, unknown> }): Promise<string> {
  const id = (await sql<{ id: string }[]>`insert into service_requests (company_id, source, customer_id, subscriber_id, name, phone, text, meta)
    values (${v.companyId}, ${v.source}, ${v.customerId ?? null}, ${v.subscriberId ?? null}, ${v.name?.slice(0, 120) ?? null}, ${v.phone?.slice(0, 40) ?? null},
      ${v.text.slice(0, 1000)}, ${sql.json((v.meta ?? {}) as never)}) returning id`)[0]!.id;
  await audit(sql, { companyId: v.companyId, userId: null, action: "service.request", source: v.source === "telegram" ? "telegram" : "system", table: "service_requests", rowId: id,
    new: { source: v.source, customer_id: v.customerId ?? null } });
  const who = v.name ?? "";
  const title = v.source === "website" ? { km: `🌐 សំណើពីគេហទំព័រ · ${who}`, en: `🌐 Website request · ${who}` } : { km: `🛠 សំណើសេវាកម្ម · ${who}`, en: `🛠 Service request · ${who}` };
  const body = `${v.phone ? `📞 ${v.phone}\n` : ""}${v.text}`.slice(0, 300);
  for (const u of await sql<{ id: string }[]>`select distinct u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = 'booking.create' and rp.allowed
      where u.company_id = ${v.companyId} and u.is_active and u.role in ('admin', 'gm')`)
    await notifyUser(sql, v.companyId, u.id, "service.request", title, body, "/requests", `req:${id}:${u.id}`);
  return id;
}

/** open requests first; with `all` also the ones handled in the last 30 days */
export async function listRequests(user: SessionUser, all: boolean) {
  return sql`select r.id, r.source, r.name, r.phone, r.text, r.status, r.meta, r.created_at, r.handled_at, c.id as customer_id, c.name as customer_name, h.full_name as handled_by_name
    from service_requests r left join customers c on c.id = r.customer_id left join users h on h.id = r.handled_by
    where r.company_id = ${user.companyId} and (r.status = 'new' ${all ? sql`or r.handled_at > now() - interval '30 days'` : sql``})
    order by (r.status = 'new') desc, r.created_at desc limit 200`;
}

export async function markRequestDone(user: SessionUser, ip: string | null, id: string) {
  const r = await sql`update service_requests set status = 'done', handled_by = ${user.id}, handled_at = now() where id = ${id} and company_id = ${user.companyId} and status = 'new' returning id`;
  if (!r.length) throw notFound();
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "service.request_done", table: "service_requests", rowId: id, ip });
  return { ok: true };
}
