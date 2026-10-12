// Customer address (CEO 12-10, D-137): house no., street no., borey project, province → khan / district → sangkat / commune →
// village from the official gazetteer (each list filtered by the one above), GPS stays next to it in the dialog. A new
// customer starts in Phnom Penh → Khan Chbar Ampov; choosing a borey fills its province / khan / sangkat (still editable).
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { geoLabel } from "@sms/shared";
import { api, type GeoUnitRow } from "@/lib/api";
import { useGeo, type AddressValue } from "./geo";
import { Field, Input, Select } from "@/components/ui";

export function AddressFields({ value, onChange, required, showErrors, boreysLink = true }: {
  value: AddressValue; onChange: (v: AddressValue) => void; required: boolean; showErrors: boolean; boreysLink?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const lang = i18n.language === "en" ? "en" : "km";
  const provinces = useGeo("");
  const districts = useGeo(value.province_code, !!value.province_code);
  const communes = useGeo(value.district_code, !!value.district_code);
  const villages = useGeo(value.commune_code, !!value.commune_code);
  const boreys = useQuery({ queryKey: ["boreys"], queryFn: () => api.boreys.list() });
  const set = (p: Partial<AddressValue>) => onChange({ ...value, ...p });
  const opts = (list: GeoUnitRow[] | undefined) => (list ?? []).map((u) => <option key={u.code} value={u.code}>{geoLabel(u, lang)}</option>);
  const missing = (v: string) => showErrors && required && !v ? t("app.required") : undefined;
  const pickBorey = (id: string) => {
    const b = (boreys.data ?? []).find((x) => x.id === id);
    if (!b) return set({ borey_id: "" });
    onChange({ ...value, borey_id: b.id, province_code: b.province_code, district_code: b.district_code, commune_code: b.commune_code ?? "", village_code: b.commune_code && b.commune_code === value.commune_code ? value.village_code : "" });
  };
  return (
    <div data-testid="address-fields">
      <div className="grid grid-cols-2 gap-x-3">
        <Field label={t("customers.house_no")}><Input name="house_no" maxLength={40} value={value.house_no} onChange={(e) => set({ house_no: e.target.value })} /></Field>
        <Field label={t("customers.street")}><Input name="street" maxLength={80} value={value.street} onChange={(e) => set({ street: e.target.value })} /></Field>
      </div>
      <Field label={t("customers.borey")} hint={t("customers.borey_hint")}>
        <div className="flex gap-2 items-center">
          <Select name="borey_id" value={value.borey_id} onChange={(e) => pickBorey(e.target.value)} className="flex-1">
            <option value="">{t("customers.borey_none")}</option>
            {(boreys.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
          {boreysLink && <Link to="/customers/boreys" className="text-sm text-blue underline whitespace-nowrap min-h-[44px] inline-flex items-center px-1">{t("customers.boreys")}</Link>}
        </div>
      </Field>
      <div className="grid sm:grid-cols-2 gap-x-3">
        <Field label={t("customers.province")} required={required} error={missing(value.province_code)}>
          <Select name="province_code" value={value.province_code} invalid={!!missing(value.province_code)}
            onChange={(e) => set({ province_code: e.target.value, district_code: "", commune_code: "", village_code: "" })}>
            <option value="">{t("customers.pick")}</option>{opts(provinces.data)}
          </Select>
        </Field>
        <Field label={t("customers.district")} required={required} error={missing(value.district_code)}>
          <Select name="district_code" value={value.district_code} disabled={!value.province_code} invalid={!!missing(value.district_code)}
            onChange={(e) => set({ district_code: e.target.value, commune_code: "", village_code: "" })}>
            <option value="">{t("customers.pick")}</option>{opts(districts.data)}
          </Select>
        </Field>
        <Field label={t("customers.commune")} required={required} error={missing(value.commune_code)}>
          <Select name="commune_code" value={value.commune_code} disabled={!value.district_code} invalid={!!missing(value.commune_code)}
            onChange={(e) => set({ commune_code: e.target.value, village_code: "" })}>
            <option value="">{t("customers.pick")}</option>{opts(communes.data)}
          </Select>
        </Field>
        <Field label={t("customers.village")}>
          <Select name="village_code" value={value.village_code} disabled={!value.commune_code} onChange={(e) => set({ village_code: e.target.value })}>
            <option value="">{t("customers.pick")}</option>{opts(villages.data)}
          </Select>
        </Field>
      </div>
    </div>
  );
}
