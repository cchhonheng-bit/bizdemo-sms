import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { companySettingsSchema, toCents, type CompanySettingsInput } from "@sms/shared";
import { supabase } from "@/lib/supabase";
import { Button, Card, Field, Input, Select, Skeleton, ErrorState } from "@/components/ui";
import { toast } from "@/lib/toast";

type Settings = CompanySettingsInput & { company_id: string; telegram_group_chat_id: number | null };
type Vehicle = { id: string; code: string; plate: string | null; owner_user_id: string | null; is_active: boolean };
type UserBasic = { id: string; full_name: string; role: string; is_active: boolean };

export default function CompanySettingsPage() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const settings = useQuery({
    queryKey: ["company_settings"],
    queryFn: async () => {
      const { data, error } = await supabase.from("company_settings").select("*").single();
      if (error) throw error;
      const d = data as Settings & { discount_approval_limit: number };
      return { ...d, work_start: String(d.work_start).slice(0, 5), work_end: String(d.work_end).slice(0, 5) };
    },
  });
  const vehicles = useQuery({ queryKey: ["vehicles"], queryFn: async () => { const { data, error } = await supabase.from("vehicles").select("*").order("code"); if (error) throw error; return data as Vehicle[]; } });
  const users = useQuery({ queryKey: ["users_basic"], queryFn: async () => { const { data, error } = await supabase.from("users_basic").select("*").eq("is_active", true).order("full_name"); if (error) throw error; return data as UserBasic[]; } });

  const form = useForm<CompanySettingsInput>({ resolver: zodResolver(companySettingsSchema) });
  const { register, handleSubmit, reset, watch, setValue, formState: { errors, isSubmitting } } = form;
  useEffect(() => {
    if (settings.data) {
      const d = settings.data;
      reset({ work_start: d.work_start, work_end: d.work_end, work_days: d.work_days, office_lat: d.office_lat, office_lng: d.office_lng,
        geofence_m: d.geofence_m, out_of_range_m: d.out_of_range_m, fx_rate_khr: Number(d.fx_rate_khr), discount_approval_limit: d.discount_approval_limit / 100,
        late_alert_min: d.late_alert_min, telegram_group_chat_id: d.telegram_group_chat_id == null ? "" : String(d.telegram_group_chat_id), invoice_prefix: d.invoice_prefix });
    }
  }, [settings.data, reset]);
  const workDays = watch("work_days") ?? [];

  const save = handleSubmit(async (v) => {
    const { error } = await supabase.rpc("update_company_settings", { p_patch: { ...v, discount_approval_limit: toCents(v.discount_approval_limit), telegram_group_chat_id: v.telegram_group_chat_id || null } });
    if (error) return toast.error(t("app.error"));
    toast.success(t("app.saved"));
    void qc.invalidateQueries({ queryKey: ["company_settings"] });
  });

  const upsertVehicle = useMutation({
    mutationFn: async (v: { id: string | null; code: string; plate: string; owner: string | null; active: boolean }) => {
      const { error } = await supabase.rpc("upsert_vehicle", { p_id: v.id, p_code: v.code, p_plate: v.plate || null, p_owner: v.owner, p_active: v.active });
      if (error) throw error;
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
                <label key={d} className={`px-3 py-1.5 rounded-full border text-sm cursor-pointer ${workDays.includes(d) ? "bg-navy text-white border-navy" : "border-grey-line"}`}>
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
            <Field label={t("settings.telegram_group")} error={errors.telegram_group_chat_id?.message} hint="M2"><Input placeholder="-100…" {...register("telegram_group_chat_id")} /></Field>
          </div>
        </Card>
        <div className="flex justify-end"><Button type="submit" variant="primary" loading={isSubmitting}>{t("app.save")}</Button></div>
      </form>

      <Card title={t("settings.vehicles")}>
        <table className="table mb-3">
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
                <td><input type="checkbox" checked={v.is_active} onChange={(e) => upsertVehicle.mutate({ id: v.id, code: v.code, plate: v.plate ?? "", owner: v.owner_user_id, active: e.target.checked })} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex gap-2 items-end flex-wrap">
          <Field label={t("settings.vehicle_code")}><Input className="w-24" value={newV.code} onChange={(e) => setNewV({ ...newV, code: e.target.value })} /></Field>
          <Field label={t("settings.plate")}><Input className="w-36" value={newV.plate} onChange={(e) => setNewV({ ...newV, plate: e.target.value })} /></Field>
          <Field label={t("settings.owner")}><Select value={newV.owner} onChange={(e) => setNewV({ ...newV, owner: e.target.value })}><option value="">—</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</Select></Field>
          <Button className="mb-3" disabled={!newV.code} loading={upsertVehicle.isPending} onClick={() => { upsertVehicle.mutate({ id: null, code: newV.code, plate: newV.plate, owner: newV.owner || null, active: true }); setNewV({ code: "", plate: "", owner: "" }); }}>{t("settings.add_vehicle")}</Button>
        </div>
      </Card>
    </div>
  );
}
