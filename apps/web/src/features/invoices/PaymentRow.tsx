// One payment on the invoice: amount, method, rate · «(ប្រាក់កក់)» when it came from a deposit · voided payments crossed out with the
// reason, their reversal row shown · Void request (reason) → approval (Admin → GM, GM → CEO, CEO directly) — D-86.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation } from "@tanstack/react-query";
import { formatKhr, formatUsd } from "@sms/shared";
import { Ban, Check, X } from "lucide-react";
import { api, errCode, type Invoice, type Payment } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Dialog, Field } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function PaymentRow({ p, d, onDone }: { p: Payment; d: Invoice; onDone: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const onErr = (e: unknown) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const ask = useMutation({ mutationFn: () => api.payments.void(p.id, reason.trim()), onSuccess: (r) => { toast.success(t(r.status === "void" ? "invoice.void_done" : "invoice.void_sent")); setAsking(false); onDone(); api.flushTelegram(); }, onError: onErr });
  const decide = useMutation({ mutationFn: (ok: boolean) => api.payments.decideVoid(p.id, ok), onSuccess: () => { toast.success(t("app.saved")); onDone(); api.flushTelegram(); }, onError: onErr });
  const reversal = !!p.reversal_of, voided = !!p.voided_at;
  const canAsk = d.can.void_request && d.status === "issued" && !reversal && !voided && !p.from_deposit && !p.void_request;
  return (
    <li className="py-2" data-testid="payment-row">
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0">
          <div className={`font-semibold tabular ${voided ? "line-through text-muted" : ""}`}>
            {p.currency === "usd" ? formatUsd(p.amount) : formatKhr(p.amount)} <span className="text-xs text-muted font-normal">· {t(`invoice.method.${p.method}`)}</span>
            {p.from_deposit && <span className="ml-1"><Badge tone="blue">{t("deposit.tag")}</Badge></span>}
            {reversal && <span className="ml-1"><Badge tone="danger">VOID</Badge></span>}
          </div>
          <div className="text-xs text-muted">{p.paid_on} · {p.received_by_name}{p.currency === "khr" ? ` · ${formatKhr(p.fx_rate_khr)}/$` : ""}{p.note && !reversal ? ` · ${p.note}` : ""}</div>
          {voided && <div className="text-xs text-danger">🚫 VOID · {p.void_reason}</div>}
          {p.void_request && <div className="text-xs text-warning">⏳ {t("invoice.void_waiting", { name: p.void_request.requested_by_name })}: {p.void_request.reason}</div>}
        </div>
        <span className={`tabular ${p.usd_cents < 0 ? "text-danger" : voided ? "text-muted line-through" : "text-success"}`}>{formatUsd(p.usd_cents)}</span>
        {canAsk && <button className="tap-target text-danger" aria-label={t("invoice.void")} onClick={() => setAsking(true)} data-testid="payment-void"><Ban size={16} /></button>}
      </div>
      {p.void_request && d.can.void_approve && (
        <div className="flex gap-2 mt-2">
          <Button loading={decide.isPending} onClick={() => decide.mutate(false)}><X size={16} /> {t("leave.reject")}</Button>
          <Button variant="danger" loading={decide.isPending} onClick={() => decide.mutate(true)} data-testid="payment-void-approve"><Check size={16} /> {t("invoice.void_approve")}</Button>
        </div>
      )}
      {asking && (
        <Dialog open onClose={() => setAsking(false)} title={`${t("payment.void")} · ${formatUsd(p.usd_cents)}`} footer={<>
          <Button onClick={() => setAsking(false)}>{t("app.back")}</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" disabled={reason.trim().length < 3} loading={ask.isPending} onClick={() => ask.mutate()} data-testid="payment-void-save">{me?.role === "ceo" ? t("invoice.void_now") : t("invoice.void_request")}</Button>
        </>}>
          <p className="text-sm mb-2">{me?.role === "ceo" ? t("payment.void_ceo_hint") : t(me?.role === "admin" ? "invoice.void_to_gm" : "invoice.void_to_ceo")}</p>
          <Field label={t("booking.cancel_reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus data-testid="payment-void-reason" /></Field>
        </Dialog>
      )}
    </li>
  );
}
