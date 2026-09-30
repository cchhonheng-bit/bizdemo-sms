// A1 «done but not invoiced»: finished jobs without an invoice — age since the work finished, estimated amount, open the job to invoice.
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api } from "@/lib/api";
import { Badge, Card, Empty, Skeleton } from "@/components/ui";

export default function UninvoicedList() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["uninvoiced"], queryFn: api.uninvoiced });
  const rows = q.data ?? [];
  const total = rows.reduce((s, r) => s + r.estimate, 0);
  return (
    <Card title={rows.length ? t("uninvoiced.summary", { n: rows.length, amount: formatUsd(total) }) : undefined}>
      {q.isLoading ? <Skeleton /> : rows.length === 0 ? <Empty text={t("uninvoiced.none")} /> : (
        <ul className="divide-y divide-grey-line -my-2" data-testid="uninvoiced">
          {rows.map((r) => (
            <li key={r.booking_id}>
              <Link to={`/bookings/${r.booking_id}`} className="flex items-center gap-3 py-3 min-h-[56px]">
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">{r.customer_name}</div>
                  <div className="text-xs text-muted font-mono">{r.number} · {t(`status.${r.status}`)}{r.warranty ? ` · 🛡 ${t("booking.warranty")}` : ""}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold tabular">≈ {formatUsd(r.estimate)}</div>
                  <Badge tone={r.age_days > 7 ? "danger" : r.age_days > 2 ? "warning" : "grey"}>{t("uninvoiced.age", { n: r.age_days })}</Badge>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
