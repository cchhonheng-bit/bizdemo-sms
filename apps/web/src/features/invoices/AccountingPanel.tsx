// D-142 «ការកត់ត្រាគណនេយ្យ» — what the books hold for this invoice (CFO / CEO / Admin): the issue, the stock a sale took at cost, each
// payment; every line with the account's code and name, debit or credit; a reversed entry stays, greyed
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api } from "@/lib/api";
import { Card, Skeleton } from "@/components/ui";

export default function AccountingPanel({ invoiceId }: { invoiceId: string }) {
  const { t, i18n } = useTranslation();
  const en = i18n.language === "en";
  const q = useQuery({ queryKey: ["invoice-journal", invoiceId], queryFn: () => api.invoices.journal(invoiceId) });
  return (
    <Card title={t("invoice.journal")}>
      {q.isLoading ? <Skeleton rows={3} /> : !q.data?.length ? <p className="text-sm text-muted">{t("invoice.journal_none")}</p> : (
        <ul className="space-y-3" data-testid="invoice-journal">
          {q.data.map((e) => (
            <li key={e.id} className={e.status === "reversed" ? "opacity-60" : ""}>
              <div className="flex flex-wrap justify-between gap-x-2 text-xs text-muted">
                <span>{t(`acct.source.${e.source}`)} · {e.number} · {e.date}</span>
                {e.status === "reversed" && <span className="text-danger">{t("acct.reversed")}</span>}
              </div>
              <table className="w-full text-sm tabular">
                <tbody>
                  {e.lines.map((l, i) => (
                    <tr key={i} className="border-b border-grey-line last:border-0">
                      <td className={`py-1 pr-2 ${l.credit ? "pl-6" : ""}`}><span className="font-mono">{l.code}</span> <span className="text-muted">{en && l.name_en ? l.name_en : l.name_km}</span></td>
                      <td className="py-1 w-24 text-right">{l.debit ? formatUsd(l.debit) : ""}</td>
                      <td className="py-1 w-24 text-right">{l.credit ? formatUsd(l.credit) : ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </li>
          ))}
          <li className="flex justify-end gap-6 text-xs text-muted"><span className="w-24 text-right">{t("acct.debit")}</span><span className="w-24 text-right">{t("acct.credit")}</span></li>
        </ul>
      )}
    </Card>
  );
}
