// Check in / out by GPS (Flow 5 · FR-901 · BR-23 · AC-12): one big button on the technician home and the GM/Admin dashboard.
// Server time only; outside the office circle or without GPS the press is kept and flagged «ក្រៅរង្វង់» for GM / CEO.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut, MapPin, MapPinOff } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { readGps } from "@/lib/offline";
import { Badge, Button, Card } from "@/components/ui";
import { toast } from "@/lib/toast";

const hm = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh" });

export default function AttendanceCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["attendance-today"], queryFn: api.attendance.today, refetchInterval: 5 * 60_000 });
  const [busy, setBusy] = useState(false);
  if (!q.data?.tracks) return null;
  const r = q.data.record;
  const kind: "in" | "out" | null = !r ? "in" : !r.out_at ? "out" : null;
  const press = async () => {
    if (!kind) return;
    if (!navigator.onLine) { toast.error(t("attendance.need_online")); return; }
    setBusy(true);
    try {
      const gps = await readGps();
      const res = await api.attendance.check({ kind, lat: gps?.lat ?? null, lng: gps?.lng ?? null, accuracy: gps?.accuracy ?? null, no_gps: !gps });
      if (res.no_gps) toast.info(t("attendance.saved_no_gps")); // saved, only flagged for the GM
      else if (res.out_of_range) toast.info(t("attendance.saved_far", { m: res.distance_m ?? "?" }));
      else toast.success(t(kind === "in" ? "attendance.in_ok" : "attendance.out_ok", { time: hm(res.at) }));
      await qc.invalidateQueries({ queryKey: ["attendance-today"] });
    } catch (e) { toast.error(t(`attendance.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setBusy(false);
  };
  const flag = (far: boolean, noGps: boolean, m: number | null) => noGps ? <Badge tone="warning"><MapPinOff size={12} /> {t("attendance.no_gps")}</Badge>
    : far ? <Badge tone="warning"><MapPin size={12} /> {t("attendance.far", { m: m ?? "?" })}</Badge> : null;
  return (
    <Card title={t("attendance.today_title")} actions={<span className="text-xs text-muted">{q.data.work_start}–{q.data.work_end}</span>}>
      {r && (
        <div className="text-sm space-y-1 mb-3">
          <div className="flex flex-wrap items-center gap-2"><LogIn size={16} className="text-success" /> {t("attendance.in")} <b className="tabular">{hm(r.in_at)}</b> {flag(r.in_out_of_range, r.in_no_gps, r.in_distance_m)}</div>
          {r.out_at && <div className="flex flex-wrap items-center gap-2"><LogOut size={16} className="text-navy" /> {t("attendance.out")} <b className="tabular">{hm(r.out_at)}</b> {flag(r.out_out_of_range, r.out_no_gps, r.out_distance_m)}</div>}
        </div>
      )}
      {kind ? (
        <Button variant={kind === "in" ? "primary" : "secondary"} className="w-full !min-h-[56px] text-base" loading={busy} onClick={() => void press()} data-testid={`attendance-${kind}`}>
          {kind === "in" ? <LogIn size={20} /> : <LogOut size={20} />} {t(kind === "in" ? "attendance.check_in" : "attendance.check_out")}
        </Button>
      ) : <p className="text-sm text-success font-semibold">✅ {t("attendance.done")}</p>}
      {!q.data.office_set && <p className="text-xs text-muted mt-2">{t("attendance.office_not_set")}</p>}
    </Card>
  );
}
