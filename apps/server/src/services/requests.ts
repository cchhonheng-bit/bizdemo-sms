// Customer requests (D-91 Telegram · D-95/D-96 website): one inbox for everything a customer asks for —
//   request    a free text from the bot («request service»): call back, create the job, mark as done
//   booking    an online booking that waits for an answer: confirm or decline (the slot is held meanwhile)
//   quote      a quote request with photos (goes to the GM)
//   reschedule a customer asks to move a booking: approve (the normal reschedule runs, requested_by = customer) or reject
// Admin / GM are told in the app and on Telegram and handle them in the app («Customer requests») or in the bot.
import { appUrl } from "../lib/app-url.js";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { Tx } from "../lib/i18n.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { notifyUser } from "./telegram.js";

export type RequestSource = "telegram" | "website";
export type RequestKind = "request" | "booking" | "quote" | "reschedule";

/** an existing customer with this phone number (digits compared, +855 = leading 0) */
export async function customerByPhone(db: Db, companyId: string, phone: string): Promise<string | null> {
  const digits = phone.replace(/\D/g, "").replace(/^855/, "0");
  if (digits.length < 8) return null;
  return (await db<{ id: string }[]>`select c.id from customers c where c.company_id = ${companyId} and c.is_active
    and exists (select 1 from unnest(c.phones) p where regexp_replace(regexp_replace(p, '[^0-9]', '', 'g'), '^855', '0') = ${digits})
    order by c.created_at limit 1`)[0]?.id ?? null;
}

/** in-app notification + personal Telegram message (with a button into the app) to the staff who handle requests */
export async function notifyRequestStaff(db: Db, companyId: string, roles: ("admin" | "gm")[], title: Tx, body: string | Tx, dedupe: string): Promise<void> {
  const markup = config.publicUrl.startsWith("https://") ? (lang: string) => ({ inline_keyboard: [[{ text: lang === "en" ? "📱 Open the requests" : "📱 បើកសំណើ", url: appUrl("/requests") }]] }) : null;
  for (const u of await db<{ id: string; language: string }[]>`select distinct u.id, u.language from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role and rp.permission_key = 'booking.create' and rp.allowed
      where u.company_id = ${companyId} and u.is_active and u.role::text = any(${db.array(roles)})`)
    await notifyUser(db, companyId, u.id, "service.request", title, body, "/requests", `req:${dedupe}:${u.id}`, markup ? markup(u.language) : null);
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
  await notifyRequestStaff(sql, v.companyId, ["admin", "gm"], title, `${v.phone ? `📞 ${v.phone}\n` : ""}${v.text}`, id);
  return id;
}

/** open requests first; with `all` also the ones handled in the last 30 days */
export async function listRequests(user: SessionUser, all: boolean) {
  return sql`select r.id, r.source, r.kind, r.name, r.phone, r.text, r.status, r.outcome, r.note, r.meta, r.created_at, r.handled_at, c.id as customer_id, c.name as customer_name, h.full_name as handled_by_name,
      r.booking_id, b.number as booking_number, b.scheduled_at as booking_at, b.ends_at as booking_ends, b.status as booking_status, b.web_status, b.web_lines, b.lat, b.lng, b.loc_accuracy,
      (select coalesce(json_agg(json_build_object('id', f.id) order by f.created_at, f.id), '[]'::json) from service_request_files f where f.request_id = r.id) as photos
    from service_requests r left join customers c on c.id = r.customer_id left join users h on h.id = r.handled_by left join bookings b on b.id = r.booking_id
    where r.company_id = ${user.companyId} and (r.status = 'new' ${all ? sql`or r.handled_at > now() - interval '30 days'` : sql``})
    order by (r.status = 'new') desc, r.created_at desc limit 200`;
}

/** «done» closes a free request or a quote; an online booking that still waits needs a decision (confirm / decline) */
export async function markRequestDone(user: SessionUser, ip: string | null, id: string) {
  const r = (await sql<{ kind: string; web_status: string | null }[]>`select r.kind, b.web_status from service_requests r left join bookings b on b.id = r.booking_id
    where r.id = ${id} and r.company_id = ${user.companyId} and r.status = 'new'`)[0];
  if (!r) throw notFound();
  if (r.kind === "booking" && r.web_status === "pending") throw new AppError("DECISION_REQUIRED", 400);
  await sql`update service_requests set status = 'done', handled_by = ${user.id}, handled_at = now() where id = ${id} and company_id = ${user.companyId} and status = 'new'`;
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "service.request_done", table: "service_requests", rowId: id, ip });
  return { ok: true };
}
