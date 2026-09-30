// C5 reports: profit & loss (period), balance sheet and trial balance (as of a date) — USD with KHR at the rate of that date,
// Excel (CSV) download; tap an account → its general ledger.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import { api, type AcctRow } from "@/lib/api";
import { Card, Empty, Field, Input, Skeleton } from "@/components/ui";
import RangePicker from "@/features/reports/RangePicker";
import { presetRange, type Range } from "@/features/reports/range";
import { todayLocal } from "@/features/invoices/util";
import { Amount } from "./common";
import { signedUsd, useAccName } from "./acct";
import { LedgerDialog } from "./Accounts";

type View = "pl" | "bs" | "tb";

export default function Reports() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("pl");
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const [asOf, setAsOf] = useState(todayLocal());
  const [ledgerOf, setLedgerOf] = useState<AcctRow | null>(null);
  return (
    <>
      <div className="grid grid-cols-3 rounded-md border border-grey-line overflow-hidden text-sm" role="tablist">
        {(["pl", "bs", "tb"] as View[]).map((k) => <button key={k} role="tab" aria-selected={view === k} data-testid={`rep-${k}`} className={`px-2 min-h-[44px] ${view === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView(k)}>{t(`acct.rep.${k}`)}</button>)}
      </div>
      <Card>
        {view === "pl" ? <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />
          : <Field label={t("acct.as_of")}><Input type="date" value={asOf} max={todayLocal()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></Field>}
      </Card>
      {view === "pl" ? <PL from={range[0]} to={range[1]} onPick={setLedgerOf} /> : view === "bs" ? <BS to={asOf} onPick={setLedgerOf} /> : <TB to={asOf} onPick={setLedgerOf} />}
      {ledgerOf && <LedgerDialog account={{ id: ledgerOf.account_id, code: ledgerOf.code, name_km: ledgerOf.name_km, name_en: ledgerOf.name_en }}
        range={view === "pl" ? range : [asOf.slice(0, 8) + "01", asOf]} onClose={() => setLedgerOf(null)} />}
    </>
  );
}

function Rows({ rows, fx, onPick }: { rows: AcctRow[]; fx: number; onPick: (r: AcctRow) => void }) {
  const name = useAccName();
  return (
    <ul className="divide-y divide-grey-line">
      {rows.map((r) => (
        <li key={r.account_id}>
          <button className="w-full flex justify-between gap-3 py-2 min-h-[44px] text-left text-sm" onClick={() => onPick(r)}>
            <span className="min-w-0 break-words">{name(r)}</span><Amount cents={r.amount} fx={fx} />
          </button>
        </li>
      ))}
    </ul>
  );
}
function Total({ label, cents, khr, big, testid }: { label: string; cents: number; khr: number; big?: boolean; testid?: string }) {
  return (
    <div className={`flex justify-between gap-3 pt-2 mt-1 border-t-2 border-grey-line ${big ? "text-lg" : ""}`} data-testid={testid}>
      <span className="font-semibold">{label}</span>
      <span className="text-right tabular"><span className="font-bold">{signedUsd(cents)}</span><span className="block text-xs text-muted">{formatKhr(khr)}</span></span>
    </div>
  );
}
const Csv = ({ href }: { href: string }) => {
  const { t } = useTranslation();
  return <a className="btn-secondary w-full sm:w-auto" href={href} download data-testid="acct-csv"><Download size={16} /> {t("acct.excel")}</a>;
};

function PL({ from, to, onPick }: { from: string; to: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["acct-pl", from, to], queryFn: () => api.accounting.pl(from, to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const p = q.data;
  return (
    <>
      <Card title={t("acct.income")}>{p.income.length ? <Rows rows={p.income} fx={p.fx_rate_khr} onPick={onPick} /> : <Empty text={t("acct.nothing")} />}
        <Total label={t("acct.income_total")} cents={p.income_total} khr={p.income_total_khr} /></Card>
      <Card title={t("acct.expense")}>{p.expense.length ? <Rows rows={p.expense} fx={p.fx_rate_khr} onPick={onPick} /> : <Empty text={t("acct.nothing")} />}
        <Total label={t("acct.expense_total")} cents={p.expense_total} khr={p.expense_total_khr} /></Card>
      <Card><Total label={p.net >= 0 ? t("acct.profit") : t("acct.loss")} cents={p.net} khr={p.net_khr} big testid="pl-net" />
        <p className="text-xs text-muted mt-2">{t("acct.rate_note", { rate: p.fx_rate_khr })}</p></Card>
      <Csv href={api.accounting.csvUrl("pl", from, to)} />
    </>
  );
}

function BS({ to, onPick }: { to: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["acct-bs", to], queryFn: () => api.accounting.bs(to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const b = q.data;
  const ok = b.assets_total === b.liabilities_total + b.equity_total + b.current_earnings;
  return (
    <>
      <Card title={t("acct.type.asset")}><Rows rows={b.assets} fx={b.fx_rate_khr} onPick={onPick} /><Total label={t("acct.assets_total")} cents={b.assets_total} khr={b.assets_total_khr} testid="bs-assets" /></Card>
      <Card title={t("acct.type.liability")}><Rows rows={b.liabilities} fx={b.fx_rate_khr} onPick={onPick} /><Total label={t("acct.liabilities_total")} cents={b.liabilities_total} khr={b.liabilities_total_khr} /></Card>
      <Card title={t("acct.type.equity")}><Rows rows={b.equity} fx={b.fx_rate_khr} onPick={onPick} />
        <div className="flex justify-between gap-3 py-2 text-sm"><span>{t("acct.current_earnings")}</span><Amount cents={b.current_earnings} fx={b.fx_rate_khr} /></div>
        <Total label={t("acct.le_total")} cents={b.liabilities_total + b.equity_total + b.current_earnings} khr={b.liabilities_total_khr + b.equity_total_khr + b.current_earnings_khr} /></Card>
      <p className={`flex items-center gap-2 text-sm ${ok ? "text-success" : "text-danger"}`}>{ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {ok ? t("acct.bs_ok") : t("acct.bs_bad")}</p>
      <Csv href={api.accounting.csvUrl("balance-sheet", null, to)} />
    </>
  );
}

function TB({ to, onPick }: { to: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const name = useAccName();
  const q = useQuery({ queryKey: ["acct-tb", to], queryFn: () => api.accounting.tb(to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const tb = q.data;
  return (
    <>
      <Card>
        {tb.rows.length === 0 ? <Empty text={t("acct.nothing")} /> : (
          <table className="w-full text-sm" data-testid="tb-table">
            <thead><tr className="text-muted text-xs"><th className="text-left font-normal py-1">{t("acct.account")}</th><th className="text-right font-normal">{t("acct.debit")}</th><th className="text-right font-normal">{t("acct.credit")}</th></tr></thead>
            <tbody className="divide-y divide-grey-line">
              {tb.rows.map((r) => (
                <tr key={r.account_id} className="cursor-pointer" onClick={() => onPick(r)}>
                  <td className="py-2 pr-2 break-words">{name(r)}</td>
                  <td className="text-right tabular whitespace-nowrap">{r.debit ? formatUsd(r.debit) : ""}</td>
                  <td className="text-right tabular whitespace-nowrap pl-2">{r.credit ? formatUsd(r.credit) : ""}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-grey-line font-bold"><td className="py-2">{t("acct.total")}</td><td className="text-right tabular whitespace-nowrap">{formatUsd(tb.total_debit)}</td><td className="text-right tabular whitespace-nowrap pl-2">{formatUsd(tb.total_credit)}</td></tr></tfoot>
          </table>
        )}
      </Card>
      <p className={`flex items-center gap-2 text-sm ${tb.balanced ? "text-success" : "text-danger"}`} data-testid="tb-balanced">{tb.balanced ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {tb.balanced ? t("acct.tb_ok") : t("acct.tb_bad")}</p>
      <Csv href={api.accounting.csvUrl("trial-balance", null, to)} />
    </>
  );
}
