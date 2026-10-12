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
  ["13000", "ស្តុកថ្មី", "New stock", "asset", null, "group"],
  ["13001", "ម៉ាស៊ីនត្រជាក់", "Air conditioners", "asset", null],
  ["13002", "ម៉ាស៊ីនបោកខោអាវ", "Washing machines", "asset", null],
  ["13003", "ទូទឹកកក", "Refrigerators", "asset", null],
  ["13004", "ម៉ូទ័រជុំរុញទឹក", "Water pumps", "asset", null],
  ["13005", "(ឆ្នាំងបាយ,កង្ហា,ម៉ាស៊ីនទឹកក្តៅទឹកត្រជាក់....)", "Small appliances (rice cookers, fans, water dispensers…)", "asset", null],
  ["13100", "ស្តុក Second hand", "Second-hand stock", "asset", null, "group"],
  ["13101", "ម៉ាស៊ីនត្រជាក់", "Air conditioners (second hand)", "asset", null],
  ["13102", "ម៉ាស៊ីនបោកខោអាវ", "Washing machines (second hand)", "asset", null],
  ["13103", "ទូទឹកកក", "Refrigerators (second hand)", "asset", null],
  ["13104", "ម៉ូទ័រជុំរុញទឹក", "Water pumps (second hand)", "asset", null],
  ["14000", "ទុយោស្ពាន់", "Copper pipe", "asset", null],
  ["15000", "ហ្គេនទុយោស្ពាន់", "Copper pipe insulation", "asset", null],
  ["16000", "ប្រអប់ខ្សែភ្លើង", "Electrical boxes", "asset", null],
  ["17000", "ខ្សែភ្លើង", "Electric wire", "asset", null],
  ["18000", "សម្ភារះសម្រាប់ជាងប្រប្រាស់", "Technicians' materials", "asset", "inventory"],
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

/** Sheet2 of the client's COA.xlsx: copper pipe and pipe insulation sizes — stock items (not accounts) under 14000 / 15000 */
export const STOCK_ITEMS: [string, string, string][] = [
  ["14001", "ទុយោស្ពាន់ 16mm (16*0.72)", "14000"],
  ["14002", "ទុយោស្ពាន់ 12mm (12*0.72)", "14000"],
  ["14003", "ទុយោស្ពាន់ 10mm (10*0.72)", "14000"],
  ["14004", "ទុយោស្ពាន់ 6mm (6*0.72)", "14000"],
  ["15001", "ហ្គេនទុយោស្ពាន់ (6*13)", "15000"],
  ["15002", "ហ្គេនទុយោស្ពាន់ (6*19)", "15000"],
  ["15003", "ហ្គេនទុយោស្ពាន់ (10*13)", "15000"],
  ["15004", "ហ្គេនទុយោស្ពាន់ (10*19)", "15000"],
  ["15005", "ហ្គេនទុយោស្ពាន់ (12*13)", "15000"],
  ["15006", "ហ្គេនទុយោស្ពាន់ (13*13)", "15000"],
  ["15007", "ហ្គេនទុយោស្ពាន់ (16*13)", "15000"],
  ["15008", "ហ្គេនទុយោស្ពាន់ (16*19)", "15000"],
  ["15009", "ហ្គេនទុយោស្ពាន់ (22*10)", "15000"],
  ["15010", "ហ្គេនទុយោស្ពាន់ (28*10)", "15000"],
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

/** a new company gets the chart; a company that already has one keeps it (chart-replace swaps it while the books are empty) */
export async function insertChart(db: Db, companyId: string): Promise<void> {
  for (const [code, km, en, type, role, flag] of CHART)
    await db`insert into accounts (company_id, code, name_km, name_en, type, role, is_group, parent_code, added_by_system)
      values (${companyId}, ${code}, ${km}, ${en}, ${type}::account_type, ${role}, ${flag === "group"}, ${parentOf(code)}, ${flag === "added"}) on conflict do nothing`;
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
    else await t`insert into catalog_items (company_id, code, name_km, kind, category, unit, track_stock, inventory_account_id)
      values (${companyId}, ${code}, ${name}, 'product', 'mep', 'ម៉ែត្រ', true, ${acc.get(account)!})`;
  }
  return plan;
}
