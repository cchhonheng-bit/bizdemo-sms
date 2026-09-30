// C6 payroll: base salary per staff → a run per month → bonus / deduction lines with a reason → CEO approves (posts to the books)
// → paid by cash / bank. Approved = fixed (void + new run to correct, CEO). Everything audited.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { Check, Plus, Trash2, Wallet, X } from "lucide-react";
import { api, type PayrollRun, type Salary } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { todayLocal } from "@/features/invoices/util";
import { PayPicker } from "./common";
import { cents, useAcctErr } from "./acct";

const TONE: Record<PayrollRun["status"], "grey" | "blue" | "green" | "danger"> = { draft: "grey", approved: "blue", paid: "green", void: "danger" };

export default function Payroll() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const manage = can("payroll.manage");
  const runs = useQuery({ queryKey: ["payroll-runs"], queryFn: api.accounting.payroll.runs });
  const [open, setOpen] = useState<string | null>(null);
  const [period, setPeriod] = useState(todayLocal().slice(0, 7));
  const create = useMutation({
    mutationFn: () => api.accounting.payroll.create(period),
    onSuccess: (r) => { void qc.invalidateQueries({ queryKey: ["payroll-runs"] }); setOpen(r.id); }, onError: onErr,
  });
  return (
    <>
      {manage && (
        <Card title={t("acct.payroll.new")}>
          <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
            <Field label={t("acct.payroll.period")}><Input type="month" value={period} onChange={(e) => e.target.value && setPeriod(e.target.value)} data-testid="pr-period" /></Field>
            <Button variant="primary" className="mb-3" loading={create.isPending} onClick={() => create.mutate()} data-testid="pr-create"><Plus size={16} /> {t("app.create")}</Button>
          </div>
        </Card>
      )}
      <Card title={t("acct.payroll.runs")}>
        {runs.isLoading ? <Skeleton /> : !runs.data?.length ? <Empty text={t("acct.nothing")} /> : (
          <ul className="divide-y divide-grey-line -my-2" data-testid="pr-list">
            {runs.data.map((r) => (
              <li key={r.id}><button className="w-full text-left py-2 min-h-[52px] flex justify-between gap-2 items-center" onClick={() => setOpen(r.id)}>
                <span><span className="font-semibold">{r.period}</span> <Badge tone={TONE[r.status]}>{t(`acct.payroll.status.${r.status}`)}</Badge><span className="block text-xs text-muted">{t("acct.payroll.people", { n: r.people })}</span></span>
                <span className="tabular font-semibold">{formatUsd(r.net)}</span>
              </button></li>
            ))}
          </ul>
        )}
      </Card>
      {manage && <Salaries />}
      {open && <RunDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}

function Salaries() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["payroll-salaries"], queryFn: api.accounting.payroll.salaries });
  return (
    <Card title={t("acct.payroll.salaries")}>
      <p className="text-xs text-muted mb-2">{t("acct.payroll.salaries_hint")}</p>
      {q.isLoading ? <Skeleton /> : <ul className="divide-y divide-grey-line -my-2">{(q.data ?? []).map((s) => <SalaryRow key={s.user_id} s={s} />)}</ul>}
    </Card>
  );
}
function SalaryRow({ s }: { s: Salary }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const [v, setV] = useState(s.base_salary ? (s.base_salary / 100).toFixed(2) : "");
  const c = v.trim() === "" ? 0 : cents(v);
  const save = useMutation({ mutationFn: () => api.accounting.payroll.setSalary(s.user_id, c), onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["payroll-salaries"] }); }, onError: onErr });
  return (
    <li className="py-2 grid grid-cols-[1fr_7rem_auto] gap-2 items-center">
      <span className="min-w-0 break-words text-sm">{s.full_name}<span className="block text-xs text-muted">{t(`roles.${s.role}`)}</span></span>
      <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="$0.00" aria-label={t("acct.payroll.base")} data-testid={`sal-${s.full_name}`} />
      <Button disabled={!(c >= 0) || c === s.base_salary} loading={save.isPending} onClick={() => save.mutate()} aria-label={t("app.save")}><Check size={16} /></Button>
    </li>
  );
}

function RunDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation();
  const { can } = useAuth();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const q = useQuery({ queryKey: ["payroll-run", id], queryFn: () => api.accounting.payroll.run(id) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["payroll-run", id] }); void qc.invalidateQueries({ queryKey: ["payroll-runs"] }); };
  const ok = () => { toast.success(t("app.saved")); refresh(); };
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState(false); const [pay, setPay] = useState("aba");
  const [voiding, setVoiding] = useState(false); const [reason, setReason] = useState("");
  const approve = useMutation({ mutationFn: () => api.accounting.payroll.approve(id), onSuccess: ok, onError: onErr });
  const payM = useMutation({ mutationFn: () => api.accounting.payroll.pay(id, pay), onSuccess: () => { setPaying(false); ok(); }, onError: onErr });
  const voidM = useMutation({ mutationFn: () => api.accounting.payroll.void(id, reason), onSuccess: () => { setVoiding(false); ok(); }, onError: onErr });
  const remove = useMutation({ mutationFn: (adj: number) => api.accounting.payroll.removeAdj(id, adj), onSuccess: ok, onError: onErr });
  const r = q.data;
  const draft = r?.status === "draft";
  return (
    <Dialog open onClose={onClose} title={r ? `${t("acct.tab.payroll")} ${r.period}` : t("app.loading")} footer={<>
      {r && (draft || r.status === "approved") && can("payroll.approve") && <Button variant="danger" onClick={() => setVoiding(true)}><X size={16} /> {t("acct.payroll.void")}</Button>}
      {draft && can("payroll.approve") && <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()} data-testid="pr-approve"><Check size={16} /> {t("acct.payroll.approve")}</Button>}
      {r?.status === "approved" && can("payroll.manage") && <Button variant="primary" onClick={() => setPaying(true)} data-testid="pr-pay"><Wallet size={16} /> {t("acct.payroll.pay")}</Button>}
      <Button onClick={onClose}>{t("app.close")}</Button>
    </>}>
      {!r ? <Skeleton /> : (<>
        <div className="flex flex-wrap gap-2 items-center mb-2">
          <Badge tone={TONE[r.status]}>{t(`acct.payroll.status.${r.status}`)}</Badge>
          {r.approved_by_name && <span className="text-xs text-muted">{t("acct.payroll.approved_by", { name: r.approved_by_name })}</span>}
          {r.void_reason && <span className="text-xs text-danger">{r.void_reason}</span>}
        </div>
        <ul className="divide-y divide-grey-line" data-testid="pr-lines">
          {r.lines.map((l) => (
            <li key={l.user_id} className="py-2 text-sm">
              <div className="flex justify-between gap-2"><span className="font-semibold break-words min-w-0">{l.full_name}</span><span className="tabular font-bold">{formatUsd(l.net)}</span></div>
              <div className="text-xs text-muted tabular">{t("acct.payroll.base")} {formatUsd(l.base)}{l.bonus ? ` · +${formatUsd(l.bonus)}` : ""}{l.deduction ? ` · −${formatUsd(l.deduction)}` : ""}</div>
              {l.adjustments.map((a) => (
                <div key={a.id} className="flex items-center gap-2 text-xs mt-1">
                  <Badge tone={a.kind === "bonus" ? "green" : "warning"}>{a.kind === "bonus" ? "+" : "−"}{formatUsd(a.amount)}</Badge>
                  <span className="flex-1 min-w-0 break-words">{a.reason}{a.by_name ? ` · ${a.by_name}` : ""}</span>
                  {draft && can("payroll.manage") && <button className="min-h-[36px] min-w-[36px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => remove.mutate(a.id)}><Trash2 size={14} /></button>}
                </div>
              ))}
            </li>
          ))}
        </ul>
        <div className="border-t-2 border-grey-line pt-2 mt-1 text-sm tabular space-y-1">
          <div className="flex justify-between"><span>{t("acct.payroll.gross")}</span><span>{formatUsd(r.gross)}</span></div>
          <div className="flex justify-between"><span>{t("acct.payroll.deductions")}</span><span>{r.deductions ? `−${formatUsd(r.deductions)}` : formatUsd(0)}</span></div>
          <div className="flex justify-between font-bold text-base" data-testid="pr-net"><span>{t("acct.payroll.net")}</span><span>{formatUsd(r.net)}</span></div>
        </div>
        {draft && can("payroll.manage") && (adding ? <AdjustForm run={r} onDone={() => { setAdding(false); ok(); }} /> :
          <Button className="mt-3 w-full" onClick={() => setAdding(true)} data-testid="pr-adjust"><Plus size={16} /> {t("acct.payroll.add_adj")}</Button>)}
        {paying && (<div className="mt-3"><p className="text-sm mb-1">{t("acct.paid_from")}</p><PayPicker value={pay} onChange={setPay} />
          <Button variant="primary" className="w-full" loading={payM.isPending} onClick={() => payM.mutate()} data-testid="pr-pay-confirm">{t("acct.payroll.pay")} {formatUsd(r.net)}</Button></div>)}
        {voiding && (<div className="mt-3"><Field label={t("acct.reverse_reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} /></Field>
          <Button variant="danger" className="w-full" disabled={reason.trim().length < 3} loading={voidM.isPending} onClick={() => voidM.mutate()}>{t("acct.payroll.void")}</Button></div>)}
      </>)}
    </Dialog>
  );
}

function AdjustForm({ run, onDone }: { run: PayrollRun; onDone: () => void }) {
  const { t } = useTranslation();
  const onErr = useAcctErr();
  const staff = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic });
  const [user, setUser] = useState(run.lines[0]?.user_id ?? "");
  const [kind, setKind] = useState<"bonus" | "deduction">("bonus");
  const [amount, setAmount] = useState(""); const [reason, setReason] = useState("");
  const c = cents(amount);
  const save = useMutation({ mutationFn: () => api.accounting.payroll.adjust(run.id, { user_id: user, kind, amount: c, reason }), onSuccess: onDone, onError: onErr });
  return (
    <div className="border border-grey-line rounded-md p-3 mt-3">
      <Field label={t("acct.payroll.staff")}><Select value={user} onChange={(e) => setUser(e.target.value)} data-testid="adj-user">{(staff.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select></Field>
      <div className="grid grid-cols-2 gap-2 mb-3">
        {(["bonus", "deduction"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)} className={`min-h-[44px] rounded-md border ${kind === k ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`acct.payroll.${k}`)}</button>)}
      </div>
      <Field label={t("acct.amount")} required><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="$0.00" data-testid="adj-amount" /></Field>
      <Field label={t("acct.payroll.reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="adj-reason" /></Field>
      <Button variant="primary" className="w-full" disabled={!user || !(c > 0) || reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()} data-testid="adj-save">{t("app.add")}</Button>
    </div>
  );
}
