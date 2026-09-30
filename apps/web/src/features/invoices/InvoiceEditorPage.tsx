// Invoice editor (Flow 4 · FR-801/802): /invoices/new?booking=<id> (lines prefilled from the reviewed job or the accepted quote),
// /invoices/new (direct sale: pick a customer) and /invoices/:id/edit (draft only). Prices by Admin / CEO (BR-10); no discount here (AC-05).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Search } from "lucide-react";
import { api, errCode, type Customer } from "@/lib/api";
import { ActionBar, Button, Card, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { LinesEditor } from "@/features/quotes/LinesEditor";
import { rowsInvalid, toLines, toRow, type Row } from "@/features/quotes/lines";

export default function InvoiceEditorPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const bookingId = sp.get("booking");
  const existing = useQuery({ queryKey: ["invoice", id], queryFn: () => api.invoices.get(id!), enabled: !!id });
  const pre = useQuery({ queryKey: ["invoice-prefill", bookingId], queryFn: () => api.invoices.prefill(bookingId!), enabled: !!bookingId && !id, retry: false });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const direct = !id && !bookingId;
  const customers = useQuery({ queryKey: ["customers"], queryFn: () => api.customers(), enabled: direct });
  const [rows, setRows] = useState<Row[]>([]);
  const [notes, setNotes] = useState("");
  const [cust, setCust] = useState<Customer | null>(null);
  const [q, setQ] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (existing.data) { setRows(existing.data.lines.map(toRow)); setNotes(existing.data.notes ?? ""); } }, [existing.data]);
  useEffect(() => { if (pre.data) setRows(pre.data.lines.map(toRow)); }, [pre.data]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return (customers.data ?? []).filter((c) => c.is_active && (c.name.toLowerCase().includes(s) || c.phones.some((p) => p.includes(s)))).slice(0, 8);
  }, [customers.data, q]);

  const fx = Number(existing.data?.fx_rate_khr ?? settings.data?.fx_rate_khr ?? 4100);
  const save = async () => {
    setSaving(true);
    try {
      const lines = toLines(rows);
      let target = id;
      if (id) await api.invoices.update(id, { lines, notes });
      else {
        const r = await api.invoices.create({ ...(bookingId ? { booking_id: bookingId } : { customer_id: cust!.id }), lines, notes });
        target = r.id; toast.success(t("invoice.created", { number: r.number }));
      }
      for (const k of [["invoice"], ["invoices"], ["invoice-for"], ["booking"]]) await qc.invalidateQueries({ queryKey: k });
      if (id) toast.success(t("app.saved"));
      nav(`/invoices/${target}`, { replace: true });
    } catch (e) { toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setSaving(false);
  };

  if ((id && existing.isLoading) || (bookingId && pre.isLoading) || catalog.isLoading) return <Skeleton />;
  if (pre.isError) return <ErrorState text={t(`invoice.err.${errCode(pre.error)}`, { defaultValue: t("app.error") })} />;
  const head = existing.data ?? pre.data;
  return (
    <div className="max-w-3xl space-y-4">
      <h1>{id ? `${t("app.edit")} ${existing.data?.number ?? ""}` : direct ? t("invoice.new_direct") : t("invoice.new")}</h1>
      {head && <p className="text-sm text-muted break-words">{[head.booking_number, head.customer_name, head.service_text].filter(Boolean).join(" · ")}</p>}
      {direct && (
        <Card title={t("booking.customer")}>
          {cust ? (
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><div className="font-semibold break-words">{cust.name}</div><div className="text-sm text-muted tabular">{cust.phones.join(", ") || "—"}</div></div>
              <Button type="button" onClick={() => setCust(null)}>{t("booking.change_customer")}</Button>
            </div>
          ) : (
            <div className="relative">
              <Search size={18} className="absolute left-3 top-[22px] -translate-y-1/2 text-muted" />
              <Input className="pl-10" type="search" inputMode="search" placeholder={t("booking.customer_search")} name="customer_search" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
              {matches.length > 0 && (
                <ul className="mt-1 card divide-y divide-grey-line max-h-72 overflow-auto overscroll-contain" role="listbox">
                  {matches.map((c) => <li key={c.id}><button type="button" className="w-full text-left px-3 py-3 min-h-[44px] hover:bg-grey-bg" onClick={() => { setCust(c); setQ(""); }}>
                    <span className="font-semibold">{c.name}</span> <span className="text-sm text-muted tabular">{c.phones[0] ?? ""}</span></button></li>)}
                </ul>
              )}
              {q && matches.length === 0 && !customers.isLoading && <p className="text-sm text-muted mt-2">{t("booking.customer_none")}</p>}
            </div>
          )}
        </Card>
      )}
      <Card title={t("quote.lines")}><LinesEditor rows={rows} setRows={setRows} catalog={catalog.data ?? []} fx={fx} testId="invoice-subtotal" /></Card>
      <Card><Field label={t("invoice.notes")}><textarea className="input h-20 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} /></Field></Card>
      <ActionBar>
        <Button type="button" onClick={() => nav(-1)}>{t("app.cancel")}</Button>
        <Button variant="primary" className="flex-1 sm:flex-none" disabled={rowsInvalid(rows) || (direct && !cust)} loading={saving} onClick={() => void save()} data-testid="invoice-save">{t("invoice.save_draft")}</Button>
      </ActionBar>
    </div>
  );
}
