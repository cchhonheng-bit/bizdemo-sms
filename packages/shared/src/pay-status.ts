// D-183 (client 28-10): a debt's state — one rule for what a customer owes (an invoice) and what the shop owes a supplier, on every
// screen and download that lists debts: ជំពាក់សុទ្ធ (nothing paid yet) · ជំពាក់ខ្លះ (paid in part) · ទូទាត់ហើយ (paid in full).
export const PAY_STATUSES = ["unpaid", "partial", "paid"] as const;
export type PayStatus = (typeof PAY_STATUSES)[number];
export const payStatusOf = (total: number, paid: number): PayStatus => (paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid");
/** liabilities that are not a supplier's debt (customer deposits, tips, wages owed) */
const NOT_SUPPLIER_DEBT = ["deposits", "tips", "payroll"];
/** an account whose lines belong to a debt — the customers' receivable or a supplier's payable: the status filter applies to it */
export const isDebtAccount = (a: { type: string; mapped: readonly string[] }): boolean =>
  a.mapped.includes("ar") || (a.type === "liability" && !a.mapped.some((k) => NOT_SUPPLIER_DEBT.includes(k)));
