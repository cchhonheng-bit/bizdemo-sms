// Books setup: opening balances once at go-live (cash, banks, old customer debts, supplier debts — open invoices, stock and
// deposits already in the app are added automatically) · lock date (CFO): nothing on or before it can be posted.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { Lock, Plus, Trash2 } from "lucide-react";
import { api, type BooksInfo } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, ConfirmDialog, Field, Input, Select } from "@/components/ui";
import { toast } from "@/lib/toast";
import { shiftDay } from "@/features/reports/range";
import { cents, useAcctErr } from "./acct";

export default function Setup({ info }: { info: BooksInfo | undefined }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  if (!info) return null;
  return (
    <>
      <Card title={t("acct.books")}>
        <dl className="text-sm grid grid-cols-2 gap-y-1">
          <dt className="text-muted">{t("acct.books_start")}</dt><dd data-testid="books-start">{info.books_start ?? "—"}</dd>
          <dt className="text-muted">{t("acct.lock_date")}</dt><dd data-testid="lock-date">{info.lock_date ?? "—"}</dd>
          <dt className="text-muted">{t("acct.rate_label")}</dt><dd>{info.fx_rate_khr}៛</dd>
        </dl>
      </Card>
      {!info.books_start && (can("accounting.close") ? <Opening today={info.today} /> : <p className="text-sm text-muted">{t("acct.not_started")}</p>)}
      {info.books_start && can("accounting.close") && <LockCard info={info} />}
    </>
  );
}

function LockCard({ info }: { info: BooksInfo }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const [date, setDate] = useState(info.lock_date ?? shiftDay(info.today, -1));
  const [reason, setReason] = useState("");
  const back = !!info.lock_date && date < info.lock_date;
  const save = useMutation({ mutationFn: () => api.accounting.setLock(date, reason), onSuccess: () => { toast.success(t("app.saved")); setReason(""); void qc.invalidateQueries({ queryKey: ["books"] }); }, onError: onErr });
  return (
    <Card title={t("acct.lock_title")}>
      <p className="text-xs text-muted mb-2">{t("acct.lock_hint")}</p>
      <Field label={t("acct.lock_until")}><Input type="date" value={date} max={shiftDay(info.today, -1)} min={shiftDay(info.books_start!, -1)} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="lock-input" /></Field>
      {back && <Field label={t("acct.reopen_reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>}
      <Button variant="primary" className="w-full sm:w-auto" disabled={date === info.lock_date || (back && reason.trim().length < 3)} loading={save.isPending} onClick={() => save.mutate()} data-testid="lock-save"><Lock size={16} /> {t("acct.lock_save")}</Button>
    </Card>
  );
}

type Recv = { customer_id: string; amount: string; note: string };
type Pay = { supplier: string; amount: string };
function Opening({ today }: { today: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const customers = useQuery({ queryKey: ["customers", "active"], queryFn: () => api.customers(true) });
  const [date, setDate] = useState(today);
  const [usd, setUsd] = useState(""); const [riel, setRiel] = useState(""); const [aba, setAba] = useState(""); const [acleda, setAcleda] = useState("");
  const [recv, setRecv] = useState<Recv[]>([]); const [pays, setPays] = useState<Pay[]>([]);
  const [confirm, setConfirm] = useState(false);
  const c = (v: string) => (v.trim() === "" ? 0 : cents(v));
  const riels = riel.trim() === "" ? 0 : /^\d+$/.test(riel.replace(/[,\s]/g, "")) ? Number(riel.replace(/[,\s]/g, "")) : NaN;
  const nums = [c(usd), c(aba), c(acleda), riels, ...recv.map((r) => c(r.amount)), ...pays.map((p) => c(p.amount))];
  const valid = nums.every((n) => Number.isFinite(n) && n >= 0) && recv.every((r) => r.customer_id && c(r.amount) > 0) && pays.every((p) => p.supplier.trim() && c(p.amount) > 0);
  const save = useMutation({
    mutationFn: () => api.accounting.opening({ date, cash_usd: c(usd), cash_khr: riels, banks: { aba: c(aba), acleda: c(acleda) },
      receivables: recv.map((r) => ({ customer_id: r.customer_id, amount: c(r.amount), note: r.note || undefined })), payables: pays.map((p) => ({ supplier: p.supplier.trim(), amount: c(p.amount) })) }),
    onSuccess: (r) => { toast.success(t("acct.opening_done", { equity: formatUsd(r.opening_equity), n: r.open_invoices })); setConfirm(false); void qc.invalidateQueries(); },
    onError: (e) => { setConfirm(false); onErr(e); },
  });
  return (
    <Card title={t("acct.opening_title")}>
      <p className="text-xs text-muted mb-3">{t("acct.opening_hint")}</p>
      <Field label={t("acct.go_live")}><Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="op-date" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("acct.pay.cash_usd")}><Input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="$0.00" data-testid="op-cash-usd" /></Field>
        <Field label={t("acct.pay.cash_khr")}><Input inputMode="numeric" value={riel} onChange={(e) => setRiel(e.target.value)} placeholder="0 ៛" data-testid="op-cash-khr" /></Field>
        <Field label="ABA"><Input inputMode="decimal" value={aba} onChange={(e) => setAba(e.target.value)} placeholder="$0.00" data-testid="op-aba" /></Field>
        <Field label="ACLEDA"><Input inputMode="decimal" value={acleda} onChange={(e) => setAcleda(e.target.value)} placeholder="$0.00" data-testid="op-acleda" /></Field>
      </div>
      <h3 className="text-sm font-semibold mt-2">{t("acct.old_debts")}</h3>
      <p className="text-xs text-muted mb-2">{t("acct.old_debts_hint")}</p>
      {recv.map((r, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2 mb-2">
          <Select value={r.customer_id} onChange={(e) => setRecv((x) => x.map((y, j) => (j === i ? { ...y, customer_id: e.target.value } : y)))} aria-label={t("customers.title", { defaultValue: "Customer" })}>
            <option value="">—</option>{(customers.data ?? []).map((cu) => <option key={cu.id} value={cu.id}>{cu.name}</option>)}
          </Select>
          <Input inputMode="decimal" value={r.amount} placeholder="$0.00" onChange={(e) => setRecv((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
          <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => setRecv((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
        </div>
      ))}
      <Button onClick={() => setRecv((x) => [...x, { customer_id: "", amount: "", note: "" }])} data-testid="op-add-recv"><Plus size={16} /> {t("acct.add_debt")}</Button>
      <h3 className="text-sm font-semibold mt-4">{t("acct.supplier_debts")}</h3>
      {pays.map((p, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2 my-2">
          <Input value={p.supplier} placeholder={t("inventory.supplier")} onChange={(e) => setPays((x) => x.map((y, j) => (j === i ? { ...y, supplier: e.target.value } : y)))} maxLength={120} />
          <Input inputMode="decimal" value={p.amount} placeholder="$0.00" onChange={(e) => setPays((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
          <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => setPays((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
        </div>
      ))}
      <Button className="mt-2" onClick={() => setPays((x) => [...x, { supplier: "", amount: "" }])} data-testid="op-add-pay"><Plus size={16} /> {t("acct.add_supplier_debt")}</Button>
      <Button variant="primary" className="w-full mt-4" disabled={!valid} onClick={() => setConfirm(true)} data-testid="op-save">{t("acct.start_books")}</Button>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => save.mutate()} loading={save.isPending} title={t("acct.start_books")} text={t("acct.opening_confirm", { date })} />
    </Card>
  );
}
