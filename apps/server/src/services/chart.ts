// The chart of accounts (CEO 12-10, D-141): One Team's own chart (Doc_Sup/00_Reference_Customer/COA.xlsx, sheet «Trial Balance») —
// 5-digit codes, the client's Khmer names exactly as written (an English name for the English screens, D-89). Group headers (10000,
// 11000, 12000, 13000, 13100, 20000, 21000, 30000, 40000, 50000) are never posted to; every other account is. BS / P&L by the code:
// 1x–3x balance sheet, 4x–5x income statement. Accounts with a role are used by the automatic postings (renamed yes, removed never).
// Accounts the system needs that the client's chart lacks are added with a free code in the right range and marked «បន្ថែមដោយប្រព័ន្ធ».
// Revenue: inside a borey → 40004 sales / 40005 service, else 40001 / 40002; other income 40006. Stock: each item has its own stock
// account (13001 …, 14000 copper pipe, 15000 insulation …; 18000 when none); job materials used → 50005, goods sold → 50001.
import type { Db } from "../db.js";
import { AppError } from "../lib/errors.js";

export type AccType = "asset" | "liability" | "equity" | "income" | "expense";
export type Role = "cash_usd" | "cash_khr" | "bank_aba" | "bank_acleda" | "ar" | "staff_advance" | "inventory" | "ap" | "deposits" | "tips" | "payroll"
  | "capital" | "drawings" | "retained" | "current_profit" | "opening" | "rev_service" | "rev_sales" | "rev_service_inside" | "rev_sales_inside" | "rev_other"
  | "discount" | "cogs" | "materials" | "stock_adjust" | "salaries" | "bonus" | "cash_diff";
/** [code, Khmer name (the client's), English name, type, role, "group" | "added"] */
export type ChartRow = [string, string, string, AccType, Role | null, ("group" | "added")?];

export const CHART: ChartRow[] = [
  ["10000", "ទ្រព្យ", "Assets", "asset", null, "group"],
  ["11000", "សាច់ប្រាក់", "Cash", "asset", null, "group"],
  ["11001", "សាច់ប្រាក់នៅបេលា", "Cash at the counter (USD)", "asset", "cash_usd"],
  ["11002", "សាច់ប្រាក់នៅធនាគា ACLEDA", "Bank – ACLEDA", "asset", "bank_acleda"],
  ["11003", "សាច់ប្រាក់នៅធនាគា ABA", "Bank – ABA", "asset", "bank_aba"],
  ["11004", "សាច់ប្រាក់រៀល", "Cash (KHR)", "asset", "cash_khr", "added"],
  ["12000", "គណនីត្រូវទទូលបាន​(គេជំពាក់យើង)", "Receivables", "asset", null, "group"],
  ["12001", "បុគ្គលិកជំពាក់", "Staff advances", "asset", "staff_advance"],
  ["12002", "អតិថិជនជំពាក់", "Customers owe us", "asset", "ar"],
  ["12003", "គណនីត្រូវទទូលផ្សេងៗ", "Other receivables", "asset", null],
  // D-165 (client 25-10, COA (4).xlsx): stock by product and brand — every stock account carries its own sub codes (13110 → 1311001 …)
  ["13000", "ស្តុកថ្មី", "New stock", "asset", null, "group"],
  ["13110", "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង Panasonic", "Wall AC Panasonic", "asset", null],
  ["13120", "ម៉ាស៊ីនត្រជាក់ជាប់ពិដាន Panasonic", "Ceiling AC Panasonic", "asset", null],
  ["13130", "ម៉ាស៊ីនត្រជាក់បញ្ឈរ Panasonic", "Floor-standing AC Panasonic", "asset", null],
  ["13210", "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង Daikin", "Wall AC Daikin", "asset", null],
  ["13220", "ម៉ាស៊ីនត្រជាក់ជាប់ពិដាន Daikin", "Ceiling AC Daikin", "asset", null],
  ["13230", "ម៉ាស៊ីនត្រជាក់បញ្ឈរ Daikin", "Floor-standing AC Daikin", "asset", null],
  ["13310", "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង LG", "Wall AC LG", "asset", null],
  ["13320", "ម៉ាស៊ីនត្រជាក់ជាប់ពិដាន LG", "Ceiling AC LG", "asset", null],
  ["13330", "ម៉ាស៊ីនត្រជាក់បញ្ឈរ LG", "Floor-standing AC LG", "asset", null],
  ["13810", "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង Gree", "Wall AC Gree", "asset", null], // the client's sheet repeats LG's 13310–13330 for Gree → 138x0
  ["13820", "ម៉ាស៊ីនត្រជាក់ជាប់ពិដាន Gree", "Ceiling AC Gree", "asset", null],
  ["13830", "ម៉ាស៊ីនត្រជាក់បញ្ឈរ Gree", "Floor-standing AC Gree", "asset", null],
  ["13400", "ទុយោស្ពាន់", "Copper pipe", "asset", null],
  ["13500", "ហ្គេនទុយោស្ពាន់", "Copper pipe insulation", "asset", null],
  ["13600", "ប្រអប់ខ្សែភ្លើង", "Electrical boxes", "asset", null],
  ["13700", "ខ្សែភ្លើង", "Electric wire", "asset", null],
  ["14100", "ម៉ាស៊ីនបោកខោអាវ", "Washing machines", "asset", null],
  ["14200", "ទូទឹកកក", "Refrigerators", "asset", null],
  ["14300", "ម៉ូទ័រជុំរុញទឹក", "Water pumps", "asset", null],
  ["14400", "(ឆ្នាំងបាយ,កង្ហា,ម៉ាស៊ីនទឹកក្តៅទឹកត្រជាក់....)", "Small appliances (rice cookers, fans, water dispensers…)", "asset", null],
  ["14500", "សម្ភារះសម្រាប់ជាងប្រប្រាស់", "Technicians' materials", "asset", "inventory"],
  ["18000", "ស្តុក Second hand", "Second-hand stock", "asset", null, "group"],
  ["18100", "ម៉ាស៊ីនត្រជាក់", "Air conditioners (second hand)", "asset", null],
  ["18200", "ម៉ាស៊ីនបោកខោអាវ", "Washing machines (second hand)", "asset", null],
  ["18300", "ទូទឹកកក", "Refrigerators (second hand)", "asset", null],
  ["18400", "ម៉ូទ័រជុំរុញទឹក", "Water pumps (second hand)", "asset", null],
  ["20000", "បំណុល", "Liabilities", "liability", null, "group"],
  ["20001", "ជំពាក់ថ្លៃម៉ាស៊ីនត្រជាក់", "Payable for air conditioners", "liability", null],
  ["20002", "ជំពាក់ម៉ាស៊ីនបោកក់", "Payable for washing machines", "liability", null],
  ["20003", "ជំពាក់ទៅអ្នកផ្គត់ផ្គង់ផ្សេងៗ", "Payable to other suppliers", "liability", "ap"],
  ["20004", "អតិថិជនកក់", "Customer deposits", "liability", "deposits"],
  ["20005", "ភ្ញៀវអោយធីបជាង", "Customer tips for technicians", "liability", "tips"],
  ["21000", "អត្ថប្រយោជន៍បន្ថែមទៅបុគ្គលិក", "Staff extra benefits", "liability", null, "group"],
  ["21001", "អត្ថប្រយោជន៍បន្ថែមទៅបុគ្គលិក", "Staff extra benefits payable", "liability", null],
  ["21002", "ប្រាក់ខែត្រូវបើក", "Salaries payable", "liability", "payroll", "added"],
  ["30000", "ដើមទុន", "Equity", "equity", null, "group"],
  ["30001", "ដើមទុនវិនិយោគ", "Invested capital", "equity", "capital"],
  ["30002", "ចំណេញ/​ខាត​(-) ក្នុងឆ្នាំ 2026", "Profit / loss (−) this year", "equity", "current_profit"],
  ["30003", "ចំណេញ/​ខាត​(-) ខែមុន 2023 and 2024,2025", "Profit / loss (−) earlier years", "equity", "retained"],
  ["30004", "មូលធនសមតុល្យដើម", "Opening balance equity", "equity", "opening", "added"],
  ["30005", "ការដកប្រើផ្ទាល់ខ្លួនរបស់ម្ចាស់", "Owner's drawings", "equity", "drawings", "added"],
  ["40000", "ចំណូល", "Income", "income", null, "group"],
  ["40001", "ចំណូលពីការលក់", "Sales", "income", "rev_sales"],
  ["40002", "ចំណូលពីការសេវាកម្ម", "Service income", "income", "rev_service"],
  ["40004", "ចំណូលពីការលក់ (ក្នុងបូរី)", "Sales (inside a borey)", "income", "rev_sales_inside"],
  ["40005", "ចំណូលពីការសេវាកម្ម (ក្នុងបូរី)", "Service income (inside a borey)", "income", "rev_service_inside"],
  ["40006", "ចំណូលផ្សេងៗ", "Other income", "income", "rev_other"],
  ["40007", "បញ្ចុះតម្លៃលក់", "Sales discounts", "income", "discount", "added"],
  ["50000", "ចំណាយ", "Expenses", "expense", null, "group"],
  ["50001", "ចំណាយទៅលើថ្លៃដើម", "Cost of goods sold", "expense", "cogs"],
  ["50002", "ចំណាយប្រាក់ខែបុគ្គលិក", "Staff salaries", "expense", "salaries"],
  ["50003", "អត្ថប្រយោជន៍បន្ថែមទៅបុគ្គលិក", "Staff extra benefits", "expense", "bonus"],
  ["50004", "ចំណាយសំរាប់សំភារៈការិយាល័យ", "Office supplies", "expense", null],
  ["50005", "សំភារះជាងប្រើប្រាស់", "Technicians' materials used", "expense", "materials"],
  ["50006", "ចំណាយជួល Office", "Office rent", "expense", null],
  ["50007", "ចំណាយទឹកភ្លើង", "Water and electricity", "expense", null],
  ["50008", "ចំណាយ​ជូសជុល Office", "Office repairs", "expense", null],
  ["50009", "ចំណាយទៅលើការផ្សោះផ្សាយ", "Advertising", "expense", null],
  ["50010", "ចំណាយ​ទៅលើកាធ្វើដំណើរ", "Travel", "expense", null],
  ["50011", "ចំណាយ​ផ្សេងៗ", "Other expenses", "expense", null],
  ["50012", "ខាត/ចំណេញ កែតម្រូវស្តុក", "Stock count differences", "expense", "stock_adjust", "added"],
  ["50013", "ខ្វះ/លើស សាច់ប្រាក់", "Cash over / short", "expense", "cash_diff", "added"],
];

/** Sheet2 of the client's COA.xlsx: copper pipe and pipe insulation sizes — stock items (not accounts) under 13400 / 13500 (codes = account + 2 digits, D-165) */
export const STOCK_ITEMS: [string, string, string][] = [
  ["1340001", "ទុយោស្ពាន់ 16mm (16*0.72)", "13400"],
  ["1340002", "ទុយោស្ពាន់ 12mm (12*0.72)", "13400"],
  ["1340003", "ទុយោស្ពាន់ 10mm (10*0.72)", "13400"],
  ["1340004", "ទុយោស្ពាន់ 6mm (6*0.72)", "13400"],
  ["1350001", "ហ្គេនទុយោស្ពាន់ (6*13)", "13500"],
  ["1350002", "ហ្គេនទុយោស្ពាន់ (6*19)", "13500"],
  ["1350003", "ហ្គេនទុយោស្ពាន់ (10*13)", "13500"],
  ["1350004", "ហ្គេនទុយោស្ពាន់ (10*19)", "13500"],
  ["1350005", "ហ្គេនទុយោស្ពាន់ (12*13)", "13500"],
  ["1350006", "ហ្គេនទុយោស្ពាន់ (13*13)", "13500"],
  ["1350007", "ហ្គេនទុយោស្ពាន់ (16*13)", "13500"],
  ["1350008", "ហ្គេនទុយោស្ពាន់ (16*19)", "13500"],
  ["1350009", "ហ្គេនទុយោស្ពាន់ (22*10)", "13500"],
  ["1350010", "ហ្គេនទុយោស្ពាន់ (28*10)", "13500"],
];

const GROUPS = CHART.filter((r) => r[5] === "group").map((r) => r[0]);
/** the group an account belongs to: the group whose code (without its trailing zeros) is the longest start of this code */
export function parentOf(code: string, groups: string[] = GROUPS): string | null {
  let best: string | null = null;
  for (const g of groups) {
    if (g === code) continue;
    const stem = g.replace(/0+$/, "");
    if (code.startsWith(stem) && (!best || stem.length > best.replace(/0+$/, "").length)) best = g;
  }
  return best;
}
/** the type follows the code's first digit (1 asset · 2 liability · 3 equity · 4 income · 5 expense) */
export const typeOfCode = (code: string): AccType | null => (({ 1: "asset", 2: "liability", 3: "equity", 4: "income", 5: "expense" }) as Record<string, AccType>)[code[0]!] ?? null;

/** D-142 → D-165 (the client 25-10): EVERY stock posting account carries sub codes — an item's code = the account code + 2 digits
 *  (13110 → 1311001, 1311002 …; 13400 → 1340001 …). An account switched to «no sub codes» IS its one item (code = the account code). */
export const isSubCodeAccount = (code: string, group = false): boolean => !group && /^1[348][0-9]{3}$/.test(code);
export const SUB_CODE_ACCOUNTS = CHART.filter((r) => isSubCodeAccount(r[0], r[5] === "group")).map((r) => r[0]);
/** D-143 → D-165: goods sold (air conditioners, appliances, second hand, the kept 13001) cost 50001; materials (copper, insulation, boxes, wire,
 *  technicians' materials, items without an account) cost 50005 */
export const isGoodsStockCode = (code: string | null | undefined): boolean => !!code && /^(130|13[1-3]|138|14[1-4]|18)/.test(code);
/** one stock item for every no-sub stock account (13001 … 13199) that has none yet: code = the account code, the account's name, tracked */
export async function ensureNoSubItems(db: Db, companyId: string): Promise<number> {
  const made = await db`insert into catalog_items (company_id, code, name_km, name_en, kind, category, unit, track_stock, is_stock, inventory_account_id)
    select a.company_id, a.code, a.name_km, a.name_en, 'product', 'mep', 'គ្រឿង', true, true, a.id
    from accounts a where a.company_id = ${companyId} and a.type = 'asset' and not a.is_group and not a.sub_codes and a.code ~ '^13[01][0-9]{2}$' and a.code !~ '00$'
      and not exists (select 1 from catalog_items ci where ci.company_id = a.company_id and ci.code = a.code) returning id`;
  await db`insert into stock_items (company_id, item_id) select ci.company_id, ci.id from catalog_items ci where ci.company_id = ${companyId} and ci.track_stock on conflict do nothing`;
  return made.length;
}

/** a new company gets the chart; a company that already has one keeps it (chart-replace swaps it while the books are empty) */
export async function insertChart(db: Db, companyId: string): Promise<void> {
  for (const [code, km, en, type, role, flag] of CHART)
    await db`insert into accounts (company_id, code, name_km, name_en, type, role, is_group, parent_code, added_by_system, sub_codes)
      values (${companyId}, ${code}, ${km}, ${en}, ${type}::account_type, ${role}, ${flag === "group"}, ${parentOf(code)}, ${flag === "added"}, ${isSubCodeAccount(code, flag === "group")}) on conflict do nothing`;
  await ensureNoSubItems(db, companyId);
}

/** the old chart's codes (D-88 template) → the new ones, by role — the mapping shown before a replace */
export const OLD_TO_NEW: Record<string, string> = {
  "1010": "11001", "1011": "11004", "1020": "11003", "1021": "11002", "1100": "12002", "1150": "12001", "1200": "18000", "2010": "20003", "2020": "20004",
  "2100": "21002", "3010": "30001", "3020": "30005", "3100": "30003", "3900": "30004", "4010": "40002 / 40005", "4020": "40001 / 40004", "4090": "40006",
  "4900": "40007", "5010": "50001 / 50005", "5020": "50012", "6010": "50002", "6020": "50003", "6030": "50010", "6040": "50006", "6050": "50007",
  "6070": "50008", "6080": "50004", "6100": "50009", "6900": "50011", "6950": "50013",
};

export type ReplacePlan = { remove: { code: string; name_km: string }[]; add: number; added_by_system: string[]; items_unlinked: number; stock_items: { code: string; name: string; exists: boolean }[]; draft_banks_dropped: string[] };
/** D-141: swap a company's chart for this one — only while the books hold no entry (all balances $0); the catalog's income accounts
 *  point nowhere afterwards (the borey rule decides), Sheet2's copper pipe / insulation sizes become stock items under 14000 / 15000 */
export async function replaceChart(t: Db, companyId: string, apply: boolean): Promise<ReplacePlan> {
  if ((await t`select 1 from journal_lines where company_id = ${companyId} limit 1`).length) throw new AppError("BOOKS_IN_USE", 409);
  const old = await t<{ code: string; name_km: string }[]>`select code, name_km from accounts where company_id = ${companyId} order by code`;
  const newCodes = new Set(CHART.map((r) => r[0]));
  const remove = old.filter((a) => !newCodes.has(a.code));
  const items_unlinked = (await t<{ n: number }[]>`select count(*)::int as n from catalog_items where company_id = ${companyId} and (income_account_id is not null or inventory_account_id is not null)`)[0]!.n;
  const existing = new Set((await t<{ code: string }[]>`select code from catalog_items where company_id = ${companyId} and code = any(${t.array(STOCK_ITEMS.map((s) => s[0]))})`).map((r) => r.code));
  const draft = (await t<{ d: { banks?: Record<string, number> } | null }[]>`select opening_draft as d from company_settings where company_id = ${companyId}`)[0]?.d ?? null;
  const draft_banks_dropped = Object.keys(draft?.banks ?? {}).filter((k) => k !== "aba" && k !== "acleda" && !newCodes.has(k));
  const plan: ReplacePlan = { remove, add: CHART.length, added_by_system: CHART.filter((r) => r[5] === "added").map((r) => `${r[0]} ${r[1]}`), items_unlinked,
    stock_items: STOCK_ITEMS.map(([code, name]) => ({ code, name, exists: existing.has(code) })), draft_banks_dropped };
  if (!apply) return plan;
  await t`update catalog_items set income_account_id = null, inventory_account_id = null where company_id = ${companyId}`;
  await t`delete from accounts where company_id = ${companyId}`;
  await insertChart(t, companyId);
  if (draft && draft_banks_dropped.length) {
    const banks = Object.fromEntries(Object.entries(draft.banks ?? {}).filter(([k]) => !draft_banks_dropped.includes(k)));
    await t`update company_settings set opening_draft = ${t.json({ ...draft, banks } as never)} where company_id = ${companyId}`;
  }
  const acc = new Map((await t<{ code: string; id: string }[]>`select code, id from accounts where company_id = ${companyId}`).map((a) => [a.code, a.id]));
  for (const [code, name, account] of STOCK_ITEMS) {
    if (existing.has(code)) await t`update catalog_items set inventory_account_id = ${acc.get(account)!}, track_stock = true where company_id = ${companyId} and code = ${code}`;
    else await t`insert into catalog_items (company_id, code, name_km, kind, category, unit, track_stock, is_stock, inventory_account_id)
      values (${companyId}, ${code}, ${name}, 'product', 'mep', 'ម៉ែត្រ', true, true, ${acc.get(account)!})`;
  }
  return plan;
}

/** D-165 (client 25-10): the 23-10 stock codes → the client's new ones. Accounts keep their id (items, links, moves and history stay);
 *  only the code / name / place change. Order matters: 18000 (technicians' materials) moves to 14500 before second hand takes 18000. */
export const V1_TO_V2: [string, string][] = [["18000", "14500"], ["13100", "18000"], ["13101", "18100"], ["13102", "18200"], ["13103", "18300"], ["13104", "18400"],
  ["14000", "13400"], ["15000", "13500"], ["16000", "13600"], ["17000", "13700"], ["13002", "14100"], ["13003", "14200"], ["13004", "14300"], ["13005", "14400"]];
export type UpdatePlan = { renamed: { from: string; to: string; name: string }[]; added: string[]; recoded: { from: string; to: string }[]; kept: string[]; already: boolean };
/** rename the accounts the client re-coded, add the ones the new sheet has, re-code the items under renamed sub-code accounts
 *  (14001 → 1340001 …), keep 13001 (the old generic air-conditioner stock, movements) switched off; idempotent */
export async function updateChartV2(t: Db, companyId: string, apply: boolean): Promise<UpdatePlan> {
  const have = new Map((await t<{ code: string; id: string; name_km: string; is_active: boolean }[]>`select code, id, name_km, is_active from accounts where company_id = ${companyId}`).map((a) => [a.code, a]));
  const rows = new Map(CHART.map((r) => [r[0], r]));
  const plan: UpdatePlan = { renamed: [], added: [], recoded: [], kept: [], already: false };
  // in order: 18000 → 14500 first frees 18000 for the 13100 group — a snapshot check would skip that pair
  const codes = new Set(have.keys()), renames: (readonly [string, string])[] = [];
  for (const [from, to] of V1_TO_V2) if (codes.has(from) && !codes.has(to)) { renames.push([from, to]); codes.delete(from); codes.add(to); }
  for (const [from, to] of renames) plan.renamed.push({ from, to, name: rows.get(to)![1] });
  for (const r of CHART) if (!have.has(r[0]) && !renames.some(([, to]) => to === r[0])) plan.added.push(r[0]);
  // items under a renamed sub-code account: the old code's number keeps its place (14001 → 1340001)
  for (const [from, to] of renames) {
    if (!isSubCodeAccount(to)) continue;
    const items = await t<{ id: string; code: string | null }[]>`select ci.id, ci.code from catalog_items ci join accounts a on a.id = ci.inventory_account_id where a.company_id = ${companyId} and a.code = ${from} order by ci.code`;
    items.forEach((it, i) => { const n = it.code && /^[0-9]+$/.test(it.code) ? Number(it.code.slice(from.replace(/0+$/, "").length)) || i + 1 : i + 1; plan.recoded.push({ from: it.code ?? "", to: `${to}${String(n).padStart(2, "0")}` }); });
  }
  if (have.get("13001")?.is_active && !rows.has("13001")) plan.kept.push("13001"); // once switched off the plan has nothing left to do
  plan.already = !plan.renamed.length && !plan.added.length && !plan.recoded.length && !plan.kept.length;
  if (!apply || plan.already) return plan;
  for (const [from, to] of renames) {
    const r = rows.get(to)!;
    await t`update accounts set code = ${to}, name_km = ${r[1]}, name_en = ${r[2]}, type = ${r[3]}::account_type, role = ${r[4]}, is_group = ${r[5] === "group"}, added_by_system = ${r[5] === "added"},
      sub_codes = ${isSubCodeAccount(to, r[5] === "group")}, is_active = true where company_id = ${companyId} and code = ${from}`;
  }
  for (const code of plan.added) { const r = rows.get(code)!;
    await t`insert into accounts (company_id, code, name_km, name_en, type, role, is_group, parent_code, added_by_system, sub_codes)
      values (${companyId}, ${code}, ${r[1]}, ${r[2]}, ${r[3]}::account_type, ${r[4]}, ${r[5] === "group"}, ${parentOf(code)}, ${r[5] === "added"}, ${isSubCodeAccount(code, r[5] === "group")}) on conflict do nothing`; }
  for (const a of await t<{ id: string; code: string }[]>`select id, code from accounts where company_id = ${companyId}`) await t`update accounts set parent_code = ${parentOf(a.code)} where id = ${a.id}`;
  await t`update accounts set sub_codes = true where company_id = ${companyId} and type = 'asset' and not is_group and code ~ '^1[348][0-9]{3}$' and code <> '13001'`;
  for (const x of plan.recoded) if (x.from) await t`update catalog_items set code = ${x.to} where company_id = ${companyId} and code = ${x.from}`;
  if (plan.kept.length) await t`update accounts set is_active = false, name_km = name_km || ' (មុន ២៥-១០)', name_en = coalesce(name_en, '') || ' (before 25-10)' where company_id = ${companyId} and code = '13001'`;
  return plan;
}
