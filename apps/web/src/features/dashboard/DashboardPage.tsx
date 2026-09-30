import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { api, fmtDate } from "@/lib/api";
import { timeRange } from "@/features/bookings/time";
import { useAuth } from "@/lib/auth";
import { Button, Card, Empty, Skeleton } from "@/components/ui";
import { StatusBadge } from "@/features/bookings/parts";
import AttendanceCard from "@/features/attendance/AttendanceCard";

/** M2 dashboard: today's jobs + pipeline counts (full KPIs in M6) */
export default function DashboardPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: () => api.bookings(), refetchInterval: 60_000 });
  const { today, counts } = useMemo(() => {
    const all = bookings.data ?? [];
    const d = fmtDate(new Date().toISOString());
    const today = all.filter((b) => fmtDate(b.scheduled_at) === d && !["closed", "cancelled"].includes(b.status));
    const counts = { new: all.filter((b) => b.status === "new").length, survey: all.filter((b) => ["survey", "quoted"].includes(b.status)).length, assigned: all.filter((b) => b.status === "assigned").length, in_progress: all.filter((b) => ["en_route", "on_site", "working"].includes(b.status)).length };
    return { today, counts };
  }, [bookings.data]);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1>{t("dashboard.title")}</h1>
        {can("booking.create") && <Button variant="primary" onClick={() => nav("/bookings/new")}><Plus size={16} /> {t("booking.new")}</Button>}
      </div>
      <AttendanceCard />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(["new", "survey", "assigned", "in_progress"] as const).map((k) => (
          <Link key={k} to="/bookings" className="card p-4 hover:border-blue"><div className="text-xs text-muted">{t(`board.${k}`)}</div><div className="text-2xl font-bold tabular">{counts[k]}</div></Link>
        ))}
      </div>
      <Card title={`${t("tech.today")} · ${fmtDate(new Date().toISOString())}`}>
        {bookings.isLoading ? <Skeleton rows={3} /> : today.length === 0 ? <Empty text={t("tech.no_jobs")} /> : (
          <ul className="divide-y divide-grey-line">
            {today.map((b) => (
              <li key={b.id}><Link to={`/bookings/${b.id}`} className="flex items-center gap-3 py-2 min-h-[48px] hover:bg-grey-bg -mx-2 px-2 rounded">
                <span className="tabular font-bold shrink-0 whitespace-nowrap">{timeRange(b.scheduled_at, b.ends_at)}</span>
                <span className="font-mono text-xs text-muted">{b.number}</span>
                <span className="font-semibold break-words min-w-0">{b.customer_name}</span>
                <span className="text-sm text-muted truncate hidden sm:inline">{(b.technicians ?? []).map((x) => x.full_name).join(", ")}</span>
                <span className="ml-auto"><StatusBadge status={b.status} /></span>
              </Link></li>
            ))}
          </ul>
        )}
      </Card>
      <p className="text-xs text-muted">{t("dashboard.coming")}</p>
    </div>
  );
}
