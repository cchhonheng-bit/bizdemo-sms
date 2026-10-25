// `node dist/cli.mjs chart-replace <slug> [--apply]` (CEO 12-10, D-141): the shop's chart of accounts becomes chart.ts (One Team's own
// chart) — only while its books hold no entry. Dry run first (the plan: accounts removed / added, the accounts the system adds, the
// stock items of Sheet2, catalog links cleared); --apply writes it in one transaction, audited as the shop's HangKH Support account.
import { sql, tx } from "../db.js";
import { audit } from "./audit.js";
import { CHART, OLD_TO_NEW, replaceChart, updateChartV2 } from "./chart.js";

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
