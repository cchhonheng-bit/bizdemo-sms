import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BOARD_COLUMNS, SERVICE_CATEGORIES, ZONES, type BookingStatus } from "@sms/shared";
import { Clock, Filter, MapPin, Plus, Users } from "lucide-react";
import { api, fmtDate, type Booking } from "@/lib/api";
import { timeRange } from "./time";
import { useAuth } from "@/lib/auth";
import { Button, Card, Empty, ErrorState, Input, Select, Skeleton } from "@/components/ui";
import { presetRange, shiftDay } from "@/features/reports/range";
import { todayLocal } from "@/features/invoices/util";
import { CategoryBadge, StatusBadge, TypeBadge } from "./parts";

/** Booking board (kanban by status) + list view */
export default function BookingsPage() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const [view, setView] = useState<"board" | "list">(() => (window.innerWidth < 768 ? "list" : "board"));
  const [q, setQ] = useState("");
  const [hideClosed, setHideClosed] = useState(true);
  const [showCancelled, setShowCancelled] = useState(false); // R4: cancelled bookings are kept, shown on demand
  // CEO 04-10: the board follows the technicians' steps within 15 s (cards move column by themselves)
  const bookings = useQuery({ queryKey: ["bookings"], queryFn: () => api.bookings(), refetchInterval: 15_000 });
  // FR-403: filters — day, category, inside/outside borey, technician
  const [showFilters, setShowFilters] = useState(false);
  const [day, setDay] = useState<"" | "today" | "week" | "date">("");
  const [pickDate, setPickDate] = useState(todayLocal());
  const [cat, setCat] = useState("");
  const [zone, setZone] = useState("");
  const [tech, setTech] = useState("");
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic, enabled: me?.role !== "tech" }); // technicians never read the staff list
  const techs = (users.data ?? []).filter((u) => u.role === "tech");
  const active = [day, cat, zone, tech].filter(Boolean).length;

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const today = todayLocal();
    const monday = presetRange("week", today)[0];
    const [from, to] = day === "today" ? [today, today] : day === "week" ? [monday, shiftDay(monday, 6)] : day === "date" ? [pickDate, pickDate] : ["", ""];
    const localDay = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString("en-CA", { timeZone: "Asia/Phnom_Penh" }) : "");
    return (bookings.data ?? []).filter((b) => (b.status === "cancelled" ? showCancelled : !hideClosed || b.status !== "closed") &&
      (!s || b.number.toLowerCase().includes(s) || b.customer_name.toLowerCase().includes(s) || b.service_text.toLowerCase().includes(s) || (b.technicians ?? []).some((x) => x.full_name.toLowerCase().includes(s))) &&
      (!day || (localDay(b.scheduled_at) >= from && localDay(b.scheduled_at) <= to)) && (!cat || b.category === cat) && (!zone || b.zone === zone) &&
      (!tech || (b.technicians ?? []).some((x) => x.user_id === tech)));
  }, [bookings.data, q, hideClosed, showCancelled, day, pickDate, cat, zone, tech]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between mb-4 gap-3">
        <h1>{t("booking.title")}</h1>
        {can("booking.create") && <Button variant="primary" onClick={() => nav("/bookings/new")}><Plus size={16} /> {t("booking.new")}</Button>}
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-3">
        <Input type="search" placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:max-w-xs" />
        <label className="flex items-center gap-2 text-sm !mb-0 !text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={hideClosed} onChange={(e) => setHideClosed(e.target.checked)} /> {t("booking.hide_closed")}</label>
        <label className="flex items-center gap-2 text-sm !mb-0 !text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={showCancelled} onChange={(e) => setShowCancelled(e.target.checked)} data-testid="show-cancelled" /> {t("booking.show_cancelled")}</label>
        <Button type="button" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters} data-testid="filters-toggle"><Filter size={16} /> {t("booking.filters")}{active ? ` (${active})` : ""}</Button>
        <div className="ml-auto flex rounded-md border border-grey-line overflow-hidden text-sm">
          <button className={`px-4 min-h-[44px] md:min-h-[36px] ${view === "board" ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView("board")}>{t("booking.view_board")}</button>
          <button className={`px-4 min-h-[44px] md:min-h-[36px] ${view === "list" ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView("list")}>{t("booking.view_list")}</button>
        </div>
      </div>
      {showFilters && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mb-3" data-testid="filters">
          <Select value={day} onChange={(e) => setDay(e.target.value as typeof day)} aria-label={t("booking.f_day")}>
            <option value="">{t("booking.f_day_all")}</option><option value="today">{t("range.today")}</option><option value="week">{t("range.week")}</option><option value="date">{t("booking.f_day_pick")}</option>
          </Select>
          {day === "date" ? <Input type="date" value={pickDate} onChange={(e) => e.target.value && setPickDate(e.target.value)} aria-label={t("booking.f_day_pick")} /> : null}
          <Select value={cat} onChange={(e) => setCat(e.target.value)} aria-label={t("booking.category")}><option value="">{t("booking.f_cat_all")}</option>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}</Select>
          <Select value={zone} onChange={(e) => setZone(e.target.value)} aria-label={t("customers.zone")}><option value="">{t("booking.f_zone_all")}</option>{ZONES.map((z) => <option key={z} value={z}>{t(`zone.${z}`)}</option>)}</Select>
          <Select value={tech} onChange={(e) => setTech(e.target.value)} aria-label={t("booking.team")}><option value="">{t("booking.f_tech_all")}</option>{techs.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select>
          {active > 0 && <Button type="button" onClick={() => { setDay(""); setCat(""); setZone(""); setTech(""); }}>{t("booking.f_clear")}</Button>}
        </div>
      )}
      {bookings.isLoading ? <Skeleton /> : bookings.isError ? <ErrorState text={t("app.error")} onRetry={() => void bookings.refetch()} /> : rows.length === 0 ? (
        <Card><Empty text={t("booking.empty")} action={can("booking.create") ? <Button variant="primary" onClick={() => nav("/bookings/new")}>{t("booking.new")}</Button> : undefined} /></Card>
      ) : view === "board" ? <Board rows={rows} /> : <List rows={rows} />}
    </div>
  );
}

function BookingCard({ b }: { b: Booking }) {
  const { t } = useTranslation();
  const lead = b.technicians?.find((x) => x.role === "lead") ?? b.technicians?.[0];
  return (
    <Link to={`/bookings/${b.id}`} className={`block card p-3 hover:border-blue transition-colors ${b.status === "cancelled" ? "opacity-70" : ""}`} data-testid="booking-card">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="font-mono text-xs text-muted">{b.number}</span>
        <TypeBadge type={b.type} />
      </div>
      <div className="font-semibold break-words">{b.customer_name}</div>
      <div className="text-sm text-ink line-clamp-2">{b.service_text}</div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
        <span className="inline-flex items-center gap-1 tabular"><Clock size={12} /> {b.scheduled_at ? `${fmtDate(b.scheduled_at)} · ${timeRange(b.scheduled_at, b.ends_at)}` : "—"}</span>
        {b.zone === "inside" && <span className="inline-flex items-center gap-1"><MapPin size={12} /> {t("zone.inside")}</span>}
        {lead && <span className="inline-flex items-center gap-1"><Users size={12} /> {lead.full_name}{(b.technicians?.length ?? 0) > 1 ? ` +${(b.technicians!.length - 1)}` : ""}</span>}
      </div>
      <div className="mt-2 flex gap-1"><CategoryBadge category={b.category} /><StatusBadge status={b.status} />{b.web_status === "pending" && <span className="badge bg-warning-50 text-warning">🌐</span>}{b.is_test && <span className="badge bg-grey-bg text-muted" title={t("requests.test")}>🧪</span>}</div>
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
                  <td className="tabular whitespace-nowrap">{b.scheduled_at ? `${fmtDate(b.scheduled_at)} · ${timeRange(b.scheduled_at, b.ends_at)}` : "—"}</td>
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
