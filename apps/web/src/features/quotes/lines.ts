// Price line rows (quote + invoice editors): string inputs ↔ API lines in cents.
import { fromCents, toCents } from "@sms/shared";
import type { QuoteLine } from "@/lib/api";

export type Row = { catalog_item_id: string | null; description: string; kind: "service" | "product"; qty: string; unit: string; price: string };
export const toRow = (l: QuoteLine): Row => ({ catalog_item_id: l.catalog_item_id, description: l.description, kind: l.kind, qty: String(l.qty), unit: l.unit, price: String(fromCents(l.unit_price)) });
export const toLines = (rows: Row[]): QuoteLine[] => rows.map((r) => ({ catalog_item_id: r.catalog_item_id, description: r.description.trim(), kind: r.kind, qty: Number(r.qty), unit: r.unit.trim() || "unit", unit_price: toCents(r.price || 0) }));
export const lineCents = (r: Row) => { try { return Math.round(Number(r.qty) * toCents(r.price || 0)); } catch { return NaN; } };
export const rowsTotal = (rows: Row[]) => rows.reduce((s, r) => s + (lineCents(r) || 0), 0);
export const rowsInvalid = (rows: Row[]) => rows.length === 0 || rows.some((r) => !r.description.trim() || !(Number(r.qty) > 0) || Number.isNaN(lineCents(r)) || Number(r.price) < 0);
