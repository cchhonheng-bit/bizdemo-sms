// D-140 F — work added on site. The technician (between arrive and report): a catalog service + quantity, or «ការងារផ្សេងៗ» (a text +
// an optional photo, no price). Every line is «បន្ថែមដោយជាង» (who, when). Admin / GM review before the invoice: confirm (price kept or
// edited) / remove (reason). D-140 E4: the Admin / GM record a job's materials too (MaterialsEditor).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Plus, Trash2, X } from "lucide-react";
import { formatUsd } from "@sms/shared";
import { api, errCode, fmtDateTime, type Booking, type JobExtra, type JobInfo } from "@/lib/api";
import { compressPhoto } from "@/lib/offline";
import { Badge, Button, Card, Dialog, Field, Input, Select } from "@/components/ui";
import { toast } from "@/lib/toast";
import { useAuth } from "@/lib/auth";
import { useFeature } from "@/lib/config";
import { ItemDialog } from "@/features/catalog/CatalogPage";
import { ItemPicker } from "./ItemPicker";
import { splitLocal } from "./time";

const OPEN = ["on_site", "working", "work_done", "revision"];
const dollars = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

/** «បន្ថែមដោយជាង · Kim · 12-10 10:32» */
function AddedBy({ x }: { x: JobExtra }) {
  const { t } = useTranslation();
  return <span className="text-xs text-muted" data-testid="extra-flag">{t("extras.added_by", { name: x.added_by_name ?? "—", at: fmtDateTime(x.added_at) })}</span>;
}

/** the technician's card: add a service or other work; own lines still waiting can be taken back */
export function ExtrasCard({ booking, info, meId, onDone }: { booking: Booking; info: JobInfo; meId: string | undefined; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const services = useMemo(() => (catalog.data ?? []).filter((i) => i.is_active && i.kind === "service"), [catalog.data]);
  const [mode, setMode] = useState<"service" | "material" | "other">("service");
  const [unit, setUnit] = useState("");
  const [item, setItem] = useState(""), [qty, setQty] = useState("1"), [text, setText] = useState(""), [photo, setPhoto] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<{ number: string; scheduled_at: string } | null>(null);
  const extras = (info.extras ?? []).filter((x) => x.status !== "removed");
  const add = useMutation({
    mutationFn: () => api.job.addExtra(booking.id, mode === "service" ? { kind: "service", item_id: item, qty: Math.max(1, Number(qty) || 1) }
      : mode === "material" ? { kind: "material", description: text.trim(), qty: Math.max(1, Number(qty) || 1), unit: unit.trim() || null, photo } : { kind: "other", description: text.trim(), photo }),
    onSuccess: (r) => {
      setOverlap(r.overlap);
      if (r.overlap) toast.error(t("extras.overlap", { number: r.overlap.number, time: splitLocal(r.overlap.scheduled_at).time }));
      else toast.success(t("extras.added"));
      setItem(""); setQty("1"); setText(""); setUnit(""); setPhoto(null); onDone();
    },
    onError: (e) => toast.error(t(`extras.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const remove = useMutation({ mutationFn: (xid: string) => api.job.removeExtra(booking.id, xid), onSuccess: onDone, onError: (e) => toast.error(t(`extras.err.${errCode(e)}`, { defaultValue: t("app.error") })) });
  if (!OPEN.includes(booking.status)) return null;
  const ready = mode === "service" ? !!item : text.trim().length >= 2;
  return (
    <Card title={t("extras.title")} className="mb-4">
      <p className="text-xs text-muted mb-3">{t("extras.hint")}</p>
      {overlap && <p className="mb-3 rounded-md bg-warning-50 text-warning p-3 text-sm" role="alert" data-testid="extra-overlap">⚠️ {t("extras.overlap", { number: overlap.number, time: splitLocal(overlap.scheduled_at).time })}</p>}
      <div className="grid grid-cols-3 gap-2 mb-3" role="radiogroup">
        {(["service", "material", "other"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} data-testid={`extra-mode-${m}`}
            className={`min-h-[48px] rounded-md border px-3 text-sm ${mode === m ? "border-navy bg-[#E6EDFD] font-bold text-navy" : "border-grey-line bg-white"}`}>{t(`extras.mode_${m}`)}</button>
        ))}
      </div>
      {mode === "service" ? (
        <div className="flex gap-2 mb-3">
          <Select name="extra_item" className="flex-1 min-w-0" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">{t("booking.line_pick")}</option>
            {services.map((s) => <option key={s.id} value={s.id}>{lang === "en" && s.name_en ? s.name_en : s.name_km}</option>)}
          </Select>
          <Input type="number" inputMode="numeric" min={1} max={999} className="!w-20 tabular" name="extra_qty" aria-label={t("booking.line_qty")} value={qty} onChange={(e) => setQty(e.target.value)} />
        </div>
      ) : (
        <>
          <Field label={t(mode === "material" ? "extras.material_text" : "extras.other_text")} hint={t(mode === "material" ? "extras.material_hint" : "extras.other_hint")}><textarea className="input h-20 py-2" name="extra_text" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          {mode === "material" && (
            <div className="grid grid-cols-2 gap-x-3">
              <Field label={t("booking.line_qty")}><Input type="number" inputMode="decimal" min={1} max={999} name="extra_qty" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
              <Field label={t("extras.unit")}><Input name="extra_unit" maxLength={20} placeholder="ម៉ែត្រ" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
            </div>
          )}
          <label className="btn-secondary w-full cursor-pointer mb-3">
            <Camera size={18} /> {photo ? t("extras.photo_ok") : t("extras.photo")}
            <input type="file" accept="image/*" capture="environment" className="sr-only" data-testid="extra-photo" onChange={(e) => { const f = e.target.files?.[0]; if (f) void compressPhoto(f).then(setPhoto); e.target.value = ""; }} />
          </label>
        </>
      )}
      <Button variant="primary" className="w-full" disabled={!ready} loading={add.isPending} onClick={() => add.mutate()} data-testid="extra-add"><Plus size={16} /> {t("extras.add")}</Button>
      {extras.length > 0 && (
        <ul className="mt-4 divide-y divide-grey-line border border-grey-line rounded-md" data-testid="extra-list">
          {extras.map((x) => (
            <li key={x.id} className="px-3 py-2 flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-sm break-words">{x.description}{x.qty !== 1 ? ` ×${x.qty}` : ""}{x.minutes ? <span className="text-muted"> · +{x.minutes} {t("extras.min")}</span> : null}</div>
                <AddedBy x={x} /> {x.status === "confirmed" && <Badge tone="green">{t("extras.confirmed")}</Badge>}
              </div>
              {x.status === "pending" && x.added_by === meId && <button type="button" className="tap-target text-danger" aria-label={t("extras.take_back")} onClick={() => remove.mutate(x.id)}><Trash2 size={16} /></button>}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Admin / GM before the invoice: each added line — confirm (price as is or edited) or remove (with a reason) */
export function ExtrasReview({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id) });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [removing, setRemoving] = useState<JobExtra | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["job", booking.id] }); void qc.invalidateQueries({ queryKey: ["invoice-prefill", booking.id] }); };
  const review = useMutation({
    mutationFn: (v: { x: JobExtra; action: "confirm" | "remove" }) => api.job.reviewExtra(booking.id, v.x.id, v.action === "confirm"
      ? { action: "confirm", ...(prices[v.x.id] !== undefined ? { unit_price: toCents(prices[v.x.id]!) } : {}) } : { action: "remove", reason: reason.trim() }),
    onSuccess: () => { toast.success(t("app.saved")); setRemoving(null); setReason(""); refresh(); },
    onError: (e) => toast.error(t(`extras.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const list = q.data?.extras ?? [];
  if (!list.length) return null;
  const waiting = list.filter((x) => x.status === "pending").length;
  return (
    <Card title={t("extras.review_title")} className="mb-4">
      {waiting > 0 && <p className="mb-3 rounded-md bg-warning-50 text-warning p-3 text-sm" data-testid="extras-waiting">{t("extras.waiting", { n: waiting })}</p>}
      <ul className="divide-y divide-grey-line" data-testid="extras-review">
        {list.map((x) => (
          <li key={x.id} className={`py-3 ${x.status === "removed" ? "opacity-60" : ""}`}>
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="font-semibold break-words">{x.description}{x.qty !== 1 ? ` ×${x.qty}${x.unit ? ` ${x.unit}` : ""}` : ""} <Badge tone="purple">{t("extras.flag")}</Badge>{x.kind === "material" && <> <Badge tone="grey">{t("extras.mode_material")}</Badge></>}</div>
                <AddedBy x={x} />
                {x.photo_file && <a className="block text-sm text-blue underline min-h-[32px]" href={`/api/files/${x.photo_file}`} target="_blank" rel="noreferrer">{t("extras.see_photo")}</a>}
                {x.status === "removed" && <p className="text-xs text-danger">{t("extras.removed", { reason: x.review_note ?? "" })}</p>}
                {x.status === "confirmed" && <p className="text-xs text-success">{t("extras.confirmed_by", { name: x.reviewed_by_name ?? "—", price: formatUsd(x.unit_price ?? 0) })}</p>}
              </div>
              {x.status === "pending" && (
                <div className="flex items-center gap-2">
                  <Input className="!w-28 tabular" inputMode="decimal" placeholder="$" aria-label={t("extras.price")} name={`extra_price_${x.id}`}
                    value={prices[x.id] ?? dollars(x.unit_price)} onChange={(e) => setPrices((p) => ({ ...p, [x.id]: e.target.value }))} />
                  <Button variant="primary" onClick={() => review.mutate({ x, action: "confirm" })} disabled={(prices[x.id] ?? dollars(x.unit_price)) === ""} data-testid="extra-confirm"><Check size={16} /> {t("extras.confirm")}</Button>
                  <Button variant="danger" onClick={() => setRemoving(x)} data-testid="extra-remove"><X size={16} /> {t("extras.remove")}</Button>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      {removing && (
        <Dialog open onClose={() => setRemoving(null)} title={t("extras.remove")} footer={<>
          <Button onClick={() => setRemoving(null)}>{t("app.back")}</Button>
          <Button variant="danger" disabled={reason.trim().length < 3} loading={review.isPending} onClick={() => review.mutate({ x: removing, action: "remove" })} data-testid="extra-remove-ok">{t("extras.remove")}</Button>
        </>}>
          <p className="text-sm mb-3 break-words">{removing.description}</p>
          <Field label={t("booking.reschedule_reason")} required><Input name="extra_reason" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
        </Dialog>
      )}
    </Card>
  );
}

/** D-140 E4: Admin / GM add or correct a job's materials (same rules as the GM) while the job is open and the stock not taken yet */
export function MaterialsEditor({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id) });
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const products = useMemo(() => (catalog.data ?? []).filter((i) => i.is_active), [catalog.data]); // D-142: every catalog item, by name or code
  const [mats, setMats] = useState<{ catalog_item_id: string; qty: string }[] | null>(null);
  const [adding, setAdding] = useState(false); // D-142: «+ ទំនិញថ្មី» — the catalog form, right here
  const { can } = useAuth();
  const websiteOn = useFeature("website");
  const rows = mats ?? (q.data?.materials ?? []).map((m) => ({ catalog_item_id: m.catalog_item_id, qty: String(m.qty) }));
  const save = useMutation({
    mutationFn: () => api.job.materials(booking.id, rows.filter((m) => Number(m.qty) > 0).map((m) => ({ catalog_item_id: m.catalog_item_id, qty: Number(m.qty) }))),
    onSuccess: () => { toast.success(t("app.saved")); setMats(null); void qc.invalidateQueries({ queryKey: ["job", booking.id] }); },
    onError: (e) => toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  if (!OPEN.includes(booking.status) || !q.data || q.data.materials.some((m) => m.confirmed_at)) return null;
  const nameOf = (id: string) => products.find((p) => p.id === id) ?? null;
  const byWho = (id: string) => q.data!.materials.find((m) => m.catalog_item_id === id)?.added_by_name;
  return (
    <Card title={t("job.materials")} className="mb-4">
      <div className="flex gap-2 items-start">
        <div className="flex-1 min-w-0"><ItemPicker items={products} exclude={rows.map((m) => m.catalog_item_id)} onPick={(i) => setMats([...rows, { catalog_item_id: i.id, qty: "1" }])} testId="mat-search" /></div>
        <Button type="button" onClick={() => setAdding(true)} data-testid="mat-new"><Plus size={16} /> {t("job.new_item")}</Button>
      </div>
      {adding && <ItemDialog item={null} showCost={can("cost.read")} websiteOn={websiteOn} onClose={() => { setAdding(false); void qc.invalidateQueries({ queryKey: ["catalog"] }); }} />}
      <ul className="mt-2 space-y-2" data-testid="mat-rows">
        {rows.map((m, i) => (
          <li key={m.catalog_item_id} className="flex items-center gap-2">
            <span className="flex-1 min-w-0 break-words text-sm">{nameOf(m.catalog_item_id)?.name_km ?? "…"}{byWho(m.catalog_item_id) ? <span className="block text-xs text-muted">{byWho(m.catalog_item_id)}</span> : null}</span>
            <Input className="!w-24" inputMode="decimal" value={m.qty} onChange={(e) => setMats(rows.map((y, j) => (j === i ? { ...y, qty: e.target.value } : y)))} aria-label={t("booking.line_qty")} />
            <button type="button" className="tap-target text-danger" aria-label={t("booking.line_remove")} onClick={() => setMats(rows.filter((_, j) => j !== i))}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
      {mats && <Button type="button" className="mt-2" variant="primary" loading={save.isPending} onClick={() => save.mutate()} data-testid="mat-save">{t("app.save")}</Button>}
    </Card>
  );
}
