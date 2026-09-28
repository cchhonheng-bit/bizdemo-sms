import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BOARD_COLUMNS, type BookingStatus } from "@sms/shared";
import { Clock, MapPin, Plus, Users } from "lucide-react";
import { api, fmtDateTime, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, Empty, ErrorState, Input, Skeleton } from "@/components/ui";
import { CategoryBadge, StatusBadge, TypeBadge } from "./parts";

/** Booking board (kanban by status) + list view */
export default function BookingsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can } = useAuth();
  const [view, setView] = useState<"board" | "list">(() => (window.innerWidth < 768 ? "list" : "board"));
  const [q, setQ] = useState("");
  const [hideClosed, setHideClosed] = useState(true);
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: () => api.bookings(), refetchInterval: 60_000 });

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (bookings.data ?? []).filter((b) => (!hideClosed || !["closed", "cancelled"].includes(b.status)) &&
      (!s || b.number.toLowerCase().includes(s) || b.customer_name.toLowerCase().includes(s) || b.service_text.toLowerCase().includes(s) || (b.technicians ?? []).some((x) => x.full_name.toLowerCase().includes(s))));
  }, [bookings.data, q, hideClosed]);

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1>{t("booking.title")}</h1>
        {can("booking.create") && <Button variant="primary" onClick={() => nav("/bookings/new")}><Plus size={16} /> {t("booking.new")}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Input placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="max-w-xs" />
        <label className="flex items-center gap-2 text-sm !mb-0 !text-ink"><input type="checkbox" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} /> {t("booking.hide_closed")}</label>
        <div className="ml-auto flex rounded-md border border-grey-line overflow-hidden text-sm">
          <button className={`px-3 py-1.5 ${view === "board" ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView("board")}>{t("booking.view_board")}</button>
          <button className={`px-3 py-1.5 ${view === "list" ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView("list")}>{t("booking.view_list")}</button>
        </div>
      </div>
      {bookings.isLoading ? <Skeleton /> : bookings.isError ? <ErrorState text={t("app.error")} onRetry={() => void bookings.refetch()} /> : rows.length === 0 ? (
        <Card><Empty text={t("booking.empty")} action={can("booking.create") ? <Button variant="primary" onClick={() => nav("/bookings/new")}>{t("booking.new")}</Button> : undefined} /></Card>
      ) : view === "board" ? <Board rows={rows} /> : <List rows={rows} />}
    </div>
  );
}

function BookingCard({ b }: { b: Booking }) {
  const lead = b.technicians?.find((x) => x.role === "lead");
  return (
    <Link to={`/bookings/${b.id}`} className="block card p-3 hover:border-blue transition-colors" data-testid="booking-card">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-mono text-xs text-muted">{b.number}</span>
        <TypeBadge type={b.type} />
      </div>
      <div className="font-semibold truncate">{b.customer_name}</div>
      <div className="text-sm text-ink line-clamp-2">{b.service_text}</div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1"><Clock size={12} /> {fmtDateTime(b.scheduled_at)}</span>
        {b.zone === "inside" && <span className="inline-flex items-center gap-1"><MapPin size={12} /> {b.zone === "inside" ? "ក្នុងបុរី" : ""}</span>}
        {lead && <span className="inline-flex items-center gap-1"><Users size={12} /> {lead.full_name}{(b.technicians?.length ?? 0) > 1 ? ` +${(b.technicians!.length - 1)}` : ""}</span>}
      </div>
      <div className="mt-2 flex gap-1"><CategoryBadge category={b.category} /><StatusBadge status={b.status} /></div>
    </Link>
  );
}

function Board({ rows }: { rows: Booking[] }) {
  const { t } = useTranslation();
  return (
    <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 snap-x">
      {BOARD_COLUMNS.map((col) => {
        const items = rows.filter((b) => (col.statuses as BookingStatus[]).includes(b.status));
        return (
          <section key={col.key} className="w-[260px] xl:w-auto xl:flex-1 xl:min-w-[200px] shrink-0 snap-start bg-[#EEF0F4] rounded-md p-2" data-testid={`col-${col.key}`}>
            <header className="flex items-center justify-between px-1 py-1 mb-2 text-sm font-bold">{t(`board.${col.key}`)}<span className="badge bg-white text-muted">{items.length}</span></header>
            <div className="space-y-2">{items.map((b) => <BookingCard key={b.id} b={b} />)}</div>
          </section>
        );
      })}
    </div>
  );
}

function List({ rows }: { rows: Booking[] }) {
  const { t } = useTranslation();
  return (
    <>
      <div className="md:hidden space-y-2">{rows.map((b) => <BookingCard key={b.id} b={b} />)}</div>
      <Card className="hidden md:block">
        <div className="overflow-x-auto -mx-4 px-4">
          <table className="table">
            <thead><tr><th>#</th><th>{t("booking.customer")}</th><th>{t("booking.service_text")}</th><th>{t("booking.scheduled_at")}</th><th>{t("booking.team")}</th><th>{t("booking.status")}</th></tr></thead>
            <tbody>
              {rows.map((b) => (
                <tr key={b.id}>
                  <td className="font-mono text-xs"><Link className="text-blue" to={`/bookings/${b.id}`}>{b.number}</Link> <TypeBadge type={b.type} /></td>
                  <td className="font-semibold">{b.customer_name}</td>
                  <td className="max-w-[320px] truncate" title={b.service_text}>{b.service_text}</td>
                  <td className="tabular whitespace-nowrap">{fmtDateTime(b.scheduled_at)}</td>
                  <td className="text-sm">{(b.technicians ?? []).map((x) => x.full_name).join(", ") || "—"}</td>
                  <td><StatusBadge status={b.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </>
  );
}
