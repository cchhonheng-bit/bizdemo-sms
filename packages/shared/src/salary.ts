// D-187 (owner 29-10): a person's salary, set on the user form or the payroll screen — base and fixed allowance in US cents, the pay
// method (→ the account map's cash / bank account), the start day, the day a change takes effect, a note.
import { z } from "zod";

export const PAY_METHOD_KEYS = ["cash_usd", "cash_khr", "aba", "acleda"] as const;
export type PayMethodKey = (typeof PAY_METHOD_KEYS)[number];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const salaryInputSchema = z.object({
  base_salary: z.number().int().min(0).max(100_000_000),
  allowance: z.number().int().min(0).max(100_000_000).optional(),
  pay_method: z.enum(PAY_METHOD_KEYS).optional(),
  start_date: day.nullable().optional(),
  effective_from: day.nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
}).strict();
export type SalaryInput = z.infer<typeof salaryInputSchema>;
