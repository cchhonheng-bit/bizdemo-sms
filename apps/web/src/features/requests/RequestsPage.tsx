// Customer requests (D-91 Telegram · D-95/D-96 website): one inbox, open ones first. A free request or a quote request: call
// back, create the job (customer search and service text prefilled), mark as done. An online booking that waits: confirm or
// decline with a reason (the slot is held meanwhile). A customer's wish for another time: approve (the normal reschedule runs)
// or reject. The same list is in the bot («🌐 សំណើអតិថិជន»).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Phone, Plus, X } from "lucide-react";
import { api, errCode, type ServiceRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, ErrorState, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));
type Action = "done" | "confirm" | "decline" | "approve" | "reject";

export default function RequestsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [asking, setAsking] = useState<{ id: string; action: "decline" | "reject" } | null>(null);
  const [reason, setReason] = useState("");
  const q = useQuery({ queryKey: ["requests", all], queryFn: () => api.requests.list(all), refetchInterval: 60_000 });
  const act = useMutation({
    mutationFn: (v: { id: string; action: Action; reason?: string }) => api.requests.act(v.id, v.action, v.reason),
    onSuccess: (_r, v) => { toast.success(t(`requests.ok.${v.action}`)); setAsking(null); setReason(""); void qc.invalidateQueries({ queryKey: ["requests"] }); void qc.invalidateQueries({ queryKey: ["bookings"] }); },
    onError: (e) => toast.error(t(`requests.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const busy = (id: string, a: Action) => act.isPending && act.variables?.id === id && act.variables.action === a;
  const book = (r: ServiceRequest) => nav(`/bookings/new?q=${encodeURIComponent(r.phone ?? r.customer_name ?? r.name ?? "")}&text=${encodeURIComponent(typeof r.meta?.service === "string" ? r.meta.service : "")}`);
  const decide = can("booking.create");
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("requests.title")}</h1>
      <p className="text-sm text-muted">{t("requests.hint")} {t("requests.hint_web")}</p>
      <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="req-all" /> {t("requests.show_done")}</label>
      {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <Card><Empty text={t("requests.empty")} /></Card> : (
        (q.data ?? []).map((r) => {
          const waiting = r.kind === "booking" && r.web_status === "pending";
          const decision: ["confirm", "decline"] | ["approve", "reject"] | null = waiting ? ["confirm", "decline"] : r.kind === "reschedule" ? ["approve", "reject"] : null;
          const no = decision ? decision[1] : null;
          return (
            <Card key={r.id}>
              <div className="flex flex-wrap items-center gap-2 mb-1" data-testid="req-card">
                <Badge tone={r.source === "website" ? "blue" : "navy"}>{t(`requests.source.${r.source}`)}</Badge>
                {r.kind !== "request" && <Badge tone={waiting ? "warning" : "grey"}>{t(`requests.kind.${r.kind}`)}</Badge>}
                <span className="font-semibold break-words min-w-0">{r.name ?? r.customer_name ?? "—"}</span>
                {r.customer_id && <Badge tone="green">{r.customer_name && r.customer_name !== r.name ? r.customer_name : t("requests.known")}</Badge>}
                <span className="text-xs text-muted ml-auto whitespace-nowrap">{when(r.created_at)}</span>
              </div>
              {r.phone && <div className="text-sm tabular">{r.phone}</div>}
              {r.booking_id && r.booking_number && <Link className="text-sm text-blue underline" to={`/bookings/${r.booking_id}`}>{r.booking_number}</Link>}
              <p className="text-sm whitespace-pre-line break-words mt-1">{r.text}</p>
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
                    <Button variant="primary" loading={busy(r.id, decision[0])} onClick={() => act.mutate({ id: r.id, action: decision[0] })} data-testid="req-yes"><Check size={16} /> {t(`requests.${decision[0]}`)}</Button>
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
    </div>
  );
}
