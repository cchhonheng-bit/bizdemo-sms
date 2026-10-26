// `node dist/cli.mjs chart-replace <slug> [--apply]` (CEO 12-10, D-141): the shop's chart of accounts becomes chart.ts (One Team's own
// chart) — only while its books hold no entry. Dry run first (the plan: accounts removed / added, the accounts the system adds, the
// stock items of Sheet2, catalog links cleared); --apply writes it in one transaction, audited as the shop's HangKH Support account.
import { sql, tx, type Db } from "../db.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { books, post } from "./accounting.js";
import { CHART, OLD_TO_NEW, isSubCodeAccount, parentOf, replaceChart, typeOfCode, updateChartV2, type Role } from "./chart.js";

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
/** the automatic postings: [role, account] — null = the role's fallback (roleIds: KHR cash → 11001, opening / drawings → 30001, cash over / short → 50011) */
export const V3_ROLES: [Role, string | null][] = [["discount", "50012"], ["stock_adjust", "50011"], ["payroll", "21001"], ["ap_ac", "20001"], ["ap_washing", "20002"],
  ["cash_khr", null], ["opening", null], ["drawings", null], ["cash_diff", null]];
export type V3Plan = { created: string[]; renamed: { code: string; from: string; to: string }[]; reactivated: string[]; roles: { role: string; from: string | null; to: string | null }[];
  off: { code: string; name: string; to: string | null; balance: number }[]; items: { id: string; code: string; to_code: string; name: string; from: string; account: string; qty: number; value: number }[];
  parents: { code: string; from: string | null; to: string | null }[]; links: number; unmapped: string[]; reclass: string | null; already: boolean };

/** names verbatim, the accounts off the list switched off (never deleted — a balance moves first with ONE dated reclass entry, old entries
 *  untouched), roles re-pointed, a stock item on an account off the list moved to the closest one with a new sub code; idempotent */
export async function clientChartV3(t: Db, user: SessionUser, apply: boolean): Promise<V3Plan> {
  const c = user.companyId;
  const have = await t<{ id: string; code: string; name_km: string; role: string | null; is_active: boolean; parent: string | null; bal: string }[]>`select a.id, a.code, a.name_km, a.role, a.is_active, a.parent_code as parent,
      coalesce((select sum(l.debit_cents - l.credit_cents) from journal_lines l where l.account_id = a.id), 0)::text as bal from accounts a where a.company_id = ${c} order by a.code`;
  const byCode = new Map(have.map((a) => [a.code, a]));
  const list = new Map(CLIENT_V3.map(([code, km, group]) => [code, { km, group }]));
  const plan: V3Plan = { created: [], renamed: [], reactivated: [], roles: [], off: [], items: [], parents: [], links: 0, unmapped: [], reclass: null, already: false };
  for (const [code, { km }] of list) {
    const a = byCode.get(code);
    if (!a) plan.created.push(code);
    else { if (a.name_km !== km) plan.renamed.push({ code, from: a.name_km, to: km }); if (!a.is_active) plan.reactivated.push(code); if (a.parent !== parentOf(code)) plan.parents.push({ code, from: a.parent, to: parentOf(code) }); }
  }
  for (const a of have) {
    if (list.has(a.code) || (!a.is_active && !a.role && Number(a.bal) === 0)) continue;
    const to = V3_MOVE[a.code] ?? null;
    if (!to && Number(a.bal) !== 0) { plan.unmapped.push(`${a.code} ${a.name_km} (balance ${a.bal}) — kept active`); continue; }
    plan.off.push({ code: a.code, name: a.name_km, to, balance: Number(a.bal) });
  }
  const roleNow = new Map(have.filter((a) => a.role).map((a) => [a.role!, a.code]));
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
    await t`insert into accounts (company_id, code, name_km, type, is_group, parent_code, sub_codes) values (${c}, ${code}, ${km}, ${typeOfCode(code)!}::account_type, ${group}, ${parentOf(code)}, ${isSubCodeAccount(code, group)})`;
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
  await t`update accounts set role = null where company_id = ${c} and role = any(${t.array(V3_ROLES.map(([r]) => r))})`;
  for (const [role, code] of V3_ROLES) if (code) await t`update accounts set role = ${role} where company_id = ${c} and code = ${code}`;
  for (const o of plan.off) if (o.to) await t`update catalog_items set income_account_id = case when income_account_id = ${id.get(o.code)!} then ${id.get(o.to)!}::uuid else income_account_id end,
      stock_link_account_id = case when stock_link_account_id = ${id.get(o.code)!} then ${id.get(o.to)!}::uuid else stock_link_account_id end where company_id = ${c}`;
  if (offCodes.length) await t`update accounts set is_active = false, role = null where company_id = ${c} and code = any(${t.array(offCodes)})`;
  for (const x of plan.items) await t`update catalog_items set code = ${x.to_code || null}, inventory_account_id = ${id.get(x.account)!} where id = ${x.id}`;
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
  for (const m of plan.unmapped) out.push(`  NOT MAPPED: ${m}`);
  out.push(apply ? "applied ✓" : "dry run only");
  return out;
}
