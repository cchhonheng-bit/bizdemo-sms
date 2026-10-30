// Price lines editor shared by quotes (FR-502) and invoices (FR-801/802): catalog pick or free line, qty, unit, unit price in $, live totals.
// D-196 (invoices, `rich`): the client's Excel — text rows inside the price of the line above (a lump-sum job) and section headings; rows move up / down.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatKhr, formatUsd, fromCents } from "@sms/shared";
import { AlignLeft, ArrowDown, ArrowUp, Plus, Trash2, Type } from "lucide-react";
import type { CatalogItem } from "@/lib/api";
import { Button, Field, Input, Select } from "@/components/ui";
import { lineCents, rowsTotal, type Row, type RowType } from "./lines";

export function LinesEditor({ rows, setRows, catalog, fx, testId = "quote-total", footer, rich = false }: {
  rows: Row[]; setRows: (f: (x: Row[]) => Row[]) => void; catalog: CatalogItem[]; fx: number; testId?: string; footer?: React.ReactNode; rich?: boolean;
}) {
  const { t } = useTranslation();
  const [pick, setPick] = useState("");
  const items = useMemo(() => catalog.filter((i) => i.is_active), [catalog]);
  const total = rowsTotal(rows);
  const addItem = (itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    if (!it) return;
    setRows((x) => [...x, { catalog_item_id: it.id, description: it.name_km, kind: it.kind, qty: "1", unit: it.unit, price: String(fromCents(it.sell_price ?? 0)) }]);
    setPick("");
  };
  const set = (i: number, patch: Partial<Row>) => setRows((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: -1 | 1) => setRows((x) => { const j = i + by; if (j < 0 || j >= x.length) return x; const y = [...x]; [y[i], y[j]] = [y[j]!, y[i]!]; return y; });
  const addPlain = (row_type: RowType) => setRows((x) => [...x, { catalog_item_id: null, description: "", kind: "service", qty: "", unit: "", price: "0", row_type }]);
  const tools = (i: number) => (
    <>
      {rich && <button type="button" className="tap-target text-muted disabled:opacity-30" disabled={i === 0} aria-label={t("quote.move_up")} onClick={() => move(i, -1)}><ArrowUp size={18} /></button>}
      {rich && <button type="button" className="tap-target text-muted disabled:opacity-30" disabled={i === rows.length - 1} aria-label={t("quote.move_down")} onClick={() => move(i, 1)}><ArrowDown size={18} /></button>}
      <button type="button" className="tap-target text-danger" aria-label="remove" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 size={18} /></button>
    </>
  );
  return (
    <>
      <div className="flex flex-wrap gap-2 mb-3">
        <Select value={pick} onChange={(e) => addItem(e.target.value)} className="flex-1 min-w-[12rem]" aria-label={t("quote.add_item")}>
          <option value="">{t("quote.add_item")}</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name_km} · {t(`catalog.kind_${i.kind}`)}</option>)}
        </Select>
        {/* D-184 (client 28-10): a free line says what it is when added — a service or goods (its revenue account follows) */}
        {(["service", "product"] as const).map((kind) => (
          <Button key={kind} type="button" onClick={() => setRows((x) => [...x, { catalog_item_id: null, description: "", kind, qty: "1", unit: "unit", price: "0" }])} data-testid={`free-${kind}`}>
            <Plus size={16} /> {t(kind === "service" ? "quote.free_service" : "quote.free_goods")}
          </Button>
        ))}
        {rich && <Button type="button" onClick={() => addPlain("text")} data-testid="add-text-row"><AlignLeft size={16} /> {t("quote.add_text")}</Button>}
        {rich && <Button type="button" onClick={() => addPlain("heading")} data-testid="add-heading-row"><Type size={16} /> {t("quote.add_heading")}</Button>}
      </div>
      {rich && <p className="text-xs text-muted mb-2">{t("quote.rows_hint")}</p>}
      {rows.length === 0 && <p className="text-sm text-muted">{t("quote.no_lines")}</p>}
      <ul className="space-y-3">
        {rows.map((r, i) => r.row_type === "heading" || r.row_type === "text" ? (
          <li key={i} className={`border rounded-md p-3 ${r.row_type === "heading" ? "border-warning bg-warning-50" : "border-dashed border-grey-line ml-4"}`} data-testid={`row-${r.row_type}`}>
            <div className="text-xs text-muted mb-1">{t(r.row_type === "heading" ? "quote.heading_row" : "quote.text_row")}</div>
            <div className="flex gap-1 items-start">
              <div className="flex-1 min-w-0"><Input value={r.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={t("quote.description")} className={r.row_type === "heading" ? "font-semibold text-center" : ""} /></div>
              {tools(i)}
            </div>
          </li>
        ) : (
          <li key={i} className="border border-grey-line rounded-md p-3">
            <div className="flex gap-1 items-start">
              <div className="flex-1 min-w-0"><Input value={r.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={t("quote.description")} /></div>
              {tools(i)}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-2">
              <Field label={t("quote.kind")}><Select value={r.kind} onChange={(e) => set(i, { kind: e.target.value as Row["kind"] })}><option value="service">{t("catalog.kind_service")}</option><option value="product">{t("catalog.kind_product")}</option></Select></Field>
              <Field label={t("quote.qty")}><Input inputMode="decimal" value={r.qty} onChange={(e) => set(i, { qty: e.target.value })} /></Field>
              <Field label={t("catalog.unit")}><Input value={r.unit} onChange={(e) => set(i, { unit: e.target.value })} /></Field>
              <Field label={t("quote.unit_price")}><Input inputMode="decimal" value={r.price} onChange={(e) => set(i, { price: e.target.value })} /></Field>
            </div>
            <div className="text-right text-sm font-semibold tabular">{Number.isNaN(lineCents(r)) ? "—" : formatUsd(lineCents(r))}</div>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex justify-between items-baseline border-t border-grey-line pt-3">
        <span className="font-bold">{t("quote.total")}</span>
        <span className="text-right"><span className="text-xl font-bold tabular" data-testid={testId}>{formatUsd(total)}</span><br /><span className="text-xs text-muted tabular">≈ {formatKhr(Math.round(fromCents(total) * fx))}</span></span>
      </div>
      {footer}
    </>
  );
}
