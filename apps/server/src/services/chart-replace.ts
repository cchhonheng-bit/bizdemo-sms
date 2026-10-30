// `node dist/cli.mjs chart-replace <slug> [--apply]` (CEO 12-10, D-141): the shop's chart of accounts becomes chart.ts (One Team's own
// chart) — only while its books hold no entry. Dry run first (the plan: accounts removed / added, the accounts the system adds, the
// stock items of Sheet2, catalog links cleared); --apply writes it in one transaction, audited as the shop's HangKH Support account.
import { sql, tx, type Db } from "../db.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { books, post } from "./accounting.js";
import { itemRemoval, removeItem } from "./inventory.js";
import { legacyN, subCode } from "./catalog.js";
import { setLineKind } from "./invoices.js";
import { CHART, OLD_TO_NEW, isSubCodeAccount, replaceChart, seedParent, typeOfCode, updateChartV2, type Role } from "./chart.js";

export async function chartReplaceCli(slug: string, apply: boolean): Promise<string[]> {
  const c = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!c) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; full_name: string }[]>`select id, full_name from users where company_id = ${c.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const plan = await tx(u.id, async (t) => {
    const p = await replaceChart(t, c.id, apply);
    if (apply) await audit(t, { companyId: c.id, userId: u.id, action: "acct.chart_replace", table: "accounts", rowId: c.id,
      old: { codes: p.remove.map((a) => a.code) }, new: { accounts: CHART.length, added_by_system: p.added_by_system, stock_items: p.stock_items.filter((s) => !s.exists).map((s) => s.code) } });
    return p;
  });
  const out = [`${c.name} (${slug}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  out.push(`accounts now: ${plan.remove.length} → removed (no entries) · ${plan.add} → the new chart (${CHART.filter((r) => r[5] === "group").length} groups)`);
  for (const a of plan.remove) out.push(`  − ${a.code} ${a.name_km}${OLD_TO_NEW[a.code] ? ` → ${OLD_TO_NEW[a.code]}` : ""}`);
  out.push(`added by the system («បន្ថែមដោយប្រព័ន្ធ»): ${plan.added_by_system.join(" · ")}`);
  out.push(`catalog items with an income / stock account link cleared: ${plan.items_unlinked}`);
  out.push(`stock items (Sheet2): ${plan.stock_items.map((s) => `${s.code}${s.exists ? " (exists → linked)" : ""}`).join(" ")}`);
  if (plan.draft_banks_dropped.length) out.push(`opening draft: other-bank codes dropped ${plan.draft_banks_dropped.join(", ")}`);
  out.push(apply ? "applied ✓" : "dry run only");
  return out;
}

/** `node dist/cli.mjs chart-update <slug> [--apply]` (client 25-10, D-165): the stock codes of 23-10 → the client's new sheet, in place */
export async function chartUpdateCli(slug: string, apply: boolean): Promise<string[]> {
  const c = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!c) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; full_name: string }[]>`select id, full_name from users where company_id = ${c.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const plan = await tx(u.id, async (t) => {
    const p = await updateChartV2(t, c.id, apply);
    if (apply && !p.already) await audit(t, { companyId: c.id, userId: u.id, action: "acct.chart_update", table: "accounts", rowId: c.id, old: { renamed: p.renamed.map((r) => r.from), recoded: p.recoded.map((r) => r.from) }, new: { renamed: p.renamed.map((r) => r.to), added: p.added, recoded: p.recoded.map((r) => r.to), kept: p.kept } });
    return p;
  });
  const out = [`${c.name} (${slug}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  if (plan.already) { out.push("already on the 25-10 chart — nothing to do"); return out; }
  for (const r of plan.renamed) out.push(`  ${r.from} → ${r.to} ${r.name}`);
  for (const a of plan.added) out.push(`  + ${a}`);
  for (const x of plan.recoded) out.push(`  item ${x.from} → ${x.to}`);
  for (const k of plan.kept) out.push(`  kept ${k} (movements) → switched off, «(មុន ២៥-១០)»`);
  out.push(apply ? "applied ✓" : "dry run only");
  return out;
}

// ---------- D-175 (client 26-10): the client's chart exactly as listed ----------
/** the client's list of 26-10: every account of chart.ts except the ones the system added; 50012 = discounts given */
export const CLIENT_V3: [string, string, boolean][] = [...CHART.filter((r) => r[5] !== "added" && r[0] !== "50012").map((r): [string, string, boolean] => [r[0], r[1], r[5] === "group"]),
  ["50012", "ចំណាយបញ្ចុះតម្លៃ", false]];
/** an account off the list → where its balance, its items and its catalog links go */
export const V3_MOVE: Record<string, string> = { "11004": "11001", "13001": "13110", "21002": "21001", "30004": "30001", "30005": "30001", "40007": "50012", "50013": "50011", "50014": "50012" };
/** the automatic postings: [map key, account] (D-178: the account map) — KHR cash on 11001, opening / drawings on the capital, cash over / short with other expenses */
export const V3_ROLES: [Role, string][] = [["discount", "50012"], ["stock_adjust", "50011"], ["payroll", "21001"], ["ap_ac", "20001"], ["ap_washing", "20002"],
  ["cash_khr", "11001"], ["opening", "30001"], ["drawings", "30001"], ["cash_diff", "50011"]];
export type V3Plan = { created: string[]; renamed: { code: string; from: string; to: string }[]; reactivated: string[]; roles: { role: string; from: string | null; to: string | null }[];
  off: { code: string; name: string; to: string | null; balance: number }[]; items: { id: string; code: string; to_code: string; name: string; from: string; account: string; qty: number; value: number }[];
  parents: { code: string; from: string | null; to: string | null }[]; links: number; unmapped: string[]; reclass: string | null; already: boolean; moves: number };

/** names verbatim, the accounts off the list switched off (never deleted — a balance moves first with ONE dated reclass entry, old entries
 *  untouched), roles re-pointed, a stock item on an account off the list moved to the closest one with a new sub code; idempotent */
export async function clientChartV3(t: Db, user: SessionUser, apply: boolean): Promise<V3Plan> {
  const c = user.companyId;
  const have = await t<{ id: string; code: string; name_km: string; mapped: boolean; is_active: boolean; parent: string | null; bal: string }[]>`select a.id, a.code, a.name_km,
      exists (select 1 from account_map m where m.account_id = a.id) as mapped, a.is_active, a.parent_code as parent,
      coalesce((select sum(l.debit_cents - l.credit_cents) from journal_lines l where l.account_id = a.id), 0)::text as bal from accounts a where a.company_id = ${c} order by a.code`;
  const byCode = new Map(have.map((a) => [a.code, a]));
  const list = new Map(CLIENT_V3.map(([code, km, group]) => [code, { km, group }]));
  const plan: V3Plan = { created: [], renamed: [], reactivated: [], roles: [], off: [], items: [], parents: [], links: 0, unmapped: [], reclass: null, already: false, moves: 0 };
  for (const [code, { km }] of list) {
    const a = byCode.get(code);
    if (!a) plan.created.push(code);
    else { if (a.name_km !== km) plan.renamed.push({ code, from: a.name_km, to: km }); if (!a.is_active) plan.reactivated.push(code); if (a.parent !== seedParent(code)) plan.parents.push({ code, from: a.parent, to: seedParent(code) }); }
  }
  for (const a of have) {
    if (list.has(a.code) || (!a.is_active && !a.mapped && Number(a.bal) === 0)) continue;
    const to = V3_MOVE[a.code] ?? null;
    if (!to && Number(a.bal) !== 0) { plan.unmapped.push(`${a.code} ${a.name_km} (balance ${a.bal}) — kept active`); continue; }
    plan.off.push({ code: a.code, name: a.name_km, to, balance: Number(a.bal) });
  }
  const roleNow = new Map((await t<{ key: string; code: string }[]>`select m.key, a.code from account_map m join accounts a on a.id = m.account_id where m.company_id = ${c}`).map((r) => [r.key, r.code]));
  for (const [role, to] of V3_ROLES) if ((roleNow.get(role) ?? null) !== to) plan.roles.push({ role, from: roleNow.get(role) ?? null, to });
  const items = await t<{ id: string; code: string | null; name: string; acct: string; qty: string; value: string }[]>`select ci.id, ci.code, ci.name_km as name, a.code as acct,
      coalesce(s.qty, 0)::text as qty, coalesce(s.value_cents, 0)::text as value from catalog_items ci join accounts a on a.id = ci.inventory_account_id
      left join stock_items s on s.item_id = ci.id where ci.company_id = ${c} and not (a.code = any(${t.array([...list.keys()])})) order by ci.code`;
  const last = new Map<string, number>();
  for (const it of items) {
    const to = V3_MOVE[it.acct];
    if (!to) { plan.unmapped.push(`item ${it.code ?? "—"} ${it.name} on ${it.acct}`); continue; }
    if (!last.has(to)) last.set(to, (await t<{ n: number }[]>`select coalesce(max(substr(code, ${to.length + 1})::int), 0)::int as n from catalog_items where company_id = ${c} and code ~ ${`^${to}[0-9]{2}$`}`)[0]!.n);
    const n = last.get(to)! + 1;
    last.set(to, n);
    plan.items.push({ id: it.id, code: it.code ?? "", to_code: isSubCodeAccount(to) ? `${to}${String(n).padStart(2, "0")}` : it.code ?? "", name: it.name, from: it.acct, account: to, qty: Number(it.qty), value: Number(it.value) });
  }
  const offCodes = plan.off.map((o) => o.code);
  plan.links = (await t<{ n: number }[]>`select count(*)::int as n from catalog_items ci join accounts a on a.id in (ci.income_account_id, ci.stock_link_account_id) where ci.company_id = ${c} and a.code = any(${t.array(offCodes)})`)[0]!.n;
  const moving = plan.off.filter((o) => o.balance !== 0 && o.to);
  plan.already = !plan.created.length && !plan.renamed.length && !plan.reactivated.length && !plan.roles.length && !plan.off.length && !plan.items.length && !plan.parents.length && !plan.links;
  if (!apply || plan.already) { if (moving.length) plan.reclass = `(dry run) ${moving.length} account(s) with a balance`; return plan; }

  for (const code of plan.created) {
    const { km, group } = list.get(code)!;
    await t`insert into accounts (company_id, code, name_km, type, is_group, parent_code, sub_codes) values (${c}, ${code}, ${km}, ${typeOfCode(code)!}::account_type, ${group}, ${seedParent(code)}, ${isSubCodeAccount(code, group)})`;
  }
  for (const [code, { km }] of list) await t`update accounts set name_km = ${km}, is_active = true, added_by_system = false where company_id = ${c} and code = ${code} and (name_km <> ${km} or not is_active or added_by_system)`;
  await t`update accounts set name_en = 'Discounts given' where company_id = ${c} and code = '50012'`;
  for (const x of plan.parents) await t`update accounts set parent_code = ${x.to} where company_id = ${c} and code = ${x.code}`;
  const id = new Map((await t<{ code: string; id: string }[]>`select code, id from accounts where company_id = ${c}`).map((a) => [a.code, a.id]));
  if (moving.length) { // the balances move with one entry dated today; the old entries stay as they are
    const e = await post(t, user, { date: (await books(t, c)).today, memo: `D-175 · ${moving.map((o) => `${o.code}→${o.to}`).join(" · ")}`, source: "manual",
      lines: moving.flatMap((o) => [{ account: id.get(o.to!)!, amount: o.balance, memo: o.code }, { account: id.get(o.code)!, amount: -o.balance, memo: o.to }]) });
    plan.reclass = e?.number ?? null;
  }
  for (const o of plan.off) if (o.to) await t`update account_map set account_id = ${id.get(o.to)!}, updated_at = now() where company_id = ${c} and account_id = ${id.get(o.code)!}`; // nothing points at an account switched off
  for (const [key, code] of V3_ROLES) await t`insert into account_map (company_id, key, account_id) values (${c}, ${key}, ${id.get(code)!})
    on conflict (company_id, key) do update set account_id = excluded.account_id, updated_at = now()`;
  for (const o of plan.off) if (o.to) await t`update catalog_items set income_account_id = case when income_account_id = ${id.get(o.code)!} then ${id.get(o.to)!}::uuid else income_account_id end,
      stock_link_account_id = case when stock_link_account_id = ${id.get(o.code)!} then ${id.get(o.to)!}::uuid else stock_link_account_id end where company_id = ${c}`;
  if (offCodes.length) await t`update accounts set is_active = false where company_id = ${c} and code = any(${t.array(offCodes)})`;
  for (const x of plan.items) await t`update catalog_items set code = ${x.to_code || null}, inventory_account_id = ${id.get(x.account)!} where id = ${x.id}`;
  // D-178: each stock movement keeps the account it was made on — a moved item's movements go with it only while nothing is posted on the old
  // account (the books never change a posted line); the append-only guard is off for this one statement
  for (const x of plan.items) {
    const from = id.get(x.from)!, to = id.get(x.account)!;
    if ((await t`select 1 from journal_lines where account_id = ${from} limit 1`).length) continue;
    await t`alter table stock_moves disable trigger stock_moves_immutable`;
    plan.moves += (await t`update stock_moves set account_id = ${to} where item_id = ${x.id} and account_id = ${from} returning id`).length;
    await t`alter table stock_moves enable trigger stock_moves_immutable`;
  }
  return plan;
}

/** `node dist/cli.mjs chart-v3 <slug> [--apply]` (client 26-10, D-175): dry run first; --apply writes in one transaction, audited as HangKH Support */
export async function chartV3Cli(slug: string, apply: boolean): Promise<string[]> {
  const co = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!co) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; role: string; username: string; full_name: string; language: "km" | "en" }[]>`select id, role::text as role, username, full_name, language from users
    where company_id = ${co.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const user = { id: u.id, companyId: co.id, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: u.language, sessionId: "cli" } as SessionUser;
  const plan = await tx(u.id, async (t) => {
    const p = await clientChartV3(t, user, apply);
    if (apply && !p.already) await audit(t, { companyId: co.id, userId: u.id, action: "acct.chart_update", table: "accounts", rowId: co.id,
      old: { roles: p.roles.map((r) => `${r.role}:${r.from ?? "-"}`), off: p.off.map((o) => o.code), items: p.items.map((x) => `${x.code}@${x.from}`) },
      new: { decision: "D-175", roles: p.roles.map((r) => `${r.role}:${r.to ?? "fallback"}`), renamed: p.renamed.map((r) => r.code), created: p.created, reclass: p.reclass, items: p.items.map((x) => `${x.to_code}@${x.account}`) } });
    return p;
  });
  const usd = (v: number) => `$${(v / 100).toFixed(2)}`;
  const out = [`${co.name} (${slug}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  if (plan.already) { out.push("already on the client's 26-10 chart — nothing to do"); return out; }
  out.push(`client's list: ${CLIENT_V3.length} accounts · created: ${plan.created.join(" ") || "none"} · switched on again: ${plan.reactivated.join(" ") || "none"}`);
  for (const r of plan.renamed) out.push(`  name ${r.code}: «${r.from.split("​").join("‹ZW›")}» → «${r.to}»`);
  for (const o of plan.off) out.push(`  off ${o.code} ${o.name} → ${o.to ?? "—"} (balance ${usd(o.balance)})`);
  for (const r of plan.roles) out.push(`  posting ${r.role}: ${r.from ?? "—"} → ${r.to ?? "fallback"}`);
  if (plan.parents.length) out.push(`under a new header: ${plan.parents.map((x) => `${x.code} ${x.from ?? "—"}→${x.to ?? "—"}`).join(" · ")}`);
  out.push(`reclass entry: ${plan.reclass ?? "none — no balance on the accounts switched off"}`);
  for (const x of plan.items) out.push(`  item ${x.code} «${x.name}» ${x.qty} · ${usd(x.value)} on ${x.from} → ${x.to_code} on ${x.account} (FLAG: brand / type not known — check)`);
  if (plan.links) out.push(`catalog links re-pointed: ${plan.links}`);
  if (plan.moves) out.push(`unposted stock movements moved with their items: ${plan.moves}`);
  for (const m of plan.unmapped) out.push(`  NOT MAPPED: ${m}`);
  out.push(apply ? "applied ✓" : "dry run only");
  return out;
}

/** `node dist/cli.mjs stock-item-remove <slug> <codes> [--apply]` (D-179): the same rule as the stock card's «លុបទំនិញនេះ», as HangKH Support */
export async function stockItemRemoveCli(slug: string, codes: string[], apply: boolean): Promise<string[]> {
  const co = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!co) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; role: string; username: string; full_name: string; language: "km" | "en" }[]>`select id, role::text as role, username, full_name, language from users
    where company_id = ${co.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const user = { id: u.id, companyId: co.id, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: u.language, sessionId: "cli" } as SessionUser;
  const out = [`${co.name} (${slug}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  for (const code of codes.map((c) => c.trim()).filter(Boolean)) {
    const it = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${co.id} and code = ${code}`)[0];
    if (!it) { out.push(`  ${code}: not found`); continue; }
    const r = await itemRemoval(sql, co.id, it.id);
    if (r.qty !== 0) { out.push(`  ${code} «${r.name}»: still ${r.qty} in stock — refused`); continue; }
    if (apply) await removeItem(user, null, it.id);
    out.push(`  ${code} «${r.name}»: ${r.action === "delete" ? "deleted (never used)" : "switched off (has history)"}${apply ? " ✓" : ""}`);
  }
  return out;
}

/** `node dist/cli.mjs item-codes-6 <slug> [--apply]` (D-197, client 30-10): the stock items' D-165 codes (account + 2 digits: 1311001,
 *  1360010) → 6 digits (account × 10 + n: 131101, 136010) in ONE transaction as HangKH Support; ids stay, so stock, invoices and the books
 *  follow; a target another item already holds is reported and left alone; idempotent (nothing left → «nothing to do») */
export async function itemCodes6Cli(slug: string, apply: boolean): Promise<string[]> {
  const co = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!co) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; full_name: string }[]>`select id, full_name from users where company_id = ${co.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const out = [`${co.name} (${slug}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  return tx(u.id, async (t) => {
    const rows = await t<{ id: string; code: string; name: string; acct: string }[]>`select i.id, i.code, i.name_km as name, a.code as acct from catalog_items i
      join accounts a on a.id = i.inventory_account_id where i.company_id = ${co.id} and a.sub_codes and i.code is not null order by a.code, i.code for update of i`;
    const plan = rows.flatMap((r) => { const n = legacyN(r.acct, r.code); return n ? [{ ...r, to: subCode(r.acct, n) }] : []; });
    const held = new Set(rows.filter((r) => !plan.some((p) => p.id === r.id)).map((r) => r.code));
    for (const r of await t<{ code: string }[]>`select code from catalog_items where company_id = ${co.id} and code is not null and (inventory_account_id is null or inventory_account_id not in (select id from accounts where company_id = ${co.id} and sub_codes))`) held.add(r.code);
    const seen = new Set<string>();
    let moved = 0, refused = 0;
    for (const p of plan) {
      if (held.has(p.to) || seen.has(p.to)) { refused++; out.push(`  ${p.code} → ${p.to} «${p.name}»: ${p.to} is taken — left as it is`); continue; }
      seen.add(p.to); moved++;
      out.push(`  ${p.code} → ${p.to} «${p.name}»${apply ? " ✓" : ""}`);
      if (apply) {
        await t`update catalog_items set code = ${p.to} where id = ${p.id}`;
        await audit(t, { companyId: co.id, userId: u.id, action: "catalog.recode", table: "catalog_items", rowId: p.id, old: { code: p.code }, new: { code: p.to }, ip: null });
      }
    }
    out.push(plan.length ? `${moved} item(s) ${apply ? "re-coded" : "to re-code"}${refused ? ` · ${refused} left (code taken)` : ""}` : "nothing to do — every sub code has 6 digits");
    return out;
  });
}

/** `node dist/cli.mjs invoice-line-kind <slug> <invoice number> <line #> <service|product> [--apply]` (D-184): the invoice screen's «ប្ដូរជាទំនិញ / សេវា»
 *  as HangKH Support — the line's kind changes; on an issued invoice its revenue moves to the other income account by one entry */
export async function invoiceLineKindCli(slug: string, number: string, pos: number, kind: "service" | "product", apply: boolean): Promise<string[]> {
  const co = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!co) throw new Error(`company "${slug}" not found`);
  const u = (await sql<{ id: string; role: string; username: string; full_name: string; language: "km" | "en" }[]>`select id, role::text as role, username, full_name, language from users
    where company_id = ${co.id} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  const user = { id: u.id, companyId: co.id, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: u.language, sessionId: "cli" } as SessionUser;
  const inv = (await sql<{ id: string; status: string }[]>`select id, status::text as status from invoices where company_id = ${co.id} and number = ${number}`)[0];
  if (!inv) throw new Error(`invoice ${number} not found`);
  const lines = await sql<{ id: string; description: string; kind: string; amount: number }[]>`select id::text as id, description, kind::text as kind, round(qty * unit_price)::int as amount
    from invoice_lines where invoice_id = ${inv.id} order by sort, id`;
  const usd = (v: number) => `$${(v / 100).toFixed(2)}`;
  const out = [`${co.name} (${slug}) · ${number} (${inv.status}) · as ${u.full_name}${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];
  lines.forEach((l, k) => out.push(`  ${k + 1}. ${l.kind.padEnd(7)} ${usd(l.amount).padStart(10)}  ${l.description}${k + 1 === pos ? `  ← ${kind}` : ""}`));
  const l = lines[pos - 1];
  if (!l) throw new Error(`no line ${pos} on ${number}`);
  if (l.kind === kind) { out.push(`line ${pos} is already ${kind} — nothing to do`); return out; }
  if (apply) {
    const r = await setLineKind(user, null, inv.id, Number(l.id), kind);
    const je = (await sql<{ number: string; lines: string }[]>`select e.number, string_agg(a.code || ' ' || case when jl.debit_cents > 0 then 'Dr ' || (jl.debit_cents / 100.0)::text else 'Cr ' || (jl.credit_cents / 100.0)::text end, ' · ' order by jl.id) as lines
      from journal_entries e join journal_lines jl on jl.entry_id = e.id join accounts a on a.id = jl.account_id where e.company_id = ${co.id} and e.source = 'invoice' and e.source_id = ${inv.id}::text
      group by e.id, e.number, e.created_at order by e.created_at desc limit 1`)[0];
    out.push(`line ${pos} → ${kind} ✓ · revenue moved ${usd(r.moved)}${r.moved && je ? ` · ${je.number}: ${je.lines}` : ""}`);
  } else out.push(`would change line ${pos} ${l.kind} → ${kind} (revenue ${usd(l.amount)} moves to the ${kind === "product" ? "goods" : "service"} income account)`);
  return out;
}
