// Deposit when the customer accepts a quote (D-86): Admin records $ / ៛ (cash, ABA, ACLEDA) with today's rate; applied to the
// job's invoice automatically when it is issued; GM / CEO void a deposit (refund) with a reason.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, toCents } from "@sms/shared";
import { Ban, Wallet } from "lucide-react";
import { api, errCode, type PayMethod } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Field, Input } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";

export default function DepositsCard({ bookingId }: { bookingId: string }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["deposits", bookingId], queryFn: () => api.deposits.list(bookingId) });
  const [open, setOpen] = useState(false);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => void qc.invalidateQueries({ queryKey: ["deposits", bookingId] });
  const voidM = useMutation({ mutationFn: () => api.deposits.void(voiding!, reason.trim()), onSuccess: () => { toast.success(t("app.saved")); setVoiding(null); setReason(""); refresh(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  const list = q.data ?? [];
  const active = list.filter((d) => d.status === "active").reduce((s, d) => s + d.usd_cents, 0);
  if (!can("payment.record") && list.length === 0) return null;
  return (
    <Card title={t("deposit.title")} actions={can("payment.record") ? <Button variant="primary" onClick={() => setOpen(true)} data-testid="deposit-open"><Wallet size={16} /> {t("deposit.record")}</Button> : undefined}>
      {list.length === 0 ? <p className="text-sm text-muted">{t("deposit.none")}</p> : (
        <ul className="text-sm divide-y divide-grey-line">
          {list.map((d) => (
            <li key={d.id} className="py-2 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className={`font-semibold tabular ${d.status === "void" ? "line-through text-muted" : ""}`}>{d.currency === "usd" ? formatUsd(d.amount) : formatKhr(d.amount)} <span className="text-xs text-muted font-normal">· {t(`invoice.method.${d.method}`)}</span></div>
                <div className="text-xs text-muted">{d.paid_on} · {d.received_by_name}{d.note ? ` · ${d.note}` : ""}</div>
              </div>
              <Badge tone={d.status === "active" ? "warning" : d.status === "applied" ? "green" : "grey"}>{t(`deposit.status.${d.status}`)}</Badge>
              {d.status === "active" && can("void.approve") && <button className="tap-target text-danger" aria-label={t("invoice.void")} onClick={() => setVoiding(d.id)}><Ban size={16} /></button>}
            </li>
          ))}
        </ul>
      )}
      {active > 0 && <p className="text-sm mt-2">{t("deposit.active_total", { amount: formatUsd(active) })}</p>}
      {open && <DepositDialog bookingId={bookingId} onClose={() => setOpen(false)} onDone={() => { setOpen(false); refresh(); }} />}
      {voiding && (
        <Dialog open onClose={() => setVoiding(null)} title={t("deposit.void")} footer={<>
          <Button onClick={() => setVoiding(null)}>{t("app.back")}</Button>
          <Button variant="danger" className="flex-1 sm:flex-none" disabled={reason.trim().length < 3} loading={voidM.isPending} onClick={() => voidM.mutate()}>{t("deposit.void")}</Button>
        </>}>
          <Field label={t("booking.cancel_reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus /></Field>
        </Dialog>
      )}
    </Card>
  );
}

function DepositDialog({ bookingId, onClose, onDone }: { bookingId: string; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [currency, setCurrency] = useState<"usd" | "khr">("usd");
  const [method, setMethod] = useState<PayMethod>("cash_usd");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  let value = NaN;
  try { value = currency === "usd" ? toCents(amount) : /^\d[\d,]*$/.test(amount.trim()) ? Number(amount.replace(/,/g, "")) : NaN; } catch { /* invalid */ }
  const pick = (c: "usd" | "khr") => { setCurrency(c); setAmount(""); if (method === "cash_usd" && c === "khr") setMethod("cash_khr"); if (method === "cash_khr" && c === "usd") setMethod("cash_usd"); };
  const save = useMutation({ mutationFn: () => api.deposits.record(bookingId, { amount: value, currency, method, paid_on: todayLocal(), note }),
    onSuccess: () => { toast.success(t("deposit.saved")); onDone(); }, onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  const methods: PayMethod[] = ["cash_usd", "cash_khr", "aba", "acleda"];
  return (
    <Dialog open onClose={onClose} title={t("deposit.record")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!(value > 0)} loading={save.isPending} onClick={() => save.mutate()} data-testid="deposit-save">{t("app.save")}</Button>
    </>}>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {(["usd", "khr"] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={currency === c} onClick={() => pick(c)} className={`min-h-[44px] rounded-md border font-semibold ${currency === c ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{c === "usd" ? "$ USD" : "៛ KHR"}</button>)}
      </div>
      <Field label={currency === "usd" ? t("invoice.amount_usd") : t("invoice.amount_khr")} required><Input inputMode={currency === "usd" ? "decimal" : "numeric"} value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus data-testid="deposit-amount" /></Field>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {methods.filter((m) => !(m === "cash_usd" && currency === "khr") && !(m === "cash_khr" && currency === "usd")).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)} className={`min-h-[44px] rounded-md border text-sm ${method === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`invoice.method.${m}`)}</button>
        ))}
      </div>
      <Field label={t("invoice.pay_note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
    </Dialog>
  );
}
