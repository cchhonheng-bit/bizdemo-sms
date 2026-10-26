// D-178 (owner 26-10): the account mapping — which account each automatic posting uses. The shop's accounts are chosen by id in
// Accounting → Setup (CEO / CFO); no posting, report or screen decides by an account code. `group`: the key takes a group header
// (the stock accounts are the posting accounts under the two stock headers).
export type MapAccType = "asset" | "liability" | "equity" | "income" | "expense";
export type MapSection = "pay" | "people" | "income" | "cost" | "payables" | "stock" | "equity";
export type MapKeyDef = { key: string; section: MapSection; types: readonly MapAccType[]; group?: boolean };

export const ACCOUNT_MAP = [
  { key: "cash_usd", section: "pay", types: ["asset"] },
  { key: "cash_khr", section: "pay", types: ["asset"] },
  { key: "bank_aba", section: "pay", types: ["asset"] },
  { key: "bank_acleda", section: "pay", types: ["asset"] },
  { key: "ar", section: "people", types: ["asset"] },
  { key: "staff_advance", section: "people", types: ["asset"] },
  { key: "deposits", section: "people", types: ["liability"] },
  { key: "tips", section: "people", types: ["liability"] },
  { key: "payroll", section: "people", types: ["liability"] },
  { key: "rev_sales", section: "income", types: ["income"] },
  { key: "rev_sales_inside", section: "income", types: ["income"] },
  { key: "rev_service", section: "income", types: ["income"] },
  { key: "rev_service_inside", section: "income", types: ["income"] },
  { key: "rev_other", section: "income", types: ["income"] },
  { key: "cogs", section: "cost", types: ["expense"] },
  { key: "materials", section: "cost", types: ["expense"] },
  { key: "discount", section: "cost", types: ["expense", "income"] },
  { key: "salaries", section: "cost", types: ["expense"] },
  { key: "bonus", section: "cost", types: ["expense"] },
  { key: "stock_adjust", section: "cost", types: ["expense"] },
  { key: "cash_diff", section: "cost", types: ["expense"] },
  { key: "ap_ac", section: "payables", types: ["liability"] },
  { key: "ap_washing", section: "payables", types: ["liability"] },
  { key: "ap", section: "payables", types: ["liability"] },
  { key: "stock_new", section: "stock", types: ["asset"], group: true },
  { key: "stock_second_hand", section: "stock", types: ["asset"], group: true },
  { key: "inventory", section: "stock", types: ["asset"] },
  { key: "capital", section: "equity", types: ["equity"] },
  { key: "current_profit", section: "equity", types: ["equity"] },
  { key: "retained", section: "equity", types: ["equity"] },
  { key: "opening", section: "equity", types: ["equity"] },
  { key: "drawings", section: "equity", types: ["equity"] },
] as const satisfies readonly MapKeyDef[];
export type AccountMapKey = (typeof ACCOUNT_MAP)[number]["key"];
export const MAP_SECTIONS: readonly MapSection[] = ["pay", "people", "income", "cost", "payables", "stock", "equity"];
/** a stock receipt's supplier type → the payable it is owed on */
export const SUPPLIER_KINDS = ["ac", "washing", "other"] as const;
export type SupplierKind = (typeof SUPPLIER_KINDS)[number];
export const PAYABLE_KEY: Record<SupplierKind, AccountMapKey> = { ac: "ap_ac", washing: "ap_washing", other: "ap" };
