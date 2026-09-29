import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ASSIGNABLE_STATUSES, CANCELLABLE_STATUSES, EDITABLE_STATUSES } from "@sms/shared";
import { ArrowLeft, Ban, Pencil, Phone, UserPlus } from "lucide-react";
import { api, errCode, fmtDate, fmtDateTime, type Booking, type Conflict } from "@/lib/api";
import { ApiError } from "@/lib/http";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { CategoryBadge, DirectionLink, StatusBadge, TypeBadge } from "./parts";
import { toast } from "@/lib/toast";
import { addMinutesLocal, isPastLocal, joinLocal, splitLocal, timeRange, todayLocal } from "./time";

export default function BookingDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const { can, me } = useAuth();
  const [assign, setAssign] = useState(false);
  const [cancel, setCancel] = useState(false);
  const b = useQuery({ queryKey: ["booking", id], queryFn: () => api.booking(id!) });
  const log = useQuery({ queryKey: ["booking-log", id], queryFn: () => api.statusLog(id!) });
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic, enabled: me?.role !== "tech" });
  const nameOf = (uid: string | null) => users.data?.find((u) => u.id === uid)?.full_name ?? "";

  if (b.isLoading) return <Skeleton />;
  if (b.isError || !b.data) return <ErrorState text={t("booking.err.NOT_FOUND")} onRetry={() => void b.refetch()} />;
  const bk = b.data;
  const canAssign = can("booking.assign") && ASSIGNABLE_STATUSES.includes(bk.status) && !(bk.type === "B" && me?.role === "admin");
  const canEdit = can("booking.create") && EDITABLE_STATUSES.includes(bk.status);
  const canCancel = can("cancel.request") && CANCELLABLE_STATUSES.includes(bk.status);
  const lead = bk.technicians?.find((x) => x.role === "lead");
  const crew = bk.technicians?.filter((x) => x.role === "assistant") ?? [];

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mb-4">
        <Link to="/bookings" className="tap-target rounded hover:bg-grey-bg" aria-label="back"><ArrowLeft size={20} /></Link>
        <h1 className="font-mono">{bk.number}</h1>
        <TypeBadge type={bk.type} /><StatusBadge status={bk.status} />
        <div className="w-full sm:w-auto sm:ml-auto flex flex-wrap gap-2">
          {canEdit && <Button onClick={() => nav(`/bookings/${bk.id}/edit`)}><Pencil size={16} /> {t("app.edit")}</Button>}
          {canCancel && <Button variant="danger" onClick={() => setCancel(true)} data-testid="cancel-btn"><Ban size={16} /> {t("booking.cancel")}</Button>}
          {canAssign && <Button variant="primary" className="flex-1 sm:flex-none" onClick={() => setAssign(true)} data-testid="assign-btn"><UserPlus size={16} /> {bk.status === "assigned" ? t("booking.reassign") : t("booking.assign")}</Button>}
        </div>
      </div>
      {bk.status === "cancelled" && (
        <div className="card border-danger bg-danger-50 p-3 mb-3 text-sm" role="status">
          <b>{t("booking.cancelled_banner")}</b> · {fmtDateTime(bk.cancelled_at)}{nameOf((bk as Booking & { cancelled_by?: string }).cancelled_by ?? null) ? ` · ${nameOf((bk as Booking & { cancelled_by?: string }).cancelled_by ?? null)}` : ""}
          <div className="mt-1 break-words">{t("booking.cancel_reason")}: {bk.cancel_reason}</div>
        </div>
      )}
      {bk.type === "B" && me?.role === "admin" && ASSIGNABLE_STATUSES.includes(bk.status) && <p className="text-sm text-muted mb-3">{t("booking.type_b_gm_only")}</p>}
      {bk.status === "survey" && <p className="text-sm text-purple mb-3">{t("booking.survey_hint")}</p>}

      <div className="grid md:grid-cols-[1fr_320px] gap-4">
        <div className="space-y-4 min-w-0">
          <Card title={t("booking.customer")}>
            <div className="font-semibold text-base break-words">{bk.customer_name}</div>
            <div className="flex flex-wrap gap-2 mt-2">
              {bk.customer_phones.map((p) => <a key={p} href={`tel:${p}`} className="btn-secondary !h-11"><Phone size={16} /> {p}</a>)}
            </div>
            <div className="text-sm mt-2 break-words">{bk.address ?? "—"} <Badge tone={bk.zone === "inside" ? "green" : "grey"}>{t(`zone.${bk.zone}`)}</Badge></div>
            <div className="mt-3 flex gap-2 items-center"><DirectionLink lat={bk.lat} lng={bk.lng} />{bk.lat == null && <span className="text-sm text-muted">{t("booking.location_none")}</span>}</div>
          </Card>
          <Card title={t("booking.job")}>
            <div className="flex gap-2 mb-2"><CategoryBadge category={bk.category} /></div>
            <p className="whitespace-pre-wrap break-words">{bk.service_text}</p>
            <dl className="mt-3 text-sm grid grid-cols-[110px_1fr] gap-y-1.5">
              <dt className="text-muted">{t("booking.scheduled_at")}</dt><dd className="tabular">{bk.scheduled_at ? `${fmtDate(bk.scheduled_at)} · ${timeRange(bk.scheduled_at, bk.ends_at)}` : "—"}</dd>
              <dt className="text-muted">{t("booking.vehicle")}</dt><dd>{bk.vehicle_code ?? "—"}</dd>
              <dt className="text-muted">{t("booking.notes")}</dt><dd className="break-words">{bk.notes ?? "—"}</dd>
              <dt className="text-muted">{t("booking.created_by")}</dt><dd>{nameOf(bk.created_by) || "—"} · {fmtDateTime(bk.created_at)}</dd>
            </dl>
          </Card>
        </div>
        <div className="space-y-4 min-w-0">
          <Card title={t("booking.team")}>
            {!bk.technicians?.length ? <p className="text-sm text-muted">{t("booking.no_team")}</p> : (
              <ul className="space-y-1 text-sm">
                {lead && <li className="font-semibold">👷 {lead.full_name} <Badge tone="navy">{t("booking.lead")}</Badge></li>}
                {crew.map((a) => <li key={a.user_id}>👷 {a.full_name}</li>)}
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
                    {l.note && <div className="text-xs break-words">{l.note}</div>}
                  </li>
                ))}
              </ol>
            )}
          </Card>
        </div>
      </div>
      {assign && <AssignDialog booking={bk} onClose={() => setAssign(false)} />}
      {cancel && <CancelDialog booking={bk} onClose={() => setCancel(false)} />}
    </div>
  );
}

const conflictText = (c: Conflict[] | undefined) => (c ?? []).map((x) => `${x.full_name ?? x.code ?? ""} · ${x.number} ${timeRange(x.scheduled_at, x.ends_at)}`).join(", ");

/** R1/R2/R5 — pick a crew from technicians FREE for the window only; lead optional; at least one technician */
function AssignDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const s0 = splitLocal(booking.scheduled_at), e0 = splitLocal(booking.ends_at);
  const future = booking.scheduled_at && !isPastLocal(booking.scheduled_at);
  const [date, setDate] = useState(future ? s0.date : "");
  const [start, setStart] = useState(future ? s0.time : "");
  const [end, setEnd] = useState(future ? e0.time : "");
  const [team, setTeam] = useState<string[]>(booking.technicians?.map((x) => x.user_id) ?? []);
  const [lead, setLead] = useState(booking.technicians?.find((x) => x.role === "lead")?.user_id ?? "");
  const [vehicle, setVehicle] = useState(booking.vehicle_id ?? "");
  const [showBusy, setShowBusy] = useState(false);
  const fromIso = date && start ? joinLocal(date, start) : null;
  const toIso = date && end ? joinLocal(date, end) : null;
  const windowOk = !!fromIso && !!toIso && toIso > fromIso && !isPastLocal(fromIso);
  const avail = useQuery({ queryKey: ["availability", fromIso, toIso, booking.id], queryFn: () => api.availability(fromIso!, toIso!, booking.id), enabled: windowOk });
  const free = useMemo(() => (avail.data?.people ?? []).filter((p) => p.available), [avail.data]);
  const busy = useMemo(() => (avail.data?.people ?? []).filter((p) => !p.available), [avail.data]);
  const freeVehicles = (avail.data?.vehicles ?? []).filter((v) => v.available);
  // keep only people still free for the chosen window
  const crew = team.filter((u) => free.some((p) => p.user_id === u));
  const leadOk = lead && crew.includes(lead) ? lead : "";

  const m = useMutation({
    mutationFn: () => api.assignBooking({ id: booking.id, lead: leadOk || null, assistants: crew.filter((u) => u !== leadOk), vehicle_id: vehicle && freeVehicles.some((v) => v.id === vehicle) ? vehicle : null, scheduled_at: fromIso!, ends_at: toIso }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["booking", booking.id] }); void qc.invalidateQueries({ queryKey: ["booking-log", booking.id] }); void qc.invalidateQueries({ queryKey: ["bookings"] });
      api.flushTelegram();
      toast.success(t("booking.assigned_ok"));
      onClose();
    },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.details as { conflicts?: Conflict[] } | undefined) : undefined;
      toast.error(`${t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })}${d?.conflicts?.length ? ` — ${conflictText(d.conflicts)}` : ""}`);
      void avail.refetch();
    },
  });
  const whenError = date && start && isPastLocal(joinLocal(date, start)) ? t("booking.err.START_IN_PAST") : fromIso && toIso && toIso <= fromIso ? t("booking.err.END_BEFORE_START") : null;

  return (
    <Dialog open onClose={onClose} title={`${booking.status === "assigned" ? t("booking.reassign") : t("booking.assign")} · ${booking.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" loading={m.isPending} disabled={!windowOk || crew.length === 0} onClick={() => m.mutate()} data-testid="assign-submit">{t("booking.confirm_assign")} ({crew.length})</Button>
    </>}>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3">
        <div className="col-span-2 sm:col-span-1"><Field label={t("booking.date")} required><Input type="date" min={todayLocal()} name="assign_date" value={date} onChange={(e) => setDate(e.target.value)} /></Field></div>
        <Field label={t("booking.start")} required><Input type="time" step={300} name="assign_start" value={start} onChange={(e) => { setStart(e.target.value); if (date && e.target.value) setEnd(addMinutesLocal(date, e.target.value, booking.scheduled_at && booking.ends_at ? (new Date(booking.ends_at).getTime() - new Date(booking.scheduled_at).getTime()) / 60_000 : 120)); }} /></Field>
        <Field label={t("booking.end")} required><Input type="time" step={300} name="assign_end" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
      </div>
      {whenError && <p className="field-error -mt-1 mb-3" role="alert">{whenError}</p>}

      <Field label={t("booking.crew")} required hint={t("booking.crew_hint")}>
        {!windowOk ? <p className="text-sm text-muted">{t("booking.pick_time_first")}</p> : avail.isLoading ? <Skeleton rows={3} /> : (
          <>
            {free.length === 0 && <p className="text-sm text-danger" role="alert">{t("booking.nobody_free")}</p>}
            <ul className="divide-y divide-grey-line border border-grey-line rounded-md">
              {free.map((p) => {
                const on = crew.includes(p.user_id);
                return (
                  <li key={p.user_id} className="flex items-center gap-3 px-3 min-h-[48px]">
                    <label className="flex flex-1 items-center gap-3 !mb-0 !text-ink text-base py-2 cursor-pointer">
                      <input type="checkbox" className="h-6 w-6 accent-navy" checked={on} onChange={(e) => setTeam((a) => e.target.checked ? [...a, p.user_id] : a.filter((x) => x !== p.user_id))} />
                      <span className="break-words">{p.full_name} <span className="text-xs text-muted">({t(`roles.${p.role}`)})</span></span>
                    </label>
                    {on && (
                      <button type="button" className={`badge min-h-[36px] px-3 ${leadOk === p.user_id ? "bg-navy text-white" : "bg-[#EEF0F4] text-[#4B5263]"}`} onClick={() => setLead(leadOk === p.user_id ? "" : p.user_id)} aria-pressed={leadOk === p.user_id}>
                        {t("booking.lead")}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {busy.length > 0 && (
              <button type="button" className="mt-2 text-sm text-blue min-h-[44px]" onClick={() => setShowBusy((v) => !v)}>{showBusy ? "▾" : "▸"} {t("booking.not_available", { n: busy.length })}</button>
            )}
            {showBusy && (
              <ul className="text-sm text-muted space-y-1">
                {busy.map((p) => <li key={p.user_id} className="break-words">⛔ {p.full_name} — {t(`booking.reason.${p.reason ?? "BUSY"}`)}: {p.busy.map((x) => `${x.number} ${timeRange(x.scheduled_at, x.ends_at)}`).join(", ")}</li>)}
              </ul>
            )}
          </>
        )}
      </Field>
      <Field label={t("booking.vehicle")} hint={windowOk && avail.data && freeVehicles.length < avail.data.vehicles.length ? t("booking.vehicles_busy_hidden") : undefined}>
        <Select name="vehicle" value={vehicle} onChange={(e) => setVehicle(e.target.value)} disabled={!windowOk}>
          <option value="">—</option>
          {freeVehicles.map((v) => <option key={v.id} value={v.id}>{v.code}{v.plate ? ` · ${v.plate}` : ""}</option>)}
        </Select>
      </Field>
      <p className="text-xs text-muted">{t("booking.assign_notify_hint")}</p>
    </Dialog>
  );
}

/** R4 — cancel with a reason (never deleted; frees the crew + vehicle; Telegram notice) */
function CancelDialog({ booking, onClose }: { booking: Booking; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const m = useMutation({
    mutationFn: () => api.cancelBooking(booking.id, reason.trim()),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["booking", booking.id] }); void qc.invalidateQueries({ queryKey: ["booking-log", booking.id] }); void qc.invalidateQueries({ queryKey: ["bookings"] });
      api.flushTelegram();
      toast.success(t("booking.cancelled_ok", { number: booking.number }));
      onClose();
    },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("booking.cancel")} · ${booking.number}`} footer={<>
      <Button onClick={onClose}>{t("app.back")}</Button>
      <Button variant="danger" className="flex-1 sm:flex-none" loading={m.isPending} disabled={reason.trim().length < 3} onClick={() => m.mutate()} data-testid="cancel-submit">{t("booking.cancel_confirm")}</Button>
    </>}>
      <p className="text-sm mb-3">{t("booking.cancel_warning")}</p>
      <Field label={t("booking.cancel_reason")} required hint={t("booking.cancel_reason_hint")}>
        <textarea className="input h-24 py-2" name="cancel_reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus />
      </Field>
    </Dialog>
  );
}
