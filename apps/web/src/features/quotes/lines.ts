// Price line rows (quote + invoice editors): string inputs ↔ API lines in cents.
import { fromCents, toCents } from "@sms/shared";
import type { QuoteLine } from "@/lib/api";

/** a unit the old default wrote («unit») is as good as none */
export const blankUnit = (u: string | null | undefined) => !u || u.trim() === "" || u === "unit";
/** D-196 (invoices): «text» = a description inside the price of the line above (a lump-sum job) · «heading» = a section heading */
export type RowType = "line" | "text" | "heading";
export type Row = { catalog_item_id: string | null; description: string; kind: "service" | "product"; qty: string; unit: string; price: string; row_type?: RowType };
export const plainRow = (r: { row_type?: RowType }) => r.row_type === "text" || r.row_type === "heading";
export const toRow = (l: QuoteLine): Row => ({ catalog_item_id: l.catalog_item_id, description: l.description, kind: l.kind, qty: l.qty === 1 && !blankUnit(l.unit) ? "1" : l.qty === 1 ? "" : String(l.qty), unit: blankUnit(l.unit) ? "" : l.unit, price: String(fromCents(l.unit_price)), row_type: l.row_type ?? "line" });
// D-152: quantity and unit are optional — a blank quantity counts as 1, a blank unit stays blank (nothing printed)
export const rowQty = (r: Row) => (r.qty.trim() === "" ? 1 : Number(r.qty));
/** a text / heading row goes without an amount; row_type is sent only for those (the quote API knows plain lines only) */
export const toLines = (rows: Row[]): QuoteLine[] => rows.map((r) => (plainRow(r)
  ? { catalog_item_id: null, description: r.description.trim(), kind: "service", qty: 1, unit: "", unit_price: 0, row_type: r.row_type }
  : { catalog_item_id: r.catalog_item_id, description: r.description.trim(), kind: r.kind, qty: rowQty(r), unit: r.unit.trim(), unit_price: toCents(r.price || 0) }));
export const lineCents = (r: Row) => { if (plainRow(r)) return 0; try { return Math.round(rowQty(r) * toCents(r.price || 0)); } catch { return NaN; } };
export const rowsTotal = (rows: Row[]) => rows.reduce((s, r) => s + (lineCents(r) || 0), 0);
export const rowsInvalid = (rows: Row[]) => rows.length === 0 || rows.some((r) => !r.description.trim() || (!plainRow(r) && (!(rowQty(r) > 0) || Number.isNaN(lineCents(r)) || Number(r.price) < 0)));
