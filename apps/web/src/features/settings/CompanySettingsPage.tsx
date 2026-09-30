import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { companySettingsSchema, toCents, type CompanySettingsInput } from "@sms/shared";
import { Badge, Button, Card, Field, Input, Select, Skeleton, ErrorState } from "@/components/ui";
import { Copy, ImageUp, Plus, Send } from "lucide-react";
import { api, errCode } from "@/lib/api";
import { toast } from "@/lib/toast";

type Settings = CompanySettingsInput & { company_id: string; telegram_group_chat_id: number | null; telegram_group_title?: string | null };

export default function CompanySettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => {
      const data = await api.settings();
      if (!data) throw new Error("NOT_FOUND");
      const d = data as unknown as Settings & { discount_approval_limit: number };
      return { ...d, work_start: String(d.work_start).slice(0, 5), work_end: String(d.work_end).slice(0, 5) };
    },
  });
  const vehicles = useQuery({ queryKey: ["vehicles", "all"], queryFn: api.vehiclesAll });
  const users = useQuery({ queryKey: ["users_basic"], queryFn: api.usersBasic });

  const form = useForm<CompanySettingsInput>({ resolver: zodResolver(companySettingsSchema) });
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = form;
  useEffect(() => {
    if (settings.data) {
      const d = settings.data;
      reset({ work_start: d.work_start, work_end: d.work_end, work_days: d.work_days, office_lat: d.office_lat, office_lng: d.office_lng,
        geofence_m: d.geofence_m, out_of_range_m: d.out_of_range_m, fx_rate_khr: Number(d.fx_rate_khr), discount_approval_limit: d.discount_approval_limit / 100,
        late_alert_min: d.late_alert_min, invoice_prefix: d.invoice_prefix });
    }
  }, [settings.data, reset]);
  const workDays = watch("work_days") ?? [];

  const save = handleSubmit(async (v) => {
    try {
      // the work group is set only through /register <code> in Telegram (v2.1) — never overwritten from this form
      const rest: Partial<CompanySettingsInput> = { ...v };
      delete rest.telegram_group_chat_id;
      await api.updateSettings({ ...rest, discount_approval_limit: toCents(v.discount_approval_limit) });
    } catch (e) { return toast.error(errCode(e) === "FORBIDDEN" ? t("app.error") : t("app.error")); }
    toast.success(t("app.saved"));
    void qc.invalidateQueries({ queryKey: ["company_settings"] });
  });

  const upsertVehicle = useMutation({
    mutationFn: async (v: { id: string | null; code: string; plate: string; owner: string | null; active: boolean }) => {
      await api.upsertVehicle({ id: v.id, code: v.code, plate: v.plate || null, owner: v.owner, active: v.active });
    },
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["vehicles"] }); toast.success(t("app.saved")); },
    onError: () => toast.error(t("app.error")),
  });
  const [newV, setNewV] = useState({ code: "", plate: "", owner: "" });

  if (settings.isLoading) return <Skeleton />;
  if (settings.isError) return <ErrorState text={t("app.error")} onRetry={() => void settings.refetch()} />;

  const num = (k: keyof CompanySettingsInput) => register(k, { valueAsNumber: true });

  return (
    <div className="space-y-4">
      <h1>{t("settings.title")}</h1>
      <form onSubmit={save} noValidate className="space-y-4">
        <Card title={t("settings.work_hours")}>
          <div className="grid grid-cols-2 gap-3 max-w-md">
            <Field label={t("settings.work_start")} error={errors.work_start?.message}><Input type="time" {...register("work_start")} /></Field>
            <Field label={t("settings.work_end")} error={errors.work_end?.message}><Input type="time" {...register("work_end")} /></Field>
          </div>
          <Field label={t("settings.work_days")} error={errors.work_days?.message}>
            <div className="flex flex-wrap gap-2">
              {[1, 2, 3, 4, 5, 6, 7].map((d) => (
                <label key={d} className={`px-3 min-h-[44px] min-w-[48px] justify-center inline-flex items-center rounded-full border text-sm cursor-pointer ${workDays.includes(d) ? "bg-navy text-white border-navy" : "border-grey-line"}`}>
                  <input type="checkbox" className="hidden" checked={workDays.includes(d)} onChange={(e) => setValue("work_days", e.target.checked ? [...workDays, d].sort() : workDays.filter((x) => x !== d), { shouldDirty: true })} />
                  {t(`settings.days.${d}`)}
                </label>
              ))}
            </div>
          </Field>
          <Field label={t("settings.late_alert")} error={errors.late_alert_min?.message}><Input type="number" className="max-w-[120px]" {...num("late_alert_min")} /></Field>
        </Card>

        <Card title={t("settings.office")}>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label={t("settings.lat")} error={errors.office_lat?.message}><Input type="number" step="any" {...register("office_lat", { setValueAs: (v) => (v === "" || v == null ? null : Number(v)) })} /></Field>
            <Field label={t("settings.lng")} error={errors.office_lng?.message}><Input type="number" step="any" {...register("office_lng", { setValueAs: (v) => (v === "" || v == null ? null : Number(v)) })} /></Field>
            <Field label={t("settings.geofence")} error={errors.geofence_m?.message}><Input type="number" {...num("geofence_m")} /></Field>
            <Field label={t("settings.out_of_range")} error={errors.out_of_range_m?.message}><Input type="number" {...num("out_of_range_m")} /></Field>
          </div>
        </Card>

        <Card title="Finance · Telegram">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Field label={t("settings.fx")} error={errors.fx_rate_khr?.message}><Input type="number" {...num("fx_rate_khr")} /></Field>
            <Field label={t("settings.discount_limit")} error={errors.discount_approval_limit?.message}><Input type="number" step="0.01" {...num("discount_approval_limit")} /></Field>
            <Field label={t("settings.invoice_prefix")} error={errors.invoice_prefix?.message}><Input {...register("invoice_prefix")} /></Field>
          </div>
        </Card>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={isSubmitting}>{t("app.save")}</Button></div>
      </form>

      <InvoiceImagesCard current={settings.data as unknown as Record<string, unknown> | undefined} />
      <TelegramGroupCard current={settings.data} />

      <Card title={t("settings.vehicles")}>
        <table className="table table-stack mb-3">
          <thead><tr><th>{t("settings.vehicle_code")}</th><th>{t("settings.plate")}</th><th>{t("settings.owner")}</th><th>{t("app.active")}</th></tr></thead>
          <tbody>
            {(vehicles.data ?? []).map((v) => (
              <tr key={v.id}>
                <td className="font-semibold">{v.code}</td>
                <td>{v.plate ?? "—"}</td>
                <td>
                  <Select value={v.owner_user_id ?? ""} onChange={(e) => upsertVehicle.mutate({ id: v.id, code: v.code, plate: v.plate ?? "", owner: e.target.value || null, active: v.is_active })}>
                    <option value="">—</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </Select>
                </td>
                <td><label className="tap-target !mb-0 cursor-pointer"><input type="checkbox" className="h-6 w-6" aria-label={t("app.active")} checked={v.is_active} onChange={(e) => upsertVehicle.mutate({ id: v.id, code: v.code, plate: v.plate ?? "", owner: v.owner_user_id, active: e.target.checked })} /></label></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 items-end flex-wrap">
          <Field label={t("settings.vehicle_code")}><Input className="w-24" value={newV.code} onChange={(e) => setNewV({ ...newV, code: e.target.value })} /></Field>
          <Field label={t("settings.plate")}><Input className="w-36" value={newV.plate} onChange={(e) => setNewV({ ...newV, plate: e.target.value })} /></Field>
          <Field label={t("settings.owner")}><Select value={newV.owner} onChange={(e) => setNewV({ ...newV, owner: e.target.value })}><option value="">—</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select></Field>
          <Button className="mb-3" disabled={!newV.code} loading={upsertVehicle.isPending} onClick={() => { upsertVehicle.mutate({ id: null, code: newV.code, plate: newV.plate, owner: newV.owner || null, active: true }); setNewV({ code: "", plate: "", owner: "" }); }}><Plus size={16} /> {t("settings.add_vehicle")}</Button>
        </div>
      </Card>

    </div>
  );
}

/** v2.1 (A3): the work group is registered with "/register ONETEAM-G-XXXXXX" (24 h, single use) — no chat ids typed by hand */
function TelegramGroupCard({ current }: { current?: { telegram_group_chat_id: number | null; telegram_group_title?: string | null } }) {
  const { t } = useTranslation();
  const [code, setCode] = useState<{ command: string; bot: string | null; expires_at: string } | null>(null);
  const make = useMutation({ mutationFn: api.telegramGroupCode, onSuccess: setCode, onError: () => toast.error(t("app.error")) });
  const copy = async () => {
    if (!code) return;
    try { await navigator.clipboard.writeText(code.command); toast.success(t("settings.copied")); } catch { /* clipboard blocked: the text stays selectable */ }
  };
  const set = current?.telegram_group_chat_id != null;
  return (
    <Card title={t("settings.tg_title")}>
      <p className="text-sm mb-3">{t("settings.tg_current")}: {set ? <Badge tone="green">{current?.telegram_group_title || String(current?.telegram_group_chat_id)}</Badge> : <Badge>{t("settings.tg_none")}</Badge>}</p>
      {code ? (
        <div className="space-y-2" data-testid="tg-group-code">
          <p className="text-sm text-muted">{t("settings.tg_steps", { bot: code.bot ?? "—" })}</p>
          <div className="flex gap-2 items-center flex-wrap">
            <code className="px-3 py-2 rounded bg-grey-bg border border-grey-line text-base font-semibold select-all">{code.command}</code>
            <Button onClick={() => void copy()}><Copy size={16} /> {t("settings.copy")}</Button>
          </div>
          <p className="text-xs text-muted">{t("settings.tg_expires")}: {new Date(code.expires_at).toLocaleString("en-GB")}</p>
        </div>
      ) : (
        <Button variant="primary" onClick={() => make.mutate()} loading={make.isPending} data-testid="tg-group-make"><Send size={16} /> {t("settings.tg_make_code")}</Button>
      )}
    </Card>
  );
}

/** FR-803 · BR-16: logo + the fixed ACLEDA QR printed on every invoice (kept lossless as PNG so the QR stays sharp) */
async function toPng(file: File, maxSide: number): Promise<string> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close();
  const png = canvas.toDataURL("image/png").split(",")[1]!;
  return png.length * 0.75 < 1_900_000 ? png : canvas.toDataURL("image/jpeg", 0.92).split(",")[1]!; // a camera photo can be too big as PNG (server limit 2 MB)
}
function InvoiceImagesCard({ current }: { current?: Record<string, unknown> }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [ver, setVer] = useState(0);
  const [busy, setBusy] = useState<"" | "logo" | "qr">("");
  const upload = async (kind: "logo" | "qr", file?: File) => {
    if (!file) return;
    setBusy(kind);
    try { await api.settingsImage(kind, await toPng(file, kind === "qr" ? 1000 : 600)); toast.success(t("app.saved")); setVer(Date.now()); void qc.invalidateQueries({ queryKey: ["company_settings"] }); }
    catch (e) { toast.error(t(`job.err.${errCode(e)}`, { defaultValue: t("app.error") })); }
    setBusy("");
  };
  const has = (k: string) => !!current?.[k] || ver > 0;
  return (
    <Card title={t("settings.invoice_images")}>
      <div className="grid grid-cols-2 gap-4">
        {([["logo", "logo_path", t("settings.logo")], ["qr", "qr_image_path", t("settings.acleda_qr")]] as const).map(([kind, key, label]) => (
          <div key={kind} className="flex flex-col items-start gap-2">
            <div className="text-sm font-semibold">{label}</div>
            {has(key) ? <img src={`/api/settings/image/${kind}?v=${ver}`} alt={label} className="h-28 w-28 object-contain border border-grey-line rounded" onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
              : <div className="h-28 w-28 border border-dashed border-grey-line rounded grid place-items-center text-xs text-muted">—</div>}
            <label className="btn-secondary cursor-pointer !mb-0"><ImageUp size={16} /> {busy === kind ? t("app.loading") : t("settings.upload")}
              <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" data-testid={`upload-${kind}`} onChange={(e) => { void upload(kind, e.target.files?.[0]); e.target.value = ""; }} /></label>
          </div>
        ))}
      </div>
    </Card>
  );
}
