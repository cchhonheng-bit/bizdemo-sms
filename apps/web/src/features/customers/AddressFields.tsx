// Customer address (CEO 12-10, D-137 · D-140): «ក្នុងបុរី» → borey project (fills province / khan / sangkat, still editable) + its
// zone («Zone B»); house no., street no., province → khan / district → sangkat / commune → village from the official gazetteer
// (each list filtered by the one above); the full address is built from these fields and only shown (read-only).
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { composeAddress, geoLabel, type GeoUnit } from "@sms/shared";
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
  const missing = (v: string) => (showErrors && required && !v ? t("app.required") : undefined);
  const pickBorey = (id: string) => {
    const b = (boreys.data ?? []).find((x) => x.id === id);
    if (!b) return set({ borey_id: "" });
    onChange({ ...value, borey_id: b.id, province_code: b.province_code, district_code: b.district_code, commune_code: b.commune_code ?? "", village_code: b.commune_code && b.commune_code === value.commune_code ? value.village_code : "" });
  };
  // the full address, as it will be saved (house, street, borey, zone, village, sangkat, khan, province)
  const unit = (list: GeoUnitRow[] | undefined, code: string) => (list ?? []).find((u) => u.code === code) as GeoUnit | undefined;
  const units = [unit(provinces.data, value.province_code), unit(districts.data, value.district_code), unit(communes.data, value.commune_code), unit(villages.data, value.village_code)].filter((u): u is GeoUnit => !!u);
  const borey = value.in_borey ? (boreys.data ?? []).find((b) => b.id === value.borey_id)?.name : null;
  const full = composeAddress({ house_no: value.house_no, street: value.street, borey, zone: value.in_borey ? value.borey_zone : null, units });
  return (
    <div data-testid="address-fields">
      <label className="flex items-center gap-3 !mb-2 !text-ink text-base min-h-[44px] cursor-pointer">
        <input type="checkbox" className="h-6 w-6 accent-navy" name="in_borey" checked={value.in_borey}
          onChange={(e) => set(e.target.checked ? { in_borey: true } : { in_borey: false, borey_id: "", borey_zone: "" })} />
        {t("customers.in_borey")}
      </label>
      {value.in_borey && (
        <div className="grid grid-cols-[1fr_120px] gap-x-3 pl-3 border-l-2 border-grey-line mb-1">
          <Field label={t("customers.borey")} hint={t("customers.borey_hint")}>
            <Select name="borey_id" value={value.borey_id} onChange={(e) => pickBorey(e.target.value)}>
              <option value="">{t("customers.borey_pick")}</option>
              {(boreys.data ?? []).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            {boreysLink && <Link to="/customers/boreys" className="text-xs text-blue underline inline-flex items-center min-h-[32px]">{t("customers.boreys")}</Link>}
          </Field>
          <Field label={t("customers.borey_zone")}><Input name="borey_zone" maxLength={40} value={value.borey_zone} placeholder="Zone B" onChange={(e) => set({ borey_zone: e.target.value })} /></Field>
        </div>
      )}
      <div className="grid grid-cols-2 gap-x-3">
        <Field label={t("customers.house_no")}><Input name="house_no" maxLength={40} value={value.house_no} onChange={(e) => set({ house_no: e.target.value })} /></Field>
        <Field label={t("customers.street")}><Input name="street" maxLength={80} value={value.street} onChange={(e) => set({ street: e.target.value })} /></Field>
      </div>
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
      <Field label={t("customers.address_full")} hint={t("customers.address_full_hint")}>
        <p className="input h-auto min-h-[44px] py-2 bg-grey-bg text-sm break-words" data-testid="address-full" aria-readonly="true">{full || "—"}</p>
      </Field>
    </div>
  );
}
