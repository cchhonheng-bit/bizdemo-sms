// D-182 (owner 28-10): the CEO may stop using — or delete — an account that is still in use, after a confirm that shows what it touches.
// KEEP the amounts: its balance moves to another account of the same type with ONE reclass entry dated today, its items (new codes) and its
// map keys follow. REMOVE the amounts (a record made by mistake): its stock movements are undone by mirror movements and its own manual /
// other / supplier-payment entries by reversals — the history stays, every balance goes back. Then the account is switched off (deleted
// when nothing ever referred to it). Only the CEO; everyone else still gets ACCOUNT_IN_USE with the places.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { books, post, reverseEntry } from "./accounting.js";
import { nextItemCode } from "./catalog.js";
import { reverseMove } from "./inventory.js";
import { postStock } from "./ledger-hooks.js";

/** the entries «remove the amounts» may reverse; anything else (opening balances, invoices, payments, payroll …) is corrected where it was made */
const REMOVABLE = ["stock", "supplier_pay", "manual", "other"];

/** what an account touches: its balance, its entries by source, its stock movements, its items, its map keys — and why «remove» may be refused */
export async function accountUsagePlan(db: Db, companyId: string, id: string) {
  const a = (await db<{ id: string; code: string; name_km: string; name_en: string | null; type: string; is_group: boolean; is_active: boolean }[]>`
    select id, code, name_km, name_en, type::text as type, is_group, is_active from accounts where id = ${id} and company_id = ${companyId}`)[0];
  if (!a) throw notFound();
  const [bal, sources, items, moves, mappings] = await Promise.all([
    db<{ b: string; n: string }[]>`select coalesce(sum(debit_cents - credit_cents), 0)::text as b, count(*)::text as n from journal_lines where account_id = ${id}`,
    db<{ source: string; n: string }[]>`select e.source, count(distinct e.id)::text as n from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = ${id} group by e.source order by e.source`,
    db<{ id: string; code: string | null; name_km: string; qty: string; value: string; is_active: boolean }[]>`select ci.id, ci.code, ci.name_km, coalesce(s.qty, 0)::text as qty,
      coalesce(s.value_cents, 0)::text as value, ci.is_active from catalog_items ci left join stock_items s on s.item_id = ci.id
      where ci.company_id = ${companyId} and ${id} in (ci.inventory_account_id, ci.income_account_id, ci.stock_link_account_id) order by ci.code nulls last, ci.name_km`,
    db<{ n: string }[]>`select count(*)::text as n from stock_moves where account_id = ${id}`,
    db<{ key: string }[]>`select key from account_map where company_id = ${companyId} and account_id = ${id} order by key`]);
  return { id: a.id, code: a.code, name_km: a.name_km, name_en: a.name_en, type: a.type, is_group: a.is_group, is_active: a.is_active,
    balance: Number(bal[0]!.b), lines: Number(bal[0]!.n), entries: Object.fromEntries(sources.map((s) => [s.source, Number(s.n)])), moves: Number(moves[0]!.n),
    mappings: mappings.map((m) => m.key), items: items.map((i) => ({ id: i.id, code: i.code, name_km: i.name_km, qty: Number(i.qty), value: Number(i.value), is_active: i.is_active })),
    remove_blockers: [...sources.filter((s) => !REMOVABLE.includes(s.source)).map((s) => `source:${s.source}`), ...mappings.map((m) => `map:${m.key}`)] };
}
export const accountUsage = (user: SessionUser, id: string) => accountUsagePlan(sql, user.companyId, id);

export async function retireAccount(user: SessionUser, ip: string | null, id: string, v: { mode: "keep" | "remove"; target_id?: string | null }) {
  if (user.role !== "ceo") throw new AppError("FORBIDDEN", 403);
  return tx(user.id, async (t) => {
    await t`select id from accounts where id = ${id} and company_id = ${user.companyId} for update`;
    const p = await accountUsagePlan(t, user.companyId, id);
    if (p.is_group) throw new AppError("SYSTEM_ACCOUNT", 400);
    const b = await books(t, user.companyId);
    const done: Record<string, unknown> = { mode: v.mode };
    if (v.mode === "keep") {
      const to = v.target_id ? (await t<{ id: string; code: string; type: string; is_group: boolean; is_active: boolean }[]>`select id, code, type::text as type, is_group, is_active
        from accounts where id = ${v.target_id} and company_id = ${user.companyId}`)[0] : undefined;
      if (!to || to.id === id || to.is_group || !to.is_active || to.type !== p.type) throw new AppError("BAD_TARGET_ACCOUNT", 400);
      if (p.balance !== 0) { // the balance moves with one entry dated today; the old entries stay as they are
        const e = await post(t, user, { date: b.today, memo: `${p.code} → ${to.code}`, source: "manual",
          lines: [{ account: to.id, amount: p.balance, memo: p.code }, { account: id, amount: -p.balance, memo: to.code }] });
        done.reclass = e?.number ?? null;
      }
      // the map keys follow (same type as before → still a fit; a group never retires)
      const keys = await t<{ key: string }[]>`update account_map set account_id = ${to.id}, updated_by = ${user.id}, updated_at = now() where company_id = ${user.companyId} and account_id = ${id} returning key`;
      const moved: string[] = [];
      for (const it of await t<{ id: string; code: string | null; inv: boolean }[]>`select id, code, coalesce(inventory_account_id = ${id}, false) as inv from catalog_items
          where company_id = ${user.companyId} and ${id} in (inventory_account_id, income_account_id, stock_link_account_id) order by code nulls last`) {
        if (it.inv) { const code = (await nextItemCode(t, user.companyId, to.id)).code; await t`update catalog_items set code = ${code}, inventory_account_id = ${to.id} where id = ${it.id}`; moved.push(`${it.code ?? "—"}→${code}`); }
        await t`update catalog_items set income_account_id = case when income_account_id = ${id} then ${to.id}::uuid else income_account_id end,
          stock_link_account_id = case when stock_link_account_id = ${id} then ${to.id}::uuid else stock_link_account_id end where id = ${it.id}`;
      }
      if (!p.lines && p.moves) { // nothing posted on it yet (the books not started): its movements follow it — the append-only guard is off for this one statement
        await t`alter table stock_moves disable trigger stock_moves_immutable`;
        await t`update stock_moves set account_id = ${to.id} where account_id = ${id}`;
        await t`alter table stock_moves enable trigger stock_moves_immutable`;
      }
      Object.assign(done, { target: to.code, balance: p.balance, keys: keys.map((k) => k.key), items: moved });
    } else {
      if (p.remove_blockers.length) throw new AppError("ACCOUNT_REMOVE_BLOCKED", 409, { blockers: p.remove_blockers });
      const moves = await t<{ id: number }[]>`select m.id from stock_moves m where m.account_id = ${id} and m.reversal_of is null
        and not exists (select 1 from stock_moves r where r.reversal_of = m.id) order by m.id desc`;
      const mirrors: number[] = [];
      for (const m of moves) mirrors.push(await reverseMove(t, user, Number(m.id)));
      if (mirrors.length) await postStock(t, user, mirrors); // the books get the mirror of each movement (nothing while they are not started)
      const entries = await t<{ id: string; number: string }[]>`select distinct e.id, e.number from journal_entries e join journal_lines l on l.entry_id = e.id where l.account_id = ${id}
        and e.source in ('manual', 'other', 'supplier_pay') and e.reversal_of is null and not exists (select 1 from journal_entries r where r.reversal_of = e.id)`;
      for (const e of entries) await reverseEntry(t, user, e.id, `${p.code} · D-182`, b.today);
      await t`update catalog_items set is_active = false where company_id = ${user.companyId} and inventory_account_id = ${id}`;
      Object.assign(done, { reversed_moves: mirrors.length, reversed_entries: entries.map((e) => e.number), items_off: p.items.filter((i) => i.is_active).length });
    }
    const left = (await t`select 1 from journal_lines where account_id = ${id} union all select 1 from stock_moves where account_id = ${id} or payable_account_id = ${id}
      union all select 1 from supplier_payments where account_id = ${id} union all select 1 from account_map where account_id = ${id}
      union all select 1 from catalog_items where ${id} in (inventory_account_id, income_account_id, stock_link_account_id) limit 1`).length > 0;
    if (left) await t`update accounts set is_active = false where id = ${id}`; else await t`delete from accounts where id = ${id}`;
    done.result = left ? "off" : "deleted";
    await audit(t, { companyId: user.companyId, userId: user.id, action: "acct.account_retire", table: "accounts", rowId: id, old: { code: p.code, name_km: p.name_km, balance: p.balance }, new: done, ip });
    return done as { result: "off" | "deleted"; mode: "keep" | "remove" } & Record<string, unknown>;
  });
}
