// Quote editor (Flow 3 · FR-502): lines from the catalog (or free text), qty, unit price in $, live totals ($ + ៛ reference).
// /quotes/new?booking=<id> and /quotes/:id/edit — mobile-first cards, sticky save bar.
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, fromCents, toCents } from "@sms/shared";
import { Plus, Trash2 } from "lucide-react";
import { api, errCode, type QuoteLine } from "@/lib/api";
import { ActionBar, Button, Card, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

type Row = { catalog_item_id: string | null; description: string; kind: "service" | "product"; qty: string; unit: string; price: string };
const toRow = (l: QuoteLine): Row => ({ catalog_item_id: l.catalog_item_id, description: l.description, kind: l.kind, qty: String(l.qty), unit: l.unit, price: String(fromCents(l.unit_price)) });

export default function QuoteEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const bookingId = sp.get("booking");
  const existing = useQuery({ queryKey: ["quote", id], queryFn: () => api.quotes.get(id!), enabled: !!id });
  const booking = useQuery({ queryKey: ["booking", bookingId ?? existing.data?.booking_id], queryFn: () => api.booking((bookingId ?? existing.data?.booking_id)!), enabled: !!(bookingId ?? existing.data?.booking_id) });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState("");
  const [validDays, setValidDays] = useState("15");
  const [pick, setPick] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (existing.data) { setRows(existing.data.lines.map(toRow)); setNotes(existing.data.notes ?? ""); } }, [existing.data]);

  const items = useMemo(() => (catalog.data ?? []).filter((i) => i.is_active), [catalog.data]);
  const fx = Number(existing.data?.fx_rate_khr ?? settings.data?.fx_rate_khr ?? 4100);
  const lineCents = (r: Row) => { try { return Math.round(Number(r.qty) * toCents(r.price || 0)); } catch { return NaN; } };
  const total = rows.reduce((s, r) => s + (lineCents(r) || 0), 0);
  const invalid = rows.length === 0 || rows.some((r) => !r.description.trim() || !(Number(r.qty) > 0) || Number.isNaN(lineCents(r)) || Number(r.price) < 0);

  const addItem = (itemId: string) => {
    const it = items.find((i) => i.id === itemId);
    if (!it) return;
    setRows((x) => [...x, { catalog_item_id: it.id, description: it.name_km, kind: it.kind, qty: "1", unit: it.unit, price: String(fromCents(it.sell_price ?? 0)) }]);
    setPick("");
  };
  const set = (i: number, patch: Partial<Row>) => setRows((x) => x.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const save = async () => {
    setSaving(true);
    const lines: QuoteLine[] = rows.map((r) => ({ catalog_item_id: r.catalog_item_id, description: r.description.trim(), kind: r.kind, qty: Number(r.qty), unit: r.unit.trim() || "unit", unit_price: toCents(r.price || 0) }));
    try {
      const done = async () => { for (const k of [["quote"], ["quote-for"], ["quotes"], ["booking"], ["bookings"]]) await qc.invalidateQueries({ queryKey: k }); };
      if (id) { await api.quotes.update(id, { lines, notes }); await done(); toast.success(t("app.saved")); nav(`/bookings/${existing.data!.booking_id}`); }
      else { const r = await api.quotes.create({ booking_id: bookingId!, lines, notes, valid_days: Number(validDays) || null }); await done(); toast.success(t("quote.created", { number: r.number })); nav(`/bookings/${bookingId}`, { replace: true }); }
    } catch (e) { toast.error(t(`quote.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setSaving(false);
  };

  if ((id && existing.isLoading) || catalog.isLoading) return <Skeleton />;
  return (
    <div className="max-w-3xl space-y-4">
      <h1>{id ? `${t("app.edit")} ${existing.data?.number ?? ""}` : t("quote.new")}</h1>
      {booking.data && <p className="text-sm text-muted break-words">{booking.data.number} · {booking.data.customer_name} · {booking.data.service_text}</p>}
      <Card title={t("quote.lines")}>
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
          <span className="text-right"><span className="text-xl font-bold tabular" data-testid="quote-total">{formatUsd(total)}</span><br /><span className="text-xs text-muted tabular">≈ {formatKhr(Math.round(fromCents(total) * fx))}</span></span>
        </div>
      </Card>
      <Card>
        <Field label={t("quote.notes")}><textarea className="input h-20 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        {!id && <Field label={t("quote.valid_days")}><Input inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value)} className="!w-28" /></Field>}
      </Card>
      <ActionBar>
        <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
        <Button variant="primary" className="flex-1 sm:flex-none" disabled={invalid} loading={saving} onClick={() => void save()} data-testid="quote-save">{id ? t("app.save") : t("quote.issue")}</Button>
      </ActionBar>
    </div>
  );
}
