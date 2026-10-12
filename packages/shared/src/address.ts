// Customer address (CEO 12-10, D-137): house no., street no., borey project, province → khan / district → sangkat / commune →
// village from the official gazetteer (NCDD, Ministry of Interior — codes 2 / 4 / 6 / 8 digits), GPS. Staff-made customers need
// province + khan + sangkat; website customers may come in incomplete (a badge until the staff complete it).

/** gazetteer unit types: c capital, p province · h khan, s district (srok), k municipality (krong) · g sangkat, u commune (khum) · v village */
export type GeoType = "c" | "p" | "h" | "s" | "k" | "g" | "u" | "v";
export type GeoUnit = { code: string; km: string; en: string; type: GeoType };
export const GEO_TYPE: Record<GeoType, { km: string; en: string }> = {
  c: { km: "រាជធានី", en: "Capital" }, p: { km: "ខេត្ត", en: "Province" },
  h: { km: "ខណ្ឌ", en: "Khan" }, s: { km: "ស្រុក", en: "District" }, k: { km: "ក្រុង", en: "Municipality" },
  g: { km: "សង្កាត់", en: "Sangkat" }, u: { km: "ឃុំ", en: "Commune" }, v: { km: "ភូមិ", en: "Village" },
};
/** a new customer starts in Phnom Penh, Khan Chbar Ampov (One Team's area) — editable */
export const GEO_DEFAULT = { province: "12", district: "1212" } as const;
export const GEO_LEN = { province: 2, district: 4, commune: 6, village: 8 } as const;
export const geoCodeRe = (len: number) => new RegExp(`^[0-9]{${len}}$`);

/** the name as it is shown: provinces keep their official full name («រាជធានីភ្នំពេញ» / «Phnom Penh Capital»); below it the type
 *  comes first in Khmer («ខណ្ឌច្បារអំពៅ») and last in English («Chbar Ampov Khan»); a village keeps its name in English */
export function geoLabel(u: GeoUnit, lang: "km" | "en"): string {
  if (u.type === "c" || u.type === "p") return lang === "en" ? u.en || u.km : u.km;
  const t = GEO_TYPE[u.type];
  if (lang === "en" && u.en) return u.type === "v" ? u.en : `${u.en} ${t.en}`;
  return u.km.startsWith(t.km) ? u.km : `${t.km}${u.km}`;
}

export type AddressParts = { house_no?: string | null; street?: string | null; borey?: string | null; units: GeoUnit[] };
/** one line for lists, job messages and prints (Khmer, the way an address is written): house, street, borey, village → province */
export function composeAddress(p: AddressParts): string {
  const house = p.house_no?.trim(), street = p.street?.trim(), borey = p.borey?.trim();
  return [
    house ? (house.startsWith("ផ្ទះ") ? house : `ផ្ទះលេខ ${house}`) : null,
    street ? (street.startsWith("ផ្លូវ") ? street : `ផ្លូវលេខ ${street}`) : null,
    borey || null,
    ...[...p.units].sort((a, b) => b.code.length - a.code.length).map((u) => geoLabel(u, "km")),
  ].filter(Boolean).join(", ");
}
/** the address is complete enough for the staff: province, khan / district and sangkat / commune are set */
export const addressComplete = (c: { province_code?: string | null; district_code?: string | null; commune_code?: string | null }): boolean =>
  !!(c.province_code && c.district_code && c.commune_code);
