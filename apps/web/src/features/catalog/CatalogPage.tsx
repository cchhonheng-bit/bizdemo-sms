// Catalog «ទំនិញ និងសេវាកម្ម» (D-106): the items with their website fields (code, website category, «from» price, shown on the
// website, quote only). Editing — the form and the Excel import — is for CEO, CFO, Admin and GM (the server checks it too).
// Excel: download the template (the services as they are now) → upload → preview (new / changed / errors) → apply. Matched by
// code; nothing is deleted. Over the list: who changed it last, and when.
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { catalogItemSchema, formatUsd, fromCents, SERVICE_CATEGORIES, toCents, WEB_CATEGORIES, WEB_CATEGORY_LABEL, type CatalogItemInput, type WebCategory } from "@sms/shared";
import { Download, Pencil, Plus, Power, Upload } from "lucide-react";
import { api, errCode, type CatalogItem, type CatalogPreview } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, RowAction, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { useFeature } from "@/lib/config";

const when = (s: string) => new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(s));
const toB64 = (f: File) => new Promise<string>((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(",")[1] ?? ""); r.onerror = () => reject(r.error); r.readAsDataURL(f); });

export default function CatalogPage() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const qc = useQueryClient();
  const { can } = useAuth();
  const websiteOn = useFeature("website");
  const [editing, setEditing] = useState<CatalogItem | "new" | null>(null);
  const [toggle, setToggle] = useState<CatalogItem | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("");
  const [preview, setPreview] = useState<{ data: string; result: CatalogPreview } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const items = useQuery({ queryKey: ["catalog"], queryFn: api.catalog });
  const meta = useQuery({ queryKey: ["catalog", "meta"], queryFn: api.catalogMeta });
  const edit = meta.data?.can_edit === true;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (items.data ?? []).filter((i) => (!cat || i.category === cat) && (!s || i.name_km.toLowerCase().includes(s) || (i.name_en ?? "").toLowerCase().includes(s) || (i.code ?? "").toLowerCase().includes(s)));
  }, [items.data, q, cat]);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ["catalog"] }); };
  const act = useMutation({
    mutationFn: (i: CatalogItem) => api.setCatalogActive(i.id, !i.is_active),
    onSuccess: () => { refresh(); toast.success(t("app.saved")); setToggle(null); },
    onError: (e) => toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const upload = async (f: File | undefined) => {
    if (!f) return;
    try {
      const data = await toB64(f);
      setPreview({ data, result: await api.catalogPreview(data) });
    } catch (e) { toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t("app.error") })); }
  };
  const apply = useMutation({
    mutationFn: () => api.catalogApply(preview!.data),
    onSuccess: (r) => { toast.success(t("catalog.applied", { new: r.counts.new, changed: r.counts.changed })); setPreview(null); refresh(); },
    onError: (e) => toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t("catalog.fix_first") })),
  });
  const showCost = can("cost.read");
  const webCat = (c: WebCategory | null | undefined) => (c ? WEB_CATEGORY_LABEL[c][lang] : null);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between mb-2 gap-3">
        <h1>{t("catalog.title")}</h1>
        {edit && <div className="flex flex-wrap gap-2">
          {websiteOn && <a className="btn-secondary" href={`/api/catalog/template.xlsx?lang=${lang}`} data-testid="cat-template"><Download size={16} /> {t("catalog.excel_template")}</a>}
          {websiteOn && <Button onClick={() => fileRef.current?.click()} data-testid="cat-upload"><Upload size={16} /> {t("catalog.excel_upload")}</Button>}
          <Button variant="primary" onClick={() => setEditing("new")}><Plus size={16} /> {t("catalog.new")}</Button>
        </div>}
        <input ref={fileRef} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" className="sr-only" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ""; }} />
      </div>
      {meta.data?.last && <p className="text-xs text-muted mb-3" data-testid="cat-last">{t("catalog.last_change", { name: meta.data.last.name, at: when(meta.data.last.at) })}</p>}
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
                  <div className="font-semibold break-words">{i.name_km}{i.is_sample && <span className="ml-2"><Badge tone="warning">{t("catalog.sample")}</Badge></span>}</div>
                  <div className="text-xs text-muted flex flex-wrap gap-x-2">
                    {i.code && <span className="tabular">{i.code}</span>}<span>{t(`catalog.kind_${i.kind}`)}</span><span>{webCat(i.web_category) ?? t(`category.${i.category}`)}</span>
                    {i.kind === "service" && <span>⏱ {i.duration_min} min</span>}
                  </div>
                  <div className="text-sm tabular">{i.sell_price != null ? formatUsd(i.sell_price) : "—"}{showCost && i.cost_price != null ? <span className="text-muted"> · {formatUsd(i.cost_price)}</span> : null} <span className="text-muted">/ {i.unit}</span></div>
                  {websiteOn && i.kind === "service" && <div className="text-xs text-muted">🌐 {i.show_on_website ? (i.quote_only ? t("catalog.quote_only") : i.from_price != null ? formatUsd(i.from_price) : "—") : "✕"}</div>}
                </div>
                {edit && <div className="flex flex-col items-end">
                  <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(i)} />
                  <RowAction icon={<Power size={16} />} label={i.is_active ? t("app.deactivate") : t("app.activate")} onClick={() => setToggle(i)} />
                </div>}
              </li>
            ))}
          </ul>
          <div className="hidden md:block overflow-x-auto -mx-4 px-4">
            <table className="table">
              <thead><tr><th>{t("catalog.code")}</th><th>{t("catalog.name")}</th><th>{t("catalog.kind")}</th><th>{websiteOn ? t("catalog.web_category") : t("catalog.category")}</th><th>{t("catalog.unit")}</th><th className="text-right">{t("catalog.duration")}</th><th className="text-right">{t("catalog.sell_price")}</th>{showCost && <th className="text-right">{t("catalog.cost_price")}</th>}{websiteOn && <th className="text-right">{t("catalog.from_price")}</th>}{edit && <th className="text-right">{t("app.actions")}</th>}</tr></thead>
              <tbody>
                {filtered.map((i) => (
                  <tr key={i.id} className={i.is_active ? "" : "opacity-60"}>
                    <td className="tabular text-xs">{i.code ?? "—"}</td>
                    <td><div className="font-semibold">{i.name_km}{i.is_sample && <span className="ml-2"><Badge tone="warning">{t("catalog.sample")}</Badge></span>}</div>{i.name_en && <div className="text-xs text-muted">{i.name_en}</div>}</td>
                    <td><Badge tone={i.kind === "service" ? "blue" : "grey"}>{t(`catalog.kind_${i.kind}`)}</Badge></td>
                    <td>{websiteOn ? (webCat(i.web_category) ?? "—") : t(`category.${i.category}`)}</td>
                    <td>{i.unit}</td>
                    <td className="text-right tabular">{i.kind === "service" ? i.duration_min : "—"}</td>
                    <td className="text-right tabular">{i.sell_price != null ? formatUsd(i.sell_price) : "—"}</td>
                    {showCost && <td className="text-right tabular text-muted">{i.cost_price != null ? formatUsd(i.cost_price) : "—"}</td>}
                    {websiteOn && <td className="text-right tabular">{i.kind !== "service" ? "" : !i.show_on_website ? "✕" : i.quote_only ? t("catalog.quote_only") : i.from_price != null ? formatUsd(i.from_price) : "—"}</td>}
                    {edit && <td className="text-right whitespace-nowrap">
                      <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(i)} />
                      <RowAction icon={<Power size={16} />} label={i.is_active ? t("app.deactivate") : t("app.activate")} onClick={() => setToggle(i)} />
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </Card>
      {editing && <ItemDialog item={editing === "new" ? null : editing} showCost={showCost} websiteOn={websiteOn} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} loading={act.isPending} danger={toggle?.is_active}
        title={toggle?.is_active ? t("catalog.deactivate") : t("catalog.activate")} text={toggle?.name_km ?? ""} onConfirm={() => toggle && act.mutate(toggle)} />
      {preview && <PreviewDialog preview={preview.result} loading={apply.isPending} onClose={() => setPreview(null)} onApply={() => apply.mutate()} />}
    </div>
  );
}

/** a changed field in the words of the screen (D-89): its own label, dollars (not cents), yes / no, the category's name */
const FIELD_LABEL: Record<string, string> = { name_km: "catalog.name_km", name_en: "catalog.name_en", web_category: "catalog.web_category", unit: "catalog.unit",
  from_price: "catalog.from_price", duration_min: "catalog.duration", show_on_website: "catalog.show_on_website", quote_only: "catalog.quote_only", is_active: "app.active" };

function PreviewDialog({ preview, loading, onClose, onApply }: { preview: CatalogPreview; loading: boolean; onClose: () => void; onApply: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const c = preview.counts, blocked = c.error > 0 || preview.file_errors.length > 0, nothing = !blocked && c.new + c.changed === 0;
  const errText = (e: string) => { const [code, col] = e.split(":"); return t(`catalog.import_err.${code}`, { col, defaultValue: e }); };
  const value = (k: string, v: unknown) => v == null || v === "" ? "—" : k === "from_price" ? formatUsd(Number(v), lang) : typeof v === "boolean" ? t(v ? "app.yes" : "app.no")
    : k === "web_category" ? WEB_CATEGORY_LABEL[v as WebCategory]?.[lang] ?? String(v) : String(v);
  return (
    <Dialog open onClose={onClose} title={t("catalog.preview_title")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" disabled={blocked || nothing} loading={loading} onClick={onApply} data-testid="cat-apply">{t("catalog.apply")}</Button>
    </>}>
      <p className="text-sm font-semibold mb-1" data-testid="cat-counts">{t("catalog.preview_counts", c)}</p>
      <p className="text-xs text-muted mb-3">{blocked ? t("catalog.fix_first") : nothing ? t("catalog.nothing") : t("catalog.import_hint")}</p>
      {preview.file_errors.map((e) => <p key={e} className="text-sm text-danger">{errText(e)}</p>)}
      <ul className="divide-y divide-grey-line text-sm max-h-[50vh] overflow-y-auto">
        {preview.rows.filter((r) => r.action !== "same").map((r) => (
          <li key={r.row} className="py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">{t("catalog.row")} {r.row}</span>
              <Badge tone={r.action === "error" ? "danger" : r.action === "new" ? "green" : "blue"}>{t(`catalog.action.${r.action}`)}</Badge>
              <span className="tabular text-xs">{r.code}</span><span className="font-semibold break-words min-w-0">{r.name}</span>
            </div>
            {r.errors.length > 0 && <div className="text-xs text-danger">{r.errors.map(errText).join(" · ")}</div>}
            {Object.entries(r.changes).map(([k, [a, b]]) => <div key={k} className="text-xs text-muted break-words" data-testid="cat-change">{FIELD_LABEL[k] ? t(FIELD_LABEL[k]) : k}: {value(k, a)} → {value(k, b)}</div>)}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}

function ItemDialog({ item, showCost, websiteOn, onClose }: { item: CatalogItem | null; showCost: boolean; websiteOn: boolean; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const qc = useQueryClient();
  const [sell, setSell] = useState(item?.sell_price != null ? String(fromCents(item.sell_price)) : "");
  const [cost, setCost] = useState(item?.cost_price != null ? String(fromCents(item.cost_price)) : "");
  const [duration, setDuration] = useState(String(item?.duration_min ?? 120)); // R3: a new service starts at 120 min (the shop edits it)
  const [code, setCode] = useState(item?.code ?? "");
  const [webCategory, setWebCategory] = useState<string>(item?.web_category ?? "");
  const [fromPrice, setFromPrice] = useState(item?.from_price != null ? String(fromCents(item.from_price)) : "");
  const [shown, setShown] = useState(item?.show_on_website ?? true);
  const [quoteOnly, setQuoteOnly] = useState(item?.quote_only ?? false);
  const remindersOn = useFeature("reminders");
  const can = useAuth((s) => s.can);
  const acctOn = useFeature("accounting") && can("accounting.view"); // D-92: the income account the item posts to
  const accounts = useQuery({ queryKey: ["acct-accounts"], queryFn: api.accounting.accounts, enabled: acctOn });
  const [incomeAcc, setIncomeAcc] = useState(item?.income_account_id ?? "");
  const [remind, setRemind] = useState(item?.reminder_months ? String(item.reminder_months) : "");
  const { register, handleSubmit, watch, formState: { errors, isSubmitting } } = useForm<CatalogItemInput>({
    resolver: zodResolver(catalogItemSchema.omit({ sell_price: true, cost_price: true, duration_min: true, code: true, web_category: true, from_price: true, show_on_website: true, quote_only: true })),
    defaultValues: item ? { name_km: item.name_km, name_en: item.name_en ?? "", kind: item.kind, category: item.category, unit: item.unit } : { name_km: "", name_en: "", kind: "service", category: "mep", unit: "" },
  });
  const service = watch("kind") === "service";
  const submit = handleSubmit(async (v) => {
    let sellC: number, costC: number | null, fromC: number | null;
    try {
      sellC = toCents(sell || 0); costC = showCost && cost !== "" ? toCents(cost) : null; fromC = fromPrice.trim() === "" ? null : toCents(fromPrice);
    } catch { return toast.error(t("catalog.err_price")); }
    if (sellC < 0 || (costC != null && costC < 0) || (fromC != null && fromC < 0)) return toast.error(t("catalog.err_price"));
    const mins = Number(duration);
    const months = remind.trim() === "" ? null : Number(remind);
    if (months !== null && (!Number.isInteger(months) || months < 1 || months > 60)) return toast.error(t("catalog.err_remind"));
    if (v.kind === "service" && (!Number.isInteger(mins) || mins < 15 || mins > 1440)) return toast.error(t("booking.err.DURATION_RANGE"));
    try {
      await api.upsertCatalogItem({ id: item?.id, name_km: v.name_km, name_en: v.name_en || null, kind: v.kind, category: v.category, unit: v.unit || null, sell_price: sellC, cost_price: costC, duration_min: v.kind === "service" ? mins : undefined,
        reminder_months: remindersOn && v.kind === "service" ? months : undefined, income_account_id: acctOn ? incomeAcc || null : undefined, code: code.trim().toUpperCase() || null,
        ...(websiteOn && v.kind === "service" ? { web_category: (webCategory || null) as WebCategory | null, from_price: fromC, show_on_website: shown, quote_only: quoteOnly } : {}) });
      void qc.invalidateQueries({ queryKey: ["catalog"] });
      toast.success(t("app.saved"));
      onClose();
    } catch (e) {
      toast.error(t(`catalog.import_err.${errCode(e)}`, { defaultValue: t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") }) }));
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
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3">
          <Field label={t("catalog.code")}><Input value={code} maxLength={20} onChange={(e) => setCode(e.target.value.toUpperCase())} data-testid="cat-code" /></Field>
          <Field label={t("catalog.kind")}><Select {...register("kind")}><option value="service">{t("catalog.kind_service")}</option><option value="product">{t("catalog.kind_product")}</option></Select></Field>
          <Field label={t("catalog.category")}><Select {...register("category")}>{SERVICE_CATEGORIES.map((c) => <option key={c} value={c}>{t(`category.${c}`)}</option>)}</Select></Field>
          <Field label={t("catalog.unit")}><Input placeholder={t("catalog.unit_ph")} {...register("unit")} /></Field>
        </div>
        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t("catalog.sell_price") + " ($)"} required><Input inputMode="decimal" name="sell_price" value={sell} onChange={(e) => setSell(e.target.value)} /></Field>
          {showCost && <Field label={t("catalog.cost_price") + " ($)"}><Input inputMode="decimal" name="cost_price" value={cost} onChange={(e) => setCost(e.target.value)} /></Field>}
        </div>
        {service && (
          <Field label={t("catalog.duration")} hint={t("catalog.duration_hint")}><Input inputMode="numeric" type="number" min={15} max={1440} step={15} name="duration_min" value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        )}
        {websiteOn && service && (
          <div className="rounded-md border border-grey-line p-3 mb-3">
            <div className="grid grid-cols-2 gap-x-3">
              <Field label={t("catalog.web_category")}>
                <Select value={webCategory} onChange={(e) => setWebCategory(e.target.value)} data-testid="cat-webcat">
                  <option value="">{t("catalog.web_none")}</option>
                  {WEB_CATEGORIES.map((c) => <option key={c} value={c}>{WEB_CATEGORY_LABEL[c][lang]}</option>)}
                </Select>
              </Field>
              <Field label={t("catalog.from_price")} hint={t("catalog.from_hint")}><Input inputMode="decimal" value={fromPrice} onChange={(e) => setFromPrice(e.target.value)} disabled={quoteOnly} data-testid="cat-from" /></Field>
            </div>
            <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={shown} onChange={(e) => setShown(e.target.checked)} data-testid="cat-shown" /> {t("catalog.show_on_website")}</label>
            <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={quoteOnly} onChange={(e) => setQuoteOnly(e.target.checked)} data-testid="cat-quote" /> {t("catalog.quote_only")}</label>
          </div>
        )}
        {remindersOn && service && (
          <Field label={t("catalog.remind")} hint={t("catalog.remind_hint")}><Input inputMode="numeric" type="number" min={1} max={60} name="reminder_months" value={remind} onChange={(e) => setRemind(e.target.value)} placeholder="—" data-testid="remind-months" /></Field>
        )}
        {acctOn && (
          <Field label={t("catalog.income_account")}>
            <Select value={incomeAcc} onChange={(e) => setIncomeAcc(e.target.value)} data-testid="income-account">
              <option value="">{t("catalog.income_account_default")}</option>
              {(accounts.data ?? []).filter((a) => a.type === "income" && a.is_active).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name_km}</option>)}
            </Select>
          </Field>
        )}
      </form>
    </Dialog>
  );
}
