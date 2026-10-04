// C5 reports (D-88 · D-92): income statement (period, income by zone), balance sheet (this month · previous month end · variance),
// trial balance by month (movement · YTD to the previous month · YTD to this month), general ledger by account code —
// USD with KHR at the rate of that date, Excel (CSV) download; tap an account → its general ledger.
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { CheckCircle2, Download, XCircle } from "lucide-react";
import { api, type AcctRow, type BsRow, type DrCr } from "@/lib/api";
import { Card, Empty, Field, Input, Skeleton } from "@/components/ui";
import RangePicker from "@/features/reports/RangePicker";
import { presetRange, type Range } from "@/features/reports/range";
import { todayLocal } from "@/features/invoices/util";
import { Amount } from "./common";
import { signedUsd, useAccName } from "./acct";
import { LedgerDialog } from "./Accounts";

type View = "pl" | "bs" | "tb" | "gl";
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
      <div className="grid grid-cols-4 rounded-md border border-grey-line overflow-hidden text-sm" role="tablist">
        {(["pl", "bs", "tb", "gl"] as View[]).map((k) => <button key={k} role="tab" aria-selected={view === k} data-testid={`rep-${k}`} className={`px-1 min-h-[44px] ${view === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView(k)}>{t(`acct.rep.${k}`)}</button>)}
      </div>
      {view !== "gl" && (
        <Card>
          {view === "pl" ? <RangePicker value={range} onChange={setRange} presets={["month", "last", "week", "today"]} />
            : view === "tb" ? <Field label={t("acct.month")}><Input type="month" value={month} max={todayLocal().slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} data-testid="tb-month" /></Field>
              : <Field label={t("acct.as_of")}><Input type="date" value={asOf} max={todayLocal()} onChange={(e) => e.target.value && setAsOf(e.target.value)} /></Field>}
        </Card>
      )}
      {view === "pl" ? <IS from={range[0]} to={range[1]} onPick={setLedgerOf} /> : view === "bs" ? <BS to={asOf} onPick={setLedgerOf} /> : view === "tb" ? <TB month={month} onPick={setLedgerOf} /> : <GL />}
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
const Csv = ({ href }: { href: string }) => {
  const { t } = useTranslation();
  return <a className="btn-secondary w-full sm:w-auto" href={href} download data-testid="acct-csv"><Download size={16} /> {t("acct.excel")}</a>;
};

/** D-126 (CEO): the income statement shows the previous month and the variance too, like the balance sheet */
function IS({ from, to, onPick }: { from: string; to: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["acct-pl", from, to], queryFn: () => api.accounting.pl(from, to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const p = q.data;
  const prev = (cur: number, before: number) => `${t("acct.col.previous")} (${p.previous.from} – ${p.previous.to}) ${signedUsd(before)} · ${t("acct.col.variance")} ${signedUsd(cur - before)}`;
  return (
    <>
      <Card title={t("acct.income")}>{p.income.length ? <BsRows rows={p.income} fx={p.fx_rate_khr} onPick={onPick} /> : <Empty text={t("acct.nothing")} />}
        <Total label={t("acct.income_total")} cents={p.income_total} khr={p.income_total_khr} sub={prev(p.income_total, p.previous.income_total)} testid="is-income" />
        <p className="text-xs text-muted mt-2 text-right tabular" data-testid="is-zones">{t("acct.zone.inside")} {formatUsd(p.zones.inside)} · {t("acct.zone.outside")} {formatUsd(p.zones.outside)}{p.zones.none ? ` · ${t("acct.zone.none")} ${formatUsd(p.zones.none)}` : ""}</p></Card>
      <Card title={t("acct.expense")}>{p.expense.length ? <BsRows rows={p.expense} fx={p.fx_rate_khr} onPick={onPick} /> : <Empty text={t("acct.nothing")} />}
        <Total label={t("acct.expense_total")} cents={p.expense_total} khr={p.expense_total_khr} sub={prev(p.expense_total, p.previous.expense_total)} /></Card>
      <Card><Total label={p.net >= 0 ? t("acct.profit") : t("acct.loss")} cents={p.net} khr={p.net_khr} big testid="pl-net" sub={prev(p.net, p.previous.net)} />
        <p className="text-xs text-muted mt-2">{t("acct.rate_note", { rate: p.fx_rate_khr })}</p></Card>
      <Csv href={api.accounting.csvUrl("income-statement", from, to)} />
    </>
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
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["acct-bs", to], queryFn: () => api.accounting.bs(to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const b = q.data;
  const ok = b.assets_total === b.liabilities_total + b.equity_total + b.current_earnings;
  const prev = (cur: number, before: number) => `${t("acct.col.previous")} (${b.previous_to}) ${signedUsd(before)} · ${t("acct.col.variance")} ${signedUsd(cur - before)}`;
  const le = b.liabilities_total + b.equity_total + b.current_earnings, lePrev = b.previous.liabilities_total + b.previous.equity_total + b.previous.current_earnings;
  return (
    <>
      <Card title={t("acct.type.asset")}><BsRows rows={b.assets} fx={b.fx_rate_khr} onPick={onPick} />
        <Total label={t("acct.assets_total")} cents={b.assets_total} khr={b.assets_total_khr} testid="bs-assets" sub={prev(b.assets_total, b.previous.assets_total)} /></Card>
      <Card title={t("acct.type.liability")}><BsRows rows={b.liabilities} fx={b.fx_rate_khr} onPick={onPick} />
        <Total label={t("acct.liabilities_total")} cents={b.liabilities_total} khr={b.liabilities_total_khr} sub={prev(b.liabilities_total, b.previous.liabilities_total)} /></Card>
      <Card title={t("acct.type.equity")}><BsRows rows={b.equity} fx={b.fx_rate_khr} onPick={onPick} />
        <div className="flex justify-between gap-3 py-2 text-sm"><span>{t("acct.current_earnings")}</span><Amount cents={b.current_earnings} fx={b.fx_rate_khr} /></div>
        <Total label={t("acct.le_total")} cents={le} khr={b.liabilities_total_khr + b.equity_total_khr + b.current_earnings_khr} sub={prev(le, lePrev)} /></Card>
      <p className={`flex items-center gap-2 text-sm ${ok ? "text-success" : "text-danger"}`}>{ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />} {ok ? t("acct.bs_ok") : t("acct.bs_bad")}</p>
      <Csv href={api.accounting.csvUrl("balance-sheet", null, to)} />
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
                  <tr key={r.account_id} className="cursor-pointer" onClick={() => onPick({ account_id: r.account_id, code: r.code, name_km: r.name_km, name_en: r.name_en, type: r.type, amount: 0 })}>
                    <td className="py-2 pr-2 break-words min-w-[12rem]">{name(r)}</td>
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
      <Csv href={api.accounting.csvUrl("trial-balance", null, tb.to, undefined, month)} />
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
      <Card>
        <Field label={t("acct.gl_code")} hint={t("acct.gl_hint")}><Input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} maxLength={6} data-testid="gl-code" /></Field>
        <RangePicker value={range} onChange={setRange} presets={["month", "last"]} />
      </Card>
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
          <div className="mt-3"><Csv href={api.accounting.csvUrl("ledger", range[0], range[1], q.data.account.id)} /></div>
        </Card>
      )}
    </>
  );
}
