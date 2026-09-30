// Invoice (Flow 4 · M8): lines + totals, discount (GM / CEO only — AC-05), approvals (discount ≥ limit → CEO, void chain),
// issue, payments in $ / ៛ / ABA / ACLEDA (partial, many — AC-10), void with reason (BR-18 … BR-21). Mobile-first, sticky actions.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, fromCents, toCents, usdToKhr } from "@sms/shared";
import { Ban, Check, Pencil, Printer, Send, Wallet, X } from "lucide-react";
import { api, errCode, fmtDate, type Invoice, type PayMethod } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ActionBar, Button, Card, Dialog, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { InvoiceBadge } from "./shared";
import { todayLocal } from "./util";

export default function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => api.invoices.get(id!) });
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const refresh = () => { for (const k of [["invoice", id], ["invoices"], ["invoice-for"], ["booking"], ["bookings"]]) void qc.invalidateQueries({ queryKey: k }); };
  const onErr = (e: unknown) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const issue = useMutation({ mutationFn: () => api.invoices.issue(id!), onSuccess: () => { toast.success(t("invoice.issued_ok")); refresh(); }, onError: onErr });
  if (q.isLoading) return <Skeleton />;
  if (q.isError || !q.data) return <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const draft = d.status === "draft", issued = d.status === "issued";
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="font-mono break-all">{d.number}</h1>
          <p className="text-sm text-muted break-words">{d.customer_name}{d.booking_number && <> · <Link className="text-blue underline" to={`/bookings/${d.booking_id}`}>{d.booking_number}</Link></>}</p>
        </div>
        <InvoiceBadge status={d.status} payment={d.payment_status} />
      </div>

      {d.status === "void" && <Card className="border-danger bg-danger-50"><p className="text-danger font-semibold">VOID · {fmtDate(d.voided_at!)} · {d.voided_by_name}</p><p className="text-sm break-words">📝 {d.void_reason}</p></Card>}
      <Approvals d={d} onDone={refresh} />

      <Card title={t("quote.lines")}>
        <ul className="text-sm divide-y divide-grey-line">
          {d.lines.map((l, i) => <li key={l.id ?? i} className="py-2 flex gap-2"><span className="flex-1 min-w-0 break-words">{l.description} <span className="text-xs text-muted">× {l.qty} {l.unit}</span></span><span className="tabular">{formatUsd(l.line_total ?? 0)}</span></li>)}
        </ul>
        <Totals d={d} />
      </Card>

      {draft && d.can.discount && <DiscountCard d={d} onDone={refresh} />}

      {(issued || d.payments.length > 0) && (
        <Card title={t("invoice.payments")} actions={issued && d.can.pay && d.balance > 0 ? <Button variant="primary" onClick={() => setPaying(true)} data-testid="pay-open"><Wallet size={16} /> {t("invoice.record_payment")}</Button> : undefined}>
          {d.payments.length === 0 ? <p className="text-sm text-muted">{t("invoice.no_payments")}</p> : (
            <ul className="text-sm divide-y divide-grey-line">
              {d.payments.map((p) => (
                <li key={p.id} className="py-2 flex gap-2 items-start">
                  <div className="flex-1 min-w-0">
                    <div className="font-semibold tabular">{p.currency === "usd" ? formatUsd(p.amount) : formatKhr(p.amount)} <span className="text-xs text-muted font-normal">· {t(`invoice.method.${p.method}`)}</span></div>
                    <div className="text-xs text-muted">{p.paid_on} · {p.received_by_name}{p.currency === "khr" ? ` · ${formatKhr(p.fx_rate_khr)}/$` : ""}{p.note ? ` · ${p.note}` : ""}</div>
                  </div>
                  <span className="tabular text-success">{formatUsd(p.usd_cents)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {d.status !== "void" && d.can.void_request && !d.void_request && d.payments.length === 0 && (
        <div className="text-center"><Button variant="danger" onClick={() => setVoiding(true)} data-testid="void-open"><Ban size={16} /> {t("invoice.void")}</Button></div>
      )}

      <ActionBar>
        {!draft && <Link className="btn-secondary" to={`/invoices/${d.id}/print`}><Printer size={16} /> {t("quote.print")}</Link>}
        {draft && d.can.issue && <Button onClick={() => nav(`/invoices/${d.id}/edit`)}><Pencil size={16} /> {t("app.edit")}</Button>}
        {draft && d.can.issue && <Button variant="primary" className="flex-1 sm:flex-none" disabled={d.discount_status === "pending"} loading={issue.isPending} onClick={() => issue.mutate()} data-testid="invoice-issue"><Send size={16} /> {t("invoice.issue")}</Button>}
        {issued && d.can.pay && d.balance > 0 && <Button variant="primary" className="flex-1 sm:flex-none" onClick={() => setPaying(true)}><Wallet size={16} /> {t("invoice.record_payment")}</Button>}
      </ActionBar>
      {draft && d.discount_status === "pending" && <p className="text-sm text-warning">{t("invoice.err.DISCOUNT_PENDING")}</p>}
      {paying && <PaymentDialog d={d} onClose={() => setPaying(false)} onDone={() => { setPaying(false); refresh(); }} />}
      {voiding && <VoidDialog d={d} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); refresh(); }} />}
    </div>
  );
}

function Totals({ d }: { d: Invoice }) {
  const { t } = useTranslation();
  const row = (label: string, v: string, strong = false, cls = "") => <div className={`flex justify-between gap-3 ${strong ? "font-bold text-base" : "text-sm"} ${cls}`}><span>{label}</span><span className="tabular text-right">{v}</span></div>;
  return (
    <div className="mt-3 border-t border-grey-line pt-3 space-y-1" data-testid="invoice-totals">
      {row(t("invoice.subtotal"), formatUsd(d.subtotal))}
      {d.discount > 0 && row(t("invoice.discount"), `− ${formatUsd(d.discount)}`, false, "text-success")}
      {row(t("quote.total"), formatUsd(d.total), true)}
      <div className="text-right text-xs text-muted tabular">≈ {formatKhr(d.total_khr)} ({formatKhr(d.fx_rate_khr)}/$)</div>
      {d.status === "issued" && <>
        {row(t("invoice.paid"), formatUsd(d.paid))}
        {row(t("invoice.balance"), formatUsd(d.balance), true, d.balance > 0 ? "text-danger" : "text-success")}
        {d.balance > 0 && <div className="text-right text-xs text-muted tabular">≈ {formatKhr(d.balance_khr)}</div>}
      </>}
    </div>
  );
}

/** pending discount (CEO decides) and pending void request (approver decides) */
function Approvals({ d, onDone }: { d: Invoice; onDone: () => void }) {
  const { t } = useTranslation();
  const onErr = (e: unknown) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const disc = useMutation({ mutationFn: (ok: boolean) => api.invoices.decideDiscount(d.id, ok), onSuccess: () => { toast.success(t("app.saved")); onDone(); api.flushTelegram(); }, onError: onErr });
  const vd = useMutation({ mutationFn: (ok: boolean) => api.invoices.decideVoid(d.id, ok), onSuccess: () => { toast.success(t("app.saved")); onDone(); api.flushTelegram(); }, onError: onErr });
  return (
    <>
      {d.status === "draft" && d.discount_status === "pending" && (
        <Card className="border-warning bg-warning-50">
          <p className="font-semibold">⏳ {t("invoice.discount_waiting", { amount: formatUsd(d.discount_requested ?? 0) })}</p>
          <p className="text-sm text-muted break-words">{d.discount_by_name}{d.discount_note ? ` · ${d.discount_note}` : ""}</p>
          {d.can.discount_approve && <div className="flex gap-2 mt-3">
            <Button variant="danger" loading={disc.isPending} onClick={() => disc.mutate(false)}><X size={16} /> {t("leave.reject")}</Button>
            <Button variant="primary" className="flex-1 sm:flex-none" loading={disc.isPending} onClick={() => disc.mutate(true)} data-testid="discount-approve"><Check size={16} /> {t("leave.approve")}</Button>
          </div>}
        </Card>
      )}
      {d.void_request && (
        <Card className="border-danger bg-danger-50">
          <p className="font-semibold text-danger">🚫 {t("invoice.void_waiting", { name: d.void_request.requested_by_name })}</p>
          <p className="text-sm break-words">📝 {d.void_request.reason}</p>
          <p className="text-xs text-muted">{t(d.void_request.requester_role === "admin" ? "invoice.void_to_gm" : "invoice.void_to_ceo")}</p>
          {d.can.void_approve && <div className="flex gap-2 mt-3">
            <Button loading={vd.isPending} onClick={() => vd.mutate(false)}><X size={16} /> {t("leave.reject")}</Button>
            <Button variant="danger" className="flex-1 sm:flex-none" loading={vd.isPending} onClick={() => vd.mutate(true)} data-testid="void-approve"><Ban size={16} /> {t("invoice.void_approve")}</Button>
          </div>}
        </Card>
      )}
    </>
  );
}

function DiscountCard({ d, onDone }: { d: Invoice; onDone: () => void }) {
  const { t } = useTranslation();
  const settings = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const limit = Number(settings.data?.discount_approval_limit ?? 5000);
  const [amount, setAmount] = useState(d.discount_requested ? String(fromCents(d.discount_requested)) : "");
  const [note, setNote] = useState(d.discount_note ?? "");
  let cents = NaN; try { cents = amount.trim() ? toCents(amount) : 0; } catch { /* invalid */ }
  const needsCeo = !d.can.discount_approve && cents >= limit;
  const save = useMutation({
    mutationFn: () => api.invoices.discount(d.id, cents, note),
    onSuccess: (r) => { toast.success(t(r.discount_status === "pending" ? "invoice.discount_sent" : "app.saved")); onDone(); api.flushTelegram(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Card title={t("invoice.discount")}>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("invoice.discount_amount")}><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" data-testid="discount-amount" /></Field>
        <Field label={t("invoice.discount_note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
      <p className={`text-xs ${needsCeo ? "text-warning font-semibold" : "text-muted"}`}>{needsCeo ? t("invoice.discount_needs_ceo") : d.can.discount_approve ? t("invoice.discount_hint_ceo") : t("invoice.discount_hint", { limit: formatUsd(limit) })}</p>
      <Button className="mt-2" variant="primary" disabled={Number.isNaN(cents) || cents < 0 || cents > d.subtotal} loading={save.isPending} onClick={() => save.mutate()} data-testid="discount-save">{t("app.save")}</Button>
    </Card>
  );
}

const METHODS: PayMethod[] = ["cash_usd", "cash_khr", "aba", "acleda"];
function PaymentDialog({ d, onClose, onDone }: { d: Invoice; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const fx = d.company.fx_now;
  const [currency, setCurrency] = useState<"usd" | "khr">("usd");
  const [method, setMethod] = useState<PayMethod>("cash_usd");
  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [note, setNote] = useState("");
  const pick = (c: "usd" | "khr") => { setCurrency(c); setAmount(""); if (method === "cash_usd" && c === "khr") setMethod("cash_khr"); if (method === "cash_khr" && c === "usd") setMethod("cash_usd"); };
  let value = NaN;
  try { value = currency === "usd" ? toCents(amount) : /^\d[\d,]*$/.test(amount.trim()) ? Number(amount.replace(/,/g, "")) : NaN; } catch { /* invalid */ }
  const cents = currency === "usd" ? value : Math.round((value / fx) * 100);
  const save = useMutation({
    mutationFn: () => api.invoices.pay(d.id, { amount: value, currency, method, paid_on: paidOn, note }),
    onSuccess: (r) => { toast.success(r.payment_status === "paid" ? t("invoice.paid_full") : t("invoice.paid_part", { balance: formatUsd(r.balance) })); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const full = () => setAmount(currency === "usd" ? fromCents(d.balance).toFixed(2) : String(usdToKhr(d.balance, fx)));
  return (
    <Dialog open onClose={onClose} title={`${t("invoice.record_payment")} · ${d.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!(value > 0)} loading={save.isPending} onClick={() => save.mutate()} data-testid="pay-save">{t("app.save")}</Button>
    </>}>
      <div className="rounded-md bg-grey-bg p-3 mb-3 flex justify-between text-sm"><span>{t("invoice.balance")}</span><span className="font-bold tabular">{formatUsd(d.balance)} <span className="font-normal text-muted">≈ {formatKhr(usdToKhr(d.balance, fx))}</span></span></div>
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup" aria-label={t("invoice.currency")}>
        {(["usd", "khr"] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={currency === c} onClick={() => pick(c)} className={`min-h-[44px] rounded-md border font-semibold ${currency === c ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{c === "usd" ? "$ USD" : "៛ KHR"}</button>)}
      </div>
      <Field label={currency === "usd" ? t("invoice.amount_usd") : t("invoice.amount_khr")} required>
        <div className="flex gap-2">
          <Input inputMode={currency === "usd" ? "decimal" : "numeric"} value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" autoFocus data-testid="pay-amount" />
          <Button type="button" onClick={full}>{t("invoice.full")}</Button>
        </div>
      </Field>
      {currency === "khr" && value > 0 && <p className="text-xs text-muted -mt-2 mb-2 tabular">= {formatUsd(cents)} ({formatKhr(fx)}/$)</p>}
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup" aria-label={t("invoice.method_label")}>
        {METHODS.filter((m) => !(m === "cash_usd" && currency === "khr") && !(m === "cash_khr" && currency === "usd")).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)} className={`min-h-[44px] rounded-md border text-sm ${method === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`invoice.method.${m}`)}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("invoice.paid_on")}><Input type="date" value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        <Field label={t("invoice.pay_note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Dialog>
  );
}

function VoidDialog({ d, onClose, onDone }: { d: Invoice; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const { me } = useAuth();
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.invoices.void(d.id, reason.trim()),
    onSuccess: (r) => { toast.success(t(r.status === "void" ? "invoice.void_done" : "invoice.void_sent")); api.flushTelegram(); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("invoice.void")} · ${d.number}`} footer={<>
      <Button onClick={onClose}>{t("app.back")}</Button>
      <Button variant="danger" className="flex-1 sm:flex-none" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()} data-testid="void-save">{me?.role === "ceo" ? t("invoice.void_now") : t("invoice.void_request")}</Button>
    </>}>
      <p className="text-sm mb-2">{me?.role === "ceo" ? t("invoice.void_ceo_hint") : t(me?.role === "admin" ? "invoice.void_to_gm" : "invoice.void_to_ceo")}</p>
      <Field label={t("booking.cancel_reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} autoFocus data-testid="void-reason" /></Field>
    </Dialog>
  );
}
