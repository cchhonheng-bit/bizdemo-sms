// Quotes list (FR-504): waiting for the customer (days), accepted, rejected — cards on phones.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api } from "@/lib/api";
import { Badge, Card, Empty, Skeleton } from "@/components/ui";

const TONE = { sent: "warning", accepted: "green", rejected: "danger" } as const;

export default function QuotesPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"sent" | "accepted" | "rejected">("sent");
  const q = useQuery({ queryKey: ["quotes", status], queryFn: () => api.quotes.list(status) });
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("quote.title")}</h1>
      <div className="flex rounded-md border border-grey-line overflow-hidden text-sm w-full sm:w-auto" role="tablist">
        {(["sent", "accepted", "rejected"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={`flex-1 px-3 min-h-[44px] ${status === s ? "bg-navy text-white" : "bg-white"}`} onClick={() => setStatus(s)}>{t(`quote.status.${s}`)}</button>
        ))}
      </div>
      <Card>
        {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("quote.none")} /> : (
          <ul className="divide-y divide-grey-line -my-2">
            {q.data.map((r) => (
              <li key={r.id}>
                <Link to={`/bookings/${r.booking_id}`} className="flex items-center gap-3 py-3 min-h-[56px]">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold break-words">{r.customer_name}</div>
                    <div className="text-xs text-muted font-mono">{r.number} · {r.booking_number}</div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold tabular">{formatUsd(r.total)}</div>
                    {r.status === "sent" ? <Badge tone={r.days_waiting > 7 ? "danger" : "warning"}>{t("quote.days_waiting", { n: r.days_waiting })}</Badge> : <Badge tone={TONE[r.status]}>{t(`quote.status.${r.status}`)}</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
