// C4 other transactions in plain words: expense · purchase (asset or expense, cash / bank / on credit) · pay a supplier ·
// other income · owner puts money in / takes it out · move money between cash and banks. $ or ៛ (today's rate), receipt photo.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd, khrToCents } from "@sms/shared";
import { ArrowDownCircle, ArrowLeftRight, ArrowUpCircle, HandCoins, PiggyBank, ShoppingCart, Truck } from "lucide-react";
import { api, type AcctTxType, type AcctType } from "@/lib/api";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";
import { shiftDay } from "@/features/reports/range";
import { PayPicker, ReceiptInput } from "./common";
import { cents, useAccName, useAcctErr } from "./acct";

const KINDS: { type: AcctTxType; icon: typeof ArrowUpCircle }[] = [
  { type: "expense", icon: ArrowUpCircle }, { type: "purchase", icon: ShoppingCart }, { type: "supplier_payment", icon: Truck },
  { type: "other_income", icon: ArrowDownCircle }, { type: "owner_contribution", icon: PiggyBank }, { type: "owner_withdrawal", icon: HandCoins },
  { type: "transfer", icon: ArrowLeftRight },
];
const ACCOUNT_TYPES: Partial<Record<AcctTxType, AcctType[]>> = { expense: ["expense"], purchase: ["asset", "expense"], other_income: ["income"] };

export default function Money() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<AcctTxType | null>(null);
  const today = todayLocal();
  const recent = useQuery({ queryKey: ["acct-journal", "other", today], queryFn: () => api.accounting.journal(shiftDay(today, -30), today, "other") });
  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {KINDS.map(({ type, icon: Icon }) => (
          <button key={type} className="card p-3 min-h-[72px] flex flex-col items-center justify-center gap-1 text-sm text-center" onClick={() => setKind(type)} data-testid={`tx-${type}`}>
            <Icon size={22} className="text-navy" /> {t(`acct.tx.${type}`)}
          </button>
        ))}
      </div>
      <Card title={t("acct.recent")}>
        {recent.isLoading ? <Skeleton /> : !recent.data?.length ? <Empty text={t("acct.nothing")} /> : (
          <ul className="divide-y divide-grey-line -my-2">
            {recent.data.map((e) => (
              <li key={e.id} className="py-2 text-sm flex justify-between gap-2">
                <span className="min-w-0 break-words"><span className="block text-xs text-muted">{e.date} · {e.number}</span>{e.memo} {e.status === "reversed" && <Badge tone="danger">{t("acct.reversed")}</Badge>}</span>
                <span className="tabular whitespace-nowrap">{formatUsd(e.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {kind && <TxDialog type={kind} onClose={() => setKind(null)} />}
    </>
  );
}

function TxDialog({ type, onClose }: { type: AcctTxType; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const name = useAccName();
  const info = useQuery({ queryKey: ["books"], queryFn: api.accounting.info });
  const accs = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts, enabled: !!ACCOUNT_TYPES[type] });
  const choices = useMemo(() => (accs.data ?? []).filter((a) => a.is_active && ACCOUNT_TYPES[type]?.includes(a.type) && a.role !== "inventory"), [accs.data, type]);
  const [date, setDate] = useState(todayLocal());
  const [amount, setAmount] = useState(""); const [khr, setKhr] = useState(false);
  const [code, setCode] = useState(type === "other_income" ? "4090" : "");
  const [pay, setPay] = useState("cash_usd"); const [from, setFrom] = useState("cash_usd"); const [to, setTo] = useState("aba");
  const [supplier, setSupplier] = useState(""); const [memo, setMemo] = useState(""); const [photo, setPhoto] = useState<string | null>(null);
  const fx = info.data?.fx_rate_khr ?? 4100;
  const amt = khr ? (/^\d+$/.test(amount.trim()) ? Number(amount) : NaN) : cents(amount);
  const usd = khr ? (Number.isFinite(amt) ? khrToCents(amt, fx) : NaN) : amt;
  const needsAccount = !!ACCOUNT_TYPES[type];
  const needsSupplier = type === "supplier_payment" || ((type === "expense" || type === "purchase") && pay === "credit");
  const valid = usd > 0 && (!needsAccount || !!code) && (!needsSupplier || !!supplier.trim()) && (type !== "transfer" || from !== to);
  const save = useMutation({
    mutationFn: () => api.accounting.transaction({ date, type, amount: amt, currency: khr ? "khr" : "usd", account_code: needsAccount ? code : undefined,
      ...(type === "transfer" ? { from, to } : { pay }), supplier: supplier.trim() || null, memo: memo.trim() || null, attachment: photo }),
    onSuccess: (r) => { toast.success(t("acct.posted", { number: r.number })); void qc.invalidateQueries({ queryKey: ["acct-journal"] }); void qc.invalidateQueries({ queryKey: ["acct-accounts"] }); onClose(); },
    onError: onErr,
  });
  return (
    <Dialog open onClose={onClose} title={t(`acct.tx.${type}`)} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="tx-save">{t("app.save")}</Button>
    </>}>
      <p className="text-xs text-muted mb-2">{t(`acct.tx_hint.${type}`)}</p>
      <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
        <Field label={t("acct.amount")} required><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={khr ? "0 ៛" : "$0.00"} data-testid="tx-amount" /></Field>
        <div className="flex rounded-md border border-grey-line overflow-hidden mb-3">
          {([false, true] as const).map((k) => <button key={String(k)} type="button" role="radio" aria-checked={khr === k} className={`px-3 min-h-[44px] ${khr === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setKhr(k)}>{k ? "៛" : "$"}</button>)}
        </div>
      </div>
      {khr && Number.isFinite(usd) && usd > 0 && <p className="text-xs text-muted -mt-2 mb-2 tabular">= {formatUsd(usd)} · {t("acct.rate", { rate: fx })}</p>}
      {needsAccount && (
        <Field label={type === "other_income" ? t("acct.income_account") : t("acct.expense_account")} required>
          <Select value={code} onChange={(e) => setCode(e.target.value)} data-testid="tx-account"><option value="">{t("acct.pick_account")}</option>{choices.map((a) => <option key={a.id} value={a.code}>{name(a)}</option>)}</Select>
        </Field>
      )}
      {type === "transfer" ? (<>
        <p className="text-sm mb-1">{t("inventory.from")}</p><PayPicker value={from} onChange={setFrom} testid="tx-from" />
        <p className="text-sm mb-1">{t("inventory.to")}</p><PayPicker value={to} onChange={setTo} testid="tx-to" />
      </>) : (<>
        <p className="text-sm mb-1">{type === "other_income" || type === "owner_contribution" ? t("acct.received_in") : t("acct.paid_from")}</p>
        <PayPicker value={pay} onChange={setPay} credit={type === "expense" || type === "purchase"} testid="tx-pay" />
      </>)}
      {(needsSupplier || type === "expense" || type === "purchase") && <Field label={t("inventory.supplier")} required={needsSupplier}><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} data-testid="tx-supplier" /></Field>}
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("acct.date")}><Input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} /></Field>
        <Field label={t("acct.memo")}><Input value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} data-testid="tx-memo" /></Field>
      </div>
      <ReceiptInput value={photo} onChange={setPhoto} />
    </Dialog>
  );
}
