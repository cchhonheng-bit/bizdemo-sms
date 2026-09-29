import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LifeBuoy, Square } from "lucide-react";
import { api, errCode, fmtDateTime, fmtTime, type PlatformCompany } from "@/lib/api";
import { useAuth, type SupportInfo } from "@/lib/auth";
import { supabase } from "@/lib/supabase";
import { Badge, Button, Card, Dialog, Empty, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

/** Platform operator home (S-15): tenant overview + Support mode (read-only, ≤ 60 min, audited, CEO notified). */
export default function PlatformPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { me, load } = useAuth();
  const overview = useQuery({ queryKey: ["platform", "overview"], queryFn: api.platformOverview, refetchInterval: 60_000 });
  const sessions = useQuery({ queryKey: ["platform", "sessions"], queryFn: api.supportSessions });
  const [target, setTarget] = useState<PlatformCompany | null>(null);
  const support = me?.support ?? null;

  const end = useMutation({
    mutationFn: api.endSupport,
    onSuccess: async () => { toast.success(t("platform.ended")); await load(); await qc.invalidateQueries(); },
    onError: () => toast.error(t("app.error")),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1>{t("platform.title")}</h1>
        <p className="text-sm text-muted mt-1 max-w-3xl">{t("platform.subtitle")}</p>
      </div>

      {support && <SupportPanel support={support} onEnd={() => end.mutate()} ending={end.isPending} />}

      <Card title={t("platform.company")}>
        {overview.isLoading ? <Skeleton rows={3} /> : overview.isError ? <ErrorState text={t("app.error")} onRetry={() => void overview.refetch()} /> : (overview.data ?? []).length === 0 ? <Empty text={t("app.empty")} /> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr>
                <th>{t("platform.company")}</th><th>{t("platform.plan")}</th><th className="text-right">{t("platform.users")}</th>
                <th className="text-right">{t("platform.bookings")}</th><th>{t("platform.telegram_group")}</th><th>{t("platform.last_activity")}</th><th></th>
              </tr></thead>
              <tbody>
                {(overview.data ?? []).map((c) => (
                  <tr key={c.id} data-testid={`company-${c.slug}`}>
                    <td><div className="font-semibold">{c.name}</div><div className="text-xs text-muted font-mono">{c.slug}</div></td>
                    <td><Badge tone={c.is_active ? "blue" : "grey"}>{c.plan}</Badge></td>
                    <td className="text-right tabular">{c.users}</td>
                    <td className="text-right tabular">{c.bookings}</td>
                    <td>{c.telegram_group ? <Badge tone="green">{t("platform.set")}</Badge> : <Badge tone="warning">{t("platform.no_group")}</Badge>}</td>
                    <td className="text-sm text-muted">{fmtDateTime(c.last_activity)}</td>
                    <td className="text-right">
                      {support?.company_id === c.id
                        ? <Badge tone="danger">{t("platform.active")}</Badge>
                        : <Button className="h-8 px-3" disabled={!c.is_active} onClick={() => setTarget(c)}><LifeBuoy size={14} /> {t("platform.support")}</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={t("platform.history")}>
        {sessions.isLoading ? <Skeleton rows={2} /> : (sessions.data ?? []).length === 0 ? <Empty text={t("platform.no_history")} /> : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead><tr><th>{t("platform.company")}</th><th>{t("platform.reason")}</th><th>{t("platform.started_at")}</th><th>{t("platform.expires_at")}</th><th>{t("platform.status")}</th></tr></thead>
              <tbody>
                {(sessions.data ?? []).map((s) => (
                  <tr key={s.id}>
                    <td className="font-semibold">{s.company_name ?? "—"}</td>
                    <td className="text-sm">{s.reason}</td>
                    <td className="text-sm tabular">{fmtDateTime(s.started_at)}</td>
                    <td className="text-sm tabular">{fmtDateTime(s.ended_at ?? s.expires_at)}</td>
                    <td>{s.active ? <Badge tone="danger">{t("platform.active")}</Badge> : <Badge tone="grey">{t("platform.closed")}</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {target && <StartDialog company={target} onClose={() => setTarget(null)} />}
    </div>
  );
}

function StartDialog({ company, onClose }: { company: PlatformCompany; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { load } = useAuth();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(30);
  const start = useMutation({
    mutationFn: () => api.startSupport({ company_id: company.id, reason: reason.trim(), minutes }),
    onSuccess: async () => {
      toast.success(t("platform.started"));
      api.flushTelegram(); // deliver the CEO notice right away (cron is the backstop)
      await load(); await qc.invalidateQueries(); onClose();
    },
    onError: (e) => toast.error(errCode(e) === "REASON_REQUIRED" ? t("platform.reason_hint") : t("app.error")),
  });
  const valid = reason.trim().length >= 5 && reason.trim().length <= 300;
  return (
    <Dialog open onClose={onClose} title={`${t("platform.support_start")} · ${company.name}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" disabled={!valid} loading={start.isPending} onClick={() => start.mutate()} data-testid="support-start">{t("platform.start")}</Button>
    </>}>
      <Field label={t("platform.reason")} required hint={t("platform.reason_hint")}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus data-testid="support-reason" />
      </Field>
      <Field label={t("platform.minutes")}>
        <Select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))}>
          {[15, 30, 45, 60].map((m) => <option key={m} value={m}>{m}</option>)}
        </Select>
      </Field>
    </Dialog>
  );
}

/** Active session: read-only company snapshot (users + key settings) and links to the tenant pages. */
function SupportPanel({ support, onEnd, ending }: { support: SupportInfo; onEnd: () => void; ending: boolean }) {
  const { t } = useTranslation();
  const users = useQuery({ queryKey: ["platform", "users", support.company_id], queryFn: () => api.profilesOf(support.company_id) });
  const settings = useQuery({
    queryKey: ["platform", "settings", support.company_id],
    queryFn: async () => {
      const r = await supabase.from("company_settings").select("work_start,work_end,fx_rate_khr,telegram_group_chat_id,office_lat,office_lng,invoice_prefix").eq("company_id", support.company_id).maybeSingle();
      if (r.error) throw new Error(r.error.message);
      return r.data as { work_start: string; work_end: string; fx_rate_khr: number; telegram_group_chat_id: number | null; office_lat: number | null; office_lng: number | null; invoice_prefix: string } | null;
    },
  });
  return (
    <Card className="border-danger" title={`${t("platform.support")} · ${support.company_name}`} actions={
      <div className="flex items-center gap-2">
        <Link to="/bookings" className="btn-secondary h-8 px-3">{t("platform.view_bookings")}</Link>
        <Button className="h-8 px-3" variant="danger" loading={ending} onClick={onEnd} data-testid="support-end"><Square size={14} /> {t("platform.end")}</Button>
      </div>}>
      <p className="text-sm text-muted mb-3">{support.reason} · {t("platform.expires_at")} {fmtTime(support.expires_at)}</p>
      <div className="grid md:grid-cols-2 gap-4">
        <div>
          <h3 className="text-sm font-semibold mb-2">{t("platform.session_users")}</h3>
          {users.isLoading ? <Skeleton rows={2} /> : (
            <table className="table">
              <thead><tr><th>{t("users.username")}</th><th>{t("users.full_name")}</th><th>{t("users.role")}</th><th>Telegram</th><th>{t("app.active")}</th></tr></thead>
              <tbody>
                {(users.data ?? []).map((u) => (
                  <tr key={u.id}>
                    <td className="font-mono text-xs">{u.username}</td><td>{u.full_name}</td><td>{t(`roles.${u.role}`)}</td>
                    <td>{u.telegram_linked ? "✓" : "—"}</td><td>{u.is_active ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div>
          <h3 className="text-sm font-semibold mb-2">{t("platform.session_settings")}</h3>
          {settings.isLoading ? <Skeleton rows={2} /> : !settings.data ? <Empty text={t("app.empty")} /> : (
            <dl className="text-sm grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">{t("settings.work_hours")}</dt><dd className="tabular">{settings.data.work_start}–{settings.data.work_end}</dd>
              <dt className="text-muted">FX (KHR)</dt><dd className="tabular">{settings.data.fx_rate_khr}</dd>
              <dt className="text-muted">{t("platform.telegram_group")}</dt><dd className="font-mono">{settings.data.telegram_group_chat_id ?? t("platform.no_group")}</dd>
              <dt className="text-muted">{t("settings.office")}</dt><dd className="tabular">{settings.data.office_lat != null ? `${settings.data.office_lat}, ${settings.data.office_lng}` : "—"}</dd>
              <dt className="text-muted">Invoice</dt><dd className="font-mono">{settings.data.invoice_prefix}</dd>
            </dl>
          )}
        </div>
      </div>
    </Card>
  );
}
