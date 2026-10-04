// Customer requests (D-91 Telegram · D-95/D-96 website): one inbox, open ones first. A free request or a quote request: call
// back, create the job (customer search and service text prefilled), mark as done. An online booking that waits: confirm or
// decline with a reason (the slot is held meanwhile). A customer's wish for another time: approve (the normal reschedule runs)
// or reject. The same list is in the bot («🌐 សំណើអតិថិជន»). D-106 (CEO): the job length can be changed while confirming; the map
// link of the customer's location; nobody answers → reminders, then «expired» once the time has passed. CEO 04-10: «បញ្ជាក់» opens
// one dialog — job length + crew picker — and confirming assigns the technicians (they and the customer are told); the bot's ✅
// opens it here (?confirm=<request id>).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, MapPin, Phone, Plus, X } from "lucide-react";
import { api, errCode, fmtDate, type ServiceRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { CrewList } from "@/features/bookings/CrewPicker";
import { crewOf, useCrewAvailability } from "@/features/bookings/crew";
import { isPastLocal, timeRange } from "@/features/bookings/time";

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));
type Action = "done" | "decline" | "approve" | "reject";
const lengthOf = (r: ServiceRequest) => (r.booking_at && r.booking_ends ? Math.round((new Date(r.booking_ends).getTime() - new Date(r.booking_at).getTime()) / 60_000) : 120);
const where = (r: ServiceRequest) => {
  const lat = r.lat ?? (typeof r.meta?.lat === "number" ? r.meta.lat : null), lng = r.lng ?? (typeof r.meta?.lng === "number" ? r.meta.lng : null);
  const acc = r.loc_accuracy ?? (typeof r.meta?.accuracy === "number" ? r.meta.accuracy : null);
  return lat != null && lng != null ? { url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`, acc } : null;
};

export default function RequestsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [asking, setAsking] = useState<{ id: string; action: "decline" | "reject" } | null>(null);
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState<ServiceRequest | null>(null);
  const [sp, setSp] = useSearchParams();
  const q = useQuery({ queryKey: ["requests", all], queryFn: () => api.requests.list(all), refetchInterval: 60_000 });
  const act = useMutation({
    mutationFn: (v: { id: string; action: Action; reason?: string }) => api.requests.act(v.id, v.action, v.reason),
    onSuccess: (_r, v) => { toast.success(t(`requests.ok.${v.action}`)); setAsking(null); setReason(""); void qc.invalidateQueries({ queryKey: ["requests"] }); void qc.invalidateQueries({ queryKey: ["bookings"] }); },
    onError: (e) => toast.error(t(`requests.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const busy = (id: string, a: Action) => act.isPending && act.variables?.id === id && act.variables.action === a;
  const book = (r: ServiceRequest) => nav(`/bookings/new?q=${encodeURIComponent(r.phone ?? r.customer_name ?? r.name ?? "")}&text=${encodeURIComponent(typeof r.meta?.service === "string" ? r.meta.service : "")}`);
  const decide = can("booking.create");
  // the bot's ✅ lands on /requests?confirm=<id>: that booking's dialog opens once the list is there
  const want = sp.get("confirm");
  useEffect(() => {
    if (!want || !q.data) return;
    const r = q.data.find((x) => x.id === want && x.kind === "booking" && x.web_status === "pending" && x.status !== "done");
    if (r && decide) setConfirming(r);
    setSp((p) => { p.delete("confirm"); return p; }, { replace: true });
  }, [want, q.data, decide, setSp]);
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("requests.title")}</h1>
      <p className="text-sm text-muted">{t("requests.hint")} {t("requests.hint_web")}</p>
      <p className="text-xs text-muted">{t("requests.escalation")}</p>
      <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="req-all" /> {t("requests.show_done")}</label>
      {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <Card><Empty text={t("requests.empty")} /></Card> : (
        (q.data ?? []).map((r) => {
          const waiting = r.kind === "booking" && r.web_status === "pending";
          const decision: ["confirm", "decline"] | ["approve", "reject"] | null = waiting ? ["confirm", "decline"] : r.kind === "reschedule" ? ["approve", "reject"] : null;
          const no = decision ? decision[1] : null;
          return (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2 mb-1" data-testid="req-card">
                {r.is_test && <Badge tone="purple">🧪 {t("requests.test")}</Badge>}
                <Badge tone={r.source === "website" ? "blue" : "navy"}>{t(`requests.source.${r.source}`)}</Badge>
                {r.kind !== "request" && <Badge tone={waiting ? "warning" : "grey"}>{t(`requests.kind.${r.kind}`)}</Badge>}
                {r.kind === "quote" && typeof r.meta?.category === "string" && <Badge tone="purple">{t(`category.${r.meta.category}`, { defaultValue: r.meta.category })}</Badge>}
                <span className="font-semibold break-words min-w-0">{r.name ?? r.customer_name ?? "—"}</span>
                {r.customer_id && <Badge tone="green">{r.customer_name && r.customer_name !== r.name ? r.customer_name : t("requests.known")}</Badge>}
                <span className="text-xs text-muted ml-auto whitespace-nowrap">{when(r.created_at)}</span>
              </div>
              {r.phone && <div className="text-sm tabular">{r.phone}</div>}
              {r.booking_id && r.booking_number && <Link className="text-sm text-blue underline" to={`/bookings/${r.booking_id}`}>{r.booking_number}</Link>}
              <p className="text-sm whitespace-pre-line break-words mt-1">{r.text}</p>
              {where(r) && <a className="text-sm text-blue underline inline-flex items-center gap-1 mt-1" href={where(r)!.url} target="_blank" rel="noreferrer" data-testid="req-map"><MapPin size={14} /> {t("requests.map")}{where(r)!.acc != null ? ` (${t("requests.accuracy", { m: Math.round(where(r)!.acc!) })})` : ""}</a>}
              {(r.photos ?? []).length > 0 && (
                <div className="flex flex-wrap gap-2 mt-2">{r.photos.map((p) => (
                  <a key={p.id} href={`/api/requests/${r.id}/photos/${p.id}`} target="_blank" rel="noreferrer"><img src={`/api/requests/${r.id}/photos/${p.id}`} alt="" loading="lazy" className="h-20 w-20 object-cover rounded-md border border-grey-line" /></a>
                ))}</div>
              )}
              {r.status === "done" ? (
                <p className="text-xs text-muted mt-2">✅ {r.outcome ? `${t(`requests.outcome.${r.outcome}`)} · ` : ""}{t("requests.handled", { name: r.handled_by_name ?? "—" })}{r.note ? ` · ${r.note}` : ""}</p>
              ) : asking?.id === r.id ? (
                <div className="mt-3 space-y-2">
                  <Input value={reason} maxLength={200} placeholder={t("requests.reason")} onChange={(e) => setReason(e.target.value)} data-testid="req-reason" autoFocus />
                  <div className="flex flex-wrap gap-2">
                    <Button onClick={() => { setAsking(null); setReason(""); }}>{t("requests.back")}</Button>
                    <Button variant="danger" loading={busy(r.id, asking.action)} onClick={() => act.mutate({ id: r.id, action: asking.action, reason: reason.trim() })} data-testid="req-no-go"><X size={16} /> {t(`requests.${asking.action}`)}</Button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2 mt-3">
                  {r.phone && <a className="btn-secondary" href={`tel:${r.phone.replace(/[^0-9+]/g, "")}`}><Phone size={16} /> {t("requests.call")}</a>}
                  {decision && decide ? (<>
                    <Button variant="primary" loading={decision[0] === "approve" && busy(r.id, "approve")} onClick={() => (decision[0] === "confirm" ? setConfirming(r) : act.mutate({ id: r.id, action: "approve" }))} data-testid="req-yes"><Check size={16} /> {t(`requests.${decision[0]}`)}</Button>
                    <Button onClick={() => { setAsking({ id: r.id, action: no as "decline" | "reject" }); setReason(""); }} data-testid="req-no"><X size={16} /> {t(`requests.${decision[1]}`)}</Button>
                  </>) : !decision ? (<>
                    {can("booking.create") && r.kind !== "booking" && <Button onClick={() => book(r)} data-testid="req-book"><Plus size={16} /> {t("requests.new_booking")}</Button>}
                    <Button variant="primary" loading={busy(r.id, "done")} onClick={() => act.mutate({ id: r.id, action: "done" })} data-testid="req-done"><Check size={16} /> {t("requests.done")}</Button>
                  </>) : null}
                </div>
              )}
            </Card>
          );
        })
      )}
      {confirming && <ConfirmBookingDialog r={confirming} onClose={() => setConfirming(null)} />}
    </div>
  );
}

/** a waiting website booking: the job length (D-106) + the crew (busy people greyed with their time) → confirmed + assigned */
function ConfirmBookingDialog({ r, onClose }: { r: ServiceRequest; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [mins, setMins] = useState(String(lengthOf(r)));
  const [team, setTeam] = useState<string[]>([]);
  const [lead, setLead] = useState("");
  const m = Number(mins), minutesOk = Number.isInteger(m) && m >= 15 && m <= 1440;
  const from = r.booking_at, to = from && minutesOk ? new Date(new Date(from).getTime() + m * 60_000).toISOString() : null;
  const windowOk = !!from && !isPastLocal(from);
  const { q, people, free } = useCrewAvailability(from, to, r.booking_id ?? undefined);
  const { crew, lead: leadOk } = crewOf(free, team, lead);
  const save = useMutation({
    mutationFn: () => api.requests.confirm(r.id, { ...(minutesOk && m !== lengthOf(r) ? { minutes: m } : {}), lead: leadOk || null, assistants: crew.filter((u) => u !== leadOk) }),
    onSuccess: () => { toast.success(t("requests.ok.confirm")); void qc.invalidateQueries({ queryKey: ["requests"] }); void qc.invalidateQueries({ queryKey: ["bookings"] }); onClose(); },
    onError: (e) => { toast.error(t(`requests.err.${errCode(e)}`, { defaultValue: t("app.error") })); void q.refetch(); },
  });
  return (
    <Dialog open onClose={onClose} title={`${t("requests.confirm_title")}${r.booking_number ? ` · ${r.booking_number}` : ""}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" loading={save.isPending} disabled={!windowOk || !minutesOk || crew.length === 0} onClick={() => save.mutate()} data-testid="req-confirm-go"><Check size={16} /> {t("requests.confirm_assign")} ({crew.length})</Button>
    </>}>
      <div className="card bg-grey-bg p-3 mb-3 text-sm" data-testid="req-confirm-when">
        <div className="font-semibold break-words">{r.name ?? r.customer_name ?? "—"}{r.phone ? ` · ${r.phone}` : ""}</div>
        <div className="font-bold tabular text-base">{from ? `${fmtDate(from)} · ${timeRange(from, to)}` : "—"}</div>
        <p className="whitespace-pre-line break-words mt-1">{r.text}</p>
      </div>
      <Field label={t("requests.minutes")} hint={t("requests.minutes_hint")}>
        <Input className="w-32" type="number" inputMode="numeric" min={15} max={1440} step={15} value={mins} onChange={(e) => setMins(e.target.value)} data-testid="req-minutes" />
      </Field>
      <Field label={t("booking.crew")} required hint={t("booking.crew_hint")}>
        {!windowOk ? <p className="text-sm text-muted">{t("booking.reschedule_first")}</p>
          : <CrewList people={people} loading={q.isLoading && !q.data} team={crew} lead={leadOk} onTeam={setTeam} onLead={setLead} />}
      </Field>
      <p className="text-xs text-muted">{t("requests.confirm_hint")}</p>
    </Dialog>
  );
}
