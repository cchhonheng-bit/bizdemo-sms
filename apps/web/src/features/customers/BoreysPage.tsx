// «គម្រោងបុរី» (CEO 12-10, D-137): the shop's own borey list — name + province / khan / sangkat (official gazetteer). CEO / GM /
// Admin add and edit; a borey is turned off, never deleted (its customers keep it). Choosing it on a customer fills the area.
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { geoLabel } from "@sms/shared";
import { ArrowLeft, Pencil, Plus, Power } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { api, errCode, type Borey } from "@/lib/api";
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, Input, RowAction, Select, Skeleton } from "@/components/ui";
import { toast } from "@/lib/toast";
import { useGeo } from "./geo";

export default function BoreysPage() {
  const { t, i18n } = useTranslation();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [all, setAll] = useState(false);
  const [editing, setEditing] = useState<Borey | "new" | null>(null);
  const [toggle, setToggle] = useState<Borey | null>(null);
  const list = useQuery({ queryKey: ["boreys", all ? "all" : "active"], queryFn: () => api.boreys.list(all) });
  const act = useMutation({
    mutationFn: (b: Borey) => api.boreys.active(b.id, !b.is_active),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["boreys"] }); toast.success(t("app.saved")); setToggle(null); },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const en = i18n.language === "en";
  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-center justify-between mb-2 gap-3">
        <h1 className="flex items-center gap-2"><button type="button" className="tap-target" aria-label={t("customers.title")} onClick={() => nav("/customers")}><ArrowLeft size={20} /></button>{t("boreys.title")}</h1>
        <Button variant="primary" onClick={() => setEditing("new")} data-testid="borey-new"><Plus size={16} /> {t("boreys.new")}</Button>
      </div>
      <p className="text-sm text-muted mb-4">{t("boreys.hint")}</p>
      <Card>
        <label className="flex items-center gap-2 text-sm !mb-3 !text-ink min-h-[44px]"><input type="checkbox" className="h-5 w-5" checked={all} onChange={(e) => setAll(e.target.checked)} /> {t("boreys.show_off")}</label>
        {list.isLoading ? <Skeleton /> : list.isError ? <ErrorState text={t("app.error")} onRetry={() => void list.refetch()} /> : !list.data?.length ? <Empty text={t("boreys.empty")} /> : (
          <table className="table table-stack" data-testid="borey-table">
            <thead><tr><th>{t("boreys.name")}</th><th>{t("customers.area")}</th><th>{t("boreys.customers")}</th><th className="text-right">{t("app.actions")}</th></tr></thead>
            <tbody>
              {list.data.map((b) => (
                <tr key={b.id} className={b.is_active ? "" : "opacity-60"} data-testid="borey-row">
                  <td className="font-semibold">{b.name}{!b.is_active && <Badge tone="danger">{t("boreys.off_badge")}</Badge>}</td>
                  <td className="text-sm">{en ? b.area_en : b.area_km}</td>
                  <td className="tabular">{b.customers}</td>
                  <td className="text-right whitespace-nowrap cell-actions">
                    <RowAction icon={<Pencil size={16} />} label={t("app.edit")} onClick={() => setEditing(b)} />
                    <RowAction icon={<Power size={16} />} label={b.is_active ? t("boreys.off") : t("boreys.on")} onClick={() => setToggle(b)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {editing && <BoreyDialog borey={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog open={!!toggle} onClose={() => setToggle(null)} loading={act.isPending} danger={toggle?.is_active}
        title={toggle?.is_active ? t("boreys.off") : t("boreys.on")} text={toggle?.is_active ? `${toggle.name} — ${t("boreys.off_confirm")}` : toggle?.name ?? ""} onConfirm={() => toggle && act.mutate(toggle)} />
    </div>
  );
}

function BoreyDialog({ borey, onClose }: { borey: Borey | null; onClose: () => void }) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const qc = useQueryClient();
  const [name, setName] = useState(borey?.name ?? "");
  const [province, setProvince] = useState(borey?.province_code ?? "12");
  const [district, setDistrict] = useState(borey?.district_code ?? "1212");
  const [commune, setCommune] = useState(borey?.commune_code ?? "");
  const [tried, setTried] = useState(false);
  const provinces = useGeo(""), districts = useGeo(province, !!province), communes = useGeo(district, !!district);
  const save = useMutation({
    mutationFn: () => api.boreys.save(borey?.id ?? null, { name: name.trim(), province_code: province, district_code: district, commune_code: commune || null }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["boreys"] }); void qc.invalidateQueries({ queryKey: ["customers"] }); toast.success(t("app.saved")); onClose(); },
    onError: (e) => toast.error(t(`booking.err.${errCode(e)}`, { defaultValue: t("app.error") })),
  });
  const ok = name.trim() && province && district;
  return (
    <Dialog open onClose={onClose} title={borey ? t("app.edit") : t("boreys.new")} footer={<>
      <Button onClick={onClose}>{t("app.cancel")}</Button>
      <Button variant="primary" loading={save.isPending} onClick={() => { setTried(true); if (ok) save.mutate(); }} data-testid="borey-save">{t("app.save")}</Button>
    </>}>
      <Field label={t("boreys.name")} required error={tried && !name.trim() ? t("app.required") : undefined}><Input name="borey_name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      <Field label={t("customers.province")} required>
        <Select name="borey_province" value={province} onChange={(e) => { setProvince(e.target.value); setDistrict(""); setCommune(""); }}>
          <option value="">{t("customers.pick")}</option>{(provinces.data ?? []).map((u) => <option key={u.code} value={u.code}>{geoLabel(u, lang)}</option>)}
        </Select>
      </Field>
      <Field label={t("customers.district")} required error={tried && !district ? t("app.required") : undefined}>
        <Select name="borey_district" value={district} disabled={!province} onChange={(e) => { setDistrict(e.target.value); setCommune(""); }}>
          <option value="">{t("customers.pick")}</option>{(districts.data ?? []).map((u) => <option key={u.code} value={u.code}>{geoLabel(u, lang)}</option>)}
        </Select>
      </Field>
      <Field label={t("customers.commune")}>
        <Select name="borey_commune" value={commune} disabled={!district} onChange={(e) => setCommune(e.target.value)}>
          <option value="">{t("customers.pick")}</option>{(communes.data ?? []).map((u) => <option key={u.code} value={u.code}>{geoLabel(u, lang)}</option>)}
        </Select>
      </Field>
    </Dialog>
  );
}
