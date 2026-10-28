// D-183 (client 28-10): a debt's state — one rule for what a customer owes (an invoice) and what the shop owes a supplier, on every
// screen and download that lists debts: ជំពាក់សុទ្ធ (nothing paid yet) · ជំពាក់ខ្លះ (paid in part) · ទូទាត់ហើយ (paid in full).
export const PAY_STATUSES = ["unpaid", "partial", "paid"] as const;
export type PayStatus = (typeof PAY_STATUSES)[number];
export const payStatusOf = (total: number, paid: number): PayStatus => (paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid");
/** an account that holds people's debts (D-185): the customers' receivable, staff advances, and every liability (suppliers, customer
 *  deposits, tips and wages owed — each line names its person) — the status filter is offered on it even before it has a line */
export const isDebtAccount = (a: { type: string; mapped: readonly string[] }): boolean =>
  a.mapped.includes("ar") || a.mapped.includes("staff_advance") || a.type === "liability";
