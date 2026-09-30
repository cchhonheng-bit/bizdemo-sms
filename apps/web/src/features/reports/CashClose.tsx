// Daily cash close (FR-1107): expected cash $ / ៛ from the day's cash payments → Admin enters the count → difference → CFO verifies (then locked).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, toCents } from "@sms/shared";
import { CheckCircle2 } from "lucide-react";
import { api, errCode, type CashClose as Row } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Empty, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import type { Range } from "./range";

export default function CashClose({ range }: { range: Range }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["cash-close", ...range], queryFn: () => api.reports.cash(range[0], range[1]), enabled: range[0] <= range[1] });
  const verify = useMutation({ mutationFn: (day: string) => api.reports.verifyCash(day), onSuccess: () => { void qc.invalidateQueries({ queryKey: ["cash-close"] }); },
    onError: (e) => toast.error(t(`reports.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  if (q.isLoading) return <Skeleton />;
  if (!q.data?.length) return <Card><Empty text={t("reports.none")} /></Card>;
  return (
    <div className="space-y-3">
      {q.data.map((r) => <DayCard key={r.day} r={r} canClose={can("payment.record")} canVerify={can("report.verify")} onVerify={() => verify.mutate(r.day)} verifying={verify.isPending && verify.variables === r.day} />)}
    </div>
  );
}

function DayCard({ r, canClose, canVerify, onVerify, verifying }: { r: Row; canClose: boolean; canVerify: boolean; onVerify: () => void; verifying: boolean }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [usd, setUsd] = useState(r.counted_usd != null ? (r.counted_usd / 100).toFixed(2) : "");
  const [khr, setKhr] = useState(r.counted_khr != null ? String(r.counted_khr) : "");
  const [note, setNote] = useState(r.note ?? "");
  let usdC = NaN; try { usdC = toCents(usd || "0"); } catch { /* invalid */ }
  const khrN = /^\d*$/.test(khr.replace(/,/g, "")) ? Number(khr.replace(/,/g, "") || 0) : NaN;
  const save = useMutation({
    mutationFn: () => api.reports.closeCash({ day: r.day, counted_usd: usdC, counted_khr: khrN, note }),
    onSuccess: (x) => { toast[x.diff_usd === 0 && x.diff_khr === 0 ? "success" : "info"](t("reports.cash_saved", { usd: formatUsd(x.diff_usd), khr: formatKhr(x.diff_khr) })); void qc.invalidateQueries({ queryKey: ["cash-close"] }); },
    onError: (e) => toast.error(t(`reports.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const diff = (n: number | null, fmt: (x: number) => string) => n == null ? "—" : <span className={n === 0 ? "text-success" : "text-danger"}>{n > 0 ? "+" : ""}{fmt(n)}</span>;
  const editable = canClose && !r.closed;
  return (
    <Card title={r.day} actions={r.closed ? <Badge tone="green">✅ {r.verified_by_name}</Badge> : r.counted_usd != null ? <Badge tone="warning">{t("reports.cash_waiting")}</Badge> : undefined}>
      <div className="grid grid-cols-3 gap-2 text-sm" data-testid="cash-day">
        <span className="text-muted" />
        <span className="text-muted text-right">$</span><span className="text-muted text-right">៛</span>
        <span>{t("reports.cash_expected")}</span><span className="text-right tabular">{formatUsd(r.expected_usd)}</span><span className="text-right tabular">{formatKhr(r.expected_khr)}</span>
        <span>{t("reports.cash_counted")}</span><span className="text-right tabular">{r.counted_usd != null ? formatUsd(r.counted_usd) : "—"}</span><span className="text-right tabular">{r.counted_khr != null ? formatKhr(r.counted_khr) : "—"}</span>
        <span>{t("reports.cash_diff")}</span><span className="text-right tabular">{diff(r.diff_usd, formatUsd)}</span><span className="text-right tabular">{diff(r.diff_khr, formatKhr)}</span>
      </div>
      {r.closed_by_name && <p className="text-xs text-muted mt-1">{t("reports.cash_by", { name: r.closed_by_name })}{r.note ? ` · 📝 ${r.note}` : ""}</p>}
      {editable && (
        <div className="mt-3 border-t border-grey-line pt-3">
          <div className="grid grid-cols-2 gap-2">
            <Field label={t("reports.cash_count_usd")}><Input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} data-testid="cash-usd" /></Field>
            <Field label={t("reports.cash_count_khr")}><Input inputMode="numeric" value={khr} onChange={(e) => setKhr(e.target.value)} data-testid="cash-khr" /></Field>
          </div>
          <Field label={t("invoice.pay_note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
          <Button variant="primary" disabled={Number.isNaN(usdC) || Number.isNaN(khrN) || usdC < 0} loading={save.isPending} onClick={() => save.mutate()} data-testid="cash-save">{t("reports.cash_save")}</Button>
        </div>
      )}
      {canVerify && !r.closed && r.counted_usd != null && <Button className="mt-3" loading={verifying} onClick={onVerify} data-testid="cash-verify"><CheckCircle2 size={16} /> {t("reports.verify")}</Button>}
    </Card>
  );
}
