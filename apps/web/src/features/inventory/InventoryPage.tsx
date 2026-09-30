// Inventory (D-87 · flag "inventory"): stock per item (qty, value, average cost, per location, low stock) → stock card;
// stock in / adjust (reason) / transfer / opening; job materials waiting for Admin confirmation; locations. Cards on phones.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatUsd, toCents } from "@sms/shared";
import { ArrowLeftRight, Check, PackagePlus, Plus, SlidersHorizontal } from "lucide-react";
import { api, errCode, type StockItem, type StockPay } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, Dialog, Empty, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { presetRange, type Range } from "@/features/reports/range";
import RangePicker from "@/features/reports/RangePicker";
import { todayLocal } from "@/features/invoices/util";

type Tab = "stock" | "jobs" | "locations";
type Op = "in" | "adjust" | "transfer" | "opening";
const qtyFmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(3).replace(/0+$/, ""));
const signed = (c: number) => `${c < 0 ? "−" : "+"}${formatUsd(Math.abs(c))}`;

export default function InventoryPage() {
  const { t } = useTranslation();
  const { can } = useAuth();
  const manage = can("inventory.manage");
  const [tab, setTab] = useState<Tab>("stock");
  const tabs: Tab[] = manage ? ["stock", "jobs", "locations"] : ["stock"];
  return (
    <div className="max-w-3xl space-y-3">
      <h1>{t("inventory.title")}</h1>
      {tabs.length > 1 && (
        <div className="flex rounded-md border border-grey-line overflow-hidden text-sm" role="tablist">
          {tabs.map((k) => <button key={k} role="tab" aria-selected={tab === k} className={`flex-1 px-3 min-h-[44px] ${tab === k ? "bg-navy text-white" : "bg-white"}`} onClick={() => setTab(k)}>{t(`inventory.tab.${k}`)}</button>)}
        </div>
      )}
      {tab === "stock" ? <Stock manage={manage} /> : tab === "jobs" ? <Jobs /> : <Locations />}
    </div>
  );
}

function useErr() {
  const { t } = useTranslation();
  return (e: unknown) => toast.error(t(`inventory.err.${errCode(e)}`, { defaultValue: t("app.error") }));
}

function Stock({ manage }: { manage: boolean }) {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ["stock-items"], queryFn: api.inventory.items });
  const [op, setOp] = useState<Op | null>(null);
  const [cardOf, setCardOf] = useState<StockItem | null>(null);
  const [tracking, setTracking] = useState(false);
  const total = (q.data ?? []).reduce((s, i) => s + i.value, 0);
  return (
    <>
      {manage && (
        <div className="grid grid-cols-2 gap-2">
          <Button variant="primary" onClick={() => setOp("in")} data-testid="op-in"><PackagePlus size={16} /> {t("inventory.op.in")}</Button>
          <Button onClick={() => setOp("transfer")} data-testid="op-transfer"><ArrowLeftRight size={16} /> {t("inventory.op.transfer")}</Button>
          <Button onClick={() => setOp("adjust")} data-testid="op-adjust"><SlidersHorizontal size={16} /> {t("inventory.op.adjust")}</Button>
          <Button onClick={() => setOp("opening")}>{t("inventory.op.opening")}</Button>
        </div>
      )}
      <Card title={`${t("inventory.value_total")} · ${formatUsd(total)}`} actions={manage ? <Button onClick={() => setTracking(true)} data-testid="track-open"><Plus size={16} /> {t("inventory.track")}</Button> : undefined}>
        {q.isLoading ? <Skeleton /> : !q.data?.length ? <Empty text={t("inventory.none")} /> : (
          <ul className="divide-y divide-grey-line -my-2" data-testid="stock-list">
            {q.data.map((i) => (
              <li key={i.item_id}>
                <button className="w-full text-left py-3 min-h-[56px]" onClick={() => setCardOf(i)}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold break-words min-w-0">{i.name}</span>
                    <span className="font-bold tabular whitespace-nowrap">{qtyFmt(i.qty)} {i.unit}</span>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1 text-xs items-center">
                    <span className="text-muted tabular">{formatUsd(i.value)} · {t("inventory.avg")} {formatUsd(i.avg_cost)}</span>
                    {i.low && <Badge tone="danger">{t("inventory.low", { level: i.reorder_level })}</Badge>}
                    {i.by_location.filter((l) => l.qty !== 0).map((l) => <Badge key={l.location_id} tone="grey">{l.name}: {qtyFmt(l.qty)}</Badge>)}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {op && <OpDialog op={op} items={q.data ?? []} onClose={() => setOp(null)} />}
      {cardOf && <CardDialog item={cardOf} onClose={() => setCardOf(null)} />}
      {tracking && <TrackDialog tracked={(q.data ?? []).map((i) => i.item_id)} onClose={() => setTracking(false)} />}
    </>
  );
}

function OpDialog({ op, items, onClose }: { op: Op; items: StockItem[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useErr();
  const locs = useQuery({ queryKey: ["stock-locations"], queryFn: api.inventory.locations });
  const active = (locs.data ?? []).filter((l) => l.is_active);
  const [item, setItem] = useState(items[0]?.item_id ?? "");
  const [loc, setLoc] = useState(""); const [to, setTo] = useState("");
  const [qty, setQty] = useState(""); const [cost, setCost] = useState(""); const [sign, setSign] = useState<1 | -1>(-1);
  const [pay, setPay] = useState<StockPay>("cash_usd"); const [supplier, setSupplier] = useState(""); const [reason, setReason] = useState("");
  const from = loc || active[0]?.id || "";
  const n = Number(qty);
  let c = NaN; try { c = cost.trim() === "" ? NaN : toCents(cost); } catch { /* invalid */ }
  const valid = !!item && !!from && n > 0 && (op === "transfer" ? !!to && to !== from : op === "adjust" ? reason.trim().length >= 3 : c >= 0);
  const save = useMutation({
    mutationFn: () => op === "in" ? api.inventory.stockIn({ item_id: item, location_id: from, qty: n, unit_cost: c, pay, supplier, note: "" })
      : op === "opening" ? api.inventory.opening({ item_id: item, location_id: from, qty: n, unit_cost: c })
      : op === "transfer" ? api.inventory.transfer({ item_id: item, from, to, qty: n })
      : api.inventory.adjust({ item_id: item, location_id: from, qty: sign * n, reason }),
    onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["stock-items"] }); onClose(); }, onError: onErr,
  });
  const pays: StockPay[] = ["cash_usd", "cash_khr", "aba", "acleda", "credit"];
  return (
    <Dialog open onClose={onClose} title={t(`inventory.op.${op}`)} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!valid} loading={save.isPending} onClick={() => save.mutate()} data-testid="op-save">{t("app.save")}</Button>
    </>}>
      {items.length === 0 ? <p className="text-sm text-muted">{t("inventory.track_first")}</p> : (<>
        <Field label={t("inventory.item")}><Select value={item} onChange={(e) => setItem(e.target.value)} data-testid="op-item">{items.map((i) => <option key={i.item_id} value={i.item_id}>{i.name} ({qtyFmt(i.qty)} {i.unit})</option>)}</Select></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label={op === "transfer" ? t("inventory.from") : t("inventory.location")}><Select value={from} onChange={(e) => setLoc(e.target.value)} data-testid="op-loc">{active.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
          {op === "transfer"
            ? <Field label={t("inventory.to")}><Select value={to} onChange={(e) => setTo(e.target.value)} data-testid="op-to"><option value="">—</option>{active.filter((l) => l.id !== from).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field>
            : <Field label={t("inventory.qty")}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="op-qty" /></Field>}
        </div>
        {op === "transfer" && <Field label={t("inventory.qty")}><Input inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} data-testid="op-qty" /></Field>}
        {(op === "in" || op === "opening") && <Field label={t("inventory.unit_cost")}><Input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} data-testid="op-cost" /></Field>}
        {op === "in" && <>
          <div className="grid grid-cols-3 gap-2 mb-3">{pays.map((p) => <button key={p} type="button" role="radio" aria-checked={pay === p} onClick={() => setPay(p)} className={`min-h-[44px] rounded-md border text-xs ${pay === p ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{t(`inventory.pay.${p}`)}</button>)}</div>
          <Field label={t("inventory.supplier")}><Input value={supplier} onChange={(e) => setSupplier(e.target.value)} maxLength={120} /></Field>
          {n > 0 && c >= 0 && <p className="text-sm tabular">{t("inventory.total")} {formatUsd(Math.round(n * c))}</p>}
        </>}
        {op === "adjust" && <>
          <div className="grid grid-cols-2 gap-2 mb-3">{([-1, 1] as const).map((sg) => <button key={sg} type="button" role="radio" aria-checked={sign === sg} onClick={() => setSign(sg)} className={`min-h-[44px] rounded-md border ${sign === sg ? "bg-navy text-white border-navy" : "bg-white border-grey-line"}`}>{sg < 0 ? t("inventory.minus") : t("inventory.plus")}</button>)}</div>
          <Field label={t("booking.cancel_reason")} required><Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} data-testid="op-reason" /></Field>
        </>}
      </>)}
    </Dialog>
  );
}

function CardDialog({ item, onClose }: { item: StockItem; onClose: () => void }) {
  const { t } = useTranslation();
  const [range, setRange] = useState<Range>(() => presetRange("month", todayLocal()));
  const q = useQuery({ queryKey: ["stock-card", item.item_id, ...range], queryFn: () => api.inventory.card(item.item_id, range[0], range[1]) });
  const c = q.data;
  return (
    <Dialog open onClose={onClose} title={`${t("inventory.card")} · ${item.name}`}>
      <RangePicker value={range} onChange={setRange} presets={["month", "last"]} />
      {!c ? <Skeleton /> : (
        <div className="text-sm" data-testid="stock-card">
          <div className="flex justify-between font-semibold py-1"><span>{t("inventory.opening")}</span><span className="tabular">{qtyFmt(c.opening.qty)} · {c.opening.value != null ? formatUsd(c.opening.value) : ""}</span></div>
          <ul className="divide-y divide-grey-line">
            {c.rows.map((r) => (
              <li key={r.id} className="py-2">
                <div className="flex justify-between gap-2"><span className="min-w-0 break-words">{r.date} · {t(`inventory.kind.${r.kind}`)}{r.ref_label ? ` · ${r.ref_label}` : ""}</span>
                  <span className={`tabular whitespace-nowrap ${r.qty < 0 ? "text-danger" : "text-success"}`}>{r.qty > 0 ? "+" : ""}{qtyFmt(r.qty)}{r.value ? ` · ${signed(r.value)}` : ""}</span></div>
                <div className="flex justify-between text-xs text-muted"><span className="min-w-0 break-words">{r.location}{r.reason ? ` · ${r.reason}` : ""}{r.supplier ? ` · ${r.supplier}` : ""}</span><span className="tabular">= {qtyFmt(r.balance_qty)}{r.balance_value != null ? ` · ${formatUsd(r.balance_value)}` : ""}</span></div>
              </li>
            ))}
          </ul>
          <div className="flex justify-between font-bold py-1 border-t border-grey-line"><span>{t("inventory.ending")}</span><span className="tabular">{qtyFmt(c.ending.qty)} · {c.ending.value != null ? formatUsd(c.ending.value) : ""}</span></div>
        </div>
      )}
    </Dialog>
  );
}

function TrackDialog({ tracked, onClose }: { tracked: string[]; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useErr();
  const cat = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const products = useMemo(() => (cat.data ?? []).filter((i) => i.kind === "product" && i.is_active && !tracked.includes(i.id)), [cat.data, tracked]);
  const [pick, setPick] = useState(""); const [level, setLevel] = useState("");
  const save = useMutation({ mutationFn: () => api.inventory.track(pick || products[0]!.id, true, level.trim() === "" ? null : Number(level)),
    onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["stock-items"] }); onClose(); }, onError: onErr });
  return (
    <Dialog open onClose={onClose} title={t("inventory.track")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" className="flex-1 sm:flex-none" disabled={!products.length} loading={save.isPending} onClick={() => save.mutate()} data-testid="track-save">{t("app.save")}</Button>
    </>}>
      {!products.length ? <p className="text-sm text-muted">{t("inventory.no_products")}</p> : <>
        <Field label={t("inventory.item")}><Select value={pick || products[0]!.id} onChange={(e) => setPick(e.target.value)} data-testid="track-item">{products.map((p) => <option key={p.id} value={p.id}>{p.name_km} ({p.unit})</option>)}</Select></Field>
        <Field label={t("inventory.reorder")} hint={t("inventory.reorder_hint")}><Input inputMode="decimal" value={level} onChange={(e) => setLevel(e.target.value)} /></Field>
      </>}
    </Dialog>
  );
}

function Jobs() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useErr();
  const q = useQuery({ queryKey: ["stock-jobs"], queryFn: api.inventory.pendingJobs });
  const locs = useQuery({ queryKey: ["stock-locations"], queryFn: api.inventory.locations });
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const confirm = useMutation({ mutationFn: (v: { id: string; loc: string }) => api.inventory.confirmJob(v.id, v.loc),
    onSuccess: () => { toast.success(t("inventory.confirmed")); for (const k of [["stock-jobs"], ["stock-items"]]) void qc.invalidateQueries({ queryKey: k }); }, onError: onErr });
  if (q.isLoading) return <Skeleton />;
  if (!q.data?.length) return <Card><Empty text={t("inventory.no_jobs")} /></Card>;
  return (
    <div className="space-y-2">
      {q.data.map((j) => {
        const loc = chosen[j.booking_id] ?? j.suggested_location_id;
        return (
          <Card key={j.booking_id}>
            <div className="flex justify-between gap-2"><Link to={`/bookings/${j.booking_id}`} className="font-semibold text-blue underline min-w-0 break-words">{j.number} · {j.customer_name}</Link><Badge>{t(`status.${j.status}`)}</Badge></div>
            <ul className="text-sm mt-1">{j.materials.map((m) => <li key={m.item_id}>• {m.name}: {qtyFmt(m.qty)} {m.unit}</li>)}</ul>
            <div className="flex gap-2 mt-2 items-end">
              <div className="flex-1"><Field label={t("inventory.from")}><Select value={loc} onChange={(e) => setChosen({ ...chosen, [j.booking_id]: e.target.value })}>{(locs.data ?? []).filter((l) => l.is_active).map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select></Field></div>
              <Button variant="primary" className="mb-3" loading={confirm.isPending} onClick={() => confirm.mutate({ id: j.booking_id, loc })} data-testid="job-confirm"><Check size={16} /> {t("inventory.confirm")}</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function Locations() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const onErr = useErr();
  const q = useQuery({ queryKey: ["stock-locations"], queryFn: api.inventory.locations });
  const [name, setName] = useState("");
  const save = useMutation({ mutationFn: (v: Parameters<typeof api.inventory.saveLocation>[0]) => api.inventory.saveLocation(v),
    onSuccess: () => { toast.success(t("app.saved")); setName(""); void qc.invalidateQueries({ queryKey: ["stock-locations"] }); }, onError: onErr });
  return (
    <Card>
      <ul className="divide-y divide-grey-line -my-2 mb-2">
        {(q.data ?? []).map((l) => (
          <li key={l.id} className={`py-2 flex items-center gap-2 ${l.is_active ? "" : "opacity-50"}`}>
            <span className="flex-1 min-w-0 break-words">{l.kind === "vehicle" ? "🚐" : "🏬"} {l.name}</span>
            <Button onClick={() => save.mutate({ id: l.id, name: l.name, kind: l.kind, is_active: !l.is_active })}>{l.is_active ? t("app.inactive") : t("app.active")}</Button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 items-end">
        <div className="flex-1"><Field label={t("inventory.new_location")}><Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field></div>
        <Button className="mb-3" disabled={!name.trim()} onClick={() => save.mutate({ name, kind: "warehouse" })}><Plus size={16} /> {t("app.add")}</Button>
      </div>
    </Card>
  );
}

