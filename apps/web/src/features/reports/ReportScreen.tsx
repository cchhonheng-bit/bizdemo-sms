// D-171: a report screen whose table IS the file — the same builder on the server answers the table (.json) and the file (.xlsx), with the
// same filters from the shared toolbar (date range · as-of · technicians · bookers · accounts with search and «ជ្រើសទាំងអស់»).
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Card, Empty, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { ReportToolbar } from "@/components/ReportToolbar";
import { exportUrl, type ExportParams, type ExportReport } from "@/components/ExportExcel";
import { SheetView, type XCell } from "@/components/SheetView";
import RangePicker from "./RangePicker";
import { presetRange, type Range } from "./range";
import { todayLocal } from "@/features/invoices/util";
import { isDebtAccount, type PayStatus } from "@sms/shared";
import { PayStatusSelect } from "@/components/PayStatusSelect";

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
  const base: ExportParams = useMemo(() => ({ ...(has("range") ? { from: range[0], to: range[1] } : {}), ...(has("asof") ? { asof } : {}),
    ...(has("technician") ? { technician } : {}), ...(has("booker") ? { booker } : {}), ...(has("account") ? { account } : {}) }), [range, asof, technician, booker, account]); // eslint-disable-line react-hooks/exhaustive-deps
  // D-183 · D-185 (client 28-10): the account report's own filters — each picked account gets the ones its lines support (the facets)
  const ledger = report === "account-report";
  const [lf, setLf] = useState<LedgerFilter>(NO_LEDGER_FILTER);
  const facets = useQuery({ queryKey: ["ledger-facets", base], queryFn: () => getJson<LedgerFacets>(exportUrl("account-report", base).replace("account-report.xlsx", "account-report/facets")),
    enabled: ledger && account.length > 0, retry: false });
  const debtOn = account.some((id) => { const a = accounts.data?.find((x) => x.id === id); return !!a && isDebtAccount(a); }) || !!facets.data?.debt;
  const pickAccounts = (v: string[]) => { setAccount(v); setLf((f) => ({ ...f, sources: [], party: [], items: [], booker: [], zone: "" })); }; // the choices follow the accounts
  const params: ExportParams = useMemo(() => (ledger ? { ...base, ...ledgerParams(lf, debtOn) } : base), [base, ledger, lf, debtOn]);
  const q = useQuery({ queryKey: ["report-preview", report, params], queryFn: () => getJson<Preview>(exportUrl(report, params).replace(/\.xlsx(\?|$)/, ".json$1")), retry: false });
  const active = technician.length + booker.length + account.length + (ledger ? ledgerActive(lf, debtOn) : 0);
  const s = q.data?.sheets[Math.min(sheet, (q.data?.sheets.length ?? 1) - 1)];
  return (
    <>
      <ReportToolbar report={report} params={params} active={active}>
        {has("range") && <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />}
        {has("asof") && <Field label={t("export.asof")} hint={t("export.asof_hint")}><Input type="date" value={asof} max={todayLocal()} onChange={(e) => e.target.value && setAsof(e.target.value)} data-testid="report-asof" /></Field>}
        {has("technician") && <MultiPick label={t("export.technician")} options={techs} value={technician} onChange={setTechnician} testid="pick-technician" />}
        {has("booker") && <MultiPick label={t("export.booker")} options={bookers} value={booker} onChange={setBooker} testid="pick-booker" />}
        {has("account") && <MultiPick label={t("export.account")} options={accs} value={account} onChange={pickAccounts} testid="pick-account" />}
        {ledger && <LedgerFilters value={lf} onChange={setLf} facets={account.length ? facets.data : undefined} debtOn={debtOn} />}
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

// ---------- D-185 (client 28-10): the account report's own filters ----------
/** what the picked accounts' lines support (server: accountFacets) — only those filters are shown */
type LedgerFacets = { debt: boolean; sources: string[]; zones: string[]; parties: { token: string; kind: "customer" | "staff" | "supplier"; name: string }[]; items: { id: string; name: string }[]; bookers: { id: string; name: string }[] };
type LedgerFilter = { paystatus: PayStatus | ""; dir: "" | "in" | "out"; sources: string[]; party: string[]; items: string[]; zone: "" | "inside" | "outside"; booker: string[]; q: string };
const NO_LEDGER_FILTER: LedgerFilter = { paystatus: "", dir: "", sources: [], party: [], items: [], zone: "", booker: [], q: "" };
const ledgerParams = (f: LedgerFilter, debtOn: boolean): ExportParams => ({ ...(debtOn && f.paystatus ? { paystatus: f.paystatus } : {}), ...(f.dir ? { dir: f.dir } : {}), sources: f.sources, party: f.party,
  items: f.items, ...(f.zone ? { zone: f.zone } : {}), booker: f.booker, ...(f.q.trim() ? { q: f.q.trim() } : {}) });
const ledgerActive = (f: LedgerFilter, debtOn: boolean) => [debtOn && f.paystatus, f.dir, f.zone, f.q.trim()].filter(Boolean).length + f.sources.length + f.party.length + f.items.length + f.booker.length;

/** every account: movement (debit / credit) and a search; then what its lines hold — the debt state (an account of people's debts, or
 *  lines tied to an invoice / a person: 12001 staff advances like 12002 customers), who (customers · staff · suppliers), the transaction
 *  types, the zone, the items, the bookers */
function LedgerFilters({ value, onChange, facets, debtOn }: { value: LedgerFilter; onChange: (f: LedgerFilter) => void; facets?: LedgerFacets; debtOn: boolean }) {
  const { t } = useTranslation();
  const set = (v: Partial<LedgerFilter>) => onChange({ ...value, ...v });
  const [text, setText] = useState(value.q);
  useEffect(() => { const h = setTimeout(() => { if (text !== value.q) onChange({ ...value, q: text }); }, 400); return () => clearTimeout(h); }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  const f = facets;
  return (<>
    {debtOn && <PayStatusSelect value={value.paystatus} onChange={(v) => set({ paystatus: v })} />}
    {!!f?.parties.length && <MultiPick label={t("export.party")} options={f.parties.map((p) => ({ id: p.token, name: `${p.name} · ${t(`export.party_kind.${p.kind}`)}` }))} value={value.party} onChange={(v) => set({ party: v })} testid="pick-party" />}
    <Field label={t("export.dir")}>
      <Select value={value.dir} onChange={(e) => set({ dir: e.target.value as LedgerFilter["dir"] })} data-testid="pick-dir">
        <option value="">{t("export.all")}</option><option value="in">{t("export.dir_in")}</option><option value="out">{t("export.dir_out")}</option>
      </Select>
    </Field>
    {(f?.sources.length ?? 0) > 1 && <MultiPick label={t("export.source")} options={f!.sources.map((s) => ({ id: s, name: t(`acct.source.${s}`, { defaultValue: s }) }))} value={value.sources} onChange={(v) => set({ sources: v })} testid="pick-source" />}
    {(f?.zones.length ?? 0) > 1 && (
      <Field label={t("export.zone")}>
        <Select value={value.zone} onChange={(e) => set({ zone: e.target.value as LedgerFilter["zone"] })} data-testid="pick-zone">
          <option value="">{t("export.all")}</option><option value="inside">{t("export.zone_inside")}</option><option value="outside">{t("export.zone_outside")}</option>
        </Select>
      </Field>
    )}
    {!!f?.items.length && <MultiPick label={t("export.item")} options={f.items} value={value.items} onChange={(v) => set({ items: v })} testid="pick-item" />}
    {!!f?.bookers.length && <MultiPick label={t("export.booker")} options={f.bookers} value={value.booker} onChange={(v) => set({ booker: v })} testid="pick-ledger-booker" />}
    <Field label={t("export.q")}><Input type="search" autoComplete="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={t("export.q_hint")} data-testid="ledger-q" /></Field>
  </>);
}
