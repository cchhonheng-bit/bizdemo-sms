// D-168 (client 25-10): the income statement as the client's Excel — four columns (the period · the whole month before · the fiscal
// year up to the end of that month · the fiscal year up to the period's end), revenue − cost of goods (50001) = gross profit, then
// the other expenses → net. A row opens the account's ledger. Scrolls sideways on a phone.
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { Download } from "lucide-react";
import { api, type AcctRow, type IsCol, type IsRow } from "@/lib/api";
import { Card, Empty, Skeleton } from "@/components/ui";
import { signedUsd, useAccName } from "./acct";

const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}`;
export function IncomeStatement({ from, to, onPick }: { from: string; to: string; onPick: (r: AcctRow) => void }) {
  const { t } = useTranslation();
  const name = useAccName();
  const q = useQuery({ queryKey: ["acct-pl", from, to], queryFn: () => api.accounting.pl(from, to) });
  if (q.isLoading || !q.data) return <Skeleton />;
  const p = q.data, c = p.columns;
  const cols: { key: keyof IsCol; label: string; range: string }[] = [
    { key: "amount", label: t("acct.col.current"), range: `${dmy(c.current.from)} – ${dmy(c.current.to)}` },
    { key: "last", label: t("acct.col.last"), range: `${dmy(c.last.from)} – ${dmy(c.last.to)}` },
    { key: "ytd_prev", label: t("acct.col.ytd_prev"), range: `${dmy(c.ytd_prev.from)} – ${dmy(c.ytd_prev.to)}` },
    { key: "ytd", label: t("acct.col.ytd"), range: `${dmy(c.ytd.from)} – ${dmy(c.ytd.to)}` },
  ];
  const Row = ({ r }: { r: IsRow }) => (
    <tr className="border-t border-grey-line">
      <td className="py-2 pr-2"><button className="text-left min-h-[36px]" onClick={() => onPick(r)}>{name(r)}</button></td>
      {cols.map((col) => <td key={col.key} className="py-2 px-2 text-right tabular whitespace-nowrap">{signedUsd((r as IsCol)[col.key])}</td>)}
    </tr>
  );
  const TotalRow = ({ label, x, strong, testid }: { label: string; x: IsCol; strong?: boolean; testid?: string }) => (
    <tr className={`border-t-2 border-grey-line ${strong ? "text-base" : ""}`} data-testid={testid}>
      <td className="py-2 pr-2 font-semibold">{label}</td>
      {cols.map((col) => <td key={col.key} className="py-2 px-2 text-right tabular font-bold whitespace-nowrap">{signedUsd(x[col.key])}</td>)}
    </tr>
  );
  const Head = ({ label }: { label: string }) => <tr><td colSpan={5} className="pt-4 pb-1 font-semibold text-muted">{label}</td></tr>;
  return (
    <>
      <Card>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full min-w-[640px] text-sm" data-testid="is-table">
            <thead><tr>
              <th className="text-left py-1 pr-2 font-semibold">{t("acct.account")}</th>
              {cols.map((col) => <th key={col.key} className="py-1 px-2 text-right font-semibold whitespace-nowrap">{col.label}<span className="block text-xs text-muted font-normal">{col.range}</span></th>)}
            </tr></thead>
            <tbody>
              <Head label={t("acct.income")} />
              {p.income.length ? p.income.map((r) => <Row key={r.account_id} r={r} />) : <tr><td colSpan={5}><Empty text={t("acct.nothing")} /></td></tr>}
              <TotalRow label={t("acct.income_total")} x={p.totals.income} testid="is-income" />
              <Head label={t("acct.cogs")} />
              {p.cogs.map((r) => <Row key={r.account_id} r={r} />)}
              <TotalRow label={t("acct.gross")} x={p.totals.gross} testid="is-gross" />
              <Head label={t("acct.expense")} />
              {p.expense.map((r) => <Row key={r.account_id} r={r} />)}
              <TotalRow label={t("acct.expense_total")} x={p.totals.expense} />
              <TotalRow label={p.totals.net.amount >= 0 ? t("acct.profit") : t("acct.loss")} x={p.totals.net} strong testid="pl-net" />
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted mt-2 text-right tabular" data-testid="is-zones">{t("acct.zone.inside")} {formatUsd(p.zones.inside)} · {t("acct.zone.outside")} {formatUsd(p.zones.outside)}{p.zones.none ? ` · ${t("acct.zone.none")} ${formatUsd(p.zones.none)}` : ""}</p>
        <p className="text-xs text-muted mt-1">{t("acct.rate_note", { rate: p.fx_rate_khr })} · {formatKhr(p.net_khr)}</p>
      </Card>
      <a className="btn-secondary w-full sm:w-auto" href={api.accounting.csvUrl("income-statement", from, to)} download data-testid="acct-csv"><Download size={16} /> {t("acct.excel")}</a>
    </>
  );
}
