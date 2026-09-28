import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ASSIGNABLE_STATUSES, EDITABLE_STATUSES } from "@sms/shared";
import { ArrowLeft, Pencil, Phone, UserPlus } from "lucide-react";
import { api, errCode, fmtDateTime, fromLocalInput, toLocalInput, type Booking } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { CategoryBadge, DirectionLink, StatusBadge, TypeBadge } from "./parts";
import { toast } from "@/lib/toast";

export default function BookingDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const [assign, setAssign] = useState(false);
  const b = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!) });
  const log = useQuery({ queryKey: ["booking-log", id], queryFn: () => api.statusLog(id!) });
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic, enabled: me?.role !== "tech" });
  const nameOf = (uid: string | null) => users.data?.find((u) => u.id === uid)?.full_name ?? "";

  if (b.isLoading) return <Skeleton />;
  if (b.isError || !b.data) return <ErrorState text={t("booking.err.NOT_FOUND")} onRetry={() => void b.refetch()} />;
  const bk = b.data;
  const canAssign = can("booking.assign") && ASSIGNABLE_STATUSES.includes(bk.status) && !(bk.type === "B" && me?.role === "admin");
  const canEdit = can("booking.create") && EDITABLE_STATUSES.includes(bk.status);
  const lead = bk.technicians?.find((x) => x.role === "lead");
  const assistants = bk.technicians?.filter((x) => x.role === "assistant") ?? [];

  return (
    <div className="max-w-4xl">
      <div className="flex items-center gap-3 mb-4">
        <Link to="/bookings" className="p-1.5 rounded hover:bg-grey-bg" aria-label="back"><ArrowLeft size={18} /></Link>
        <h1 className="font-mono">{bk.number}</h1>
        <TypeBadge type={bk.type} /><StatusBadge status={bk.status} />
        <div className="ml-auto flex gap-2">
          {canEdit && <Button onClick={() => nav(`/bookings/${bk.id}/edit`)}><Pencil size={16} /> {t("app.edit")}</Button>}
          {canAssign && <Button variant="primary" onClick={() => setAssign(true)} data-testid="assign-btn"><UserPlus size={16} /> {bk.status === "assigned" ? t("booking.reassign") : t("booking.assign")}</Button>}
        </div>
      </div>
      {bk.type === "B" && me?.role === "admin" && ASSIGNABLE_STATUSES.includes(bk.status) && <p className="text-sm text-muted mb-3">{t("booking.type_b_gm_only")}</p>}
      {bk.status === "survey" && <p className="text-sm text-purple mb-3">{t("booking.survey_hint")}</p>}

      <div className="grid md:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4">
          <Card title={t("booking.customer")}>
            <div className="font-semibold text-base">{bk.customer_name}</div>
            <div className="flex flex-wrap gap-2 mt-1">
              {bk.customer_phones.map((p) => <a key={p} href={`tel:${p}`} className="badge bg-blue-50 text-blue inline-flex items-center gap-1"><Phone size={12} /> {p}</a>)}
            </div>
            <div className="text-sm mt-2">{bk.address ?? "—"} <Badge tone={bk.zone === "inside" ? "green" : "grey"}>{t(`zone.${bk.zone}`)}</Badge></div>
            <div className="mt-3 flex gap-2 items-center"><DirectionLink lat={bk.lat} lng={bk.lng} />{bk.lat == null && <span className="text-sm text-muted">{t("booking.location_none")}</span>}</div>
          </Card>
          <Card title={t("booking.job")}>
            <div className="flex gap-2 mb-2"><CategoryBadge category={bk.category} /></div>
            <p className="whitespace-pre-wrap">{bk.service_text}</p>
            <dl className="mt-3 text-sm grid grid-cols-[130px_1fr] gap-y-1">
              <dt className="text-muted">{t("booking.scheduled_at")}</dt><dd className="tabular">{fmtDateTime(bk.scheduled_at)}</dd>
              <dt className="text-muted">{t("booking.vehicle")}</dt><dd>{bk.vehicle_code ?? "—"}</dd>
              <dt className="text-muted">{t("booking.notes")}</dt><dd>{bk.notes ?? "—"}</dd>
              <dt className="text-muted">{t("booking.created_by")}</dt><dd>{nameOf(bk.created_by) || "—"} · {fmtDateTime(bk.created_at)}</dd>
            </dl>
          </Card>
        </div>
        <div className="space-y-4">
          <Card title={t("booking.team")}>
            {!bk.technicians?.length ? <p className="text-sm text-muted">{t("booking.no_team")}</p> : (
              <ul className="space-y-1 text-sm">
                {lead && <li className="font-semibold">👷 {lead.full_name} <Badge tone="navy">{t("booking.lead")}</Badge></li>}
                {assistants.map((a) => <li key={a.user_id}>{a.full_name} <Badge>{t("booking.assistant")}</Badge></li>)}
              </ul>
            )}
          </Card>
          <Card title={t("booking.timeline")}>
            {log.isLoading ? <Skeleton rows={3} /> : (
              <ol className="relative border-l border-grey-line ml-2 space-y-3 text-sm">
                {(log.data ?? []).map((l) => (
                  <li key={l.id} className="ml-4">
                    <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full bg-navy" />
                    <div><StatusBadge status={l.to_status} /></div>
                    <div className="text-xs text-muted tabular">{fmtDateTime(l.at)}{nameOf(l.by) ? ` · ${nameOf(l.by)}` : ""}</div>
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
      {assign && <AssignDialog booking={bk} onClose={() => setAssign(false)} />}
    </div>
  );
}

/** Assign drawer (FR-401/402): lead + assistants + vehicle + schedule, with availability */
function AssignDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [lead, setLead] = useState(booking.technicians?.find((x) => x.role === "lead")?.user_id ?? "");
  const [assistants, setAssistants] = useState<string[]>(booking.technicians?.filter((x) => x.role === "assistant").map((x) => x.user_id) ?? []);
  const [vehicle, setVehicle] = useState(booking.vehicle_id ?? "");
  const [when, setWhen] = useState(toLocalInput(booking.scheduled_at));
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: api.vehicles });
  const whenIso = fromLocalInput(when);
  const avail = useQuery({ queryKey: ["availability", whenIso], queryFn: () => api.availability(whenIso!), enabled: !!whenIso });
  const people = useMemo(() => avail.data ?? [], [avail.data]);
  useEffect(() => { if (assistants.includes(lead)) setAssistants((a) => a.filter((x) => x !== lead)); }, [lead, assistants]);

  const m = useMutation({
    mutationFn: () => api.assignBooking({ id: booking.id, lead, assistants, vehicle_id: vehicle || null, scheduled_at: whenIso! }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["booking", booking.id] }); void qc.invalidateQueries({ queryKey: ["booking-log", booking.id] }); void qc.invalidateQueries({ queryKey: ["bookings"] });
      api.flushTelegram();
      toast.success(r.conflicts.length ? t("booking.assigned_conflicts", { n: r.conflicts.length }) : t("booking.assigned_ok"));
      onClose();
    },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const busyText = (p: { busy: { number: string; scheduled_at: string }[] }) => p.busy.length ? `⚠ ${p.busy.map((x) => `${x.number} ${fmtDateTime(x.scheduled_at)}`).join(", ")}` : "";

  return (
    <Dialog open onClose={onClose} title={`${t("booking.assign")} · ${booking.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" loading={m.isPending} disabled={!lead || !whenIso} onClick={() => m.mutate()} data-testid="assign-submit">{t("booking.confirm_assign")}</Button>
    </>}>
      <Field label={t("booking.scheduled_at")} required><Input type="datetime-local" name="assign_when" value={when} onChange={(e) => setWhen(e.target.value)} /></Field>
      <Field label={t("booking.lead")} required hint={t("booking.lead_hint")}>
        <Select name="lead" value={lead} onChange={(e) => setLead(e.target.value)}>
          <option value="">—</option>
          {people.map((p) => <option key={p.user_id} value={p.user_id}>{p.full_name} ({t(`roles.${p.role}`)}) {busyText(p)}</option>)}
        </Select>
      </Field>
      <Field label={t("booking.assistants")}>
        {!whenIso ? <p className="text-sm text-muted">{t("booking.pick_time_first")}</p> : avail.isLoading ? <Skeleton rows={3} /> : (
          <div className="grid sm:grid-cols-2 gap-1 max-h-56 overflow-auto">
            {people.filter((p) => p.user_id !== lead).map((p) => (
              <label key={p.user_id} className="flex items-center gap-2 text-sm !text-ink !mb-0 py-1">
                <input type="checkbox" checked={assistants.includes(p.user_id)} onChange={(e) => setAssistants((a) => e.target.checked ? [...a, p.user_id] : a.filter((x) => x !== p.user_id))} />
                <span>{p.full_name}</span>{p.busy.length > 0 && <span className="text-xs text-warning">{busyText(p)}</span>}
              </label>
            ))}
          </div>
        )}
      </Field>
      <Field label={t("booking.vehicle")}>
        <Select name="vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)}><option value="">—</option>{(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.code}{v.plate ? ` · ${v.plate}` : ""}</option>)}</Select>
      </Field>
      <p className="text-xs text-muted">{t("booking.assign_notify_hint")}</p>
    </Dialog>
  );
}
