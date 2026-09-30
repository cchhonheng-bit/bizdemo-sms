// Booking page: the job's invoice (FR-801). Reviewed job → «Create invoice» (Admin / CEO); afterwards the number, total, balance and a link.
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { Receipt } from "lucide-react";
import { api, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card } from "@/components/ui";
import { InvoiceBadge } from "./shared";
import { INVOICE_VIEW } from "./util";

const STAGES = ["reviewed", "invoiced", "partially_paid", "closed"];

export default function BookingInvoiceCard({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const visible = STAGES.includes(booking.status) && INVOICE_VIEW.some((p) => can(p));
  const q = useQuery({ queryKey: ["invoice-for", booking.id], queryFn: () => api.invoices.forBooking(booking.id), enabled: visible });
  if (!visible || q.isLoading) return null;
  const r = q.data;
  if (!r) {
    if (booking.status !== "reviewed") return null;
    return (
      <Card title={t("invoice.title_one")}>
        <p className="text-sm text-muted mb-3">{t("invoice.ready")}</p>
        {can("invoice.issue") && <Button variant="primary" onClick={() => nav(`/invoices/new?booking=${booking.id}`)} data-testid="invoice-create"><Receipt size={16} /> {t("invoice.new")}</Button>}
      </Card>
    );
  }
  return (
    <Card title={`${t("invoice.title_one")} · ${r.number}`} actions={<InvoiceBadge status={r.status} payment={r.payment_status} />}>
      <div className="flex justify-between text-sm"><span>{t("quote.total")}</span><span className="font-bold tabular">{formatUsd(r.total)}</span></div>
      {r.status === "issued" && r.payment_status !== "paid" && <div className="flex justify-between text-sm text-danger"><span>{t("invoice.balance")}</span><span className="tabular">{formatUsd(r.total - r.paid)}</span></div>}
      <Link className="btn-secondary mt-3" to={`/invoices/${r.id}`}><Receipt size={16} /> {t("invoice.open")}</Link>
    </Card>
  );
}
