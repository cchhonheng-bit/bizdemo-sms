// D-178 (owner 26-10): the accounts follow Accounting everywhere. ONE mapping table (account_map) says which account each automatic
// posting uses — by account id, edited in Accounting → Setup by the CEO / CFO. The stock accounts are the posting accounts directly under
// the mapped stock headers (new stock, second hand). An account that is mapped or linked to items is never switched off or deleted —
// the refusal lists where it is used.
import { ACCOUNT_MAP, type AccountMapKey } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";

/** key → account id for every mapped key */
export async function mapIds(db: Db, companyId: string): Promise<Record<AccountMapKey, string>> {
  const rows = await db<{ key: AccountMapKey; account_id: string }[]>`select key, account_id from account_map where company_id = ${companyId}`;
  return Object.fromEntries(rows.map((r) => [r.key, r.account_id])) as Record<AccountMapKey, string>;
}

/** the stock accounts: the asset posting accounts directly under a mapped stock header (new stock 13000, second hand 18000 for One Team) */
export async function stockAccountIds(db: Db, companyId: string, activeOnly = false): Promise<string[]> {
  return (await db<{ id: string }[]>`select a.id from accounts a join accounts h on h.company_id = a.company_id and h.code = a.parent_code
    join account_map m on m.account_id = h.id and m.company_id = a.company_id and m.key in ('stock_new', 'stock_second_hand')
    where a.company_id = ${companyId} and a.type = 'asset' and not a.is_group ${activeOnly ? db`and a.is_active` : db``}`).map((r) => r.id);
}
export const isStockAccount = async (db: Db, companyId: string, id: string, activeOnly = false) => (await stockAccountIds(db, companyId, activeOnly)).includes(id);

/** where an account is used: the mapping keys that point at it and the catalog items linked to it (stock, income or stock-link account) */
export async function accountUsage(db: Db, companyId: string, id: string): Promise<{ mappings: string[]; items: string[] }> {
  const mappings = (await db<{ key: string }[]>`select key from account_map where company_id = ${companyId} and account_id = ${id} order by key`).map((r) => r.key);
  const items = (await db<{ code: string | null; name_km: string }[]>`select code, name_km from catalog_items where company_id = ${companyId}
    and ${id} in (inventory_account_id, income_account_id, stock_link_account_id) order by code nulls last, name_km`).map((i) => (i.code ? `${i.code} ${i.name_km}` : i.name_km));
  return { mappings, items };
}
/** an account still mapped or linked to items stays on: ACCOUNT_IN_USE with the keys and up to 20 items */
export async function assertNotInUse(db: Db, companyId: string, id: string): Promise<void> {
  const u = await accountUsage(db, companyId, id);
  if (u.mappings.length || u.items.length) throw new AppError("ACCOUNT_IN_USE", 409, { mappings: u.mappings, items: u.items.slice(0, 20), more: Math.max(0, u.items.length - 20) });
}

const canEdit = (user: SessionUser) => user.role === "ceo" || user.role === "cfo";
export async function getMapping(user: SessionUser) {
  const rows = await sql<{ key: string; account_id: string; code: string; name_km: string; name_en: string | null; updated_at: string; updated_by: string | null }[]>`
    select m.key, m.account_id, a.code, a.name_km, a.name_en, m.updated_at, u.full_name as updated_by from account_map m join accounts a on a.id = m.account_id
      left join users u on u.id = m.updated_by where m.company_id = ${user.companyId}`;
  const by = new Map(rows.map((r) => [r.key, r]));
  return { can_edit: canEdit(user), keys: ACCOUNT_MAP.map((k) => ({ ...k, account: by.get(k.key) ?? null })) };
}
export async function setMapping(user: SessionUser, ip: string | null, key: string, accountId: string) {
  if (!canEdit(user)) throw new AppError("FORBIDDEN", 403);
  const def = ACCOUNT_MAP.find((k) => k.key === key);
  if (!def) throw notFound();
  return tx(user.id, async (t) => {
    const a = (await t<{ code: string; type: string; is_group: boolean; is_active: boolean }[]>`select code, type::text as type, is_group, is_active from accounts
      where id = ${accountId} and company_id = ${user.companyId}`)[0];
    if (!a) throw notFound();
    if (!a.is_active) throw new AppError("ACCOUNT_INACTIVE", 400);
    if (Boolean((def as { group?: boolean }).group) !== a.is_group || !(def.types as readonly string[]).includes(a.type)) throw new AppError("MAP_WRONG_ACCOUNT", 400, { types: def.types });
    const old = (await t<{ code: string }[]>`select a.code from account_map m join accounts a on a.id = m.account_id where m.company_id = ${user.companyId} and m.key = ${key}`)[0]?.code ?? null;
    await t`insert into account_map (company_id, key, account_id, updated_by) values (${user.companyId}, ${key}, ${accountId}, ${user.id})
      on conflict (company_id, key) do update set account_id = excluded.account_id, updated_by = excluded.updated_by, updated_at = now()`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.mapping", table: "account_map", rowId: user.companyId, old: { key, code: old }, new: { key, code: a.code }, ip });
    return { ok: true };
  });
}
