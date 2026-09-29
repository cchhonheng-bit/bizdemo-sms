import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { catalogItemSchema, formatUsd, fromCents, SERVICE_CATEGORIES, toCents, type CatalogItemInput } from "@sms/shared";
import { Pencil, Plus, Power } from "lucide-react";
import { api, errCode, type CatalogItem } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";

export default function CatalogPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { can } = useAuth();
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [toggle, setToggle] = useState<CatalogItem | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("");
  const items = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items.data ?? []).filter((i) => (!cat || i.category === cat) && (!s || i.name_km.toLowerCase().includes(s) || (i.name_en ?? "").toLowerCase().includes(s)));
  }, [items.data, q, cat]);
  const act = useMutation({
    mutationFn: (i: CatalogItem) => api.setCatalogActive(i.id, !i.is_active),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["catalog"] }); toast.success(t("app.saved")); setToggle(null); },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const showCost = can("cost.read");

  return (
    <div>
      <div className="flex items-center justify-between mb-4 gap-3">
        <h1>{t("catalog.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} /> {t("catalog.new")}</Button>
      </div>
      <Card>
        <div className="flex flex-wrap gap-3 mb-3">
          <Input type="search" placeholder={t("app.search")} value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:max-w-xs" />
          <Select value={cat} onChange={(e) => setCat(e.target.value)} className="w-full sm:max-w-[200px]">
            <option value="">{t("catalog.all_categories")}</option>
            {SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}
          </Select>
        </div>
        {items.isLoading ? <Skeleton /> : items.isError ? <ErrorState text={t("app.error")} onRetry={() => void items.refetch()} /> : filtered.length === 0 ? <Empty text={t("app.empty")} /> : (
          <>
          {/* phones: cards (tables become cards on mobile — UI Design v1.1) */}
          <ul className="md:hidden divide-y divide-grey-line -mx-4">
            {filtered.map((i) => (
              <li key={i.id} className={`px-4 py-3 flex items-start gap-2 ${i.is_active ? "" : "opacity-60"}`}>
                <div className="flex-1 min-w-0">
                  <div className="font-semibold break-words">{i.name_km}</div>
                  <div className="text-xs text-muted flex flex-wrap gap-x-2">
                    <span>{t(`catalog.kind_${i.kind}`)}</span><span>{t(`category.${i.category}`)}</span>
                    {i.kind === "service" && <span>⏱ {i.duration_min} min</span>}
                  </div>
                  <div className="text-sm tabular">{i.sell_price != null ? formatUsd(i.sell_price) : "—"}{showCost && i.cost_price != null ? <span className="text-muted"> · {formatUsd(i.cost_price)}</span> : null} <span className="text-muted">/ {i.unit}</span></div>
                </div>
                <button className="tap-target rounded hover:bg-grey-bg" aria-label={t("app.edit")} onClick={() => setEditing(i)}><Pencil size={18} /></button>
                <button className="tap-target rounded hover:bg-grey-bg" aria-label={i.is_active ? t("app.inactive") : t("app.active")} onClick={() => setToggle(i)}><Power size={18} /></button>
              </li>
            ))}
          </ul>
          <div className="hidden md:block overflow-x-auto -mx-4 px-4">
            <table className="table">
              <thead><tr><th>{t("catalog.name")}</th><th>{t("catalog.kind")}</th><th>{t("catalog.category")}</th><th>{t("catalog.unit")}</th><th className="text-right">{t("catalog.duration")}</th><th className="text-right">{t("catalog.sell_price")}</th>{showCost && <th className="text-right">{t("catalog.cost_price")}</th>}<th className="text-right">{t("app.actions")}</th></tr></thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} className={i.is_active ? "" : "opacity-60"}>
                    <td><div className="font-semibold">{i.name_km}</div>{i.name_en && <div className="text-xs text-muted">{i.name_en}</div>}</td>
                    <td><Badge tone={i.kind === "service" ? "blue" : "grey"}>{t(`catalog.kind_${i.kind}`)}</Badge></td>
                    <td>{t(`category.${i.category}`)}</td>
                    <td>{i.unit}</td>
                    <td className="text-right tabular">{i.kind === "service" ? i.duration_min : "—"}</td>
                    <td className="text-right tabular">{i.sell_price != null ? formatUsd(i.sell_price) : "—"}</td>
                    {showCost && <td className="text-right tabular text-muted">{i.cost_price != null ? formatUsd(i.cost_price) : "—"}</td>}
                    <td className="text-right whitespace-nowrap">
                      <button className="tap-target rounded hover:bg-grey-bg" title={t("app.edit")} onClick={() => setEditing(i)}><Pencil size={16} /></button>
                      <button className="tap-target rounded hover:bg-grey-bg" title={i.is_active ? t("app.inactive") : t("app.active")} onClick={() => setToggle(i)}><Power size={16} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
      {editing && <ItemDialog item={editing === "new" ? null : editing} showCost={showCost} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} loading={act.isPending} danger={toggle?.is_active}
        title={toggle?.is_active ? t("catalog.deactivate") : t("catalog.activate")} text={toggle?.name_km ?? ""} onConfirm={() => toggle && act.mutate(toggle)} />
    </div>
  );
}

function ItemDialog({ item, showCost, onClose }: { item: CatalogItem | null; showCost: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [sell, setSell] = useState(item?.sell_price != null ? String(fromCents(item.sell_price)) : "");
  const [cost, setCost] = useState(item?.cost_price != null ? String(fromCents(item.cost_price)) : "");
  const [duration, setDuration] = useState(String(item?.duration_min ?? 120)); // R3 placeholder 120 min until One Team confirms
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CatalogItemInput>({
    resolver: zodResolver(catalogItemSchema.omit({ sell_price: true, cost_price: true, duration_min: true })),
    defaultValues: item ? { name_km: item.name_km, name_en: item.name_en ?? "", kind: item.kind, category: item.category, unit: item.unit } : { name_km: "", name_en: "", kind: "service", category: "mep", unit: "" },
  });
  const submit = handleSubmit(async (v) => {
    let sellC: number, costC: number | null;
    try {
      sellC = toCents(sell || 0); costC = showCost && cost !== "" ? toCents(cost) : null;
    } catch { return toast.error(t("catalog.err_price")); }
    if (sellC < 0 || (costC != null && costC < 0)) return toast.error(t("catalog.err_price"));
    const mins = Number(duration);
    if (v.kind === "service" && (!Number.isInteger(mins) || mins < 15 || mins > 1440)) return toast.error(t("booking.err.DURATION_RANGE"));
    try {
      await api.upsertCatalogItem({ id: item?.id, name_km: v.name_km, name_en: v.name_en || null, kind: v.kind, category: v.category, unit: v.unit || null, sell_price: sellC, cost_price: costC, duration_min: v.kind === "service" ? mins : undefined });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      toast.success(t("app.saved"));
      onClose();
    } catch (e) {
      toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }));
    }
  });
  return (
    <Dialog open onClose={onClose} title={item ? t("app.edit") : t("catalog.new")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" onClick={() => void submit()} loading={isSubmitting}>{t("app.save")}</Button>
    </>}>
      <form onSubmit={submit} noValidate>
        <Field label={t("catalog.name_km")} required error={errors.name_km && t("app.required")}><Input invalid={!!errors.name_km} {...register("name_km")} autoFocus /></Field>
        <Field label={t("catalog.name_en")}><Input {...register("name_en")} /></Field>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-3">
          <Field label={t("catalog.kind")}><Select {...register("kind")}><option value="service">{t("catalog.kind_service")}</option><option value="product">{t("catalog.kind_product")}</option></Select></Field>
          <Field label={t("catalog.category")}><Select {...register("category")}>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}</Select></Field>
          <Field label={t("catalog.unit")}><Input placeholder="unit" {...register("unit")} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t("catalog.sell_price") + " ($)"} required><Input inputMode="decimal" name="sell_price" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
          {showCost && <Field label={t("catalog.cost_price") + " ($)"}><Input inputMode="decimal" name="cost_price" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
        </div>
        {watch("kind") === "service" && (
          <Field label={t("catalog.duration")} hint={t("catalog.duration_hint")}><Input inputMode="numeric" type="number" min={15} max={1440} step={15} name="duration_min" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        )}
      </form>
    </Dialog>
  );
}
