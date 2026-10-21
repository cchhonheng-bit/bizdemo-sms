// Customers by Excel (owner 21-10, D-156): one sheet = the customer list — «ទាញ Excel» exports it (the same sheet is the
// template), «នាំចូល Excel» previews, then applies: a row is matched to an existing customer by any of its phones (updated),
// otherwise made new (a staff customer needs province + khan + sangkat, or a borey that carries them). Places may be written as the
// official Khmer / English names or as the gazetteer codes; «ក្នុងបុរី» yes/no; nothing is ever deleted (a row not in the file stays).
import { addressComplete, composeAddress, geoLabel, normalizeKhPhone, type GeoUnit } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import { checkPlace, geoChildren } from "../lib/gazetteer.js";
import { readSheet, writeXlsx } from "../lib/xlsx.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";

export const CUSTOMER_COLUMNS = ["name", "phones", "house_no", "street", "borey", "borey_zone", "province", "district", "commune", "village", "in_borey", "notes", "active"] as const;
type Col = (typeof CUSTOMER_COLUMNS)[number];
const HEAD: Record<Col, { km: string; en: string }> = {
  name: { km: "ឈ្មោះ", en: "Name" }, phones: { km: "ទូរស័ព្ទ (ច្រើនលេខ ខណ្ឌដោយ /)", en: "Phones (several: a / between)" },
  house_no: { km: "ផ្ទះលេខ", en: "House no." }, street: { km: "ផ្លូវ", en: "Street" }, borey: { km: "បុរី", en: "Borey" }, borey_zone: { km: "តំបន់ក្នុងបុរី", en: "Zone in the borey" },
  province: { km: "ខេត្ត / រាជធានី", en: "Province" }, district: { km: "ខណ្ឌ / ស្រុក", en: "Khan / district" }, commune: { km: "សង្កាត់ / ឃុំ", en: "Sangkat / commune" }, village: { km: "ភូមិ", en: "Village" },
  in_borey: { km: "ក្នុងបុរី (បាទ / ទេ)", en: "Inside a borey (yes / no)" }, notes: { km: "ចំណាំ", en: "Notes" }, active: { km: "សកម្ម (បាទ / ទេ)", en: "Active (yes / no)" },
};
const YES = { km: "បាទ", en: "yes" }, NO = { km: "ទេ", en: "no" };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const bool = (s: string): boolean | null | "bad" => {
  const v = norm(s);
  if (!v) return null;
  if (["1", "yes", "y", "true", "បាទ", "ចាស", "✓", "✔"].includes(v)) return true;
  if (["0", "no", "n", "false", "ទេ"].includes(v)) return false;
  return "bad";
};
const WIDTHS = [26, 28, 10, 14, 18, 14, 18, 18, 18, 16, 14, 30, 10];

type Row = { id: string; name: string; phones: string[]; address: string | null; zone: string; notes: string | null; is_active: boolean; origin: string;
  house_no: string | null; street: string | null; borey_id: string | null; borey_name: string | null; borey_zone: string | null;
  province_code: string | null; district_code: string | null; commune_code: string | null; village_code: string | null };
const ROWS = (db: Db) => db`c.id, c.name, c.phones, c.address, c.zone::text as zone, c.notes, c.is_active, c.origin, c.house_no, c.street, c.borey_id, bo.name as borey_name, c.borey_zone,
  c.province_code, c.district_code, c.commune_code, c.village_code`;
const geoLabelOf = (code: string | null, lang: "km" | "en") => { const u = code ? geoChildrenAll().get(code) : null; return u ? geoLabel(u, lang) : ""; };
let all: Map<string, GeoUnit> | null = null;
/** every gazetteer unit by code (built once from the children lists) */
function geoChildrenAll(): Map<string, GeoUnit> {
  if (all) return all;
  const m = new Map<string, GeoUnit>();
  const walk = (parent: string) => { for (const u of geoChildren(parent)) { m.set(u.code, u); walk(u.code); } };
  walk("");
  return (all = m);
}
/** a place written as a code or as its Khmer / English name, searched among the children of `parent` */
function resolve(text: string, parent: string): GeoUnit | null | "bad" {
  const v = norm(text);
  if (!v) return null;
  const kids = geoChildren(parent);
  return kids.find((u) => u.code === v) ?? kids.find((u) => [u.km, u.en, geoLabel(u, "km"), geoLabel(u, "en")].some((n) => norm(n) === v)) ?? "bad"; // «ចំការមន» or «ខណ្ឌចំការមន» (as exported)
}

function rowsOf(list: Row[], lang: "km" | "en") {
  const yn = (b: boolean) => (b ? YES[lang] : NO[lang]);
  return [CUSTOMER_COLUMNS.map((c) => HEAD[c][lang]), ...list.map((c) => [c.name, c.phones.map(local).join(" / "), c.house_no ?? "", c.street ?? "", c.borey_name ?? "", c.borey_zone ?? "",
    geoLabelOf(c.province_code, lang), geoLabelOf(c.district_code, lang), geoLabelOf(c.commune_code, lang), geoLabelOf(c.village_code, lang), yn(c.zone === "inside"), c.notes ?? "", yn(c.is_active)])];
}
/** +855 12 345 678 → 012345678 (as people write it) */
const local = (p: string) => (p.startsWith("+855") ? `0${p.slice(4)}` : p);

/** the customer list as a sheet — also the import template (D-120: test customers never leave the server) */
export async function customersExport(user: SessionUser, lang: "km" | "en"): Promise<Buffer> {
  const list = await sql<Row[]>`select ${ROWS(sql)} from customers c left join boreys bo on bo.id = c.borey_id where c.company_id = ${user.companyId} and not c.is_test order by c.name`;
  return writeXlsx(lang === "en" ? "Customers" : "អតិថិជន", rowsOf(list, lang), WIDTHS);
}
/** three made-up rows showing every column (for the owner's demo and the handover) */
export function customersSample(lang: "km" | "en"): Buffer {
  const pp = geoChildren("").find((u) => u.code === "12");
  const khan = pp ? geoChildren(pp.code)[0] : undefined, sangkat = khan ? geoChildren(khan.code)[0] : undefined;
  const yn = (b: boolean) => (b ? YES[lang] : NO[lang]);
  const rows = [
    ["លោក សុខា", "012 345 678 / 098 765 432", "24", "19", "", "", pp ? geoLabel(pp, lang) : "ភ្នំពេញ", khan ? geoLabel(khan, lang) : "ដូនពេញ", sangkat ? geoLabel(sangkat, lang) : "ផ្សារចាស់", "", yn(false), "អតិថិជនចាស់", yn(true)],
    ["អ្នកស្រី ចន្ថា", "015 222 333", "A-12", "", "បុរីពិភពថ្មី", "Zone B", "", "", "", "", yn(true), "", yn(true)],
    ["ហាង គីមស៊ុន", "017 888 999", "", "ផ្លូវ 271", "", "", "12", "1201", "120101", "", yn(false), "អាសយដ្ឋានជាកូដ", yn(false)],
  ];
  return writeXlsx(lang === "en" ? "Customers" : "អតិថិជន", [CUSTOMER_COLUMNS.map((c) => HEAD[c][lang]), ...rows], WIDTHS);
}

type Parsed = { name: string; phones: string[]; house_no: string | null; street: string | null; borey: string | null; borey_zone: string | null;
  place: { province_code: string | null; district_code: string | null; commune_code: string | null; village_code: string | null }; in_borey: boolean | null; notes: string | null; active: boolean | null };
export type PreviewRow = { row: number; code: string; name: string; action: "new" | "changed" | "same" | "error"; errors: string[]; changes: Record<string, [unknown, unknown]> };

export function parseCustomerSheet(rows: string[][]): { rows: { row: number; data: Parsed | null; code: string; name: string; errors: string[] }[]; fileErrors: string[] } {
  const headAt = rows.findIndex((r) => r.some((c) => c.trim()));
  if (headAt < 0) return { rows: [], fileErrors: ["EMPTY"] };
  const header: Partial<Record<Col, number>> = {};
  rows[headAt]!.forEach((cell, i) => { const h = norm(cell); const col = CUSTOMER_COLUMNS.find((c) => h === c || h === norm(HEAD[c].km) || h === norm(HEAD[c].en)); if (col && header[col] === undefined) header[col] = i; });
  const missing = (["name", "phones"] as const).filter((c) => header[c] === undefined);
  if (missing.length) return { rows: [], fileErrors: missing.map((c) => `MISSING_COLUMN:${c}`) };
  const out: { row: number; data: Parsed | null; code: string; name: string; errors: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = headAt + 1; i < rows.length && out.length <= 1000; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => (c ?? "").trim())) continue;
    const get = (c: Col) => (header[c] === undefined ? "" : String(r[header[c]!] ?? "").trim());
    const errors: string[] = [];
    const name = get("name").slice(0, 120);
    if (!name) errors.push("NAME");
    const phones = get("phones").split(/[\/,;|\n]+/).map((p) => p.trim()).filter(Boolean).map((p) => normalizeKhPhone(p));
    if (!phones.length || phones.some((p) => !p)) errors.push("PHONE");
    const ph = phones.filter((p): p is string => !!p).slice(0, 3);
    for (const p of ph) { if (seen.has(p)) errors.push("DUPLICATE"); seen.add(p); }
    const prov = resolve(get("province"), ""), dist = prov && prov !== "bad" ? resolve(get("district"), prov.code) : get("district") ? "bad" : null;
    const comm = dist && dist !== "bad" ? resolve(get("commune"), dist.code) : get("commune") ? "bad" : null;
    const vill = comm && comm !== "bad" ? resolve(get("village"), comm.code) : get("village") ? "bad" : null;
    if ([prov, dist, comm, vill].includes("bad")) errors.push("PLACE");
    const flags = [bool(get("in_borey")), bool(get("active"))];
    if (flags.includes("bad")) errors.push("YES_NO");
    const code = ph[0] ? local(ph[0]) : "";
    out.push({ row: i + 1, code, name, errors, data: errors.length ? null : { name, phones: ph, house_no: get("house_no").slice(0, 40) || null, street: get("street").slice(0, 80) || null,
      borey: get("borey").slice(0, 120) || null, borey_zone: get("borey_zone").slice(0, 40) || null,
      place: { province_code: prov && prov !== "bad" ? prov.code : null, district_code: dist && dist !== "bad" ? dist.code : null, commune_code: comm && comm !== "bad" ? comm.code : null, village_code: vill && vill !== "bad" ? vill.code : null },
      in_borey: flags[0] as boolean | null, notes: get("notes").slice(0, 500) || null, active: flags[1] as boolean | null } });
  }
  return { rows: out, fileErrors: out.length > 1000 ? ["TOO_MANY_ROWS"] : [] };
}

type Next = { name: string; phones: string[]; house_no: string | null; street: string | null; borey_id: string | null; borey_name: string | null; borey_zone: string | null;
  province_code: string | null; district_code: string | null; commune_code: string | null; village_code: string | null; zone: "inside" | "outside"; notes: string | null; is_active: boolean; address: string | null };
async function plan(db: Db, companyId: string, buf: Buffer) {
  let rows: string[][];
  try { rows = readSheet(buf); } catch { throw new AppError("BAD_FILE", 400); }
  const parsed = parseCustomerSheet(rows);
  const existing = await db<Row[]>`select ${ROWS(db)} from customers c left join boreys bo on bo.id = c.borey_id where c.company_id = ${companyId} and not c.is_test`;
  const byPhone = new Map<string, Row>();
  for (const c of existing) for (const p of c.phones) byPhone.set(p, c);
  const boreys = await db<{ id: string; name: string; province_code: string; district_code: string; commune_code: string | null }[]>`select id, name, province_code, district_code, commune_code from boreys where company_id = ${companyId} and is_active`;
  const items: { row: PreviewRow; old: Row | null; next: Next | null }[] = [];
  const taken = new Set<string>(); // one row per existing customer
  for (const p of parsed.rows) {
    const row: PreviewRow = { row: p.row, code: p.code, name: p.name, action: "error", errors: [...p.errors], changes: {} };
    if (!p.data) { items.push({ row, old: null, next: null }); continue; }
    const d = p.data;
    const old = d.phones.map((ph) => byPhone.get(ph)).find((c): c is Row => !!c) ?? null;
    if (old && taken.has(old.id)) row.errors.push("DUPLICATE");
    if (old) taken.add(old.id);
    const borey = d.borey ? boreys.find((b) => norm(b.name) === norm(d.borey!)) ?? null : null;
    if (d.borey && !borey) row.errors.push("BOREY");
    const inBorey = d.in_borey ?? (!!borey || (old ? old.zone === "inside" : false));
    const bo = inBorey ? borey ?? (old?.borey_id ? boreys.find((b) => b.id === old.borey_id) ?? null : null) : null;
    const own = !!d.place.province_code;
    const place = own ? d.place : bo ? { province_code: bo.province_code, district_code: bo.district_code, commune_code: bo.commune_code, village_code: null }
      : { province_code: old?.province_code ?? null, district_code: old?.district_code ?? null, commune_code: old?.commune_code ?? null, village_code: old?.village_code ?? null };
    if (!old && !addressComplete(place)) row.errors.push("ADDRESS"); // a staff customer needs province + khan + sangkat (D-137)
    if (row.errors.length) { items.push({ row, old, next: null }); continue; }
    const units = place.province_code ? checkPlace(place) : [];
    const house = d.house_no ?? old?.house_no ?? null, street = d.street ?? old?.street ?? null, zone = inBorey ? d.borey_zone ?? old?.borey_zone ?? null : null;
    const next: Next = { name: d.name, phones: d.phones, house_no: house, street, borey_id: bo?.id ?? null, borey_name: bo?.name ?? null, borey_zone: zone, ...place,
      zone: inBorey ? "inside" : "outside", notes: d.notes ?? old?.notes ?? null, is_active: d.active ?? old?.is_active ?? true,
      address: place.province_code ? composeAddress({ house_no: house, street, borey: bo?.name, zone, units }) : old?.address ?? null };
    if (!old) row.action = "new";
    else {
      const keys = ["name", "phones", "house_no", "street", "borey_name", "borey_zone", "province_code", "district_code", "commune_code", "village_code", "zone", "notes", "is_active"] as const;
      for (const k of keys) { const a = old[k], b = next[k]; if (JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)) row.changes[k] = [a ?? null, b ?? null]; }
      row.action = Object.keys(row.changes).length ? "changed" : "same";
    }
    items.push({ row, old, next });
  }
  const counts = { new: 0, changed: 0, same: 0, error: 0 };
  for (const x of items) counts[x.row.action]++;
  return { items, counts, fileErrors: parsed.fileErrors };
}

export async function customersPreview(user: SessionUser, buf: Buffer) {
  const p = await plan(sql, user.companyId, buf);
  return { counts: p.counts, file_errors: p.fileErrors, rows: p.items.map((x) => x.row) };
}

/** refused while the file has errors; new rows added, changed rows updated, every one audited; rows not in the file untouched */
export async function customersApply(user: SessionUser, ip: string | null, buf: Buffer) {
  return tx(user.id, async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`customer-import:${user.companyId}`}, 0))`;
    const p = await plan(t, user.companyId, buf);
    if (p.fileErrors.length || p.counts.error) throw new AppError("IMPORT_HAS_ERRORS", 400, { file_errors: p.fileErrors, rows: p.items.filter((x) => x.row.action === "error").map((x) => x.row) });
    for (const x of p.items) {
      if (x.row.action === "same" || !x.next) continue;
      const n = x.next;
      if (!x.old) {
        const id = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, notes, is_active, created_by, house_no, street, borey_id, borey_zone, province_code, district_code, commune_code, village_code)
          values (${user.companyId}, ${n.name}, ${t.array(n.phones)}, ${n.address}, ${n.zone}::zone, ${n.notes}, ${n.is_active}, ${user.id}, ${n.house_no}, ${n.street}, ${n.borey_id}, ${n.borey_zone},
            ${n.province_code}, ${n.district_code}, ${n.commune_code}, ${n.village_code}) returning id`)[0]!.id;
        await audit(t, { companyId: user.companyId, userId: user.id, action: "customer.create", table: "customers", rowId: id, new: { name: n.name, address: n.address, import: true }, ip });
      } else {
        await t`update customers set name = ${n.name}, phones = ${t.array(n.phones)}, address = ${n.address}, zone = ${n.zone}::zone, notes = ${n.notes}, is_active = ${n.is_active},
            house_no = ${n.house_no}, street = ${n.street}, borey_id = ${n.borey_id}, borey_zone = ${n.borey_zone}, province_code = ${n.province_code}, district_code = ${n.district_code},
            commune_code = ${n.commune_code}, village_code = ${n.village_code}, updated_at = now() where id = ${x.old.id}`;
        await audit(t, { companyId: user.companyId, userId: user.id, action: "customer.update", table: "customers", rowId: x.old.id, old: Object.fromEntries(Object.entries(x.row.changes).map(([k, v]) => [k, v[0]])),
          new: { ...Object.fromEntries(Object.entries(x.row.changes).map(([k, v]) => [k, v[1]])), import: true }, ip });
      }
    }
    await audit(t, { companyId: user.companyId, userId: user.id, action: "customer.import", table: "customers", rowId: user.companyId, new: p.counts, ip });
    return { ok: true as const, counts: p.counts };
  });
}
