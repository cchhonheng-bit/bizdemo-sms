// Invoice (Flow 4 · M8): lines + totals, discount (GM / CEO only — AC-05), approvals (discount ≥ limit → CEO, void chain),
// issue, payments in $ / ៛ / ABA / ACLEDA (partial, many — AC-10), void with reason (BR-18 … BR-21). Mobile-first, sticky actions.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, fromCents, toCents, usdToKhr } from "@sms/shared";
import { Ban, Check, Link2, Pencil, Printer, Send, Wallet, X } from "lucide-react";
import { api, errCode, fmtDate, type Invoice, type PaymentSlip, type PayMethod } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ActionBar, Badge, Button, Card, ConfirmDialog, Dialog, ErrorState, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { InvoiceBadge } from "./shared";
import PaymentRow from "./PaymentRow";
import AccountingPanel from "./AccountingPanel";
import { useFeature } from "@/lib/config";
import { todayLocal } from "./util";
import { NumberDialog } from "@/components/NumberDialog";

export default function InvoiceDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams();
  const nav = useNavigate();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["invoice", id], queryFn: () => api.invoices.get(id!) });
  const [paying, setPaying] = useState(false);
  const [voiding, setVoiding] = useState(false);
  const [numbering, setNumbering] = useState(false); // D-196
  const refresh = () => { for (const k of [["invoice", id], ["invoices"], ["invoice-for"], ["booking"], ["bookings"]]) void qc.invalidateQueries({ queryKey: k }); };
  const onErr = (e: unknown) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  // D-126: the invoice date may be earlier (inside an unlocked period; a reason when more than 3 days back)
  const [issuing, setIssuing] = useState(false);
  const can = useAuth((st) => st.can), accountingOn = useFeature("accounting");
  const acctOn = accountingOn && can("accounting.view"); // D-142: «ការកត់ត្រាគណនេយ្យ» (CFO / CEO / Admin)
  const issue = useMutation({ mutationFn: (v: { date?: string; reason?: string }) => api.invoices.issue(id!, v), onSuccess: () => { toast.success(t("invoice.issued_ok")); setIssuing(false); refresh(); }, onError: onErr });
  if (q.isLoading) return <Skeleton />;
  if (q.isError || !q.data) return <ErrorState text={t("app.error")} onRetry={() => void q.refetch()} />;
  const d = q.data;
  const draft = d.status === "draft", issued = d.status === "issued";
  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="font-mono break-all">{d.number}{d.can.issue && d.status !== "void" && <button type="button" className="ml-2 align-middle text-muted hover:text-ink" aria-label={t("numbers.edit")} onClick={() => setNumbering(true)} data-testid="invoice-number-edit"><Pencil size={16} /></button>}</h1>
          <p className="text-sm text-muted break-words">{d.customer_name}{d.booking_number && <> · <Link className="text-blue underline" to={`/bookings/${d.booking_id}`}>{d.booking_number}</Link></>}</p>
        </div>
        <InvoiceBadge status={d.status} payment={d.payment_status} />
      </div>

      {d.status === "void" && <Card className="border-danger bg-danger-50"><p className="text-danger font-semibold">VOID · {fmtDate(d.voided_at!)} · {d.voided_by_name}</p><p className="text-sm break-words">📝 {d.void_reason}</p></Card>}
      <Approvals d={d} onDone={refresh} />

      <Card title={t("quote.lines")}>
        <ul className="text-sm divide-y divide-grey-line">
          {d.lines.map((l, i) => <LineRow key={l.id ?? i} d={d} l={l} canSwitch={issued && !!d.can.line_kind && accountingOn && l.id != null} onDone={refresh} />)}
        </ul>
        <Totals d={d} />
      </Card>

      {draft && d.can.discount && <DiscountCard d={d} onDone={refresh} />}
      {issued && d.balance > 0 && d.can.issue && <SendCard d={d} onDone={refresh} />}
      {d.slips.length > 0 && <SlipsCard d={d} onDone={() => { refresh(); api.flushTelegram(); }} />}

      {(issued || d.payments.length > 0) && (
        <Card title={t("invoice.payments")} actions={issued && d.can.pay && d.balance > 0 ? <Button variant="primary" onClick={() => setPaying(true)} data-testid="pay-open"><Wallet size={16} /> {t("invoice.record_payment")}</Button> : undefined}>
          {d.payments.length === 0 ? <p className="text-sm text-muted">{t("invoice.no_payments")}</p> : (
            <ul className="text-sm divide-y divide-grey-line">
              {d.payments.map((p) => <PaymentRow key={p.id} p={p} d={d} onDone={refresh} />)}
            </ul>
          )}
        </Card>
      )}

      {acctOn && !draft && <AccountingPanel invoiceId={d.id} />}

      {d.status !== "void" && d.can.void_request && !d.void_request && d.paid === 0 && (
        <div className="text-center"><Button variant="danger" onClick={() => setVoiding(true)} data-testid="void-open"><Ban size={16} /> {t("invoice.void")}</Button></div>
      )}

      <ActionBar>
        {!draft && <Link className="btn-secondary" to={`/invoices/${d.id}/print`}><Printer size={16} /> {t("quote.print")}</Link>}
        {draft && d.can.issue && <Button onClick={() => nav(`/invoices/${d.id}/edit`)}><Pencil size={16} /> {t("app.edit")}</Button>}
        {draft && d.can.issue && <Button variant="primary" className="flex-1 sm:flex-none" disabled={d.discount_status === "pending"} onClick={() => setIssuing(true)} data-testid="invoice-issue"><Send size={16} /> {t("invoice.issue")}</Button>}
        {issued && d.can.pay && d.balance > 0 && <Button variant="primary" className="flex-1 sm:flex-none" onClick={() => setPaying(true)}><Wallet size={16} /> {t("invoice.record_payment")}</Button>}
      </ActionBar>
      {draft && d.discount_status === "pending" && <p className="text-sm text-warning">{t("invoice.err.DISCOUNT_PENDING")}</p>}
      {issuing && <IssueDialog loading={issue.isPending} onClose={() => setIssuing(false)} onIssue={(v) => issue.mutate(v)} />}
      {paying && <PaymentDialog d={d} onClose={() => setPaying(false)} onDone={() => { setPaying(false); refresh(); }} />}
      {numbering && <NumberDialog title={t("numbers.title_invoice")} current={d.number} needReason={d.status === "issued"} onSave={(n, r) => api.invoices.setNumber(d.id, n, r).then(refresh)} onClose={() => setNumbering(false)} />}
      {voiding && <VoidDialog d={d} onClose={() => setVoiding(false)} onDone={() => { setVoiding(false); refresh(); }} />}
    </div>
  );
}

/** D-126: issue with today's date, or an earlier one inside an unlocked period (a reason when more than 3 days back) */
function IssueDialog({ loading, onClose, onIssue }: { loading: boolean; onClose: () => void; onIssue: (v: { date?: string; reason?: string }) => void }) {
  const { t } = useTranslation();
  const today = todayLocal();
  const [date, setDate] = useState(today);
  const [reason, setReason] = useState("");
  const back = Math.round((Date.parse(today) - Date.parse(date)) / 86_400_000);
  const ok = !!date && date <= today && (back <= 3 || reason.trim().length >= 3);
  return (
    <Dialog open onClose={onClose} title={t("invoice.issue")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!ok} loading={loading} onClick={() => onIssue(date === today ? {} : { date, ...(back > 3 ? { reason: reason.trim() } : {}) })} data-testid="invoice-issue-go"><Send size={16} /> {t("invoice.issue")}</Button>
    </>}>
      <Field label={t("invoice.issue_date")} hint={t("invoice.issue_date_hint")}>
        <Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="invoice-issue-date" />
      </Field>
      {back > 3 && <Field label={t("invoice.issue_reason")} required><textarea className="input h-20 py-2" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} data-testid="invoice-issue-reason" /></Field>}
    </Dialog>
  );
}

/** D-184 (client 28-10): a line with its type (service / goods); on an issued invoice the CFO / CEO switch it — its revenue moves to
 *  the other income account by one entry, the total and the payments stay */
function LineRow({ d, l, canSwitch, onDone }: { d: Invoice; l: Invoice["lines"][number]; canSwitch: boolean; onDone: () => void }) {
  const { t } = useTranslation();
  const [ask, setAsk] = useState(false);
  const to = l.kind === "service" ? "product" : "service";
  const m = useMutation({
    mutationFn: () => api.invoices.setLineKind(d.id, l.id!, to),
    onSuccess: () => { toast.success(t("invoice.kind_done")); setAsk(false); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  // D-196: a section heading / a text row inside the price of the line above (the client's Excel)
  if (l.row_type === "heading") return <li className="py-2 text-center font-semibold bg-warning-50 rounded" data-testid="invoice-heading">{l.description}</li>;
  if (l.row_type === "text") return <li className="py-1 pl-6 text-muted break-words" data-testid="invoice-text-row">↳ {l.description}</li>;
  return (
    <li className="py-2 flex flex-wrap items-center gap-2" data-testid="invoice-line">
      <span className="flex-1 min-w-0 break-words">{l.description} <span className="text-xs text-muted">× {l.qty} {l.unit}</span> <Badge tone={l.kind === "product" ? "blue" : "grey"} data-testid="line-kind">{t(`catalog.kind_${l.kind}`)}</Badge></span>
      <span className="tabular">{formatUsd(l.line_total ?? 0)}</span>
      {canSwitch && <Button type="button" onClick={() => setAsk(true)} data-testid="line-kind-switch">{t(to === "product" ? "invoice.kind_to_product" : "invoice.kind_to_service")}</Button>}
      <ConfirmDialog open={ask} onClose={() => setAsk(false)} onConfirm={() => m.mutate()} loading={m.isPending} title={t("invoice.kind_title")}
        text={t("invoice.kind_text", { line: l.description, kind: t(`catalog.kind_${to}`), amount: formatUsd(l.line_total ?? 0) })} />
    </li>
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
type SlipMethod = "aba" | "acleda" | "cash_usd";
const SLIP_METHODS: SlipMethod[] = ["aba", "acleda", "cash_usd"];
type PayLine = { key: number; currency: "usd" | "khr"; method: PayMethod; amount: string };
const lineCents = (l: PayLine, fx: number): number => {
  try { const v = l.currency === "usd" ? toCents(l.amount) : /^\d[\d,]*$/.test(l.amount.trim()) ? Number(l.amount.replace(/,/g, "")) : NaN; return l.currency === "usd" ? v : Math.round((v / fx) * 100); } catch { return NaN; }
};
const lineValue = (l: PayLine): number => { try { return l.currency === "usd" ? toCents(l.amount) : Number(l.amount.replace(/,/g, "")); } catch { return NaN; } };
/** D-161 (owner 22-10): one save may carry several parts — some cash $, some ABA, some ៛ (each line = method · currency · amount) */
function PaymentDialog({ d, onClose, onDone }: { d: Invoice; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const fx = d.company.fx_now;
  const [lines, setLines] = useState<PayLine[]>([{ key: 1, currency: "usd", method: "cash_usd", amount: "" }]);
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [note, setNote] = useState("");
  const set = (key: number, patch: Partial<PayLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const pick = (l: PayLine, c: "usd" | "khr") => set(l.key, { currency: c, amount: "", method: l.method === "cash_usd" && c === "khr" ? "cash_khr" : l.method === "cash_khr" && c === "usd" ? "cash_usd" : l.method });
  const cents = lines.map((l) => lineCents(l, fx));
  const sum = cents.reduce((a, c) => a + (c > 0 ? c : 0), 0);
  const valid = cents.every((c) => c > 0);
  const over = sum > d.balance + Math.ceil((100 / fx) * 100);
  const remaining = Math.max(0, d.balance - sum);
  const full = (l: PayLine) => { const rest = d.balance - cents.reduce((a, c, k) => a + (lines[k]!.key !== l.key && c > 0 ? c : 0), 0); set(l.key, { amount: l.currency === "usd" ? fromCents(Math.max(0, rest)).toFixed(2) : String(usdToKhr(Math.max(0, rest), fx)) }); };
  const save = useMutation({
    mutationFn: () => api.invoices.pay(d.id, { parts: lines.map((l) => ({ amount: lineValue(l), currency: l.currency, method: l.method })), paid_on: paidOn, note }),
    onSuccess: (r) => { toast.success(r.payment_status === "paid" ? t("invoice.paid_full") : t("invoice.paid_part", { balance: formatUsd(r.balance) })); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("invoice.record_payment")} · ${d.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid || over} loading={save.isPending} onClick={() => save.mutate()} data-testid="pay-save">{t("app.save")}</Button>
    </>}>
      <div className="rounded-md bg-grey-bg p-3 mb-3 flex justify-between text-sm"><span>{t("invoice.balance")}</span><span className="font-bold tabular">{formatUsd(d.balance)} <span className="font-normal text-muted">≈ {formatKhr(usdToKhr(d.balance, fx))}</span></span></div>
      {lines.map((l, k) => (
        <div key={l.key} className={`${k > 0 ? "mt-3 pt-3 border-t border-grey-line" : ""}`} data-testid={`pay-line-${k + 1}`}>
          {lines.length > 1 && <div className="flex items-center justify-between mb-1"><span className="text-xs font-semibold text-muted">{t("invoice.pay_part", { n: k + 1 })}</span>
            <button type="button" className="text-xs text-danger underline min-h-[32px]" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} data-testid={`pay-remove-${k + 1}`}>{t("invoice.remove_part")}</button></div>}
          <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup" aria-label={t("invoice.currency")}>
            {(["usd", "khr"] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={l.currency === c} onClick={() => pick(l, c)} className={`min-h-[44px] rounded-md border font-semibold ${l.currency === c ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{c === "usd" ? "$ USD" : "៛ KHR"}</button>)}
          </div>
          <Field label={l.currency === "usd" ? t("invoice.amount_usd") : t("invoice.amount_khr")} required>
            <div className="flex gap-2">
              <Input inputMode={l.currency === "usd" ? "decimal" : "numeric"} value={l.amount} onChange={(e) => set(l.key, { amount: e.target.value })} className="flex-1" autoFocus={k === lines.length - 1} data-testid={k === 0 ? "pay-amount" : `pay-amount-${k + 1}`} />
              <Button type="button" onClick={() => full(l)}>{t("invoice.full")}</Button>
            </div>
          </Field>
          {l.currency === "khr" && cents[k]! > 0 && <p className="text-xs text-muted -mt-2 mb-2 tabular">= {formatUsd(cents[k]!)} ({formatKhr(fx)}/$)</p>}
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("invoice.method_label")}>
            {METHODS.filter((m) => !(m === "cash_usd" && l.currency === "khr") && !(m === "cash_khr" && l.currency === "usd")).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={l.method === m} onClick={() => set(l.key, { method: m })} className={`min-h-[44px] rounded-md border text-sm ${l.method === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`invoice.method.${m}`)}</button>
            ))}
          </div>
        </div>
      ))}
      {lines.length < 6 && remaining > 0 && <Button type="button" className="mt-3 w-full" onClick={() => setLines((ls) => [...ls, { key: Date.now(), currency: "usd", method: "aba", amount: "" }])} data-testid="pay-add-part">+ {t("invoice.add_part")}</Button>}
      {lines.length > 1 && <div className="rounded-md bg-grey-bg p-3 mt-3 text-sm flex justify-between" data-testid="pay-sum"><span>{t("invoice.pay_total")}</span><span className="font-bold tabular">{formatUsd(sum)}{over ? <span className="text-danger font-normal"> · {t("invoice.err.OVERPAY")}</span> : remaining > 0 ? <span className="text-muted font-normal"> · {t("invoice.balance")} {formatUsd(remaining)}</span> : null}</span></div>}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <Field label={t("invoice.paid_on")}><Input type="date" value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        <Field label={t("invoice.pay_note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} /></Field>
      </div>
    </Dialog>
  );
}

/** D-195: the invoice reaches the customer — the Telegram notice (state, send again) or the customer's link to paste into any chat */
function SendCard({ d, onDone }: { d: Invoice; onDone: () => void }) {
  const { t } = useTranslation();
  const [url, setUrl] = useState<string | null>(null);
  const onErr = (e: unknown) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const link = useMutation({
    mutationFn: () => api.invoices.customerLink(d.id),
    onSuccess: async (r) => { setUrl(r.url); try { await navigator.clipboard.writeText(r.url); toast.success(t("invoice.send.copied")); } catch { /* shown below to copy by hand */ } },
    onError: onErr,
  });
  const again = useMutation({ mutationFn: () => api.invoices.notify(d.id), onSuccess: () => { toast.success(t("invoice.send.sent")); onDone(); }, onError: onErr });
  return (
    <Card title={t("invoice.send.title")}>
      <p className="text-sm" data-testid="invoice-send-state">{d.customer_notified_at ? `✅ ${t("invoice.send.notified", { at: fmtDate(d.customer_notified_at) })}` : d.customer_linked ? t("invoice.send.not_yet") : t("invoice.send.no_telegram")}</p>
      {d.customer_has_account && <p className="text-xs text-muted mt-1">{t("invoice.send.account")}</p>}
      <div className="flex flex-wrap gap-2 mt-3">
        <Button onClick={() => link.mutate()} loading={link.isPending} data-testid="invoice-copy-link"><Link2 size={16} /> {t("invoice.send.copy")}</Button>
        {d.customer_linked && <Button onClick={() => again.mutate()} loading={again.isPending} data-testid="invoice-notify"><Send size={16} /> {t("invoice.send.again")}</Button>}
      </div>
      {url && <input readOnly className="input mt-2 text-xs" value={url} onFocus={(e) => e.currentTarget.select()} data-testid="invoice-link" />}
    </Card>
  );
}

/** D-194: the customer's transfer receipts (website «ខ្ញុំបានបង់រួច») — the photo, then confirm (= a payment on the mapped account) or refuse with a reason */
function SlipsCard({ d, onDone }: { d: Invoice; onDone: () => void }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<PaymentSlip | null>(null);
  const [rejecting, setRejecting] = useState<PaymentSlip | null>(null);
  const canDecide = d.can.pay && d.status === "issued" && d.balance > 0;
  return (
    <Card title={t("invoice.slips.title")} className={d.slips.some((s) => s.status === "pending") ? "border-warning" : ""}>
      <ul className="text-sm divide-y divide-grey-line">
        {d.slips.map((s) => (
          <li key={s.id} className="py-3 flex gap-3" data-testid="slip-row">
            {d.can.pay && <a href={`/api/invoices/${d.id}/slips/${s.id}/photo`} target="_blank" rel="noopener" className="shrink-0">
              <img src={`/api/invoices/${d.id}/slips/${s.id}/photo`} alt={t("invoice.slips.photo")} className="w-20 h-20 object-cover rounded-md border border-grey-line" loading="lazy" />
            </a>}
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-semibold tabular">{formatUsd(s.amount)} · {s.bank === "other" ? t("invoice.slips.bank_other") : t(`invoice.method.${s.bank}`)}</p>
              <p className="text-xs text-muted">{fmtDate(s.created_at)} · {t(`invoice.slips.via_${s.via}`)}</p>
              {s.note && <p className="text-xs break-words">📝 {s.note}</p>}
              {s.status === "pending"
                ? canDecide
                  ? <div className="flex flex-wrap gap-2 pt-1"><Button variant="primary" onClick={() => setConfirming(s)} data-testid="slip-confirm"><Check size={16} /> {t("invoice.slips.confirm")}</Button>
                    <Button onClick={() => setRejecting(s)} data-testid="slip-reject"><X size={16} /> {t("invoice.slips.reject")}</Button></div>
                  : <Badge tone="warning">{t("invoice.slips.pending")}</Badge>
                : <p className="text-xs break-words"><Badge tone={s.status === "confirmed" ? "green" : "danger"}>{t(`invoice.slips.${s.status}`)}</Badge> {s.decided_by_name}{s.reject_reason ? ` · ${s.reject_reason}` : ""}</p>}
            </div>
          </li>
        ))}
      </ul>
      {confirming && <ConfirmSlipDialog d={d} s={confirming} onClose={() => setConfirming(null)} onDone={() => { setConfirming(null); onDone(); }} />}
      {rejecting && <RejectSlipDialog d={d} s={rejecting} onClose={() => setRejecting(null)} onDone={() => { setRejecting(null); onDone(); }} />}
    </Card>
  );
}

function ConfirmSlipDialog({ d, s, onClose, onDone }: { d: Invoice; s: PaymentSlip; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(fromCents(Math.min(s.amount, d.balance)).toFixed(2));
  const [method, setMethod] = useState<SlipMethod>(s.bank === "acleda" ? "acleda" : "aba");
  const [paidOn, setPaidOn] = useState(todayLocal());
  let cents = NaN; try { cents = toCents(amount); } catch { /* invalid */ }
  const ok = cents > 0 && cents <= d.balance;
  const save = useMutation({
    mutationFn: () => api.invoices.confirmSlip(d.id, s.id, { amount: cents, method, paid_on: paidOn }),
    onSuccess: (r) => { toast.success(r.payment_status === "paid" ? t("invoice.paid_full") : t("invoice.paid_part", { balance: formatUsd(r.balance) })); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("invoice.slips.confirm")} · ${d.number}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!ok} loading={save.isPending} onClick={() => save.mutate()} data-testid="slip-confirm-save">{t("invoice.slips.confirm")}</Button>
    </>}>
      <p className="text-sm mb-3">{t("invoice.slips.confirm_hint")}</p>
      <Field label={t("invoice.amount_usd")} required><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} data-testid="slip-amount" /></Field>
      {cents > d.balance && <p className="text-xs text-danger -mt-2 mb-2">{t("invoice.err.OVERPAY")}</p>}
      <div className="grid grid-cols-3 gap-2 mb-3" role="radiogroup" aria-label={t("invoice.method_label")}>
        {SLIP_METHODS.map((m) => <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)} className={`min-h-[44px] rounded-md border text-sm ${method === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`invoice.method.${m}`)}</button>)}
      </div>
      <Field label={t("invoice.paid_on")}><Input type="date" value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} /></Field>
    </Dialog>
  );
}

function RejectSlipDialog({ d, s, onClose, onDone }: { d: Invoice; s: PaymentSlip; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [reason, setReason] = useState("");
  const save = useMutation({
    mutationFn: () => api.invoices.rejectSlip(d.id, s.id, reason.trim()),
    onSuccess: () => { toast.success(t("app.saved")); onDone(); },
    onError: (e) => toast.error(t(`invoice.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  return (
    <Dialog open onClose={onClose} title={`${t("invoice.slips.reject")} · ${formatUsd(s.amount)}`} footer={<>
      <Button onClick={onClose}>{t("app.back")}</Button>
      <Button variant="danger" className="flex-1 sm:flex-none" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()} data-testid="slip-reject-save">{t("invoice.slips.reject")}</Button>
    </>}>
      <p className="text-sm mb-2">{t("invoice.slips.reject_hint")}</p>
      <Field label={t("invoice.slips.reason")} required><textarea className="input h-20 py-2" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} autoFocus data-testid="slip-reason" /></Field>
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
