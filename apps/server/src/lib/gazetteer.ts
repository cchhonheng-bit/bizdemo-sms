// The Cambodia gazetteer (D-137): data/gazetteer-kh.json, built from the official NCDD database of the Ministry of Interior by
// scripts/gazetteer/build.mjs (never edited by hand). Loaded once; the cascading pickers ask for the children of a code.
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GEO_LEN, geoLabel, type GeoType, type GeoUnit } from "@sms/shared";
import { AppError } from "./errors.js";

type Data = { source: string; downloaded: string; units: [string, string, string, GeoType][] };
let cache: { source: string; downloaded: string; byCode: Map<string, GeoUnit>; children: Map<string, GeoUnit[]> } | null = null;

function load() {
  if (cache) return cache;
  // source tree (src/lib → src/data) or the server bundle (dist/*.mjs → dist/data)
  const file = [new URL("../data/gazetteer-kh.json", import.meta.url), new URL("./data/gazetteer-kh.json", import.meta.url)].map((u) => fileURLToPath(u)).find((f) => existsSync(f));
  if (!file) throw new Error("gazetteer-kh.json not found");
  const d = JSON.parse(readFileSync(file, "utf8")) as Data;
  const byCode = new Map<string, GeoUnit>(), children = new Map<string, GeoUnit[]>();
  for (const [code, km, en, type] of d.units) {
    const u: GeoUnit = { code, km, en, type };
    byCode.set(code, u);
    const parent = code.length === 2 ? "" : code.slice(0, code.length - 2);
    (children.get(parent) ?? children.set(parent, []).get(parent)!).push(u);
  }
  cache = { source: d.source, downloaded: d.downloaded, byCode, children };
  return cache;
}

export const geoInfo = () => ({ source: load().source, downloaded: load().downloaded });
export const geoUnit = (code: string | null | undefined): GeoUnit | null => (code ? load().byCode.get(code) ?? null : null);
/** "" → the 25 provinces; a code → the units directly under it */
export const geoChildren = (code: string): GeoUnit[] => load().children.get(code) ?? [];
/** the label of a code in a language (null when unknown) */
export const geoName = (code: string | null | undefined, lang: "km" | "en"): string | null => { const u = geoUnit(code); return u ? geoLabel(u, lang) : null; };

export type Place = { province_code: string | null; district_code: string | null; commune_code: string | null; village_code: string | null };
/** every code exists, has the right length and sits under the one above it; a lower level needs the levels above */
export function checkPlace(p: Place): GeoUnit[] {
  const chain = [p.province_code, p.district_code, p.commune_code, p.village_code];
  const lens = [GEO_LEN.province, GEO_LEN.district, GEO_LEN.commune, GEO_LEN.village];
  const out: GeoUnit[] = [];
  let parent = "";
  for (let i = 0; i < chain.length; i++) {
    const c = chain[i];
    if (!c) { if (chain.slice(i + 1).some(Boolean)) throw new AppError("INVALID_PLACE", 400); break; }
    const u = geoUnit(c);
    if (!u || c.length !== lens[i] || !c.startsWith(parent)) throw new AppError("INVALID_PLACE", 400);
    out.push(u); parent = c;
  }
  return out;
}
