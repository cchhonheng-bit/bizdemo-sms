// me(): profile + company + permissions in one round trip (same shape as v1 api.me()).
import { sql } from "../db.js";
import { unauthenticated } from "../lib/errors.js";
import { permissionsFor } from "./permissions.js";

export async function mePayload(userId: string) {
  const rows = await sql<{
    id: string; username: string; full_name: string; role: string; phone: string | null; email: string | null; language: string;
    must_change_password: boolean; telegram_linked: boolean; company_id: string; company_name: string; slug: string; timezone: string; is_active: boolean;
  }[]>`
    select u.id, u.username, u.full_name, u.role, u.phone, u.email, u.language, u.must_change_password,
           u.telegram_user_id is not null as telegram_linked, u.is_active,
           c.id as company_id, c.name as company_name, c.slug, c.timezone
    from users u join companies c on c.id = u.company_id where u.id = ${userId}`;
  const u = rows[0];
  if (!u || !u.is_active) throw unauthenticated();
  const permissions = await permissionsFor(sql, u.company_id, u.role);
  return {
    id: u.id, username: u.username, full_name: u.full_name, role: u.role, phone: u.phone, email: u.email, language: u.language,
    must_change_password: u.must_change_password, telegram_linked: u.telegram_linked,
    company: { id: u.company_id, name: u.company_name, slug: u.slug, timezone: u.timezone },
    permissions,
  };
}
