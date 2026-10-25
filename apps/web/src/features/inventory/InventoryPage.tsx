// Stock (D-87 · D-144 «stock is separate», flag "inventory"): the Admin's warehouse. Stock in = a direct entry (name · qty · unit ·
// unit cost · stock account · supplier · date → the total; the item is made on its first entry). Stock out = what a technician
// collects (item · qty · technician · job or place · date → the balance left). «កែតម្រូវ» = a count. Stock card per item,
// «តម្លៃស្តុកចុងខែ» against the books, «ផ្ទៀងផ្ទាត់សម្ភារំ» = stock out vs invoiced per job and group. Cards on phones.
import { useMemo, useState } from "react";
import { ReportToolbar } from "@/components/ReportToolbar";
import { ReportScreen } from "@/features/reports/ReportScreen";
import { useTranslation } from "react-i18next";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd, toCents } from "@sms/shared";
import { PackageMinus, PackagePlus, SlidersHorizontal } from "lucide-react";
import { api, errCode, fmtDateTime, type StockItem, type StockPay } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { presetRange, type Range } from "@/features/reports/range";
import RangePicker from "@/features/reports/RangePicker";
import { todayLocal } from "@/features/invoices/util";
import { Payables } from "./Payables"; // D-167
import MonthEnd from "./MonthEnd";

type Tab = "stock" | "withdrawals" | "moves" | "monthend" | "reconcile" | "payables";
type Op = "in" | "out" | "adjust";
const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));
const signed = (c: number) => `${c < 0 ? "−" : "+"}${formatUsd(Math.abs(c))}`;

export default function InventoryPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can("inventory.manage");
  const tabs: Tab[] = can("cost.read") ? ["stock", "withdrawals", "moves", "monthend", "reconcile", "payables"] : can("inventory.manage") ? ["stock", "withdrawals", "moves", "monthend", "payables"] : ["stock", "withdrawals", "moves", "monthend"]; // D-167 · D-171
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => (tabs.includes(sp.get("tab") as Tab) ? (sp.get("tab") as Tab) : "stock"));
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("inventory.title")}</h1>
      <div className="flex rounded-md border border-grey-line overflow-x-auto text-sm" role="tablist">
        {tabs.map((k) => <button key={k} role="tab" aria-selected={tab === k} data-testid={`inv-tab-${k}`} className={`flex-1 shrink-0 whitespace-nowrap px-3 min-h-[44px] ${tab === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setTab(k)}>{t(`inventory.tab.${k}`)}</button>)}
      </div>
      {tab === "stock" ? <Stock manage={manage} /> : tab === "monthend" ? <MonthEnd /> : tab === "payables" ? <Payables manage={manage} /> : tab === "withdrawals" ? <ReportScreen report="tech-withdrawals" needs={["range", "technician", "booker"]} /> : tab === "moves" ? <ReportScreen report="stock-moves" needs={["range"]} /> : <Reconcile />}
    </div>
  );
}

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => toast.error(t(`inventory.err.${errCode(e)}`, { defaultValue: t("app.error") }));
}
const useAccName = () => { const { i18n } = useTranslation(); return (a: { code: string; name_km: string; name_en: string | null }) => `${a.code} · ${(i18n.language === "en" && a.name_en) || a.name_km}`; };

function Stock({ manage }: { manage: boolean }) {
  const { t, i18n } = useTranslation();
  const q = useQuery({ queryKey: ["stock-items"], queryFn: api.inventory.items });
  const [op, setOp] = useState<Op | null>(null);
  const [cardOf, setCardOf] = useState<StockItem | null>(null);
  const total = (q.data ?? []).reduce((s, i) => s + i.value, 0);
  // grouped by stock account (13001 …, 14000 …, 18000), each group expandable
  const groups = useMemo(() => { const g = new Map<string, { code: string; name: string; items: StockItem[] }>(); for (const i of q.data ?? []) { const k = i.account_code ?? "—";
    const x = g.get(k) ?? { code: k, name: (i18n.language === "en" && i.account_name_en) || i.account_name || "", items: [] }; x.items.push(i); g.set(k, x); } return [...g.values()]; }, [q.data, i18n.language]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  return (
    <>
      <ReportToolbar report="stock-balance" params={{ asof: todayLocal() }} />
      {manage && (
        <div className="grid grid-cols-3 gap-2">
          <Button variant="primary" onClick={() => setOp("in")} data-testid="op-in"><PackagePlus size={16} /> {t("inventory.op.in")}</Button>
          <Button onClick={() => setOp("out")} data-testid="op-out"><PackageMinus size={16} /> {t("inventory.op.out")}</Button>
          <Button onClick={() => setOp("adjust")} data-testid="op-adjust"><SlidersHorizontal size={16} /> {t("inventory.op.adjust")}</Button>
        </div>
      )}
      <p className="text-xs text-muted">{t("inventory.separate_hint")}</p>
      <Card title={`${t("inventory.value_total")} · ${formatUsd(total)}`}>
        {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("inventory.none")} /> : (
          <div className="-my-2" data-testid="stock-list">
            {groups.map((g) => (
              <div key={g.code} data-testid="stock-group">
                <button className="w-full flex items-center justify-between gap-2 py-3 min-h-[48px] font-semibold border-b border-grey-line" onClick={() => setClosed((c) => ({ ...c, [g.code]: !c[g.code] }))} aria-expanded={!closed[g.code]}>
                  <span className="min-w-0 break-words text-left"><span className="font-mono">{g.code}</span> {g.name} <span className="text-xs text-muted font-normal">· {g.items.length}</span></span>
                  <span className="tabular whitespace-nowrap">{formatUsd(g.items.reduce((s, i) => s + i.value, 0))}</span>
                </button>
                {!closed[g.code] && (
                  <ul className="divide-y divide-grey-line">
                    {g.items.map((i) => (
                      <li key={i.item_id}>
                        <button className="w-full text-left py-3 pl-3 min-h-[56px]" onClick={() => setCardOf(i)}>
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-semibold break-words min-w-0">{i.code && <span className="font-mono text-xs text-muted mr-1">{i.code}</span>}{i.name}</span>
                            <span className="font-bold tabular whitespace-nowrap">{qtyFmt(i.qty)} {i.unit}</span>
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1 text-xs items-center">
                            <span className="text-muted tabular">{t("inventory.unit_cost_short")} {formatUsd(i.avg_cost)} · {formatUsd(i.value)}</span>
                            {i.low && <Badge tone="danger">{t("inventory.low", { level: i.reorder_level })}</Badge>}
                          </div>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      {op === "in" && <StockInDialog items={q.data ?? []} onClose={() => setOp(null)} />}
      {op === "out" && <StockOutDialog items={q.data ?? []} onClose={() => setOp(null)} />}
      {op === "adjust" && <AdjustDialog items={q.data ?? []} onClose={() => setOp(null)} />}
      {cardOf && <CardDialog item={cardOf} manage={manage} onClose={() => setCardOf(null)} />}
    </>
  );
}

const ItemSelect = ({ items, value, onChange, testId, blank }: { items: StockItem[]; value: string; onChange: (v: string) => void; testId: string; blank?: string }) => (
  <Select value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
    {blank !== undefined && <option value="">{blank}</option>}
    {items.map((i) => <option key={i.item_id} value={i.item_id}>{i.code ? `${i.code} · ` : ""}{i.name} ({qtyFmt(i.qty)} {i.unit})</option>)}
  </Select>
);
const DateField = ({ value, onChange }: { value: string; onChange: (v: string) => void }) => {
  const { t } = useTranslation();
  return <Field label={t("inventory.date")}><Input type="date" value={value} max={todayLocal()} onChange={(e) => e.target.value && onChange(e.target.value)} data-testid="op-date" /></Field>;
};
const useRefresh = () => { const qc = useQueryClient(); return () => { void qc.invalidateQueries({ queryKey: ["stock-items"] }); void qc.invalidateQueries({ queryKey: ["catalog"] }); }; };

/** D-144 stock in: an item already in stock, or a new one (name · unit · stock account → code on the client's scheme) */
function StockInDialog({ items, onClose }: { items: StockItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const onErr = useErr();
  const refresh = useRefresh();
  const accName = useAccName();
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts });
  const stockAccounts = useMemo(() => (accounts.data ?? []).filter((a) => a.type === "asset" && a.is_active && !a.is_group && /^1[3-8]/.test(a.code)), [accounts.data]);
  const [mode, setMode] = useState<"existing" | "new">(items.length ? "existing" : "new");
  const [item, setItem] = useState(items[0]?.item_id ?? "");
  const [name, setName] = useState(""), [unit, setUnit] = useState(""), [account, setAccount] = useState("");
  const [qty, setQty] = useState(""), [cost, setCost] = useState(""), [totalIn, setTotalIn] = useState("");
  const [pay, setPay] = useState<StockPay>("cash_usd"), [supplier, setSupplier] = useState(""), [date, setDate] = useState(todayLocal()), [note, setNote] = useState("");
  const [paidIn, setPaidIn] = useState(""), [invoiceNo, setInvoiceNo] = useState(""); // D-167: paid now (the rest owed) · the supplier's invoice number
  const n = Number(qty);
  let c = NaN, tot = NaN;
  try { c = cost.trim() === "" ? NaN : toCents(cost); } catch { /* invalid */ }
  try { tot = totalIn.trim() === "" ? NaN : toCents(totalIn); } catch { /* invalid */ }
  const total = tot >= 0 ? tot : c >= 0 && n > 0 ? Math.round(n * c) : NaN; // the total follows qty × unit cost, or is typed itself
  let paidC = NaN; try { paidC = paidIn.trim() === "" ? total : toCents(paidIn); } catch { /* invalid */ }
  const paid = pay === "credit" ? 0 : paidC, owed = total >= 0 && paid >= 0 ? total - paid : NaN;
  const valid = n > 0 && total >= 0 && (mode === "existing" ? !!item : name.trim().length > 0 && !!account) && paid >= 0 && paid <= total && (owed === 0 || supplier.trim().length > 0);
  const save = useMutation({
    mutationFn: () => api.inventory.stockIn({ ...(mode === "existing" ? { item_id: item } : { name: name.trim(), unit: unit.trim() || null, account_id: account }), qty: n,
      ...(tot >= 0 ? { total: tot } : { unit_cost: c }), pay, supplier: supplier.trim() || null, date, note: note.trim() || null, paid: pay === "credit" ? 0 : paid, supplier_invoice: invoiceNo.trim() || null }),
    onSuccess: (r) => { toast.success(t("inventory.in_done", { total: formatUsd(r.total), balance: qtyFmt(r.balance) })); refresh(); onClose(); }, onError: onErr,
  });
  const pays: StockPay[] = ["cash_usd", "cash_khr", "aba", "acleda", "credit"];
  return (
    <Dialog open onClose={onClose} title={t("inventory.op.in")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="op-save">{t("app.save")}</Button>
    </>}>
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup">
        {(["existing", "new"] as const).map((m) => <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} data-testid={`in-mode-${m}`} disabled={m === "existing" && !items.length}
          className={`min-h-[44px] rounded-md border text-sm ${mode === m ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`inventory.in_${m}`)}</button>)}
      </div>
      {mode === "existing" ? <Field label={t("inventory.item")}><ItemSelect items={items} value={item} onChange={setItem} testId="op-item" /></Field> : (<>
        <Field label={t("inventory.item_name")} required hint={t("inventory.item_name_hint")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} data-testid="in-name" autoFocus /></Field>
        <div className="grid grid-cols-[1fr_6rem] gap-2">
          <Field label={t("inventory.account")} required hint={t("inventory.account_hint")}>
            <Select value={account} onChange={(e) => setAccount(e.target.value)} data-testid="in-account"><option value="">—</option>{stockAccounts.map((a) => <option key={a.id} value={a.id}>{accName(a)}</option>)}</Select>
          </Field>
          <Field label={t("inventory.unit")}><Input value={unit} onChange={(e) => setUnit(e.target.value)} maxLength={20} placeholder="ម៉ែត្រ" data-testid="in-unit" /></Field>
        </div>
      </>)}
      <div className="grid grid-cols-3 gap-2">
        <Field label={t("inventory.qty")} required><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="op-qty" /></Field>
        <Field label={t("inventory.unit_cost")}><Input inputMode="decimal" value={cost} onChange={(e) => { setCost(e.target.value); setTotalIn(""); }} data-testid="op-cost" /></Field>
        <Field label={t("inventory.total") + " ($)"}><Input inputMode="decimal" value={totalIn || (total >= 0 ? (total / 100).toFixed(2) : "")} onChange={(e) => setTotalIn(e.target.value)} data-testid="op-total" /></Field>
      </div>
      <p className="text-sm mb-1">{t("inventory.paid_with")}</p>
      <div className="grid grid-cols-3 gap-2 mb-3">{pays.map((p) => <button key={p} type="button" role="radio" aria-checked={pay === p} onClick={() => setPay(p)} data-testid={`pay-${p}`} className={`min-h-[44px] rounded-md border text-xs ${pay === p ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`inventory.pay.${p}`)}</button>)}</div>
      <div className="grid grid-cols-2 gap-2">
        <Field label={t("inventory.supplier")} required={owed > 0}><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} data-testid="op-supplier" /></Field>
        <Field label={t("inventory.supplier_invoice")} hint={t("inventory.supplier_invoice_hint")}><Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} maxLength={60} data-testid="in-invoice" /></Field>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {pay !== "credit" && <Field label={t("inventory.paid_now")} hint={owed > 0 ? t("inventory.owed_rest", { amount: formatUsd(owed) }) : t("inventory.paid_all")}><Input inputMode="decimal" value={paidIn} placeholder={total >= 0 ? (total / 100).toFixed(2) : ""} onChange={(e) => setPaidIn(e.target.value)} data-testid="op-paid" /></Field>}
        <DateField value={date} onChange={setDate} />
      </div>
      <Field label={t("inventory.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
      {total >= 0 && <p className="text-sm tabular font-semibold" data-testid="op-total-text">{t("inventory.total")} {formatUsd(total)}</p>}
    </Dialog>
  );
}

/** D-144 stock out: the Admin records what a technician collects — for a job, or for a place (project · borey · house no.) */
function StockOutDialog({ items, onClose }: { items: StockItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const onErr = useErr();
  const refresh = useRefresh();
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic });
  const techs = useMemo(() => (users.data ?? []).filter((u) => u.role === "tech"), [users.data]);
  // D-147: every job of the last 30 / next 30 days except cancelled ones — the technician's own first; a closed or invoiced job can still receive a late stock out
  const day = 86_400_000;
  const jobs = useQuery({ queryKey: ["bookings", "for-stock"], queryFn: () => api.bookings({ from: new Date(Date.now() - 30 * day).toISOString(), to: new Date(Date.now() + 30 * day).toISOString() }) });
  const [item, setItem] = useState(items[0]?.item_id ?? "");
  const [qty, setQty] = useState(""), [tech, setTech] = useState(""), [job, setJob] = useState(""), [place, setPlace] = useState(""), [date, setDate] = useState(todayLocal()), [note, setNote] = useState("");
  const [left, setLeft] = useState<number | null>(null);
  const n = Number(qty);
  const current = items.find((i) => i.item_id === item);
  const techJobs = useMemo(() => {
    const all = (jobs.data ?? []).filter((b) => b.status !== "cancelled");
    const mine = tech ? all.filter((b) => b.technicians?.some((x) => x.user_id === tech)) : [];
    return [...mine, ...all.filter((b) => !mine.includes(b))];
  }, [jobs.data, tech]);
  const picked = techJobs.find((b) => b.id === job);
  const pickJob = (id: string) => { setJob(id); const b = techJobs.find((x) => x.id === id); const lead = b?.technicians?.find((x) => x.role === "lead") ?? b?.technicians?.[0]; if (!tech && lead) setTech(lead.user_id); };
  const valid = !!item && n > 0 && !!tech && (!!job || place.trim().length > 0);
  const save = useMutation({
    mutationFn: () => api.inventory.stockOut({ item_id: item, qty: n, technician_id: tech, booking_id: job || null, place: job ? null : place.trim(), date, note: note.trim() || null }),
    onSuccess: (r) => { setLeft(r.balance); toast.success(t("inventory.out_done", { balance: qtyFmt(r.balance), unit: current?.unit ?? "" })); refresh(); onClose(); }, onError: onErr,
  });
  return (
    <Dialog open onClose={onClose} title={t("inventory.op.out")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="op-save">{t("app.save")}</Button>
    </>}>
      {!items.length ? <p className="text-sm text-muted">{t("inventory.none")}</p> : (<>
        <p className="text-xs text-muted mb-3">{t("inventory.out_hint")}</p>
        <Field label={t("inventory.item")}><ItemSelect items={items} value={item} onChange={(v) => { setItem(v); setLeft(null); }} testId="op-item" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("inventory.qty")} required hint={current ? t("inventory.in_stock", { qty: qtyFmt(current.qty), unit: current.unit }) : undefined}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="op-qty" /></Field>
          <Field label={t("inventory.technician")} required>
            <Select value={tech} onChange={(e) => setTech(e.target.value)} data-testid="out-tech"><option value="">—</option>{techs.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select>
          </Field>
        </div>
        <Field label={t("inventory.job")} hint={t("inventory.job_hint")}>
          <Select value={job} onChange={(e) => pickJob(e.target.value)} data-testid="out-job"><option value="">{t("inventory.no_job")}</option>{techJobs.map((b) => <option key={b.id} value={b.id}>{b.number} · {b.customer_name}{b.scheduled_at ? ` · ${b.scheduled_at.slice(5, 10).split("-").reverse().join("-")}` : ""} · {t(`status.${b.status}`)}</option>)}</Select>
        </Field>
        {picked && (
          <div className="rounded-md border border-grey-line bg-white p-3 mb-3 text-sm space-y-0.5" data-testid="out-job-info">
            <div className="font-semibold break-words">{picked.number} · {picked.customer_name} <Badge tone="grey">{t(`status.${picked.status}`)}</Badge></div>
            <div className="break-words">{picked.service_text}</div>
            {picked.scheduled_at && <div className="text-muted">🕒 {fmtDateTime(picked.scheduled_at)}</div>}
            {picked.address && <div className="text-muted break-words">📍 {picked.address}</div>}
            {picked.customer_phones?.length > 0 && <div className="text-muted">📞 {picked.customer_phones.join(" · ")}</div>}
            {picked.technicians?.length ? <div className="text-muted">👷 {picked.technicians.map((x) => x.full_name).join(", ")}</div> : null}
          </div>
        )}
        {!job && <Field label={t("inventory.place")} required><Input value={place} onChange={(e) => setPlace(e.target.value)} maxLength={120} placeholder={t("inventory.place_ph")} data-testid="out-place" /></Field>}
        <div className="grid grid-cols-2 gap-2">
          <DateField value={date} onChange={setDate} />
          <Field label={t("inventory.note")}><Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} /></Field>
        </div>
        {current && n > 0 && <p className="text-sm tabular" data-testid="out-left">{t("inventory.left_after", { qty: qtyFmt(Math.max(0, current.qty - n)), unit: current.unit })}</p>}
        {left != null && <p className="text-sm font-semibold">{t("inventory.left_after", { qty: qtyFmt(left), unit: current?.unit ?? "" })}</p>}
      </>)}
    </Dialog>
  );
}

/** «កែតម្រូវ»: a count — more or less than the record, with a reason (a + takes the average cost, or the one typed) */
function AdjustDialog({ items, onClose }: { items: StockItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const onErr = useErr();
  const refresh = useRefresh();
  const [item, setItem] = useState(items[0]?.item_id ?? "");
  const [qty, setQty] = useState(""), [sign, setSign] = useState<1 | -1>(-1), [reason, setReason] = useState(""), [cost, setCost] = useState(""), [date, setDate] = useState(todayLocal());
  const n = Number(qty);
  let c: number | null = null; try { c = cost.trim() === "" ? null : toCents(cost); } catch { c = -1; }
  const valid = !!item && n > 0 && reason.trim().length >= 3 && (c == null || c >= 0);
  const save = useMutation({
    mutationFn: () => api.inventory.adjust({ item_id: item, qty: sign * n, reason: reason.trim(), unit_cost: sign > 0 ? c : null, date }),
    onSuccess: () => { toast.success(t("app.saved")); refresh(); onClose(); }, onError: onErr,
  });
  return (
    <Dialog open onClose={onClose} title={t("inventory.op.adjust")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="op-save">{t("app.save")}</Button>
    </>}>
      {!items.length ? <p className="text-sm text-muted">{t("inventory.none")}</p> : (<>
        <Field label={t("inventory.item")}><ItemSelect items={items} value={item} onChange={setItem} testId="op-item" /></Field>
        <div className="grid grid-cols-2 gap-2 mb-3">{([-1, 1] as const).map((sg) => <button key={sg} type="button" role="radio" aria-checked={sign === sg} onClick={() => setSign(sg)} data-testid={`adj-${sg > 0 ? "plus" : "minus"}`} className={`min-h-[44px] rounded-md border ${sign === sg ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{sg > 0 ? t("inventory.adjust_plus") : t("inventory.adjust_minus")}</button>)}</div>
        <div className="grid grid-cols-2 gap-2">
          <Field label={t("inventory.qty")} required><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="op-qty" /></Field>
          {sign > 0 ? <Field label={t("inventory.unit_cost")} hint={t("inventory.adjust_cost_hint")}><Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} data-testid="op-cost" /></Field> : <DateField value={date} onChange={setDate} />}
        </div>
        {sign > 0 && <DateField value={date} onChange={setDate} />}
        <Field label={t("booking.cancel_reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="op-reason" /></Field>
      </>)}
    </Dialog>
  );
}

function CardDialog({ item, manage, onClose }: { item: StockItem; manage: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const onErr = useErr();
  const refresh = useRefresh();
  const [range, setRange] = useState<Range>(() => presetRange("month", todayLocal()));
  const q = useQuery({ queryKey: ["stock-card", item.item_id, ...range], queryFn: () => api.inventory.card(item.item_id, range[0], range[1]) });
  const [level, setLevel] = useState(item.reorder_level == null ? "" : String(item.reorder_level));
  const reorder = useMutation({ mutationFn: () => api.inventory.reorder(item.item_id, level.trim() === "" ? null : Number(level)), onSuccess: () => { toast.success(t("app.saved")); refresh(); }, onError: onErr });
  const c = q.data;
  return (
    <Dialog open onClose={onClose} title={`${t("inventory.card")} · ${item.code ? `${item.code} · ` : ""}${item.name}`}>
      <RangePicker value={range} onChange={setRange} presets={["month", "last"]} />
      {!c ? <Skeleton /> : (
        <div className="text-sm" data-testid="stock-card">
          <div className="flex justify-between font-semibold py-1"><span>{t("inventory.opening")}</span><span className="tabular">{qtyFmt(c.opening.qty)} · {c.opening.value != null ? formatUsd(c.opening.value) : ""}</span></div>
          <ul className="divide-y divide-grey-line">
            {c.rows.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex justify-between gap-2"><span className="min-w-0 break-words">{r.date} · {t(`inventory.kind.${r.kind}`)}{r.ref_label ? ` · ${r.ref_label}` : ""}{r.place ? ` · ${r.place}` : ""}</span>
                  <span className={`tabular whitespace-nowrap ${r.qty < 0 ? "text-danger" : "text-success"}`}>{r.qty > 0 ? "+" : ""}{qtyFmt(r.qty)}{r.value ? ` · ${signed(r.value)}` : ""}</span></div>
                <div className="flex justify-between text-xs text-muted"><span className="min-w-0 break-words">{r.technician ? `👷 ${r.technician}` : ""}{r.reason ? ` · ${r.reason}` : ""}{r.supplier ? ` · ${r.supplier}` : ""}{r.supplier_invoice ? ` · #${r.supplier_invoice}` : ""}{r.kind === "in" && r.paid != null && Number(r.paid) < Math.abs(r.value ?? 0) ? ` · ${t("inventory.owed_rest", { amount: formatUsd(Math.abs(r.value ?? 0) - Number(r.paid)) })}` : ""}</span><span className="tabular">= {qtyFmt(r.balance_qty)}{r.balance_value != null ? ` · ${formatUsd(r.balance_value)}` : ""}</span></div>
              </li>
            ))}
          </ul>
          <div className="flex justify-between font-bold py-1 border-t border-grey-line"><span>{t("inventory.ending")}</span><span className="tabular">{qtyFmt(c.ending.qty)} · {c.ending.value != null ? formatUsd(c.ending.value) : ""}</span></div>
        </div>
      )}
      {manage && (
        <div className="flex gap-2 items-end mt-3">
          <div className="flex-1"><Field label={t("inventory.reorder")} hint={t("inventory.reorder_hint")}><Input inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} data-testid="reorder-level" /></Field></div>
          <Button className="mb-3" loading={reorder.isPending} onClick={() => reorder.mutate()} data-testid="reorder-save">{t("app.save")}</Button>
        </div>
      )}
    </Dialog>
  );
}

/** D-144 «ផ្ទៀងផ្ទាត់សម្ភារៈ»: per job (or place) and stock group — what left the stock vs what the invoice charged through the linked
 *  price-list lines; a difference is highlighted. Filter by technician and dates. Admin / CEO / CFO. */
function Reconcile() {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("month", todayLocal()));
  const [tech, setTech] = useState("");
  const users = useQuery({ queryKey: ["users-basic"], queryFn: api.usersBasic });
  const techs = useMemo(() => (users.data ?? []).filter((u) => u.role === "tech"), [users.data]);
  const q = useQuery({ queryKey: ["stock-reconcile", ...range, tech], queryFn: () => api.inventory.reconcile(range[0], range[1], tech || undefined) });
  const d = q.data;
  return (
    <>
      <ReportToolbar report="stock-reconcile" params={{ from: range[0], to: range[1], technician: tech ? [tech] : [] }} active={tech ? 1 : 0}>
        <RangePicker value={range} onChange={setRange} presets={["week", "month", "last"]} />
        <Field label={t("inventory.technician")}><Select value={tech} onChange={(e) => setTech(e.target.value)} data-testid="rec-tech"><option value="">{t("app.all")}</option>{techs.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select></Field>
      </ReportToolbar>
      <p className="text-xs text-muted">{t("inventory.rec_hint")}</p>
      {!d ? <Skeleton /> : !d.rows.length ? <Card><Empty text={t("inventory.rec_none")} /></Card> : (<>
        <Card title={t("inventory.rec_totals")}>
          <ul className="divide-y divide-grey-line -my-2" data-testid="rec-totals">
            {d.totals.map((x) => (
              <li key={x.group_code} className="py-2 text-sm flex items-center gap-2">
                <span className="flex-1 min-w-0 break-words"><span className="font-mono">{x.group_code}</span> {x.group_name}</span>
                <span className="tabular text-xs text-muted whitespace-nowrap">{t("inventory.rec_out")} {qtyFmt(x.out_qty)} · {t("inventory.rec_invoiced")} {qtyFmt(x.invoiced_qty)}</span>
                <Badge tone={x.difference === 0 ? "green" : "danger"}>{x.difference > 0 ? "+" : ""}{qtyFmt(x.difference)}</Badge>
              </li>
            ))}
          </ul>
        </Card>
        <Card title={t("inventory.rec_rows")}>
          <ul className="divide-y divide-grey-line -my-2" data-testid="rec-rows">
            {d.rows.map((r) => (
              <li key={r.key} className={`py-2 text-sm ${r.difference !== 0 ? "bg-warning-50 -mx-3 px-3" : ""}`} data-testid="rec-row">
                <div className="flex items-center gap-2">
                  <span className="flex-1 min-w-0 break-words font-semibold">{r.booking_id ? <Link to={`/bookings/${r.booking_id}`} className="text-blue underline">{r.booking_number}</Link> : r.place}{r.customer_name ? ` · ${r.customer_name}` : ""}</span>
                  <Badge tone={r.difference === 0 ? "green" : "danger"}>{r.difference > 0 ? "+" : ""}{qtyFmt(r.difference)}</Badge>
                </div>
                <div className="text-xs text-muted flex flex-wrap gap-x-2"><span><span className="font-mono">{r.group_code}</span> {r.group_name}</span>{r.technician && <span>👷 {r.technician}</span>}{r.borey_name && <span>🏘 {r.borey_name}</span>}
                  <span className="tabular">{t("inventory.rec_out")} {qtyFmt(r.out_qty)} · {t("inventory.rec_invoiced")} {qtyFmt(r.invoiced_qty)}</span></div>
              </li>
            ))}
          </ul>
        </Card>
      </>)}
    </>
  );
}
