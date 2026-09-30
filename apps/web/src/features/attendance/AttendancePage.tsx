// Attendance report (Flow 5 · FR-904): present, late (minutes), absent, leave, minutes after work end, «out of range» flags (AC-12).
// Team view for report.ops (GM, Admin, CEO, CFO); «mine» for everyone who records attendance. Sundays / holidays never count as absent.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, MapPin } from "lucide-react";
import { api, type AttendanceDay, type AttendancePerson } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Card, Empty, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { todayLocal } from "@/features/invoices/util";

const TONE: Record<AttendanceDay["status"], "green" | "warning" | "danger" | "blue" | "grey" | "purple"> = {
  present: "green", late: "warning", absent: "danger", leave: "blue", holiday: "purple", off: "grey", pending: "grey", none: "grey",
};
const shift = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
function presets(today: string) {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Mon 0
  const month = today.slice(0, 8) + "01";
  const lastMonthEnd = shift(month, -1);
  return { week: [shift(today, -dow), today], month: [month, today], last: [lastMonthEnd.slice(0, 8) + "01", lastMonthEnd] } as const;
}

export default function AttendancePage() {
  const { t } = useTranslation();
  const { can, me } = useAuth();
  const team = can("report.ops");
  const mine = !!me && ["gm", "admin", "tech"].includes(me.role);
  const [view, setView] = useState<"team" | "mine">(team ? "team" : "mine");
  const today = todayLocal();
  const p = useMemo(() => presets(today), [today]);
  const [range, setRange] = useState<readonly [string, string]>(p.month);
  const q = useQuery({
    queryKey: ["attendance", view, range[0], range[1]],
    queryFn: async () => view === "team" ? (await api.attendance.report(range[0], range[1])).users : [await api.attendance.me(range[0], range[1])].filter((x): x is AttendancePerson => !!x),
    enabled: range[0] <= range[1],
  });
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("attendance.title")}</h1>
      {team && mine && (
        <div className="flex rounded-md border border-grey-line overflow-hidden text-sm" role="tablist">
          {(["team", "mine"] as const).map((v) => <button key={v} role="tab" aria-selected={view === v} className={`flex-1 px-3 min-h-[44px] ${view === v ? "bg-navy text-white" : "bg-white"}`} onClick={() => setView(v)}>{t(`attendance.view_${v}`)}</button>)}
        </div>
      )}
      <Card>
        <div className="flex flex-wrap gap-2 mb-2">
          {(["week", "month", "last"] as const).map((k) => (
            <button key={k} type="button" className={`px-3 min-h-[44px] rounded-md border text-sm ${range[0] === p[k][0] && range[1] === p[k][1] ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`} onClick={() => setRange(p[k])}>{t(`attendance.range_${k}`)}</button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("attendance.from")}><Input type="date" value={range[0]} max={range[1]} onChange={(e) => e.target.value && setRange([e.target.value, range[1]])} /></Field>
          <Field label={t("attendance.to")}><Input type="date" value={range[1]} min={range[0]} onChange={(e) => e.target.value && setRange([range[0], e.target.value])} /></Field>
        </div>
      </Card>
      {q.isLoading ? <Skeleton /> : q.isError ? <ErrorState text={t("attendance.err.range")} onRetry={() => void q.refetch()} /> : !q.data?.length ? <Card><Empty text={t("attendance.none")} /></Card>
        : q.data.map((u) => <PersonCard key={u.user_id} u={u} open={view === "mine" || q.data.length === 1} />)}
    </div>
  );
}

function PersonCard({ u, open: initial }: { u: AttendancePerson; open: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initial);
  const min = (n: number) => (n >= 60 ? t("attendance.h_min", { h: Math.floor(n / 60), m: n % 60 }) : t("attendance.min", { n }));
  const days = u.days.filter((d) => d.status !== "none");
  return (
    <Card>
      <button type="button" className="w-full text-left flex items-start gap-2 min-h-[44px]" onClick={() => setOpen(!open)} aria-expanded={open} data-testid="att-person">
        <div className="flex-1 min-w-0">
          <div className="font-semibold break-words">{u.full_name} <span className="text-xs text-muted font-normal">· {t(`roles.${u.role}`)}</span></div>
          <div className="flex flex-wrap gap-1 mt-1 text-xs">
            <Badge tone="green">{t("attendance.s.present")} {u.present}</Badge>
            {u.late_count > 0 && <Badge tone="warning">{t("attendance.s.late")} {u.late_count} · {min(u.late_min)}</Badge>}
            {u.absent > 0 && <Badge tone="danger">{t("attendance.s.absent")} {u.absent}</Badge>}
            {u.leave > 0 && <Badge tone="blue">{t("attendance.s.leave")} {u.leave}</Badge>}
            {u.ot_min > 0 && <Badge tone="navy">{t("attendance.ot")} {min(u.ot_min)}</Badge>}
            {u.out_of_range > 0 && <Badge tone="warning"><MapPin size={12} /> {u.out_of_range}</Badge>}
          </div>
        </div>
        {open ? <ChevronUp size={20} className="shrink-0 mt-1" /> : <ChevronDown size={20} className="shrink-0 mt-1" />}
      </button>
      {open && (
        <ul className="mt-2 divide-y divide-grey-line text-sm">
          {days.length === 0 && <li className="py-2 text-muted">{t("attendance.none")}</li>}
          {[...days].reverse().map((d) => (
            <li key={d.date} className="py-2 flex items-start gap-2">
              <span className="w-[88px] shrink-0 tabular">{d.date.slice(8)}/{d.date.slice(5, 7)} <span className="text-xs text-muted">{t(`attendance.dow.${new Date(`${d.date}T00:00:00Z`).getUTCDay()}`)}</span></span>
              <div className="flex-1 min-w-0">
                <Badge tone={TONE[d.status]}>{t(`attendance.s.${d.status}`)}{d.leave_part && d.leave_part !== "full" ? ` (${t(`leave.part.${d.leave_part}`)})` : ""}</Badge>
                {d.in && <span className="ml-2 tabular">{d.in}–{d.out ?? "?"}</span>}
                <div className="flex flex-wrap gap-1 mt-1">
                  {!!d.late_min && <span className="text-xs text-warning">{t("attendance.late_by", { t: min(d.late_min) })}</span>}
                  {!!d.ot_min && <span className="text-xs text-navy">{t("attendance.ot")} {min(d.ot_min)}</span>}
                  {d.out_of_range && <span className="text-xs text-warning inline-flex items-center gap-0.5"><MapPin size={12} />{d.no_gps ? t("attendance.no_gps") : t("attendance.far", { m: Math.max(d.distance_in ?? 0, d.distance_out ?? 0) })}</span>}
                  {d.missing_out && <span className="text-xs text-danger">{t("attendance.missing_out")}</span>}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
