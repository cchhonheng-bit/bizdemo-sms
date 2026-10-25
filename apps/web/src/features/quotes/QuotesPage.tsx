// Quotes list (FR-504): waiting for the customer (days), accepted, rejected — cards on phones.
import { useState } from "react";
import { ListFilters, useListState } from "@/components/ListFilters";
import { ReportToolbar } from "@/components/ReportToolbar";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { filterList, formatUsd, LIST_SPECS } from "@sms/shared";
import { api } from "@/lib/api";
import { Badge, Card, Empty, Input, Skeleton } from "@/components/ui";

const TONE = { sent: "warning", accepted: "green", rejected: "danger" } as const;

export default function QuotesPage() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"sent" | "accepted" | "rejected">("sent");
  const q = useQuery({ queryKey: ["quotes", status], queryFn: () => api.quotes.list(status) });
  const [s, setS] = useState(""); // D-140: number, job, customer, phone in any form
  const ls = useListState();
  const filters = { ...ls.params, ...(s.trim() ? { q: s.trim() } : {}), status: [status] };
  const rows = filterList(q.data ?? [], LIST_SPECS.quotes, filters); // D-172
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("quote.title")}</h1>
      <div className="flex rounded-md border border-grey-line overflow-hidden text-sm w-full sm:w-auto" role="tablist">
        {(["sent", "accepted", "rejected"] as const).map((s) => (
          <button key={s} role="tab" aria-selected={status === s} className={`flex-1 px-3 min-h-[44px] ${status === s ? "bg-navy text-white" : "bg-white"}`} onClick={() => setStatus(s)}>{t(`quote.status.${s}`)}</button>
        ))}
      </div>
      <ReportToolbar report="quotes" params={filters} active={ls.active}><ListFilters s={ls} search={false} /></ReportToolbar>
      <Card>
        <Input type="search" autoComplete="off" placeholder={t("app.search")} value={s} onChange={(e) => setS(e.target.value)} className="mb-3 w-full sm:max-w-xs" name="quote_filter" />
        {q.isLoading ? <Skeleton /> : !rows.length ? <Empty text={t("quote.none")} /> : (
          <ul className="divide-y divide-grey-line -my-2">
            {rows.map((r) => (
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
