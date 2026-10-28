// Business events → accounting (D-86 / Part C). Every money flow calls one of these hooks inside its own transaction.
// The accounting module registers a handler per event; while the "accounting" flag is off for the shop nothing is posted.
import type { Db } from "../db.js";
import type { SessionUser } from "./auth.js";

export type SourceKind = "invoice" | "payment" | "deposit" | "stock" | "cash_close" | "payroll" | "other" | "supplier_pay";
export type LedgerEvent =
  | { kind: "deposit"; id: string; method: string; usd_cents: number; fx: number; date: string }
  | { kind: "deposit_applied"; payment_id: string; usd_cents: number; fx: number }
  | { kind: "payment"; id: string; method: string; usd_cents: number; fx: number; date: string }
  | { kind: "invoice_issue"; invoice_id: string; date?: string }
  | { kind: "invoice_line_kind"; invoice_id: string; amount: number; from: string; to: string; line: string } // D-184
  | { kind: "reverse"; source: SourceKind; id: string; memo: string }
  | { kind: "stock"; move_ids: number[] }
  | { kind: "cash_close"; day: string; diff_usd: number; diff_khr: number }
  | { kind: "supplier_pay"; id: string; supplier: string; usd_cents: number; method: string; fx: number; date: string; khr: number | null; note: string | null; account?: string | null }; // D-167 · D-181 the debt account picked

type Handler = (t: Db, u: SessionUser, e: LedgerEvent) => Promise<void>;
let handler: Handler | null = null;
let enabled: () => boolean = () => false;
/** Part C: the accounting module plugs in here (and says when it is on) */
export function registerLedger(h: Handler, isOn: () => boolean): void { handler = h; enabled = isOn; }

async function emit(t: Db, u: SessionUser, e: LedgerEvent): Promise<void> {
  if (handler && enabled()) await handler(t, u, e);
}
export const postDeposit = (t: Db, u: SessionUser, d: { id: string; method: string; usd_cents: number; fx: number; date: string }) => emit(t, u, { kind: "deposit", ...d });
export const postDepositApplied = (t: Db, u: SessionUser, p: { payment_id: string; usd_cents: number; fx: number }) => emit(t, u, { kind: "deposit_applied", ...p });
export const postPayment = (t: Db, u: SessionUser, p: { id: string; method: string; usd_cents: number; fx: number; date: string }) => emit(t, u, { kind: "payment", ...p });
export const postInvoiceIssue = (t: Db, u: SessionUser, invoiceId: string, date?: string) => emit(t, u, { kind: "invoice_issue", invoice_id: invoiceId, date });
/** D-184: a line of an issued invoice changed between service and goods — its revenue moves to the other income account */
export const postInvoiceLineKind = (t: Db, u: SessionUser, p: { invoice_id: string; amount: number; from: string; to: string; line: string }) => emit(t, u, { kind: "invoice_line_kind", ...p });
/** reverse every posted entry of a business record (void invoice / payment / deposit, cancelled stock move …) */
export const reverseSource = (t: Db, u: SessionUser, source: SourceKind, id: string, memo: string) => emit(t, u, { kind: "reverse", source, id, memo });
export const postStock = (t: Db, u: SessionUser, moveIds: number[]) => emit(t, u, { kind: "stock", move_ids: moveIds });
export const postSupplierPay = (t: Db, u: SessionUser, p: { id: string; supplier: string; usd_cents: number; method: string; fx: number; date: string; khr: number | null; note: string | null; account?: string | null }) => emit(t, u, { kind: "supplier_pay", ...p });
export const postCashClose = (t: Db, u: SessionUser, c: { day: string; diff_usd: number; diff_khr: number }) => emit(t, u, { kind: "cash_close", ...c });
