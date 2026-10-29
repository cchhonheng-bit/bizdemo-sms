// Books setup (D-88 · D-92): opening balances once at go-live (cash, each bank, stock value, retained earnings, old customer debts,
// supplier debts — open invoices, stock and deposits already in the app are added automatically) · fiscal year start · lock date
// (CFO: nothing on or before it can be posted) · year-end closing (CFO: income and expenses reset into retained earnings).
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd, fromCents } from "@sms/shared";
import { CalendarCheck, Lock, Plus, Trash2 } from "lucide-react";
import { api, type BooksInfo, type OpeningValues } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Button, Card, ConfirmDialog, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { shiftDay } from "@/features/reports/range";
import { cents, signedUsd, useAccName, useAcctErr } from "./acct";
import AccountMapping from "./AccountMapping"; // D-178

const MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];

export default function Setup({ info }: { info: BooksInfo | undefined }) {
  const { t, i18n } = useTranslation();
  const { can } = useAuth();
  if (!info) return null;
  const monthName = (m: number) => new Intl.DateTimeFormat(i18n.language === "km" ? "km-KH" : "en-GB", { month: "long" }).format(new Date(Date.UTC(2026, m - 1, 1)));
  return (
    <>
      <Card title={t("acct.books")}>
        <dl className="text-sm grid grid-cols-2 gap-y-1">
          <dt className="text-muted">{t("acct.books_start")}</dt><dd data-testid="books-start">{info.books_start ?? "—"}</dd>
          <dt className="text-muted">{t("acct.lock_date")}</dt><dd data-testid="lock-date">{info.lock_date ?? "—"}</dd>
          <dt className="text-muted">{t("acct.rate_label")}</dt><dd>{info.fx_rate_khr}៛</dd>
          <dt className="text-muted">{t("acct.fy")}</dt><dd data-testid="fy-month">{monthName(info.fiscal_year_start_month)}</dd>
          <dt className="text-muted">{t("acct.closed_through")}</dt><dd data-testid="closed-through">{info.books_closed_through ?? "—"}</dd>
        </dl>
        {can("accounting.close") && <FiscalYear info={info} monthName={monthName} />}
      </Card>
      <AccountMapping />
      {!info.books_start && (can("accounting.close") ? <Opening today={info.today} draft={info.opening_draft} planned={info.planned_start ?? null} pending={info.pending?.total ?? 0} /> : <p className="text-sm text-muted">{t("acct.not_started")}</p>)}
      {info.books_start && can("accounting.close") && <LockCard info={info} />}
      {info.books_start && can("accounting.close") && <CloseYear info={info} />}
    </>
  );
}

function FiscalYear({ info, monthName }: { info: BooksInfo; monthName: (m: number) => string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const [m, setM] = useState(info.fiscal_year_start_month);
  const fixed = !!info.books_closed_through;
  const save = useMutation({ mutationFn: () => api.accounting.setFiscalYear(m), onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["books"] }); }, onError: onErr });
  return (
    <div className="flex items-end gap-2 mt-3">
      <div className="flex-1"><Field label={t("acct.fy")} hint={fixed ? t("acct.fy_fixed") : undefined}>
        <Select value={String(m)} disabled={fixed} onChange={(e) => setM(Number(e.target.value))} data-testid="fy-select">{MONTHS.map((x) => <option key={x} value={x}>{monthName(x)}</option>)}</Select>
      </Field></div>
      {!fixed && <Button variant="primary" className="mb-3" disabled={m === info.fiscal_year_start_month} loading={save.isPending} onClick={() => save.mutate()} data-testid="fy-save">{t("app.save")}</Button>}
    </div>
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

/** D-92 · D-190 (client 29-10): the year-end closing — try it first (nothing posted), edit the lines (amounts, accounts, add / delete;
 *  it must balance), post exactly that; the last closed year can be opened again to correct and close again */
type CloseRow = { account_id: string; debit: string; credit: string };
function CloseYear({ info }: { info: BooksInfo }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const name = useAccName();
  const [open, setOpen] = useState(false), [confirm, setConfirm] = useState(false), [reopenAsk, setReopenAsk] = useState(false);
  const plan = useQuery({ queryKey: ["closing-plan"], queryFn: api.accounting.closingPlan, enabled: open });
  const accs = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts, enabled: open });
  const fromPlan = () => (plan.data?.lines ?? []).map((l) => ({ account_id: l.account_id, debit: l.debit ? (l.debit / 100).toFixed(2) : "", credit: l.credit ? (l.credit / 100).toFixed(2) : "" }));
  const [rows, setRows] = useState<CloseRow[] | null>(null);
  useEffect(() => { if (plan.data && rows === null) setRows(fromPlan()); }, [plan.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = rows ?? [];
  const set = (i: number, v: Partial<CloseRow>) => setRows(list.map((r, j) => (j === i ? { ...r, ...v } : r)));
  const amt = (s: string) => (s.trim() ? cents(s) : 0);
  const dr = list.reduce((s, r) => s + (amt(r.debit) || 0), 0), cr = list.reduce((s, r) => s + (amt(r.credit) || 0), 0);
  const ok = list.length >= 2 && dr === cr && dr > 0 && list.every((r) => r.account_id && (amt(r.debit) > 0) !== (amt(r.credit) > 0));
  const done = () => { setConfirm(false); setReopenAsk(false); setOpen(false); setRows(null); void qc.invalidateQueries(); };
  const close = useMutation({
    mutationFn: () => api.accounting.closeYear(plan.data!.year_end, list.map((r) => (amt(r.debit) > 0 ? { account_id: r.account_id, debit: amt(r.debit) } : { account_id: r.account_id, credit: amt(r.credit) }))),
    onSuccess: (r) => { toast.success(t("acct.close_done", { net: signedUsd(r.net_profit) })); done(); },
    onError: (e) => { setConfirm(false); onErr(e); },
  });
  const reopen = useMutation({ mutationFn: api.accounting.reopenYear, onSuccess: () => { toast.success(t("acct.reopen_done")); done(); }, onError: (e) => { setReopenAsk(false); onErr(e); } });
  const p = plan.data;
  return (
    <Card title={t("acct.close_title")}>
      <p className="text-xs text-muted mb-2">{t("acct.close_hint")}</p>
      {info.next_year_end && <p className="text-sm mb-3" data-testid="close-next">{t("acct.close_next", { date: info.next_year_end })}</p>}
      <div className="flex flex-wrap gap-2">
        {!open && <Button variant="primary" onClick={() => setOpen(true)} data-testid="close-try"><CalendarCheck size={16} /> {t("acct.close_try")}</Button>}
        {info.books_closed_through && <Button variant="danger" onClick={() => setReopenAsk(true)} data-testid="reopen-year">{t("acct.reopen_btn", { date: info.books_closed_through })}</Button>}
      </div>
      {open && (!p || !rows ? <Skeleton /> : (
        <div className="mt-3" data-testid="close-plan">
          <p className="text-sm font-semibold">{t("acct.close_plan", { from: p.year_start, to: p.year_end, net: signedUsd(p.net_profit) })}</p>
          {!p.ended && <p className="text-xs text-warning mb-1" data-testid="close-test-note">{t("acct.close_test_note", { date: p.upto })}</p>}
          <p className="text-xs text-muted mb-2">{t("acct.close_edit_hint")}</p>
          {list.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_6.5rem_6.5rem_auto] gap-2 mb-2 items-center" data-testid={`close-line-${i}`}>
              <Select value={r.account_id} onChange={(e) => set(i, { account_id: e.target.value })} aria-label={t("acct.account")}>
                <option value="">{t("acct.pick_account")}</option>
                {(accs.data ?? []).filter((a) => !a.is_group && (a.is_active || a.id === r.account_id)).map((a) => <option key={a.id} value={a.id}>{name(a)}</option>)}
              </Select>
              <Input inputMode="decimal" placeholder={t("acct.debit")} value={r.debit} onChange={(e) => set(i, { debit: e.target.value })} aria-label={t("acct.debit")} />
              <Input inputMode="decimal" placeholder={t("acct.credit")} value={r.credit} onChange={(e) => set(i, { credit: e.target.value })} aria-label={t("acct.credit")} />
              <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => setRows(list.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setRows([...list, { account_id: "", debit: "", credit: "" }])} data-testid="close-add"><Plus size={16} /> {t("acct.add_line")}</Button>
            <Button onClick={() => setRows(fromPlan())}>{t("acct.close_reset")}</Button>
          </div>
          <div className={`flex justify-between text-sm mt-3 tabular ${ok ? "text-success" : "text-danger"}`} data-testid="close-diff">
            <span>{t("acct.debit")} {formatUsd(dr)} · {t("acct.credit")} {formatUsd(cr)}</span>
            <span>{dr === cr ? (dr > 0 ? t("acct.balanced") : "") : t("acct.diff", { amount: formatUsd(Math.abs(dr - cr)) })}</span>
          </div>
          <div className="flex flex-wrap gap-2 mt-3">
            <Button onClick={() => { setOpen(false); setRows(null); }}>{t("app.cancel")}</Button>
            <Button variant="primary" disabled={!p.ended || !ok} onClick={() => setConfirm(true)} data-testid="close-year">{p.ended ? t("acct.close_post") : t("acct.close_wait")}</Button>
          </div>
        </div>
      ))}
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => close.mutate()} loading={close.isPending} title={t("acct.close_title")} text={t("acct.close_btn", { date: p?.year_end ?? "" })} />
      <ConfirmDialog open={reopenAsk} onClose={() => setReopenAsk(false)} onConfirm={() => reopen.mutate()} loading={reopen.isPending} danger title={t("acct.reopen_btn", { date: info.books_closed_through ?? "" })} text={t("acct.reopen_text")} />
    </Card>
  );
}

type Recv = { customer_id: string; amount: string; note: string };
type Pay = { supplier: string; amount: string; account_id: string }; // D-181: the debt account ("" = other suppliers)
type Bank = { code: string; amount: string };
type Other = { code: string; amount: string }; // D-166: any other balance-sheet account (capital, customer deposits, staff advances, tips …)
/** D-126 (CEO): «រក្សាទុក» keeps the opening balances as a draft — change them as often as needed (each change is logged) — and
 *  «បញ្ជាក់សមតុល្យដើម» posts them and starts the books; after that only a journal entry corrects them */
function Opening({ today, draft, planned, pending }: { today: string; draft: OpeningValues | null; planned: string | null; pending: number }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useAcctErr();
  const customers = useQuery({ queryKey: ["customers", "active"], queryFn: () => api.customers(true) });
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const dollars = (v?: number) => (v ? String(fromCents(v)) : "");
  const [date, setDate] = useState(draft?.date ?? (planned && planned <= today ? planned : today)); // D-144: One Team's 01-10-2026
  const [usd, setUsd] = useState(dollars(draft?.cash_usd)); const [riel, setRiel] = useState(draft?.cash_khr ? String(draft.cash_khr) : "");
  const [aba, setAba] = useState(dollars(draft?.banks?.aba)); const [acleda, setAcleda] = useState(dollars(draft?.banks?.acleda));
  const [stock, setStock] = useState(dollars(draft?.stock)); const [retained, setRetained] = useState(dollars(draft?.retained_earnings));
  const [banks, setBanks] = useState<Bank[]>(Object.entries(draft?.banks ?? {}).filter(([k]) => k !== "aba" && k !== "acleda").map(([code, v]) => ({ code, amount: dollars(v) })));
  const [recv, setRecv] = useState<Recv[]>((draft?.receivables ?? []).map((r) => ({ customer_id: r.customer_id, amount: dollars(r.amount), note: r.note ?? "" })));
  const [pays, setPays] = useState<Pay[]>((draft?.payables ?? []).map((p) => ({ supplier: p.supplier, amount: dollars(p.amount), account_id: p.account_id ?? "" })));
  const [others, setOthers] = useState<Other[]>((draft?.others ?? []).map((o) => ({ code: o.code, amount: dollars(o.amount) })));
  const HANDLED = ["cash_usd", "cash_khr", "bank_aba", "bank_acleda", "ar", "ap", "deposits", "retained", "opening", "inventory", "current_profit"];
  const otherBs = (accounts.data ?? []).filter((a) => !a.is_group && a.is_active && a.statement === "BS" && !a.is_cash && !a.is_stock && !a.mapped.some((k) => HANDLED.includes(k))); // D-178: by the map, no code
  const debtAccs = (accounts.data ?? []).filter((a) => a.type === "liability" && a.is_active && !a.is_group); // D-181
  const [confirm, setConfirm] = useState(false);
  const c = (v: string) => (v.trim() === "" ? 0 : cents(v));
  const riels = riel.trim() === "" ? 0 : /^\d+$/.test(riel.replace(/[,\s]/g, "")) ? Number(riel.replace(/[,\s]/g, "")) : NaN;
  const otherAssets = (accounts.data ?? []).filter((a) => a.is_cash && !a.mapped.length && a.is_active); // D-178: the other banks beside the mapped cash
  const nums = [c(usd), c(aba), c(acleda), c(stock), c(retained), riels, ...banks.map((b) => c(b.amount)), ...recv.map((r) => c(r.amount)), ...pays.map((p) => c(p.amount)), ...others.map((o) => c(o.amount))];
  const valid = nums.every((n) => Number.isFinite(n) && n >= 0) && banks.every((b) => b.code && c(b.amount) > 0) && recv.every((r) => r.customer_id && c(r.amount) > 0) && pays.every((p) => p.supplier.trim() && c(p.amount) > 0)
    && others.every((o) => o.code && c(o.amount) > 0);
  const body = (): OpeningValues => ({ date, cash_usd: c(usd), cash_khr: riels, banks: { aba: c(aba), acleda: c(acleda), ...Object.fromEntries(banks.map((b) => [b.code, c(b.amount)])) },
    stock: c(stock), retained_earnings: c(retained),
    receivables: recv.map((r) => ({ customer_id: r.customer_id, amount: c(r.amount), note: r.note || undefined })), payables: pays.map((p) => ({ supplier: p.supplier.trim(), amount: c(p.amount), account_id: p.account_id || null })),
    others: others.map((o) => ({ code: o.code, amount: c(o.amount) })) });
  const keep = useMutation({ mutationFn: () => api.accounting.openingDraft(body()), onSuccess: () => { toast.success(t("acct.opening_draft_saved")); void qc.invalidateQueries({ queryKey: ["acct-lock"] }); }, onError: onErr });
  const save = useMutation({
    mutationFn: () => api.accounting.opening(body()),
    onSuccess: (r) => { toast.success(t("acct.opening_done", { equity: formatUsd(r.opening_equity), n: r.open_invoices }) + (r.backlog?.posted ? ` · ${t("acct.backlog_done", { n: r.backlog.posted })}` : "")); setConfirm(false); void qc.invalidateQueries(); },
    onError: (e) => { setConfirm(false); onErr(e); },
  });
  const row = (i: number, patch: Partial<Bank>) => setBanks((x) => x.map((y, j) => (j === i ? { ...y, ...patch } : y)));
  return (
    <Card title={t("acct.opening_title")}>
      <p className="text-xs text-muted mb-3">{t("acct.opening_hint")}</p>
      {pending > 0 && <p className="mb-3 rounded-md bg-blue-50 p-3 text-sm" data-testid="op-pending">{t("acct.opening_backlog_hint", { n: pending })}</p>}
      <Field label={t("acct.go_live")}><Input type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} data-testid="op-date" /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("acct.pay.cash_usd")}><Input inputMode="decimal" value={usd} onChange={(e) => setUsd(e.target.value)} placeholder="$0.00" data-testid="op-cash-usd" /></Field>
        <Field label={t("acct.pay.cash_khr")}><Input inputMode="numeric" value={riel} onChange={(e) => setRiel(e.target.value)} placeholder="0 ៛" data-testid="op-cash-khr" /></Field>
        <Field label="ABA"><Input inputMode="decimal" value={aba} onChange={(e) => setAba(e.target.value)} placeholder="$0.00" data-testid="op-aba" /></Field>
        <Field label="ACLEDA"><Input inputMode="decimal" value={acleda} onChange={(e) => setAcleda(e.target.value)} placeholder="$0.00" data-testid="op-acleda" /></Field>
      </div>
      {banks.map((b, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2 mb-2">
          <Select value={b.code} onChange={(e) => row(i, { code: e.target.value })} aria-label={t("acct.account")}>
            <option value="">—</option>{otherAssets.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name_km}</option>)}
          </Select>
          <Input inputMode="decimal" value={b.amount} placeholder="$0.00" onChange={(e) => row(i, { amount: e.target.value })} />
          <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => setBanks((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
        </div>
      ))}
      {otherAssets.length > 0 && <Button onClick={() => setBanks((x) => [...x, { code: "", amount: "" }])} data-testid="op-add-bank"><Plus size={16} /> {t("acct.add_bank")}</Button>}
      <div className="grid grid-cols-2 gap-2 mt-3">
        <Field label={t("acct.stock_value")}><Input inputMode="decimal" value={stock} onChange={(e) => setStock(e.target.value)} placeholder="$0.00" data-testid="op-stock" /></Field>
        <Field label={t("acct.retained")}><Input inputMode="decimal" value={retained} onChange={(e) => setRetained(e.target.value)} placeholder="$0.00" data-testid="op-retained" /></Field>
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
          <div className="col-span-3"><Select value={p.account_id} onChange={(e) => setPays((x) => x.map((y, j) => (j === i ? { ...y, account_id: e.target.value } : y)))} aria-label={t("acct.debt_account")} data-testid="op-pay-account">
            <option value="">{t("acct.debt_default")}</option>{debtAccs.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name_km}</option>)}
          </Select></div>
        </div>
      ))}
      <Button className="mt-2" onClick={() => setPays((x) => [...x, { supplier: "", amount: "", account_id: "" }])} data-testid="op-add-pay"><Plus size={16} /> {t("acct.add_supplier_debt")}</Button>
      <h3 className="text-sm font-semibold mt-4">{t("acct.other_bs")}</h3>
      <p className="text-xs text-muted">{t("acct.other_bs_hint")}</p>
      {others.map((o, i) => (
        <div key={i} className="grid grid-cols-[1fr_6rem_auto] gap-2 my-2" data-testid="op-other">
          <Select value={o.code} onChange={(e) => setOthers((x) => x.map((y, j) => (j === i ? { ...y, code: e.target.value } : y)))} aria-label={t("acct.account")}>
            <option value="">—</option>{otherBs.map((a) => <option key={a.id} value={a.code}>{a.code} · {a.name_km}</option>)}
          </Select>
          <Input inputMode="decimal" value={o.amount} placeholder="$0.00" onChange={(e) => setOthers((x) => x.map((y, j) => (j === i ? { ...y, amount: e.target.value } : y)))} />
          <button type="button" className="min-h-[44px] min-w-[44px] grid place-items-center text-muted" aria-label={t("app.delete")} onClick={() => setOthers((x) => x.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
        </div>
      ))}
      <Button className="mt-2" onClick={() => setOthers((x) => [...x, { code: "", amount: "" }])} data-testid="op-add-other"><Plus size={16} /> {t("acct.add_other_bs")}</Button>
      {draft && <p className="text-xs text-muted mt-4" data-testid="op-draft-note">{t("acct.opening_draft_note")}</p>}
      <div className="grid sm:grid-cols-2 gap-2 mt-4">
        <Button disabled={!valid} loading={keep.isPending} onClick={() => keep.mutate()} data-testid="op-draft">{t("acct.opening_keep")}</Button>
        <Button variant="primary" disabled={!valid} onClick={() => setConfirm(true)} data-testid="op-save">{t("acct.opening_confirm_btn")}</Button>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => save.mutate()} loading={save.isPending} title={t("acct.opening_confirm_btn")} text={t("acct.opening_confirm", { date })} />
    </Card>
  );
}
