// Customer requests (D-91 Telegram · D-95 website): what customers asked for, open ones first — call back, create the job
// (customer search and service text prefilled), mark as done. The same list is in the bot («🌐 សំណើអតិថិជន»).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Phone, Plus } from "lucide-react";
import { api, type ServiceRequest } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, ErrorState, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));

export default function RequestsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["requests", all], queryFn: () => api.requests.list(all), refetchInterval: 60_000 });
  const done = useMutation({
    mutationFn: (id: string) => api.requests.done(id),
    onSuccess: () => { toast.success(t("requests.done_ok")); void qc.invalidateQueries({ queryKey: ["requests"] }); },
    onError: () => toast.error(t("app.error")),
  });
  const book = (r: ServiceRequest) => nav(`/bookings/new?q=${encodeURIComponent(r.phone ?? r.customer_name ?? r.name ?? "")}&text=${encodeURIComponent(typeof r.meta?.service === "string" ? r.meta.service : "")}`);
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("requests.title")}</h1>
      <p className="text-sm text-muted">{t("requests.hint")}</p>
      <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={all} onChange={(e) => setAll(e.target.checked)} data-testid="req-all" /> {t("requests.show_done")}</label>
      {q.isLoading ? <Skeleton rows={3} /> : q.isError ? <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} /> : (q.data ?? []).length === 0 ? <Card><Empty text={t("requests.empty")} /></Card> : (
        (q.data ?? []).map((r) => (
          <Card key={r.id}>
            <div className="flex flex-wrap items-center gap-2 mb-1" data-testid="req-card">
              <Badge tone={r.source === "website" ? "blue" : "navy"}>{t(`requests.source.${r.source}`)}</Badge>
              <span className="font-semibold break-words min-w-0">{r.customer_name ?? r.name ?? "—"}</span>
              {r.customer_id && <Badge tone="green">{t("requests.known")}</Badge>}
              <span className="text-xs text-muted ml-auto whitespace-nowrap">{when(r.created_at)}</span>
            </div>
            {r.phone && <div className="text-sm tabular">{r.phone}</div>}
            <p className="text-sm whitespace-pre-line break-words mt-1">{r.text}</p>
            {r.status === "done" ? <p className="text-xs text-muted mt-2">✅ {t("requests.handled", { name: r.handled_by_name ?? "—" })}</p> : (
              <div className="flex flex-wrap gap-2 mt-3">
                {r.phone && <a className="btn-secondary" href={`tel:${r.phone.replace(/[^0-9+]/g, "")}`}><Phone size={16} /> {t("requests.call")}</a>}
                {can("booking.create") && <Button onClick={() => book(r)} data-testid="req-book"><Plus size={16} /> {t("requests.new_booking")}</Button>}
                <Button variant="primary" loading={done.isPending && done.variables === r.id} onClick={() => done.mutate(r.id)} data-testid="req-done"><Check size={16} /> {t("requests.done")}</Button>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  );
}
