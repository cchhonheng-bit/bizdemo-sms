// Subscribe + promotions (A4/A5 · flag "subscribe" · customer.manage): link + QR, own subscribers, history. D-106: promotions only
// (service messages are about the customer's own bookings) — written by the CEO / GM, previewed first, at most 4 lines; the hub
// sends one per customer every N days (Settings → Website) and never 20:00–08:00, with a «stop promotions» button.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import QRCode from "qrcode";
import { Eye, Megaphone, Printer } from "lucide-react";
import { PROMO_ROLES } from "@sms/shared";
import { api, errCode } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { toast } from "@/lib/toast";
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, Field, Input, Skeleton } from "@/components/ui";

const fmt = (d: string) => new Date(d).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

export default function SubscribePage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const mayPromo = !!me && PROMO_ROLES.includes(me.role);
  const info = useQuery({ queryKey: ["subscribe"], queryFn: api.subscribe.info });
  const history = useQuery({ queryKey: ["subscribe", "broadcasts"], queryFn: api.subscribe.broadcasts });
  const [qr, setQr] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [days, setDays] = useState("30");
  const [preview, setPreview] = useState<{ text: string; button: string; recipients: number; gap_days: number } | null>(null);
  const [confirm, setConfirm] = useState(false);

  useEffect(() => {
    if (info.data?.link) void QRCode.toDataURL(info.data.link, { width: 480, margin: 1, errorCorrectionLevel: "M" }).then(setQr);
  }, [info.data?.link]);

  const onErr = (e: unknown) => toast.error(t(`subscribe.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const look = useMutation({ mutationFn: () => api.subscribe.preview(text.trim()), onSuccess: setPreview, onError: onErr });
  const send = useMutation({
    mutationFn: () => api.subscribe.send(text.trim(), Math.min(90, Math.max(1, Number(days) || 30))),
    onSuccess: (r) => { toast.success(t("subscribe.sent", { n: r.recipients })); setText(""); setPreview(null); setConfirm(false); void qc.invalidateQueries({ queryKey: ["subscribe"] }); },
    onError: (e) => { setConfirm(false); onErr(e); },
  });

  if (info.isLoading) return <Skeleton rows={6} />;
  if (info.isError) return <ErrorState text={t(`subscribe.err.${errCode(info.error)}`, { defaultValue: t("subscribe.hub_down") })} onRetry={() => void info.refetch()} />;
  const d = info.data!;
  const lines = text.split("\n").length;

  return (
    <div className="space-y-4 max-w-5xl">
      <h1 className="text-xl font-bold text-navy">{t("subscribe.title")}</h1>
      <p className="text-sm text-muted">{t("subscribe.intro")}</p>

      <div className="grid md:grid-cols-3 gap-4">
        <Card title={t("subscribe.link")}>
          {qr && <img src={qr} alt="QR" className="w-48 h-48 mx-auto" data-testid="sub-qr" />}
          {d.link ? <p className="text-xs break-all text-center mt-2" data-testid="sub-link">{d.link}</p> : <p className="text-sm text-danger text-center">{t("me.telegram_not_configured")}</p>}
          {d.link && <div className="flex justify-center mt-3"><Link className="btn-secondary" to="/subscribe/print" data-testid="sub-poster-link"><Printer size={16} /> {t("subscribe.print")}</Link></div>}
        </Card>
        <Card className="md:col-span-2" title={t("subscribe.total")}>
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-3xl font-bold text-navy" data-testid="sub-total">{d.total}</div><div className="text-xs text-muted">{t("subscribe.total")}</div></div>
            <div><div className="text-3xl font-bold text-navy">{d.promo}</div><div className="text-xs text-muted">{t("subscribe.promo")}</div></div>
            <div><div className="text-3xl font-bold text-muted">{d.stopped}</div><div className="text-xs text-muted">{t("subscribe.stopped")}</div></div>
          </div>
        </Card>
      </div>

      <Card title={t("subscribe.compose")}>
        {!mayPromo ? <p className="text-sm text-muted">{t("subscribe.only_roles")}</p> : (<>
          <Field label={t("subscribe.text")} hint={t("subscribe.chars", { n: text.length, l: lines })}>
            <textarea className="input h-28 py-2" maxLength={400} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} data-testid="bc-text" />
          </Field>
          <div className="grid sm:grid-cols-3 gap-3 items-end">
            <Field label={t("subscribe.valid_days")}><Input type="number" inputMode="numeric" min={1} max={90} value={days} onChange={(e) => setDays(e.target.value)} data-testid="bc-days" /></Field>
            <div className="sm:col-span-2 flex flex-wrap gap-2 justify-end pb-3">
              <Button disabled={!text.trim() || lines > 4} loading={look.isPending} onClick={() => look.mutate()} data-testid="bc-preview"><Eye size={16} /> {t("subscribe.preview")}</Button>
              <Button variant="primary" disabled={!preview || preview.recipients === 0} onClick={() => setConfirm(true)} data-testid="bc-send"><Megaphone size={16} /> {t("subscribe.send")}{preview ? ` (${preview.recipients})` : ""}</Button>
            </div>
          </div>
          {preview && (
            <div className="rounded-md border border-grey-line p-3 bg-grey-bg" data-testid="bc-shown">
              <div className="text-xs text-muted mb-1">{t("subscribe.preview_title")}</div>
              <p className="text-sm whitespace-pre-line break-words">{preview.text}</p>
              <span className="inline-block mt-2 text-xs rounded border border-grey-line bg-white px-2 py-1">{preview.button}</span>
              <p className="text-xs text-muted mt-2">{t("subscribe.recipients", { n: preview.recipients, d: preview.gap_days })}</p>
            </div>
          )}
          <p className="text-xs text-muted mt-2">{t("subscribe.rule", { d: preview?.gap_days ?? 7 })}</p>
        </>)}
      </Card>

      <Card title={t("subscribe.history")}>
        {!history.data?.length ? <Empty text="—" /> : (
          <table className="table table-stack">
            <thead><tr><th>{t("subscribe.when")}</th><th>{t("subscribe.kind")}</th><th>{t("subscribe.text")}</th><th>{t("subscribe.by")}</th><th>{t("subscribe.result")}</th></tr></thead>
            <tbody>{history.data.map((b) => (
              <tr key={b.id}><td className="whitespace-nowrap">{fmt(b.created_at)}</td><td><Badge tone={b.kind === "promo" ? "purple" : "blue"}>{b.kind === "promo" ? t("subscribe.promo_kind") : t("subscribe.service")}</Badge></td>
                <td className="md:max-w-[340px] md:truncate" title={b.text}>{b.text}</td><td>{b.created_by_name ?? "—"}</td>
                <td className="whitespace-nowrap">✅ {b.sent} / {b.recipients}{b.failed ? <span className="text-danger"> · ❌ {b.failed}</span> : null}{b.pending ? <span className="text-muted"> · ⏳ {b.pending}</span> : null}</td></tr>))}
            </tbody>
          </table>
        )}
      </Card>

      <Card title={t("subscribe.list")}>
        {d.subscribers.length === 0 ? <Empty text={t("subscribe.empty")} /> : (
          <table className="table table-stack" data-testid="sub-list">
            <thead><tr><th>{t("subscribe.name")}</th><th>{t("subscribe.since")}</th><th>{t("subscribe.status")}</th></tr></thead>
            <tbody>{d.subscribers.map((x, i) => (
              <tr key={i}><td>{x.first_name ?? "—"}{x.username ? <span className="text-muted"> @{x.username}</span> : null}</td><td>{fmt(x.subscribed_at)}</td>
                <td>{x.stopped ? <Badge>{t("subscribe.stopped")}</Badge> : x.promo ? <Badge tone="green">{t("subscribe.promo")}</Badge> : <Badge tone="blue">{t("subscribe.service")}</Badge>}</td></tr>))}
            </tbody>
          </table>
        )}
      </Card>

      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => send.mutate()} loading={send.isPending}
        title={t("subscribe.compose")} text={t("subscribe.confirm", { n: preview?.recipients ?? 0 })} />
    </div>
  );
}
