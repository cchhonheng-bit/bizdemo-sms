// D-167 (client 25-10): what the shop owes each supplier (purchases paid in part, opening debts, minus the payments) and «បង់» —
// a payment in $ or ៛ by cash / ABA / ACLEDA, dated, posted Dr the supplier's payable / Cr the method.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatKhr, formatUsd, toCents, usdToKhr } from "@sms/shared";
import { api, errCode, type Payable } from "@/lib/api";
import { Button, Card, Dialog, Empty, Field, Input, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";

type Method = "cash_usd" | "cash_khr" | "aba" | "acleda";
const METHODS: Method[] = ["cash_usd", "cash_khr", "aba", "acleda"];

export function Payables({ manage }: { manage: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["payables"], queryFn: api.inventory.payables });
  const [paying, setPaying] = useState<Payable | null>(null);
  if (q.isLoading || !q.data) return <Skeleton />;
  const rows = q.data;
  return (
    <Card title={t("inventory.payables_title")}>
      {!rows.length ? <Empty text={t("inventory.payables_none")} /> : (
        <ul className="divide-y divide-grey-line" data-testid="payables">
          {rows.map((p) => (
            <li key={p.supplier} className="py-3 flex flex-wrap items-center gap-2" data-testid="payable-row">
              <div className="flex-1 min-w-0">
                <div className="font-semibold break-words">{p.supplier}</div>
                <div className="text-xs text-muted break-words">{t("inventory.purchases_n", { n: p.purchases })}{p.opening ? ` · ${t("inventory.opening_debt")} ${formatUsd(p.opening)}` : ""}{p.paid ? ` · ${t("inventory.last_payment")} ${p.last_payment}` : ""}
                  {p.invoices.length ? ` · ${t("inventory.open_invoices")}: ${p.invoices.map((x) => `#${x}`).join(", ")}` : ""}</div>
              </div>
              <div className={`tabular font-bold ${p.owed > 0 ? "text-danger" : ""}`} data-testid="payable-owed">{formatUsd(p.owed)}</div>
              {manage && p.owed > 0 && <Button variant="primary" onClick={() => setPaying(p)} data-testid="payable-pay">{t("inventory.pay_supplier")}</Button>}
            </li>
          ))}
        </ul>
      )}
      {paying && <PayDialog p={paying} onClose={() => setPaying(null)} />}
    </Card>
  );
}

function PayDialog({ p, onClose }: { p: Payable; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const fxq = useQuery({ queryKey: ["acct-info"], queryFn: api.accounting.info });
  const fx = fxq.data?.fx_rate_khr ?? 4100;
  const [currency, setCurrency] = useState<"usd" | "khr">("usd");
  const [method, setMethod] = useState<Method>("cash_usd");
  const [amount, setAmount] = useState(""), [date, setDate] = useState(todayLocal()), [note, setNote] = useState("");
  const pick = (c: "usd" | "khr") => { setCurrency(c); setAmount(""); if (c === "khr" && method === "cash_usd") setMethod("cash_khr"); if (c === "usd" && method === "cash_khr") setMethod("cash_usd"); };
  let value = NaN;
  try { value = currency === "usd" ? toCents(amount) : /^\d[\d,]*$/.test(amount.trim()) ? Number(amount.replace(/,/g, "")) : NaN; } catch { /* invalid */ }
  const cents = currency === "usd" ? value : Math.round((value / fx) * 100);
  const save = useMutation({
    mutationFn: () => api.inventory.supplierPay({ supplier: p.supplier, amount: value, currency, method, date, note: note.trim() || null }),
    onSuccess: (r) => { toast.success(t("inventory.pay_done", { owed: formatUsd(r.owed) })); void qc.invalidateQueries({ queryKey: ["payables"] }); onClose(); },
    onError: (e) => toast.error(t(`inventory.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const full = () => setAmount(currency === "usd" ? (p.owed / 100).toFixed(2) : String(usdToKhr(p.owed, fx)));
  return (
    <Dialog open onClose={onClose} title={`${t("inventory.pay_supplier")} · ${p.supplier}`} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!(value > 0)} loading={save.isPending} onClick={() => save.mutate()} data-testid="spay-save">{t("app.save")}</Button>
    </>}>
      <div className="rounded-md bg-grey-bg p-3 mb-3 flex justify-between text-sm"><span>{t("inventory.owed")}</span><span className="font-bold tabular">{formatUsd(p.owed)} <span className="font-normal text-muted">≈ {formatKhr(usdToKhr(p.owed, fx))}</span></span></div>
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup">
        {(["usd", "khr"] as const).map((c) => <button key={c} type="button" role="radio" aria-checked={currency === c} onClick={() => pick(c)} className={`min-h-[44px] rounded-md border font-semibold ${currency === c ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{c === "usd" ? "$ USD" : "៛ KHR"}</button>)}
      </div>
      <Field label={currency === "usd" ? t("inventory.amount_usd") : t("inventory.amount_khr")} required>
        <div className="flex gap-2"><Input inputMode={currency === "usd" ? "decimal" : "numeric"} value={amount} onChange={(e) => setAmount(e.target.value)} className="flex-1" autoFocus data-testid="spay-amount" /><Button type="button" onClick={full}>{t("invoice.full")}</Button></div>
      </Field>
      {currency === "khr" && value > 0 && <p className="text-xs text-muted -mt-2 mb-2 tabular">= {formatUsd(cents)} ({formatKhr(fx)}/$)</p>}
      <p className="text-sm mb-1">{t("inventory.method")}</p>
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup">
        {METHODS.filter((m) => !(m === "cash_usd" && currency === "khr") && !(m === "cash_khr" && currency === "usd")).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={method === m} onClick={() => setMethod(m)} className={`min-h-[44px] rounded-md border text-sm ${method === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`inventory.pay.${m}`)}</button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("inventory.date")}><Input type="date" value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label={t("inventory.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      </div>
    </Dialog>
  );
}
