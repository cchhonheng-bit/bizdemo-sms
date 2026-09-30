// A3 exchange rate (D-86): one current rate per company (company_settings.fx_rate_khr, default 4100 ៛ = $1), set by CEO / CFO (fx.set),
// every change audited and kept in fx_rates. Quotes, invoices, payments, deposits … store their own rate — old records never change.
import { sql, type Db } from "../db.js";
import { notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";

export async function setRate(t: Db, user: SessionUser, rate: number, note: string | null, ip: string | null): Promise<void> {
  const old = (await t<{ fx: string }[]>`select fx_rate_khr::text as fx from company_settings where company_id = ${user.companyId} for update`)[0];
  if (!old) throw notFound();
  if (Number(old.fx) === rate && !note) return;
  await t`update company_settings set fx_rate_khr = ${rate}, updated_by = ${user.id} where company_id = ${user.companyId}`;
  await t`insert into fx_rates (company_id, rate, note, set_by) values (${user.companyId}, ${rate}, ${note}, ${user.id})`;
  await audit(t, { companyId: user.companyId, userId: user.id, action: "fx.set", table: "company_settings", rowId: user.companyId, old: { fx_rate_khr: Number(old.fx) }, new: { fx_rate_khr: rate, note }, ip });
}

export async function rateInfo(user: SessionUser) {
  const current = Number((await sql<{ fx: string }[]>`select fx_rate_khr::text as fx from company_settings where company_id = ${user.companyId}`)[0]?.fx ?? 4100);
  const history = await sql`select r.rate::float as rate, r.note, r.set_at, u.full_name as set_by_name from fx_rates r left join users u on u.id = r.set_by
    where r.company_id = ${user.companyId} order by r.set_at desc, r.id desc limit 50`;
  return { current, history };
}
