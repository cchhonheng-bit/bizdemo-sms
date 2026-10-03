// C1 chart of accounts: grouped by type with balances; add / rename / switch off (system accounts stay; a used account keeps its
// code and type; only a never-used one can be deleted). Tap → general ledger with running balance (+ Excel).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd } from "@sms/shared";
import { Download, Pencil, Plus } from "lucide-react";
import { api, type Account, type AcctType } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import RangePicker from "@/features/reports/RangePicker";
import type { Range } from "@/features/reports/range";
import { TYPES, signedUsd, useAccName, useAcctErr } from "./acct";

export default function Accounts() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const name = useAccName();
  const q = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const [edit, setEdit] = useState<Account | "new" | null>(null);
  const [ledgerOf, setLedgerOf] = useState<Account | null>(null);
  const today = new Date().toISOString().slice(0, 10);
  if (q.isLoading) return <Skeleton />;
  return (
    <>
      {can("accounting.post") && <Button onClick={() => setEdit("new")} data-testid="acc-new"><Plus size={16} /> {t("acct.new_account")}</Button>}
      {TYPES.map((ty) => {
        const rows = (q.data ?? []).filter((a) => a.type === ty);
        return (
          <Card key={ty} title={t(`acct.type.${ty}`)}>
            {!rows.length ? <Empty text={t("acct.nothing")} /> : (
              <ul className="divide-y divide-grey-line -my-2">
                {rows.map((a) => (
                  <li key={a.id} className="flex items-center gap-2">
                    <button className="flex-1 min-w-0 text-left py-2 min-h-[48px]" onClick={() => setLedgerOf(a)}>
                      <span className={`block break-words text-sm ${a.is_active ? "" : "text-muted line-through"}`}>{name(a)}</span>
                      <Badge tone={a.statement === "PL" ? "green" : "purple"}>{t(`acct.stmt.${a.statement}`)}</Badge>{a.role && <> <Badge tone="navy">{t("acct.system")}</Badge></>}
                    </button>
                    <span className="tabular text-sm whitespace-nowrap">{signedUsd(a.balance)}</span>
                    {can("accounting.post") && <button className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.edit")} onClick={() => setEdit(a)}><Pencil size={16} /></button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        );
      })}
      {edit && <AccountDialog account={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {ledgerOf && <LedgerDialog account={ledgerOf} range={[today.slice(0, 8) + "01", today]} onClose={() => setLedgerOf(null)} />}
    </>
  );
}

function AccountDialog({ account, onClose }: { account: Account | null; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const [code, setCode] = useState(account?.code ?? "");
  const [km, setKm] = useState(account?.name_km ?? ""); const [en, setEn] = useState(account?.name_en ?? "");
  const [type, setType] = useState<AcctType>(account?.type ?? "expense");
  const [active, setActive] = useState(account?.is_active ?? true);
  const locked = !!account && (account.used || !!account.role);
  const done = () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["acct-accounts"] }); onClose(); };
  const save = useMutation({ mutationFn: () => api.accounting.saveAccount({ id: account?.id, code, name_km: km, name_en: en || null, type, is_active: active }), onSuccess: done, onError: onErr });
  const remove = useMutation({ mutationFn: () => api.accounting.deleteAccount(account!.id), onSuccess: done, onError: onErr });
  return (
    <Dialog open onClose={onClose} title={account ? t("acct.edit_account") : t("acct.new_account")} footer={<>
      {account && !account.used && !account.role && <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>{t("app.delete")}</Button>}
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!/^[1-9]\d{3,5}$/.test(code) || !km.trim()} loading={save.isPending} onClick={() => save.mutate()} data-testid="acc-save">{t("app.save")}</Button>
    </>}>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("acct.code")} hint={t("acct.code_hint")}><Input inputMode="numeric" value={code} disabled={locked} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} maxLength={6} data-testid="acc-code" /></Field>
        <Field label={t("acct.acc_type")}><Select value={type} disabled={locked} onChange={(e) => setType(e.target.value as AcctType)}>{TYPES.map((x) => <option key={x} value={x}>{t(`acct.type.${x}`)}</option>)}</Select></Field>
      </div>
      <Field label={t("acct.name_km")} required><Input value={km} onChange={(e) => setKm(e.target.value)} maxLength={80} data-testid="acc-name" /></Field>
      <Field label={t("acct.name_en")}><Input value={en} onChange={(e) => setEn(e.target.value)} maxLength={80} /></Field>
      {account && !account.role && <label className="flex items-center gap-2 min-h-[44px] text-sm"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> {t("acct.active")}</label>}
      {locked && <p className="text-xs text-muted">{account?.role ? t("acct.system_hint") : t("acct.used_hint")}</p>}
    </Dialog>
  );
}

export function LedgerDialog({ account, range: initial, onClose }: { account: { id: string; code: string; name_km: string; name_en: string | null }; range: Range; onClose: () => void }) {
  const { t } = useTranslation();
  const name = useAccName();
  const [range, setRange] = useState<Range>(initial);
  const q = useQuery({ queryKey: ["acct-ledger", account.id, range], queryFn: () => api.accounting.ledger(account.id, range[0], range[1]) });
  return (
    <Dialog open onClose={onClose} title={name(account)} footer={<>
      <a className="btn-secondary" href={api.accounting.csvUrl("ledger", range[0], range[1], account.id)} download><Download size={16} /> {t("acct.excel")}</a>
      <Button variant="primary" className="flex-1 sm:flex-none" onClick={onClose}>{t("app.close")}</Button>
    </>}>
      <RangePicker value={range} onChange={setRange} presets={["month", "last"]} />
      {q.isLoading || !q.data ? <Skeleton /> : (
        <div data-testid="ledger">
          <div className="flex justify-between text-sm py-2 border-b border-grey-line"><span className="text-muted">{t("acct.opening")}</span><span className="tabular">{signedUsd(q.data.opening)}</span></div>
          {!q.data.rows.length ? <Empty text={t("acct.nothing")} /> : (
            <ul className="divide-y divide-grey-line">
              {q.data.rows.map((r, i) => (
                <li key={i} className="py-2 text-sm">
                  <div className="flex justify-between gap-2"><span className="text-muted text-xs">{r.date} · {r.number}</span>
                    <span className="tabular whitespace-nowrap">{r.debit ? `+${formatUsd(r.debit)}` : `−${formatUsd(r.credit)}`}</span></div>
                  <div className="flex justify-between gap-2"><span className="break-words min-w-0">{[r.memo, r.line_memo, r.customer_name, r.user_name, r.supplier].filter(Boolean).join(" · ")}</span>
                    <span className="tabular text-xs text-muted whitespace-nowrap">{signedUsd(r.balance)}</span></div>
                </li>
              ))}
            </ul>
          )}
          <div className="flex justify-between text-sm pt-2 border-t-2 border-grey-line font-bold"><span>{t("acct.closing")}</span><span className="tabular">{signedUsd(q.data.closing)}</span></div>
        </div>
      )}
    </Dialog>
  );
}
