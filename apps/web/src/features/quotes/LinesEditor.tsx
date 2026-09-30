// Price lines editor shared by quotes (FR-502) and invoices (FR-801/802): catalog pick or free line, qty, unit, unit price in $, live totals.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatKhr, formatUsd, fromCents } from "@sms/shared";
import { Plus, Trash2 } from "lucide-react";
import type { CatalogItem } from "@/lib/api";
import { Button, Field, Input, Select } from "@/components/ui";
import { lineCents, rowsTotal, type Row } from "./lines";

export function LinesEditor({ rows, setRows, catalog, fx, testId = "quote-total", footer }: {
  rows: Row[]; setRows: (f: (x: Row[]) => Row[]) => void; catalog: CatalogItem[]; fx: number; testId?: string; footer?: React.ReactNode;
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
  return (
    <>
      <div className="flex gap-2 mb-3">
        <Select value={pick} onChange={(e) => addItem(e.target.value)} className="flex-1" aria-label={t("quote.add_item")}>
          <option value="">{t("quote.add_item")}</option>
          {items.map((i) => <option key={i.id} value={i.id}>{i.name_km} · {t(`catalog.kind_${i.kind}`)}</option>)}
        </Select>
        <Button type="button" onClick={() => setRows((x) => [...x, { catalog_item_id: null, description: "", kind: "service", qty: "1", unit: "unit", price: "0" }])}><Plus size={16} /> {t("quote.free_line")}</Button>
      </div>
      {rows.length === 0 && <p className="text-sm text-muted">{t("quote.no_lines")}</p>}
      <ul className="space-y-3">
        {rows.map((r, i) => (
          <li key={i} className="border border-grey-line rounded-md p-3">
            <div className="flex gap-2 items-start">
              <div className="flex-1 min-w-0"><Input value={r.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={t("quote.description")} /></div>
              <button type="button" className="tap-target text-danger" aria-label="remove" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Trash2 size={18} /></button>
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
