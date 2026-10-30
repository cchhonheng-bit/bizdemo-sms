// D-196 (client 30-10): while the GM is away (leave / absent) the CEO names a substitute reviewer until a day — that person reviews
// the technicians' reports (job.review) and gets the «waiting for review» alerts; the GM keeps the right too. Settings →
// «អ្នកត្រួតពិនិត្យជំនួស». A technician is never a substitute; a switched-off account or a past day ends it by itself.
import { sql, tx, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";

/** the substitute in force today (shop time), or null */
export async function activeSubstitute(db: Db, companyId: string): Promise<string | null> {
  return (await db<{ id: string }[]>`select u.id from company_settings s join companies co on co.id = s.company_id
    join users u on u.id = s.review_substitute_id and u.company_id = s.company_id and u.is_active and u.role <> 'tech'
    where s.company_id = ${companyId} and (s.review_substitute_until is null or s.review_substitute_until >= (now() at time zone co.timezone)::date)`)[0]?.id ?? null;
}

export async function getSubstitute(user: SessionUser) {
  const r = (await sql<{ user_id: string | null; until: string | null; name: string | null }[]>`select s.review_substitute_id as user_id, s.review_substitute_until::text as until, u.full_name as name
    from company_settings s left join users u on u.id = s.review_substitute_id where s.company_id = ${user.companyId}`)[0];
  return { user_id: r?.user_id ?? null, until: r?.until ?? null, name: r?.name ?? null, active: !!r?.user_id && (await activeSubstitute(sql, user.companyId)) === r.user_id };
}

/** settings.manage (the CEO): name the substitute (until a day, or open-ended) or clear it; audited */
export async function setSubstitute(user: SessionUser, ip: string | null, v: { user_id: string | null; until: string | null }) {
  return tx(user.id, async (t) => {
    if (v.user_id) {
      const u = (await t<{ role: string; is_active: boolean }[]>`select role::text as role, is_active from users where id = ${v.user_id} and company_id = ${user.companyId}`)[0];
      if (!u || !u.is_active) throw new AppError("NOT_FOUND", 404);
      if (u.role === "tech") throw new AppError("NOT_A_REVIEWER", 400);
      if (v.until && (await t<{ past: boolean }[]>`select ${v.until}::date < (now() at time zone co.timezone)::date as past from companies co where co.id = ${user.companyId}`)[0]!.past)
        throw new AppError("BAD_DATE", 400);
    }
    const old = (await t<{ user_id: string | null; until: string | null }[]>`select review_substitute_id as user_id, review_substitute_until::text as until from company_settings where company_id = ${user.companyId} for update`)[0];
    await t`update company_settings set review_substitute_id = ${v.user_id}, review_substitute_until = ${v.user_id ? v.until : null} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "settings.review_substitute", table: "company_settings", rowId: user.companyId, old, new: { user_id: v.user_id, until: v.user_id ? v.until : null }, ip });
    return { ok: true };
  });
}
