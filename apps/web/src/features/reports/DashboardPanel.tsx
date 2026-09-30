// CEO / GM dashboard (FR-1101): money today + this month + debts (report.finance only), what waits for someone
// (review, approvals, CFO checks) and where every technician is right now (job status, attendance).
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { api } from "@/lib/api";
import { Badge, Card, Skeleton } from "@/components/ui";

const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh" }) : null);
const TONE: Record<string, "green" | "blue" | "warning" | "purple" | "grey"> = { free: "green", en_route: "blue", on_site: "purple", working: "warning", leave: "grey" };

export default function DashboardPanel() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["dashboard"], queryFn: api.reports.dashboard, refetchInterval: 60_000 });
  if (q.isLoading) return <Skeleton rows={3} />;
  if (!q.data) return null;
  const d = q.data;
  const tile = (label: string, value: string | number, to: string, tone = "") => (
    <Link to={to} className="card p-3 hover:border-blue min-w-0"><div className="text-xs text-muted truncate">{label}</div><div className={`text-xl font-bold tabular ${tone}`}>{value}</div></Link>
  );
  const waiting = d.approvals.discounts + d.approvals.voids;
  return (
    <div className="space-y-3" data-testid="dashboard-panel">
      {d.today.revenue !== undefined && d.month && d.debts && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {tile(t("dashboard.revenue_today"), formatUsd(d.today.revenue), "/reports")}
          {tile(t("dashboard.received_today"), formatUsd(d.today.received ?? 0), "/reports", "text-success")}
          {tile(t("dashboard.revenue_month"), formatUsd(d.month.revenue), "/reports")}
          {tile(t("dashboard.debts"), formatUsd(d.debts.total), "/invoices", d.debts.d60_plus > 0 ? "text-danger" : "")}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {tile(t("status.pending_review"), d.pending_review, "/bookings", d.pending_review ? "text-warning" : "")}
        {tile(t("dashboard.approvals"), waiting, "/invoices", waiting ? "text-warning" : "")}
        {tile(t("dashboard.leave_waiting"), d.approvals.leave, "/leave", d.approvals.leave ? "text-warning" : "")}
        {d.unverified !== undefined ? tile(t("dashboard.unverified"), d.unverified, "/reports", d.unverified ? "text-warning" : "") : tile(t("dashboard.jobs_today"), `${d.today.done}/${d.today.jobs}`, "/bookings")}
      </div>
      <Card title={t("dashboard.techs")}>
        {d.techs.length === 0 ? <p className="text-sm text-muted">—</p> : (
          <ul className="divide-y divide-grey-line -my-2">
            {d.techs.map((x) => (
              <li key={x.user_id} className="py-2 flex items-center gap-2 min-h-[44px]">
                <span className="font-semibold flex-1 min-w-0 break-words">{x.full_name}</span>
                {x.job_id && <Link to={`/bookings/${x.job_id}`} className="font-mono text-xs text-blue underline">{x.job_number}</Link>}
                <Badge tone={TONE[x.status] ?? "grey"}>{t(`dashboard.tech_status.${x.status}`)}</Badge>
                <span className="text-xs text-muted tabular w-[84px] text-right">{hm(x.in_at) ? `${hm(x.in_at)}${x.out_at ? `–${hm(x.out_at)}` : ""}` : t("dashboard.not_in")}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
