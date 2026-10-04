// Reports (Flow 6 · M11): summary for a period (FR-1102: jobs, revenue inside/outside borey + by category, payments by method,
// new debt, voids / discounts / cancels, attendance) · verification with the CFO «verified» mark (FR-1103/1106) · audit log (FR-1202).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { CheckCircle2, Download } from "lucide-react";
import { api, errCode, type VerifyItem } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, ErrorState, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";
import RangePicker from "./RangePicker";
import CashClose from "./CashClose";
import AuditLog from "./AuditLog";
import { presetRange, type Range } from "./range";

type Tab = "summary" | "cash" | "verify" | "audit";
const dt = (iso: string) => new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Phnom_Penh" });

export default function ReportsPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const tabs: Tab[] = ["summary", ...(can("payment.record") || can("report.verify") ? ["cash" as const] : []), ...(can("report.verify") ? ["verify" as const] : []), ...(can("audit.read") ? ["audit" as const] : [])];
  const [tab, setTab] = useState<Tab>("summary");
  const [range, setRange] = useState<Range>(() => sp.get("from") && sp.get("to") ? [sp.get("from")!, sp.get("to")!] : presetRange("today", todayLocal()));
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("reports.title")}</h1>
      {tabs.length > 1 && (
        <div className="flex rounded-md border border-grey-line overflow-x-auto text-sm" role="tablist">
          {tabs.map((k) => <button key={k} role="tab" aria-selected={tab === k} className={`flex-1 shrink-0 whitespace-nowrap px-3 min-h-[44px] ${tab === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setTab(k)}>{t(`reports.tab.${k}`)}</button>)}
        </div>
      )}
      {tab !== "audit" && <Card><RangePicker value={range} onChange={setRange} presets={["today", "week", "month", "last"]} /></Card>}
      {tab === "summary" ? <Summary range={range} /> : tab === "cash" ? <CashClose range={range} /> : tab === "verify" ? <Verification range={range} /> : <AuditLog />}
    </div>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string | number; strong?: boolean; tone?: string }) {
  return <div className={`flex justify-between gap-3 py-1 ${strong ? "font-bold" : "text-sm"} ${tone ?? ""}`}><span className="min-w-0">{label}</span><span className="tabular text-right">{value}</span></div>;
}

function Summary({ range }: { range: Range }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["report-summary", ...range], queryFn: () => api.reports.summary(range[0], range[1]), enabled: range[0] <= range[1] });
  if (q.isLoading) return <Skeleton />;
  if (q.isError || !q.data) return <ErrorState text={t(`reports.err.${errCode(q.error)}`, { defaultValue: t("app.error") })} onRetry={() => void q.refetch()} />;
  const s = q.data;
  return (
    <div className="space-y-3" data-testid="report-summary">
      {s.revenue && s.payments && (
        <>
          <div className="grid grid-cols-2 gap-2">
            <div className="card p-3"><div className="text-xs text-muted">{t("reports.revenue")}</div><div className="text-xl font-bold tabular">{formatUsd(s.revenue.total)}</div><div className="text-xs text-muted">{t("invoice.n_invoices", { n: s.revenue.invoices })}</div></div>
            <div className="card p-3"><div className="text-xs text-muted">{t("reports.received")}</div><div className="text-xl font-bold tabular text-success">{formatUsd(s.payments.total)}</div><div className="text-xs text-muted">{t("reports.n_payments", { n: s.payments.count })}</div></div>
          </div>
          <Card title={t("reports.revenue")}>
            <Row label={t("reports.inside")} value={formatUsd(s.revenue.inside)} />
            <Row label={t("reports.outside")} value={formatUsd(s.revenue.outside)} />
            <div className="border-t border-grey-line my-1" />
            {Object.entries(s.revenue.by_category).map(([k, v]) => <Row key={k} label={t(k === "direct" ? "invoice.new_direct" : `category.${k}`)} value={formatUsd(v)} />)}
          </Card>
          <Card title={t("reports.received")}>
            {(["cash_usd", "cash_khr", "aba", "acleda"] as const).map((m) => <Row key={m} label={t(`invoice.method.${m}`)} value={formatUsd(s.payments!.by_method[m] ?? 0)} />)}
            {s.payments.khr_riel > 0 && <Row label={t("reports.riel_received")} value={formatKhr(s.payments.khr_riel)} />}
          </Card>
          <Card title={t("invoice.tab.debts")}>
            <Row label={t("reports.new_debt")} value={formatUsd(s.new_debt ?? 0)} tone="text-danger" />
            <Row label={t("reports.debt_total")} value={formatUsd(s.debt_total ?? 0)} strong />
          </Card>
          <Card title={t("reports.controls")}>
            <Row label={t("reports.type.void")} value={`${s.voids!.count} · ${formatUsd(s.voids!.total)}`} />
            <Row label={t("invoice.discount")} value={`${s.discounts!.count} · ${formatUsd(s.discounts!.total)} ${t("reports.over_limit", { n: s.discounts!.over_limit })}`} />
            <Row label={t("reports.cancels")} value={s.cancels} />
          </Card>
        </>
      )}
      <Card title={t("reports.jobs")}>
        <Row label={t("reports.jobs_created")} value={s.jobs.created} />
        <Row label={t("reports.jobs_finished")} value={s.jobs.finished} />
        <Row label={t("reports.cancels")} value={s.jobs.cancelled} />
        <Row label={t("status.pending_review")} value={s.jobs.pending_review} />
        <Row label={t("board.in_progress")} value={s.jobs.in_progress} />
      </Card>
      {s.techs.length > 0 && (
        <Card title={t("reports.tech_perf")}>
          <div className="grid grid-cols-[1fr_repeat(4,auto)] gap-x-3 gap-y-1 text-sm" data-testid="tech-perf">
            <span className="text-xs text-muted" /><span className="text-xs text-muted text-right">{t("reports.jobs")}</span><span className="text-xs text-muted text-right">{t("reports.hours")}</span>
            <span className="text-xs text-muted text-right">{t("reports.revisions")}</span><span className="text-xs text-muted text-right">{t("attendance.s.late")}</span>
            {s.techs.map((x) => [
              <span key={x.user_id + "n"} className="min-w-0 break-words">{x.full_name}</span>,
              <span key={x.user_id + "j"} className="text-right tabular">{x.jobs}</span>,
              <span key={x.user_id + "h"} className="text-right tabular">{(x.work_min / 60).toFixed(1)}</span>,
              <span key={x.user_id + "r"} className={`text-right tabular ${x.revisions ? "text-warning" : ""}`}>{x.revisions}</span>,
              <span key={x.user_id + "l"} className={`text-right tabular ${x.late ? "text-danger" : ""}`}>{x.late}</span>,
            ])}
          </div>
        </Card>
      )}
      <Card title={t("reports.excel")}>
        <div className="flex flex-wrap gap-2">
          {(s.revenue ? (["invoices", "payments", "jobs", "attendance"] as const) : (["jobs", "attendance"] as const)).map((k) => (
            <a key={k} className="btn-secondary" href={api.reports.exportUrl(k, range[0], range[1])} download data-testid={`export-${k}`}><Download size={16} /> {t(`reports.export.${k}`)}</a>
          ))}
        </div>
      </Card>
      {s.attendance && (
        <Card title={t("attendance.title")}>
          <Row label={t("attendance.s.present")} value={`${s.attendance.present}/${s.attendance.people}`} />
          <Row label={t("attendance.s.late")} value={s.attendance.late} />
          <Row label={t("attendance.s.absent")} value={s.attendance.absent} />
          <Row label={t("attendance.s.leave")} value={s.attendance.leave} />
          <Row label={t("reports.out_of_range")} value={s.attendance.out_of_range} />
        </Card>
      )}
    </div>
  );
}

const TYPE_TONE: Record<VerifyItem["type"], "danger" | "warning" | "grey" | "green"> = { void: "danger", discount: "warning", cancel: "grey", payment: "green" };
function Verification({ range }: { range: Range }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const q = useQuery({ queryKey: ["verification", ...range, open], queryFn: () => api.reports.verification(range[0], range[1], open), enabled: range[0] <= range[1] });
  const mark = useMutation({ mutationFn: (i: VerifyItem) => api.reports.verify(i.type, i.id), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["verification"] }); void qc.invalidateQueries({ queryKey: ["dashboard"] }); },
    onError: (e) => toast.error(t(`reports.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  return (
    <Card>
      <label className="flex items-center gap-2 min-h-[44px] mb-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={open} onChange={(e) => setOpen(e.target.checked)} /> {t("reports.only_unverified")}</label>
      {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("reports.nothing_to_verify")} /> : (
        <ul className="divide-y divide-grey-line -my-2">
          {q.data.map((i) => (
            <li key={`${i.type}:${i.id}`} className="py-3 flex gap-2 items-start" data-testid="verify-item">
              <div className="flex-1 min-w-0">
                <div className="flex flex-wrap items-center gap-2"><Badge tone={TYPE_TONE[i.type]}>{t(`reports.type.${i.type}`)}</Badge><Link className="font-mono text-sm text-blue underline" to={i.link}>{i.ref}</Link>
                  {i.amount != null && <span className="font-semibold tabular">{formatUsd(i.amount)}</span>}
                  {i.type === "payment" && i.method && <span className="text-xs text-muted">{t(`invoice.method.${i.method}`)}{i.currency === "khr" && i.raw_amount ? ` · ${formatKhr(i.raw_amount)}` : ""}</span>}
                  {i.status && i.status !== "applied" && <Badge>{i.status}</Badge>}</div>
                {i.reason && <div className="text-sm break-words mt-1">📝 {i.reason}</div>}
                <div className="text-xs text-muted mt-1">{dt(i.at)} · {i.type === "payment" ? t("reports.received_by") : t("reports.requested_by")} {i.requested_by_name ?? "—"}{i.approved_by_name ? ` · ${t("reports.approved_by")} ${i.approved_by_name}` : ""}</div>
                {i.verified_at && <div className="text-xs text-success mt-1">✅ {i.verified_by_name} · {dt(i.verified_at)}</div>}
              </div>
              {!i.verified_at && <Button className="shrink-0" loading={mark.isPending && mark.variables?.id === i.id} onClick={() => mark.mutate(i)} data-testid="verify-btn"><CheckCircle2 size={16} /> {t("reports.verify")}</Button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

