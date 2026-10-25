// D-171: a report screen whose table IS the file — the same builder on the server answers the table (.json) and the file (.xlsx), with the
// same filters from the shared toolbar (date range · as-of · technicians · bookers · accounts with search and «ជ្រើសទាំងអស់»).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Empty, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { ReportToolbar } from "@/components/ReportToolbar";
import { exportUrl, type ExportParams, type ExportReport } from "@/components/ExportExcel";
import { SheetView, type XCell } from "@/components/SheetView";
import RangePicker from "./RangePicker";
import { presetRange, type Range } from "./range";
import { todayLocal } from "@/features/invoices/util";

export type Need = "range" | "asof" | "technician" | "booker" | "account";
type Preview = { title_km: string; title_en: string; filters: string[]; rows: number; sheets: { name: string; rows: XCell[][]; truncated: number }[] };
async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "same-origin" });
  if (!r.ok) { let code = `HTTP_${r.status}`; try { code = (await r.json())?.error ?? code; } catch { /* no body */ } throw new Error(code); }
  return (await r.json()) as T;
}

export function MultiPick({ label, options, value, onChange, testid }: { label: string; options: { id: string; name: string }[]; value: string[]; onChange: (v: string[]) => void; testid: string }) {
  const { t } = useTranslation();
  const [q, setQ] = useState("");
  const shown = useMemo(() => options.filter((o) => !q.trim() || o.name.toLowerCase().includes(q.trim().toLowerCase())), [options, q]);
  return (
    <div className="rounded-md border border-grey-line p-2 w-full sm:w-64 bg-white" data-testid={testid}>
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="text-sm font-semibold">{label} <span className="text-muted font-normal">· {value.length ? t("export.selected_n", { n: value.length }) : t("export.all")}</span></span>
        <button type="button" className="text-sm text-navy underline min-h-[36px]" onClick={() => onChange([])} data-testid={`${testid}-all`}>{t("export.pick_all")}</button>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("export.search")} autoComplete="off" />
      <ul className="max-h-36 overflow-y-auto mt-1 text-sm">
        {shown.map((o) => (
          <li key={o.id}><label className="flex items-center gap-2 min-h-[36px]"><input type="checkbox" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} /> <span className="break-words">{o.name}</span></label></li>
        ))}
        {!shown.length && <li className="text-muted py-2">—</li>}
      </ul>
    </div>
  );
}

export function ReportScreen({ report, needs }: { report: ExportReport; needs: Need[] }) {
  const { t, i18n } = useTranslation();
  const has = (n: Need) => needs.includes(n);
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const [asof, setAsof] = useState(todayLocal());
  const [technician, setTechnician] = useState<string[]>([]), [booker, setBooker] = useState<string[]>([]), [account, setAccount] = useState<string[]>([]);
  const [sheet, setSheet] = useState(0);
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic, enabled: has("technician") || has("booker") });
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts, enabled: has("account") });
  const techs = (users.data ?? []).filter((u) => u.role === "tech").map((u) => ({ id: u.id, name: u.full_name }));
  const bookers = (users.data ?? []).filter((u) => u.role !== "tech").map((u) => ({ id: u.id, name: u.full_name }));
  const accs = (accounts.data ?? []).filter((a) => !a.is_group).map((a) => ({ id: a.id, name: `${a.code} ${a.name_km}` }));
  const params: ExportParams = useMemo(() => ({ ...(has("range") ? { from: range[0], to: range[1] } : {}), ...(has("asof") ? { asof } : {}),
    ...(has("technician") ? { technician } : {}), ...(has("booker") ? { booker } : {}), ...(has("account") ? { account } : {}) }), [range, asof, technician, booker, account]); // eslint-disable-line react-hooks/exhaustive-deps
  const q = useQuery({ queryKey: ["report-preview", report, params], queryFn: () => getJson<Preview>(exportUrl(report, params).replace(/\.xlsx(\?|$)/, ".json$1")), retry: false });
  const active = technician.length + booker.length + account.length;
  const s = q.data?.sheets[Math.min(sheet, (q.data?.sheets.length ?? 1) - 1)];
  return (
    <>
      <ReportToolbar report={report} params={params} active={active}>
        {has("range") && <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />}
        {has("asof") && <Field label={t("export.asof")} hint={t("export.asof_hint")}><Input type="date" value={asof} max={todayLocal()} onChange={(e) => e.target.value && setAsof(e.target.value)} data-testid="report-asof" /></Field>}
        {has("technician") && <MultiPick label={t("export.technician")} options={techs} value={technician} onChange={setTechnician} testid="pick-technician" />}
        {has("booker") && <MultiPick label={t("export.booker")} options={bookers} value={booker} onChange={setBooker} testid="pick-booker" />}
        {has("account") && <MultiPick label={t("export.account")} options={accs} value={account} onChange={setAccount} testid="pick-account" />}
      </ReportToolbar>
      {q.isLoading ? <Skeleton /> : q.isError || !q.data || !s ? <ErrorState text={t(`export.err.${(q.error as Error | null)?.message ?? ""}`, { defaultValue: t("export.failed") })} onRetry={() => void q.refetch()} /> : (
        <Card title={i18n.language === "en" ? q.data.title_en : q.data.title_km}>
          {q.data.sheets.length > 1 && (
            <div className="flex overflow-x-auto rounded-md border border-grey-line text-sm mb-3" role="tablist">
              {q.data.sheets.map((x, i) => <button key={x.name} role="tab" aria-selected={i === sheet} className={`flex-1 shrink-0 whitespace-nowrap px-3 min-h-[40px] ${i === sheet ? "bg-navy text-white" : "bg-white"}`} onClick={() => setSheet(i)} data-testid={`sheet-tab-${i}`}>{x.name}</button>)}
            </div>
          )}
          <p className="text-xs text-muted mb-2" data-testid="report-filters">{q.data.filters.join(" · ")} · {t("export.rows_n", { n: q.data.rows })}</p>
          {!q.data.rows && s.rows.length <= 2 ? <Empty text={t("acct.nothing")} /> : null}
          <SheetView rows={s.rows} />
          {s.truncated > 0 && <p className="text-xs text-muted mt-2">{t("export.truncated", { n: s.truncated })}</p>}
        </Card>
      )}
    </>
  );
}
