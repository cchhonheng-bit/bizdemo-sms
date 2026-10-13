// D-142 «តម្លៃស្តុកចុងខែ» — stock on a day by account (quantity + value, the items under each), beside the books' balance of the stock
// accounts (13000–18999): stock = books ✓, or the difference per account and in total (the books side needs accounting.view)
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { formatUsd } from "@sms/shared";
import { api } from "@/lib/api";
import { Card, Field, Input, Skeleton } from "@/components/ui";
import { todayLocal } from "@/features/invoices/util";

const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));

export default function MonthEnd() {
  const { t, i18n } = useTranslation();
  const en = i18n.language === "en";
  const [to, setTo] = useState(todayLocal());
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const q = useQuery({ queryKey: ["stock-month-end", to], queryFn: () => api.inventory.monthEnd(to), enabled: /^\d{4}-\d{2}-\d{2}$/.test(to) });
  const d = q.data;
  return (
    <Card title={t("inventory.tab.monthend")}>
      <Field label={t("inventory.me_date")}><Input type="date" value={to} max={todayLocal()} onChange={(e) => e.target.value && setTo(e.target.value)} data-testid="me-date" /></Field>
      {!d ? <Skeleton /> : (
        <div data-testid="month-end">
          <table className="w-full text-sm tabular">
            <thead><tr className="text-xs text-muted"><th className="text-left py-1">{t("acct.account")}</th><th className="text-right py-1">{t("inventory.qty")}</th><th className="text-right py-1">{t("inventory.me_stock")}</th>
              {d.books_total !== null && <><th className="text-right py-1">{t("inventory.me_books")}</th><th className="text-right py-1">{t("inventory.me_diff")}</th></>}</tr></thead>
            <tbody>
              {d.accounts.map((a) => (
                <>
                  <tr key={a.code} className="border-t border-grey-line cursor-pointer" onClick={() => setOpen((o) => ({ ...o, [a.code]: !o[a.code] }))} data-testid="me-account">
                    <td className="py-2 font-semibold"><span className="inline-flex items-center gap-1">{open[a.code] ? <ChevronDown size={14} /> : <ChevronRight size={14} />}<span className="font-mono">{a.code}</span> {en && a.name_en ? a.name_en : a.name_km}</span></td>
                    <td className="py-2 text-right">{qtyFmt(a.qty)}</td>
                    <td className="py-2 text-right">{formatUsd(a.value)}</td>
                    {d.books_total !== null && <><td className="py-2 text-right">{a.balance === null ? "—" : formatUsd(a.balance)}</td>
                      <td className={`py-2 text-right ${a.difference ? "text-danger font-bold" : "text-success"}`}>{a.difference === null ? "—" : a.difference ? formatUsd(a.difference) : "✓"}</td></>}
                  </tr>
                  {open[a.code] && a.items.map((i) => (
                    <tr key={i.item_id} className="text-xs text-muted">
                      <td className="py-1 pl-6"><span className="font-mono">{i.code ?? "—"}</span> {i.name}</td>
                      <td className="py-1 text-right">{qtyFmt(i.qty)} {i.unit}</td>
                      <td className="py-1 text-right">{formatUsd(i.value)}{i.qty > 0 ? ` (${formatUsd(Math.round(i.value / i.qty))})` : ""}</td>
                      {d.books_total !== null && <td colSpan={2} />}
                    </tr>
                  ))}
                </>
              ))}
            </tbody>
            <tfoot><tr className="border-t-2 border-grey-line font-bold"><td className="py-2">{t("inventory.total")}</td><td /><td className="py-2 text-right">{formatUsd(d.stock_total)}</td>
              {d.books_total !== null && <><td className="py-2 text-right">{formatUsd(d.books_total)}</td><td className={`py-2 text-right ${d.difference ? "text-danger" : "text-success"}`}>{d.difference ? formatUsd(d.difference) : "✓"}</td></>}</tr></tfoot>
          </table>
          {d.books_total !== null && (
            <p className={`mt-3 rounded-md p-3 text-sm ${d.difference ? "bg-danger-50 text-danger" : "bg-success-50 text-success"}`} data-testid="me-check">
              {d.difference ? `${t("inventory.me_diff")}: ${formatUsd(d.difference)} — ${t("inventory.me_diff_hint")}` : t("inventory.me_ok")}
            </p>
          )}
        </div>
      )}
    </Card>
  );
}
