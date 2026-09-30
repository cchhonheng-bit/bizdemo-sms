// Customer history (FR-203): running warranties, debt, bookings and invoices of one customer — bottom sheet on phones.
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api, fmtDate, type Customer } from "@/lib/api";
import { Badge, Dialog, ErrorState, Skeleton } from "@/components/ui";
import { StatusBadge } from "@/features/bookings/parts";
import { InvoiceBadge } from "@/features/invoices/shared";

export default function CustomerHistoryDialog({ customer, onClose }: { customer: Customer; onClose: () => void }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["customer-history", customer.id], queryFn: () => api.customerHistory(customer.id) });
  const d = q.data;
  return (
    <Dialog open onClose={onClose} title={`${t("customers.history")} · ${customer.name}`}>
      {q.isLoading ? <Skeleton /> : q.isError || !d ? <ErrorState text={t("app.error")} /> : (
        <div className="space-y-4" data-testid="history">
          {d.warranties.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold mb-1">🛡 {t("booking.warranty")}</h3>
              <ul className="space-y-1">{d.warranties.map((w) => (
                <li key={w.booking_id} className="flex items-center gap-2 text-sm">
                  <Link className="font-mono text-blue underline" to={`/bookings/${w.booking_id}`}>{w.number}</Link>
                  <Badge tone="green">{t("booking.warranty_active", { days: w.days_left })}</Badge>
                  <Link className="ml-auto text-blue underline" to={`/bookings/new?warranty_of=${w.booking_id}`}>{t("booking.new_warranty")}</Link>
                </li>))}
              </ul>
            </section>
          )}
          {d.debt !== undefined && (
            <div className={`rounded-md p-3 flex justify-between ${d.debt > 0 ? "bg-danger-50 text-danger" : "bg-grey-bg"}`}><span>{t("invoice.tab.debts")}</span><b className="tabular">{formatUsd(d.debt)}</b></div>
          )}
          <section>
            <h3 className="text-sm font-semibold mb-1">{t("booking.title")} ({d.bookings.length})</h3>
            {d.bookings.length === 0 ? <p className="text-sm text-muted">—</p> : (
              <ul className="divide-y divide-grey-line">{d.bookings.map((b) => (
                <li key={b.id}><Link to={`/bookings/${b.id}`} className="flex items-center gap-2 py-2 min-h-[44px] text-sm">
                  <span className="font-mono text-xs text-muted shrink-0">{b.number}</span>
                  <span className="flex-1 min-w-0 truncate">{b.warranty_of ? "🛡 " : ""}{b.service_text}</span>
                  <span className="text-xs text-muted tabular shrink-0">{b.scheduled_at ? fmtDate(b.scheduled_at) : ""}</span>
                  <StatusBadge status={b.status} />
                </Link></li>))}
              </ul>
            )}
          </section>
          {d.invoices && (
            <section>
              <h3 className="text-sm font-semibold mb-1">{t("invoice.title")} ({d.invoices.length})</h3>
              {d.invoices.length === 0 ? <p className="text-sm text-muted">—</p> : (
                <ul className="divide-y divide-grey-line">{d.invoices.map((i) => (
                  <li key={i.id}><Link to={`/invoices/${i.id}`} className="flex items-center gap-2 py-2 min-h-[44px] text-sm">
                    <span className="font-mono text-xs shrink-0">{i.number}</span>
                    <span className="flex-1 min-w-0 tabular text-right">{formatUsd(i.total)}{i.balance > 0 ? <span className="text-danger"> · {formatUsd(i.balance)}</span> : ""}</span>
                    <InvoiceBadge status={i.status} payment={i.payment_status} />
                  </Link></li>))}
                </ul>
              )}
            </section>
          )}
        </div>
      )}
    </Dialog>
  );
}
