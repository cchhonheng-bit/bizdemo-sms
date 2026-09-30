// Quote editor (Flow 3 · FR-502): lines from the catalog (or free text), qty, unit price in $, live totals ($ + ៛ reference).
// /quotes/new?booking=<id> and /quotes/:id/edit — mobile-first cards, sticky save bar.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, errCode } from "@/lib/api";
import { ActionBar, Button, Card, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { LinesEditor } from "./LinesEditor";
import { rowsInvalid, toLines, toRow, type Row } from "./lines";

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
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (existing.data) { setRows(existing.data.lines.map(toRow)); setNotes(existing.data.notes ?? ""); } }, [existing.data]);

  const fx = Number(existing.data?.fx_rate_khr ?? settings.data?.fx_rate_khr ?? 4100);
  const save = async () => {
    setSaving(true);
    const lines = toLines(rows);
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
      <Card title={t("quote.lines")}><LinesEditor rows={rows} setRows={setRows} catalog={catalog.data ?? []} fx={fx} /></Card>
      <Card>
        <Field label={t("quote.notes")}><textarea className="input h-20 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field>
        {!id && <Field label={t("quote.valid_days")}><Input inputMode="numeric" value={validDays} onChange={(e) => setValidDays(e.target.value)} className="!w-28" /></Field>}
      </Card>
      <ActionBar>
        <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
        <Button variant="primary" className="flex-1 sm:flex-none" disabled={rowsInvalid(rows)} loading={saving} onClick={() => void save()} data-testid="quote-save">{id ? t("app.save") : t("quote.issue")}</Button>
      </ActionBar>
    </div>
  );
}
