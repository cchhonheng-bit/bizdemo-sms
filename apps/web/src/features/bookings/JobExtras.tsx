// D-140 F · D-144 — work added on site. The technician (between arrive and report): a line of the service / price list + quantity
// (a service or a package-priced sale line, at its list price — never a stock item), or «ការងារ/សម្ភារៈបន្ថែម» (a text + quantity +
// unit + an optional photo, no price). Every line is «បន្ថែមដោយជាង» (who, when). Admin / GM review before the invoice: confirm (price
// kept or edited; a free line is marked service or goods) / remove (reason). Technician work never moves stock.
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Camera, Check, Plus, Trash2, X } from "lucide-react";
import { formatUsd } from "@sms/shared";
import { api, errCode, fmtDateTime, type Booking, type JobExtra, type JobInfo } from "@/lib/api";
import { compressPhoto } from "@/lib/offline";
import { Badge, Button, Card, Dialog, Field, Input, Select } from "@/components/ui";
import { toast } from "@/lib/toast";
import { splitLocal } from "./time";

const OPEN = ["on_site", "working", "work_done", "revision"];
const dollars = (cents: number | null) => (cents == null ? "" : (cents / 100).toFixed(2));
const toCents = (v: string) => (v.trim() === "" ? null : Math.round(Number(v) * 100));

/** «បន្ថែមដោយជាង · Kim · 12-10 10:32» */
function AddedBy({ x }: { x: JobExtra }) {
  const { t } = useTranslation();
  return <span className="text-xs text-muted" data-testid="extra-flag">{t("extras.added_by", { name: x.added_by_name ?? "—", at: fmtDateTime(x.added_at) })}</span>;
}
const qtyText = (x: JobExtra) => (x.qty !== 1 || x.unit ? ` ×${x.qty}${x.unit ? ` ${x.unit}` : ""}` : "");

/** the technician's card: a price-list line or a free line; own lines still waiting can be taken back */
export function ExtrasCard({ booking, info, meId, onDone }: { booking: Booking; info: JobInfo; meId: string | undefined; onDone: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const catalog = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const list = useMemo(() => (catalog.data ?? []).filter((i) => i.is_active && !i.is_stock), [catalog.data]); // the price list — the server sends no stock items to technicians
  const [mode, setMode] = useState<"service" | "other">("service");
  const [item, setItem] = useState(""), [qty, setQty] = useState("1"), [text, setText] = useState(""), [unit, setUnit] = useState(""), [photo, setPhoto] = useState<string | null>(null);
  const [overlap, setOverlap] = useState<{ number: string; scheduled_at: string } | null>(null);
  const extras = (info.extras ?? []).filter((x) => x.status !== "removed");
  const add = useMutation({
    mutationFn: () => api.job.addExtra(booking.id, mode === "service" ? { kind: "service", item_id: item, qty: Math.max(1, Number(qty) || 1) }
      : { kind: "other", description: text.trim(), qty: Math.max(1, Number(qty) || 1), unit: unit.trim() || null, photo }),
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
  const picked = list.find((i) => i.id === item);
  return (
    <Card title={t("extras.title")} className="mb-4">
      <p className="text-xs text-muted mb-3">{t("extras.hint")}</p>
      {overlap && <p className="mb-3 rounded-md bg-warning-50 text-warning p-3 text-sm" role="alert" data-testid="extra-overlap">⚠️ {t("extras.overlap", { number: overlap.number, time: splitLocal(overlap.scheduled_at).time })}</p>}
      <div className="grid grid-cols-2 gap-2 mb-3" role="radiogroup">
        {(["service", "other"] as const).map((m) => (
          <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} data-testid={`extra-mode-${m}`}
            className={`min-h-[48px] rounded-md border px-3 text-sm ${mode === m ? "border-navy bg-[#E6EDFD] font-bold text-navy" : "border-grey-line bg-white"}`}>{t(`extras.mode_${m}`)}</button>
        ))}
      </div>
      {mode === "service" ? (
        <div className="flex gap-2 mb-3">
          <Select name="extra_item" className="flex-1 min-w-0" value={item} onChange={(e) => setItem(e.target.value)}>
            <option value="">{t("booking.line_pick")}</option>
            {list.map((s) => <option key={s.id} value={s.id}>{lang === "en" && s.name_en ? s.name_en : s.name_km}{s.kind === "product" ? ` (${s.unit})` : ""}</option>)}
          </Select>
          <Input type="number" inputMode="decimal" min={1} max={999} className="!w-20 tabular" name="extra_qty" aria-label={t("booking.line_qty")} value={qty} onChange={(e) => setQty(e.target.value)} />
          {picked?.kind === "product" && <span className="self-center text-xs text-muted">{picked.unit}</span>}
        </div>
      ) : (
        <>
          <Field label={t("extras.other_text")} hint={t("extras.other_hint")}><textarea className="input h-20 py-2" name="extra_text" maxLength={300} value={text} onChange={(e) => setText(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label={t("booking.line_qty")}><Input type="number" inputMode="decimal" min={1} max={999} name="extra_qty" value={qty} onChange={(e) => setQty(e.target.value)} /></Field>
            <Field label={t("extras.unit")}><Input name="extra_unit" maxLength={20} placeholder="ម៉ែត្រ" value={unit} onChange={(e) => setUnit(e.target.value)} /></Field>
          </div>
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
                <div className="text-sm break-words">{x.description}{qtyText(x)}{x.minutes ? <span className="text-muted"> · +{x.minutes} {t("extras.min")}</span> : null}</div>
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

/** the lines on the job page for Admin / GM / the GM's review — read-only, every line flagged */
export function ExtrasList({ extras }: { extras: JobExtra[] }) {
  const { t } = useTranslation();
  const list = extras.filter((x) => x.status !== "removed");
  if (!list.length) return null;
  return (
    <div data-testid="extras-list">
      <div className="text-muted text-xs">{t("extras.review_title")}</div>
      <ul>{list.map((x) => <li key={x.id}>• {x.description}{qtyText(x)} <Badge tone="purple">{t("extras.flag")}</Badge>{x.status === "confirmed" && <> <Badge tone="green">{t("extras.confirmed")}</Badge></>}</li>)}</ul>
    </div>
  );
}

/** Admin / GM before the invoice: each added line — confirm (price as is or edited; a free line: service or goods) or remove (with a reason) */
export function ExtrasReview({ booking }: { booking: Booking }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["job", booking.id], queryFn: () => api.job.info(booking.id) });
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [kinds, setKinds] = useState<Record<string, "service" | "product">>({});
  const [removing, setRemoving] = useState<JobExtra | null>(null);
  const [reason, setReason] = useState("");
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["job", booking.id] }); void qc.invalidateQueries({ queryKey: ["invoice-prefill", booking.id] }); };
  const review = useMutation({
    mutationFn: (v: { x: JobExtra; action: "confirm" | "remove" }) => api.job.reviewExtra(booking.id, v.x.id, v.action === "confirm"
      ? { action: "confirm", ...(prices[v.x.id] !== undefined ? { unit_price: toCents(prices[v.x.id]!) } : {}), ...(v.x.catalog_item_id ? {} : { kind: kinds[v.x.id] ?? (v.x.kind === "material" ? "product" : "service") }) }
      : { action: "remove", reason: reason.trim() }),
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
        {list.map((x) => {
          const free = !x.catalog_item_id;
          const kind = kinds[x.id] ?? (x.item_kind ?? (x.kind === "material" ? "product" : "service"));
          return (
            <li key={x.id} className={`py-3 ${x.status === "removed" ? "opacity-60" : ""}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-semibold break-words">{x.description}{qtyText(x)} <Badge tone="purple">{t("extras.flag")}</Badge> <Badge tone="grey">{t(kind === "product" ? "extras.kind_product" : "extras.kind_service")}</Badge></div>
                  <AddedBy x={x} />
                  {x.photo_file && <a className="block text-sm text-blue underline min-h-[32px]" href={`/api/files/${x.photo_file}`} target="_blank" rel="noreferrer">{t("extras.see_photo")}</a>}
                  {x.status === "removed" && <p className="text-xs text-danger">{t("extras.removed", { reason: x.review_note ?? "" })}</p>}
                  {x.status === "confirmed" && <p className="text-xs text-success">{t("extras.confirmed_by", { name: x.reviewed_by_name ?? "—", price: formatUsd(x.unit_price ?? 0) })}</p>}
                </div>
                {x.status === "pending" && (
                  <div className="flex flex-wrap items-center gap-2">
                    {free && (
                      <div className="flex rounded-md border border-grey-line overflow-hidden" role="radiogroup" data-testid="extra-kind">
                        {(["service", "product"] as const).map((k) => <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKinds((p) => ({ ...p, [x.id]: k }))} className={`px-3 min-h-[44px] text-xs ${kind === k ? "bg-navy text-white" : "bg-white"}`}>{t(`extras.kind_${k}`)}</button>)}
                      </div>
                    )}
                    <Input className="!w-28 tabular" inputMode="decimal" placeholder="$" aria-label={t("extras.price")} name={`extra_price_${x.id}`}
                      value={prices[x.id] ?? dollars(x.unit_price)} onChange={(e) => setPrices((p) => ({ ...p, [x.id]: e.target.value }))} />
                    <Button variant="primary" onClick={() => review.mutate({ x, action: "confirm" })} disabled={(prices[x.id] ?? dollars(x.unit_price)) === ""} data-testid="extra-confirm"><Check size={16} /> {t("extras.confirm")}</Button>
                    <Button variant="danger" onClick={() => setRemoving(x)} data-testid="extra-remove"><X size={16} /> {t("extras.remove")}</Button>
                  </div>
                )}
              </div>
            </li>
          );
        })}
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
