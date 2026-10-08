// Settings → Website (flag "website", D-95): the texts and photos of the shop's public page. Empty fields hide their section;
// name / phone / address are the company's public details (the invoice prints the same). Photos here are public.
// D-106 (CEO): the online booking hours with a lunch break (the same time twice = none) and the days between two promotions per customer.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, ImagePlus, Trash2 } from "lucide-react";
import { PROMO_GAP_DAYS_DEFAULT, webHours, type WebHours } from "@sms/shared";
import { api, errCode } from "@/lib/api";
import { Button, Card, Field, Input, Skeleton } from "@/components/ui";
import { compressPhoto } from "@/lib/offline";
import { toast } from "@/lib/toast";

const INFO = ["name_km", "name_en", "phone", "address"] as const;
const TEXTS = ["short_name", "tagline_km", "tagline_en", "about_km", "about_en", "highlights_km", "highlights_en", "area_km", "area_en", "hours_km", "hours_en", "facebook"] as const;
const AREA = new Set(["about_km", "about_en", "highlights_km", "highlights_en"]);
type Key = (typeof INFO)[number] | (typeof TEXTS)[number];

export default function WebsiteCard() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["website"], queryFn: api.website.get });
  const [f, setF] = useState<Record<Key, string> | null>(null);
  const [published, setPublished] = useState(false);
  const [hours, setHours] = useState<WebHours | null>(null);
  const [gap, setGap] = useState(String(PROMO_GAP_DAYS_DEFAULT));
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!q.data || f) return;
    const w = q.data.website as Record<string, unknown>, info = q.data.company_info;
    const init = {} as Record<Key, string>;
    for (const k of INFO) init[k] = info[k] ?? "";
    for (const k of TEXTS) init[k] = Array.isArray(w[k]) ? (w[k] as string[]).join("\n") : typeof w[k] === "string" ? (w[k] as string) : "";
    setF(init); setPublished(w.published === true);
    setHours(webHours(w.hours as Partial<WebHours> | undefined)); setGap(String(typeof w.promo_gap_days === "number" ? w.promo_gap_days : PROMO_GAP_DAYS_DEFAULT));
  }, [q.data, f]);
  const onErr = (e: unknown) => toast.error(t(`website.err.${errCode(e)}`, { defaultValue: t("app.error") }));
  const save = useMutation({
    mutationFn: () => {
      const lines = (v: string) => v.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 6);
      const body: Record<string, unknown> = { published, ...(hours ? { hours } : {}), promo_gap_days: Math.min(60, Math.max(1, Number(gap) || PROMO_GAP_DAYS_DEFAULT)) };
      for (const k of [...INFO, ...TEXTS]) body[k] = k.startsWith("highlights_") ? lines(f![k]) : f![k].trim();
      return api.website.save(body);
    },
    onSuccess: () => { toast.success(t("app.saved")); void qc.invalidateQueries({ queryKey: ["website"] }); },
    onError: onErr,
  });
  const upload = async (slot: "hero" | "gallery", file: File | undefined) => {
    if (!file) return;
    setBusy(slot);
    try { await api.website.addPhoto(slot, await compressPhoto(file)); void qc.invalidateQueries({ queryKey: ["website"] }); toast.success(t("app.saved")); }
    catch (e) { onErr(e); } finally { setBusy(null); }
  };
  const remove = useMutation({ mutationFn: (id: string) => api.website.removePhoto(id), onSuccess: () => void qc.invalidateQueries({ queryKey: ["website"] }), onError: onErr });
  if (q.isLoading || !q.data || !f) return <Card title={t("website.title")}><Skeleton /></Card>;
  const w = q.data.website;
  const field = (k: Key) => (
    <Field key={k} label={t(`website.${k}`)}>
      {AREA.has(k)
        ? <textarea className="input h-24 py-2" value={f[k]} maxLength={1200} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`web-${k}`} />
        : <Input value={f[k]} maxLength={300} onChange={(e) => setF({ ...f, [k]: e.target.value })} data-testid={`web-${k}`} />}
    </Field>
  );
  const photo = (id: string) => (
    <div key={id} className="relative">
      <img src={`/pub/img/${id}`} alt="" className="h-24 w-32 object-cover rounded-md border border-grey-line" />
      <button type="button" className="absolute top-1 right-1 min-h-[32px] min-w-[32px] grid place-items-center rounded bg-white/90 text-danger" aria-label={t("website.remove")} onClick={() => remove.mutate(id)}><Trash2 size={14} /></button>
    </div>
  );
  const picker = (slot: "hero" | "gallery") => (
    <label className="btn-secondary cursor-pointer">
      <ImagePlus size={16} /> {busy === slot ? t("app.loading") : t("website.add_photo")}
      <input type="file" accept="image/*" className="sr-only" disabled={!!busy} onChange={(e) => { void upload(slot, e.target.files?.[0]); e.target.value = ""; }} data-testid={`web-photo-${slot}`} />
    </label>
  );
  return (
    <Card title={t("website.title")} actions={<a className="btn-secondary" href="/" target="_blank" rel="noreferrer" data-testid="web-view"><ExternalLink size={16} /> {t("website.view")}</a>}>
      <p className="text-xs text-muted mb-3">{t("website.hint")}</p>
      <div className="grid sm:grid-cols-2 gap-x-3">{INFO.map(field)}</div>
      <div className="grid sm:grid-cols-2 gap-x-3">{TEXTS.map(field)}</div>
      <h3 className="text-sm font-semibold mt-2 mb-2">{t("website.hero")}</h3>
      <div className="flex flex-wrap items-center gap-3 mb-3">{w.hero && photo(w.hero)}{picker("hero")}</div>
      <h3 className="text-sm font-semibold mb-2">{t("website.gallery")}</h3>
      <div className="flex flex-wrap items-center gap-3 mb-3">{(w.gallery ?? []).map(photo)}{(w.gallery ?? []).length < 12 && picker("gallery")}</div>
      {hours && <>
        <h3 className="text-sm font-semibold mt-2 mb-1">{t("website.hours_title")}</h3>
        <p className="text-xs text-muted mb-2">{t("website.hours_hint")}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-3">
          {(["open", "close", "lunch_start", "lunch_end"] as const).map((k) => (
            <Field key={k} label={t(`website.${k}`)}><Input type="time" step={1800} value={hours[k]} onChange={(e) => setHours({ ...hours, [k]: e.target.value.slice(0, 5) })} data-testid={`web-hours-${k}`} /></Field>
          ))}
        </div>
      </>}
      <div className="grid sm:grid-cols-2 gap-x-3"><Field label={t("website.promo_gap")}><Input type="number" inputMode="numeric" min={1} max={60} value={gap} onChange={(e) => setGap(e.target.value)} data-testid="web-promo-gap" /></Field></div>
      <label className="flex items-center gap-2 text-sm min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={published} onChange={(e) => setPublished(e.target.checked)} data-testid="web-published" /> {t("website.published")}</label>
      <div className="flex justify-end"><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()} data-testid="web-save">{t("app.save")}</Button></div>
    </Card>
  );
}
