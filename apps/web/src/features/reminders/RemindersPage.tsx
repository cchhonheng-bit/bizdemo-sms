// A2 service reminders (flag "reminders"): overdue / due soon per unit or per customer · one-tap call · contacted / snooze / dismiss ·
// book the job · optional Telegram reminder to customers who subscribed through their own link (once per due date, daily limit).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BellRing, CalendarPlus, Check, Clock, Phone, Send, X } from "lucide-react";
import { api, errCode, type Reminder } from "@/lib/api";
import { Badge, Button, Card, Empty, ErrorState, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

const key = (r: Reminder) => `${r.customer_id}|${r.unit_id ?? "-"}|${r.service_item_id}|${r.due_on}`;
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

export default function RemindersPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [days, setDays] = useState(14);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const q = useQuery({ queryKey: ["reminders", days], queryFn: () => api.reminders.list(days) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ["reminders"] });
  const onErr = (e: unknown) => toast.error(t(`reminders.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const act = useMutation({
    mutationFn: (v: { r: Reminder; action: "contacted" | "snoozed" | "dismissed"; until?: string }) =>
      api.reminders.action({ customer_id: v.r.customer_id, unit_id: v.r.unit_id, service_item_id: v.r.service_item_id, due_on: v.r.due_on, action: v.action, until: v.until ?? null }),
    onSuccess: () => { toast.success(t("app.saved")); refresh(); }, onError: onErr,
  });
  const send = useMutation({
    mutationFn: (rows: Reminder[]) => api.reminders.telegram(rows.map((r) => ({ customer_id: r.customer_id, unit_id: r.unit_id, service_item_id: r.service_item_id, due_on: r.due_on }))),
    onSuccess: (x) => { toast.info(t("reminders.sent", x)); setPicked(new Set()); refresh(); }, onError: onErr,
  });
  const rows = useMemo(() => q.data ?? [], [q.data]);
  const overdue = rows.filter((r) => r.status === "overdue").length;
  const pickedRows = useMemo(() => rows.filter((r) => picked.has(key(r)) && r.telegram), [rows, picked]);
  const toggle = (r: Reminder) => setPicked((s) => { const n = new Set(s); if (n.has(key(r))) n.delete(key(r)); else n.add(key(r)); return n; });
  return (
    <div className="max-w-3xl space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1>{t("reminders.title")}</h1>
        {overdue > 0 && <Badge tone="danger">{t("reminders.overdue_n", { n: overdue })}</Badge>}
      </div>
      <div className="flex rounded-md border border-grey-line overflow-hidden text-sm" role="tablist">
        {[7, 14, 30].map((d) => <button key={d} role="tab" aria-selected={days === d} className={`flex-1 px-3 min-h-[44px] ${days === d ? "bg-navy text-white" : "bg-white"}`} onClick={() => setDays(d)}>{t("reminders.window", { n: d })}</button>)}
      </div>
      {pickedRows.length > 0 && (
        <div className="sticky top-2 z-10"><Button variant="primary" className="w-full" loading={send.isPending} onClick={() => send.mutate(pickedRows)} data-testid="rem-send"><Send size={16} /> {t("reminders.send_n", { n: pickedRows.length })}</Button></div>
      )}
      {q.isLoading ? <Skeleton /> : q.isError ? <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} /> : rows.length === 0 ? <Card><Empty text={t("reminders.none")} /></Card> : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={key(r)} className={r.status === "overdue" ? "border-danger" : ""}>
              <div className="flex items-start gap-2" data-testid="rem-row">
                {r.telegram && <input type="checkbox" className="h-6 w-6 mt-1 shrink-0" aria-label={t("reminders.pick")} checked={picked.has(key(r))} onChange={() => toggle(r)} />}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">{r.customer_name}</div>
                  <div className="text-sm break-words">{r.service_name}{r.unit_label ? <span className="text-muted"> · {r.unit_label}</span> : null}</div>
                  <div className="flex flex-wrap gap-1 mt-1 text-xs">
                    <Badge tone={r.status === "overdue" ? "danger" : "warning"}>{r.status === "overdue" ? t("reminders.overdue_days", { n: r.days_overdue }) : t("reminders.due_in", { n: r.days_left })}</Badge>
                    <span className="text-muted">{t("reminders.last", { date: r.last_on })} · {t("reminders.due", { date: r.due_on })}</span>
                    {r.telegram && <Badge tone="blue">Telegram</Badge>}
                  </div>
                  {r.last_action && <p className="text-xs text-muted mt-1">✔ {t(`reminders.act.${r.last_action}`)}{r.last_note ? ` · ${r.last_note}` : ""}</p>}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 mt-2">
                {r.phones[0] && <a className="btn-primary" href={`tel:${r.phones[0]}`} data-testid="rem-call"><Phone size={16} /> {r.phones[0]}</a>}
                <Link className="btn-secondary" to={`/bookings/new?customer=${r.customer_id}&service=${r.service_item_id}${r.unit_id ? `&unit=${r.unit_id}` : ""}`}><CalendarPlus size={16} /> {t("reminders.book")}</Link>
                <Button onClick={() => act.mutate({ r, action: "contacted" })} data-testid="rem-contacted"><Check size={16} /> {t("reminders.act.contacted")}</Button>
                <Button onClick={() => act.mutate({ r, action: "snoozed", until: inDays(7) })}><Clock size={16} /> 7 {t("attendance.days_short")}</Button>
                <Button onClick={() => act.mutate({ r, action: "snoozed", until: inDays(30) })}><Clock size={16} /> 30 {t("attendance.days_short")}</Button>
                {r.telegram && <Button onClick={() => send.mutate([r])}><BellRing size={16} /> Telegram</Button>}
                <Button variant="danger" onClick={() => act.mutate({ r, action: "dismissed" })} aria-label={t("reminders.act.dismissed")}><X size={16} /></Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
