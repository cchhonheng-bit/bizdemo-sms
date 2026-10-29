// C5 reports (D-88 · D-92): income statement (period, income by zone), balance sheet (this month · previous month end · variance),
// trial balance by month (movement · YTD to the previous month · YTD to this month), general ledger by account code —
// USD with KHR at the rate of that date, Excel (CSV) download; tap an account → its general ledger.
import { Fragment, useState } from "react";
import { ReportToolbar } from "@/components/ReportToolbar";
import { ReportScreen } from "@/features/reports/ReportScreen";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { CheckCircle2, XCircle } from "lucide-react";
import { api, type AcctRow, type BsRow, type DrCr } from "@/lib/api";
import { Card, Empty, Field, Input, Skeleton } from "@/components/ui";
import RangePicker from "@/features/reports/RangePicker";
import { presetRange, type Range } from "@/features/reports/range";
import { todayLocal } from "@/features/invoices/util";
import { Amount } from "./common";
import { signedUsd, useAccName } from "./acct";
import { LedgerDialog } from "./Accounts";
import { IncomeStatement as IS } from "./IncomeStatement"; // D-168: four columns + the gross profit (client 25-10)

type View = "pl" | "bs" | "tb" | "gl" | "coa" | "acc";
const monthEnd = (ym: string) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).toISOString().slice(0, 10); };

export default function Reports() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("pl");
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const [asOf, setAsOf] = useState(todayLocal());
  const [month, setMonth] = useState(todayLocal().slice(0, 7));
  const [ledgerOf, setLedgerOf] = useState<AcctRow | null>(null);
  return (
    <>
      <div className="flex overflow-x-auto rounded-md border border-grey-line text-sm" role="tablist">
        {(["pl", "bs", "tb", "gl", "coa", "acc"] as View[]).map((k) => <button key={k} role="tab" aria-selected={view === k} data-testid={`rep-${k}`} className={`flex-1 shrink-0 whitespace-nowrap px-3 min-h-[44px] ${view === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView(k)}>{t(`acct.rep.${k}`)}</button>)}
      </div>
      {(view === "pl" || view === "bs" || view === "tb") && (
        <ReportToolbar report={view === "pl" ? "income-statement" : view === "bs" ? "balance-sheet" : "trial-balance"} params={view === "pl" ? { from: range[0], to: range[1] } : view === "bs" ? { asof: asOf } : { month }}>
          {view === "pl" ? <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />
            : view === "tb" ? <Field label={t("acct.month")}><Input type="month" value={month} max={todayLocal().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="tb-month" /></Field>
              : <Field label={t("acct.as_of")}><Input type="date" value={asOf} max={todayLocal()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></Field>}
        </ReportToolbar>
      )}
      {view === "pl" ? <IS from={range[0]} to={range[1]} onPick={setLedgerOf} /> : view === "bs" ? <BS to={asOf} onPick={setLedgerOf} /> : view === "tb" ? <TB month={month} onPick={setLedgerOf} /> : view === "coa" ? <ReportScreen report="coa" needs={["range", "asof"]} /> : view === "acc" ? <ReportScreen report="account-report" needs={["range", "asof", "account"]} /> : <GL />}
      {ledgerOf && <LedgerDialog account={{ id: ledgerOf.account_id, code: ledgerOf.code, name_km: ledgerOf.name_km, name_en: ledgerOf.name_en }}
        range={view === "pl" ? range : view === "tb" ? [`${month}-01`, monthEnd(month)] : [asOf.slice(0, 8) + "01", asOf]} onClose={() => setLedgerOf(null)} />}
    </>
  );
}

function Total({ label, cents, khr, big, testid, sub }: { label: string; cents: number; khr: number; big?: boolean; testid?: string; sub?: string }) {
  return (
    <div className={`flex justify-between gap-3 pt-2 mt-1 border-t-2 border-grey-line ${big ? "text-lg" : ""}`} data-testid={testid}>
      <span className="font-semibold">{label}</span>
      <span className="text-right tabular"><span className="font-bold">{signedUsd(cents)}</span><span className="block text-xs text-muted">{formatKhr(khr)}</span>{sub && <span className="block text-xs text-muted">{sub}</span>}</span>
    </div>
  );
}

function BsRows({ rows, fx, onPick }: { rows: BsRow[]; fx: number; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const name = useAccName();
  return (
    <ul className="divide-y divide-grey-line">
      {rows.map((r) => (
        <li key={r.account_id}>
          <button className="w-full py-2 min-h-[44px] text-left text-sm" onClick={() => onPick(r)}>
            <div className="flex justify-between gap-3"><span className="min-w-0 break-words">{name(r)}</span><Amount cents={r.amount} fx={fx} /></div>
            <div className="flex justify-between gap-3 text-xs text-muted tabular"><span>{t("acct.col.previous")} {signedUsd(r.previous)}</span><span>{t("acct.col.variance")} {signedUsd(r.variance)}</span></div>
          </button>
        </li>
      ))}
    </ul>
  );
}
function BS({ to, onPick }: { to: string; onPick: (r: AcctRow) => void }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["acct-bs", to], queryFn: () => api.accounting.bs(to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const b = q.data;
  const ok = b.assets_total === b.liabilities_total + b.equity_total + b.current_earnings + b.prior_earnings; // D-171: earlier years' result not closed
  const prev = (cur: number, before: number) => `${t("acct.col.previous")} (${b.previous_to}) ${signedUsd(before)} · ${t("acct.col.variance")} ${signedUsd(cur - before)}`;
  const le = b.liabilities_total + b.equity_total + b.current_earnings + b.prior_earnings, lePrev = b.previous.liabilities_total + b.previous.equity_total + b.previous.current_earnings + b.previous.prior_earnings;
  return (
    <>
      <Card title={t("acct.type.asset")}><BsRows rows={b.assets} fx={b.fx_rate_khr} onPick={onPick} />
        <Total label={t("acct.assets_total")} cents={b.assets_total} khr={b.assets_total_khr} testid="bs-assets" sub={prev(b.assets_total, b.previous.assets_total)} /></Card>
      <Card title={t("acct.type.liability")}><BsRows rows={b.liabilities} fx={b.fx_rate_khr} onPick={onPick} />
        <Total label={t("acct.liabilities_total")} cents={b.liabilities_total} khr={b.liabilities_total_khr} sub={prev(b.liabilities_total, b.previous.liabilities_total)} /></Card>
      <Card title={t("acct.type.equity")}><BsRows rows={b.equity} fx={b.fx_rate_khr} onPick={onPick} />
        {/* D-188 (client 29-10): this year to the end of last month on the account (30002), then this month's result */}
        <div className="flex justify-between gap-3 py-2 text-sm" data-testid="bs-year"><span>{b.current_earnings_account ? `${b.current_earnings_account.code} · ${(i18n.language === "en" && b.current_earnings_account.name_en) || b.current_earnings_account.name_km}` : t("acct.current_earnings")} <span className="text-xs text-muted">({t("acct.to_last_month")})</span></span><Amount cents={b.year_earnings} fx={b.fx_rate_khr} /></div>
        <div className="flex justify-between gap-3 py-2 text-sm" data-testid="bs-month"><span>{t("acct.month_earnings")}</span><Amount cents={b.month_earnings} fx={b.fx_rate_khr} /></div>
        {(b.prior_earnings !== 0 || b.previous.prior_earnings !== 0) && <div className="flex justify-between gap-3 py-2 text-sm" data-testid="bs-prior"><span>{b.prior_earnings_account ? `${b.prior_earnings_account.code} · ` : ""}{t("acct.prior_earnings")}</span><span className="tabular">{signedUsd(b.prior_earnings)}</span></div>}
        <Total label={t("acct.le_total")} cents={le} khr={b.liabilities_total_khr + b.equity_total_khr + b.current_earnings_khr + b.prior_earnings_khr} sub={prev(le, lePrev)} /></Card>
      <p className={`flex items-center gap-2 text-sm ${ok ? "text-success" : "text-danger"}`}>{ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {ok ? t("acct.bs_ok") : t("acct.bs_bad")}</p>
    </>
  );
}

const COLS = ["period", "ytd_prev", "ytd"] as const;
function TB({ month, onPick }: { month: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const name = useAccName();
  const q = useQuery({ queryKey: ["acct-tbm", month], queryFn: () => api.accounting.tbMonth(month) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const tb = q.data;
  const cell = (v: number) => <td className="text-right tabular whitespace-nowrap pl-2">{v ? formatUsd(v) : ""}</td>;
  const pair = (d: DrCr) => <>{cell(d.debit)}{cell(d.credit)}</>;
  return (
    <>
      <Card>
        {tb.rows.length === 0 ? <Empty text={t("acct.nothing")} /> : (
          <div className="overflow-x-auto -mx-3 px-3">
            <table className="text-sm min-w-[640px] w-full" data-testid="tb-table">
              <thead>
                <tr className="text-muted text-xs"><th rowSpan={2} className="text-left font-normal py-1">{t("acct.account")}</th>
                  {COLS.map((k) => <th key={k} colSpan={2} className="font-normal text-center border-l border-grey-line">{t(`acct.col.${k}`)}</th>)}</tr>
                <tr className="text-muted text-xs">{COLS.map((k) => <Fragment key={k}><th className="text-right font-normal border-l border-grey-line">{t("acct.debit")}</th><th className="text-right font-normal">{t("acct.credit")}</th></Fragment>)}</tr>
              </thead>
              <tbody className="divide-y divide-grey-line">
                {tb.rows.map((r) => (
                  <tr key={r.account_id + (r.computed ? "-c" : "")} className={r.computed ? "italic" : "cursor-pointer"} onClick={r.computed ? undefined : () => onPick({ account_id: r.account_id, code: r.code, name_km: r.name_km, name_en: r.name_en, type: r.type, amount: 0 })} data-testid={r.computed ? "tb-computed" : undefined}>
                    <td className="py-2 pr-2 break-words min-w-[12rem]">{name(r)}{r.computed && <span className="block text-xs text-muted not-italic">{t("acct.to_last_month")}</span>}</td>
                    {COLS.map((k) => <Fragment key={k}>{pair(r[k])}</Fragment>)}
                  </tr>
                ))}
              </tbody>
              <tfoot><tr className="border-t-2 border-grey-line font-bold"><td className="py-2">{t("acct.total")}</td>{COLS.map((k) => <Fragment key={k}>{pair(tb.totals[k])}</Fragment>)}</tr></tfoot>
            </table>
          </div>
        )}
        <p className="text-xs text-muted mt-2">{tb.from} → {tb.to} · {t("acct.fy")} {tb.fiscal_year_start}</p>
      </Card>
      <p className={`flex items-center gap-2 text-sm ${tb.balanced ? "text-success" : "text-danger"}`} data-testid="tb-balanced">{tb.balanced ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {tb.balanced ? t("acct.tb_ok") : t("acct.tb_bad")}</p>
    </>
  );
}

/** general ledger by account code: every transaction of the account with the running balance */
function GL() {
  const { t } = useTranslation();
  const name = useAccName();
  const [code, setCode] = useState("");
  const [range, setRange] = useState<Range>(presetRange("month", todayLocal()));
  const ok = /^[1-9]\d{3,5}$/.test(code);
  const q = useQuery({ queryKey: ["acct-gl", code, range], queryFn: () => api.accounting.ledgerByCode(code, range[0], range[1]), enabled: ok, retry: false });
  return (
    <>
      <ReportToolbar report={q.data ? "account-report" : undefined} params={{ from: range[0], to: range[1], account: q.data ? [q.data.account.id] : [] }}>
        <Field label={t("acct.gl_code")} hint={t("acct.gl_hint")}><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} maxLength={6} data-testid="gl-code" /></Field>
        <RangePicker value={range} onChange={setRange} presets={["month", "last"]} />
      </ReportToolbar>
      {!ok ? null : q.isLoading ? <Skeleton /> : q.isError || !q.data ? <Card><Empty text={t("acct.err.ACCOUNT_NOT_FOUND")} /></Card> : (
        <Card title={name(q.data.account)}>
          <div data-testid="gl">
            <div className="flex justify-between text-sm py-2 border-b border-grey-line"><span className="text-muted">{t("acct.opening")}</span><span className="tabular">{signedUsd(q.data.opening)}</span></div>
            {!q.data.rows.length ? <Empty text={t("acct.nothing")} /> : (
              <ul className="divide-y divide-grey-line">
                {q.data.rows.map((r, i) => (
                  <li key={i} className="py-2 text-sm">
                    <div className="flex justify-between gap-2"><span className="text-muted text-xs">{r.date} · {r.number}</span>
                      <span className="tabular whitespace-nowrap">{r.debit ? `+${formatUsd(r.debit)}` : `−${formatUsd(r.credit)}`}</span></div>
                    <div className="flex justify-between gap-2"><span className="break-words min-w-0">{[r.memo, r.line_memo, r.customer_name, r.user_name, r.supplier].filter(Boolean).join(" · ")}</span>
                      <span className="tabular text-xs text-muted whitespace-nowrap">{signedUsd(r.balance)}</span></div>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex justify-between text-sm pt-2 border-t-2 border-grey-line font-bold"><span>{t("acct.closing")}</span><span className="tabular">{signedUsd(q.data.closing)}</span></div>
          </div>
        </Card>
      )}
    </>
  );
}
