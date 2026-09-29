import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Clock, MapPin, Phone } from "lucide-react";
import { api, fmtDate, type Booking } from "@/lib/api";
import { timeRange } from "@/features/bookings/time";
import { useAuth } from "@/lib/auth";
import { Badge, Card, Empty, ErrorState, Skeleton } from "@/components/ui";
import { CategoryBadge, DirectionLink, StatusBadge } from "@/features/bookings/parts";

const OPEN = ["assigned", "en_route", "on_site", "working", "work_done", "pending_review", "revision"];

/** Technician home: my jobs (today first, then upcoming) — checkpoints arrive in M3 */
export default function TechTodayPage() {
  const { t } = useTranslation();
  const { me } = useAuth();
  const jobs = useQuery({ queryKey: ["bookings", "mine"], queryFn: () => api.bookings(), refetchInterval: 60_000 });
  const { today, upcoming } = useMemo(() => {
    const all = (jobs.data ?? []).filter((b) => OPEN.includes(b.status));
    const d = fmtDate(new Date().toISOString());
    return { today: all.filter((b) => fmtDate(b.scheduled_at) === d), upcoming: all.filter((b) => fmtDate(b.scheduled_at) !== d) };
  }, [jobs.data]);

  return (
    <div className="space-y-4">
      <h1>{t("tech.hello", { name: me?.full_name ?? "" })}</h1>
      <section>
        <h2 className="text-base mb-2">{t("tech.today")} <Badge tone="navy">{today.length}</Badge></h2>
        {jobs.isLoading ? <Skeleton rows={3} /> : jobs.isError ? <ErrorState text={t("app.error")} onRetry={() => void jobs.refetch()} /> : today.length === 0 ? <Card><Empty text={t("tech.no_jobs")} /></Card> : (
          <div className="space-y-2">{today.map((b) => <JobCard key={b.id} b={b} />)}</div>
        )}
      </section>
      {upcoming.length > 0 && (
        <section>
          <h2 className="text-base mb-2">{t("tech.upcoming")} <Badge>{upcoming.length}</Badge></h2>
          <div className="space-y-2">{upcoming.map((b) => <JobCard key={b.id} b={b} />)}</div>
        </section>
      )}
    </div>
  );
}

function JobCard({ b }: { b: Booking }) {
  const me = useAuth((s) => s.me);
  const { t } = useTranslation();
  const isLead = b.technicians?.some((x) => x.user_id === me?.id && x.role === "lead");
  return (
    <Link to={`/tech/job/${b.id}`} className="block card p-3 hover:border-blue" data-testid="job-card">
      <div className="flex items-center justify-between">
        <span className="font-bold text-lg tabular inline-flex items-center gap-1"><Clock size={16} /> {timeRange(b.scheduled_at, b.ends_at)}</span>
        <div className="flex gap-1">{isLead && <Badge tone="navy">{t("booking.lead")}</Badge>}<StatusBadge status={b.status} /></div>
      </div>
      <div className="font-semibold mt-1">{b.customer_name}</div>
      <div className="text-sm line-clamp-2">{b.service_text}</div>
      <div className="text-xs text-muted mt-1 inline-flex items-center gap-1"><MapPin size={12} /> {b.address ?? "—"}</div>
    </Link>
  );
}

export function TechJobPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const b = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!) });
  if (b.isLoading) return <Skeleton />;
  if (b.isError || !b.data) return <ErrorState text={t("booking.err.NOT_FOUND")} onRetry={() => void b.refetch()} />;
  const bk = b.data;
  return (
    <div className="space-y-3 max-w-xl">
      <div className="flex items-center gap-2"><Link to="/tech" className="tap-target rounded hover:bg-grey-bg" aria-label="back"><ArrowLeft size={18} /></Link><h1 className="font-mono">{bk.number}</h1><StatusBadge status={bk.status} /></div>
      <Card>
        <div className="text-2xl font-bold tabular">{bk.scheduled_at ? `${fmtDate(bk.scheduled_at)} · ${timeRange(bk.scheduled_at, bk.ends_at)}` : "—"}</div>
        {bk.status === "cancelled" && <div className="card border-danger bg-danger-50 p-3 mt-2 text-sm break-words" role="alert">❌ {bk.cancel_reason}</div>}
        <div className="font-semibold text-lg mt-2">{bk.customer_name}</div>
        <div className="flex flex-wrap gap-2 mt-1">{bk.customer_phones.map((p) => <a key={p} href={`tel:${p}`} className="btn-secondary"><Phone size={16} /> {p}</a>)}</div>
        <div className="text-sm mt-2">{bk.address ?? "—"} <Badge tone={bk.zone === "inside" ? "green" : "grey"}>{t(`zone.${bk.zone}`)}</Badge></div>
        <div className="mt-3"><DirectionLink lat={bk.lat} lng={bk.lng} size="lg" /></div>
      </Card>
      <Card title={t("booking.job")}>
        <CategoryBadge category={bk.category} />
        <p className="mt-2 whitespace-pre-wrap">{bk.service_text}</p>
        {bk.notes && <p className="mt-2 text-sm text-muted">📝 {bk.notes}</p>}
        {bk.vehicle_code && <p className="mt-2 text-sm">🚐 {bk.vehicle_code}</p>}
      </Card>
      <Card title={t("booking.team")}>
        <ul className="text-sm space-y-1">{(bk.technicians ?? []).map((x) => <li key={x.user_id}>{x.full_name} {x.role === "lead" && <Badge tone="navy">{t("booking.lead")}</Badge>}</li>)}</ul>
      </Card>
      <p className="text-xs text-muted">{t("tech.checkpoints_m3")}</p>
    </div>
  );
}
