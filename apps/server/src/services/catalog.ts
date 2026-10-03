// Catalog «ទំនិញ និងសេវាកម្ម» (D-106): items with their website fields (code, website category, «from» price, shown on the
// website, quote only). Editing — the form and the Excel import — is for CEO, CFO, Admin and GM only; every change is in the
// audit log with old → new. Excel: download the template (the services as they are now) → upload → preview (new / changed /
// errors) → apply. Rows are matched by code; nothing is ever deleted (an item is switched off with «active»). Sample items for a
// new shop are seeded with is_sample = true (prices only in demo / test data — never on the live shop).
import { CATALOG_CODE_RE, CATALOG_EDIT_ROLES, WEB_CATEGORIES, WEB_CATEGORY_GROUP, WEB_CATEGORY_LABEL, type CatalogItemInput, type WebCategory } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { readSheet, writeXlsx } from "../lib/xlsx.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";

export const assertCatalogEditor = (u: { role: string }) => { if (!CATALOG_EDIT_ROLES.includes(u.role)) throw new AppError("FORBIDDEN", 403); };

type Item = { id: string; code: string | null; name_km: string; name_en: string | null; kind: "service" | "product"; category: string; web_category: WebCategory | null; unit: string;
  sell_price: number; cost_price: number | null; duration_min: number; is_active: boolean; show_on_website: boolean; quote_only: boolean; is_sample: boolean; from_price: number | null;
  reminder_months: number | null; income_account_id: string | null };
const COLS = (db: Db) => db`id, code, name_km, name_en, kind, category::text as category, web_category, unit, sell_price, cost_price, duration_min, is_active, show_on_website, quote_only, is_sample, from_price, reminder_months, income_account_id`;

export async function listCatalog(user: SessionUser, perms: string[]) {
  const isTech = user.role === "tech", withCost = perms.includes("cost.read");
  const rows = await sql<(Item & { created_at: Date; updated_at: Date })[]>`select ${COLS(sql)}, created_at, updated_at from catalog_items
    where company_id = ${user.companyId} ${isTech ? sql`and is_active` : sql``} order by category, web_category nulls last, name_km`;
  return rows.map((r) => ({ ...r, company_id: user.companyId, sell_price: isTech ? null : r.sell_price, cost_price: withCost ? r.cost_price : null }));
}

/** «last changed: <name> · <date time>» over the list */
export async function catalogMeta(user: SessionUser) {
  const r = (await sql<{ name: string | null; at: Date }[]>`select u.full_name as name, a.at from audit_log a left join users u on u.id = a.user_id
    where a.company_id = ${user.companyId} and a.table_name = 'catalog_items' order by a.id desc limit 1`)[0];
  return { last: r ? { name: r.name ?? "—", at: r.at } : null, can_edit: CATALOG_EDIT_ROLES.includes(user.role) };
}

const FIELDS = ["code", "name_km", "name_en", "kind", "category", "web_category", "unit", "sell_price", "cost_price", "duration_min", "reminder_months", "income_account_id", "from_price", "show_on_website", "quote_only", "is_active"] as const;
/** old → new of the fields that changed (the audit log keeps exactly this) */
function diff(old: Partial<Item> | null, next: Partial<Item>): { old: Record<string, unknown>; new: Record<string, unknown> } | null {
  const o: Record<string, unknown> = {}, n: Record<string, unknown> = {};
  for (const k of FIELDS) {
    if (!(k in next)) continue;
    const a = old ? (old as Record<string, unknown>)[k] ?? null : null, b = (next as Record<string, unknown>)[k] ?? null;
    if (a !== b) { o[k] = a; n[k] = b; }
  }
  return Object.keys(n).length ? { old: o, new: n } : null;
}
async function codeFree(db: Db, companyId: string, code: string | null, exceptId: string | null) {
  if (!code) return;
  if ((await db`select 1 from catalog_items where company_id = ${companyId} and code = ${code} ${exceptId ? db`and id <> ${exceptId}` : db``}`).length) throw new AppError("CODE_TAKEN", 409);
}

/** the catalog form (D-106: CEO / CFO / Admin / GM). The cost price only with cost.read; every change audited with old → new. */
export async function upsertItem(user: SessionUser, ip: string | null, b: CatalogItemInput & { id?: string | null }, withCost: boolean) {
  assertCatalogEditor(user);
  if (b.cost_price != null && !withCost) throw new AppError("FORBIDDEN_COST", 403);
  if (b.income_account_id && !(await sql`select 1 from accounts where id = ${b.income_account_id} and company_id = ${user.companyId} and type = 'income'`).length) throw new AppError("NOT_INCOME_ACCOUNT", 400);
  const code = b.code ? b.code : null;
  return tx(user.id, async (t) => {
    const old = b.id ? (await t<Item[]>`select ${COLS(t)} from catalog_items where id = ${b.id} and company_id = ${user.companyId} for update`)[0] : null;
    if (b.id && !old) throw notFound();
    await codeFree(t, user.companyId, code, b.id ?? null);
    const service = b.kind === "service";
    const next: Partial<Item> = {
      code: code ?? old?.code ?? null, name_km: b.name_km, name_en: b.name_en || null, kind: b.kind, category: b.category, unit: b.unit || old?.unit || "unit", sell_price: b.sell_price,
      duration_min: b.duration_min ?? old?.duration_min ?? 120,
      ...(b.reminder_months !== undefined ? { reminder_months: b.reminder_months ?? null } : {}),
      ...(b.income_account_id !== undefined ? { income_account_id: b.income_account_id ?? null } : {}),
      ...(withCost && b.cost_price !== undefined ? { cost_price: b.cost_price ?? null } : {}),
      ...(b.web_category !== undefined ? { web_category: service ? b.web_category ?? null : null } : {}),
      ...(b.from_price !== undefined ? { from_price: service ? b.from_price ?? null : null } : {}),
      ...(b.show_on_website !== undefined ? { show_on_website: b.show_on_website } : {}),
      ...(b.quote_only !== undefined ? { quote_only: service && b.quote_only } : {}),
    };
    let id: string;
    if (!old) {
      id = (await t<{ id: string }[]>`insert into catalog_items (company_id, code, name_km, name_en, kind, category, web_category, unit, sell_price, cost_price, duration_min, reminder_months, income_account_id,
          from_price, show_on_website, quote_only, created_by, updated_by)
        values (${user.companyId}, ${next.code ?? null}, ${b.name_km}, ${next.name_en ?? null}, ${b.kind}::item_kind, ${b.category}::service_category, ${next.web_category ?? null}, ${next.unit!}, ${b.sell_price},
          ${next.cost_price ?? null}, ${next.duration_min!}, ${next.reminder_months ?? null}, ${next.income_account_id ?? null}, ${next.from_price ?? null}, ${next.show_on_website ?? true}, ${next.quote_only ?? false},
          ${user.id}, ${user.id}) returning id`)[0]!.id;
    } else {
      id = old.id;
      const m = { ...old, ...next } as Item;
      await t`update catalog_items set code = ${m.code}, name_km = ${m.name_km}, name_en = ${m.name_en}, kind = ${m.kind}::item_kind, category = ${m.category}::service_category, web_category = ${m.web_category},
          unit = ${m.unit}, sell_price = ${m.sell_price}, cost_price = ${m.cost_price}, duration_min = ${m.duration_min}, reminder_months = ${m.reminder_months}, income_account_id = ${m.income_account_id},
          from_price = ${m.from_price}, show_on_website = ${m.show_on_website}, quote_only = ${m.quote_only}, is_sample = ${old.is_sample && !diff(old, next)}, updated_by = ${user.id}
        where id = ${id}`;
    }
    const d = diff(old, next);
    if (d || !old) await audit(t, { companyId: user.companyId, userId: user.id, action: "catalog.upsert", table: "catalog_items", rowId: id, old: old ? d?.old : undefined, new: d?.new ?? { name_km: b.name_km }, ip });
    return id;
  });
}

export async function setItemActive(user: SessionUser, ip: string | null, id: string, active: boolean) {
  assertCatalogEditor(user);
  return tx(user.id, async (t) => {
    const r = (await t<{ is_active: boolean }[]>`select is_active from catalog_items where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!r) throw notFound();
    if (r.is_active !== active) {
      await t`update catalog_items set is_active = ${active}, updated_by = ${user.id} where id = ${id}`;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "catalog.active", table: "catalog_items", rowId: id, old: { is_active: r.is_active }, new: { is_active: active }, ip });
    }
    return { ok: true };
  });
}

// ---------- Excel: template, preview, apply ----------
export const IMPORT_COLUMNS = ["code", "category", "name_km", "name_en", "unit", "from_price", "duration_min", "show_on_website", "quote_only", "active"] as const;
type Col = (typeof IMPORT_COLUMNS)[number];
const HEAD: Record<Col, { km: string; en: string }> = {
  code: { km: "កូដ", en: "Code" }, category: { km: "ប្រភេទ", en: "Category" }, name_km: { km: "ឈ្មោះ (ខ្មែរ)", en: "Name (Khmer)" }, name_en: { km: "ឈ្មោះ (អង់គ្លេស)", en: "Name (English)" },
  unit: { km: "ឯកតា", en: "Unit" }, from_price: { km: "តម្លៃចាប់ពី ($)", en: "From price ($)" }, duration_min: { km: "រយៈពេល (នាទី)", en: "Duration (min)" },
  show_on_website: { km: "បង្ហាញលើគេហទំព័រ", en: "Show on website" }, quote_only: { km: "ស្នើសុំតម្លៃប៉ុណ្ណោះ", en: "Quote only" }, active: { km: "សកម្ម", en: "Active" },
};
const YES = { km: "បាទ", en: "yes" }, NO = { km: "ទេ", en: "no" };
const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export function catalogTemplateRows(items: Item[], lang: "km" | "en") {
  const yn = (b: boolean) => (b ? YES[lang] : NO[lang]);
  return [IMPORT_COLUMNS.map((c) => HEAD[c][lang]), ...items.filter((i) => i.kind === "service").map((i) => [i.code ?? "", i.web_category ? WEB_CATEGORY_LABEL[i.web_category][lang] : "", i.name_km, i.name_en ?? "", i.unit,
    i.from_price == null ? "" : i.from_price / 100, i.duration_min, yn(i.show_on_website), yn(i.quote_only), yn(i.is_active)])];
}
export async function catalogTemplate(user: SessionUser, lang: "km" | "en"): Promise<Buffer> {
  assertCatalogEditor(user);
  const items = await sql<Item[]>`select ${COLS(sql)} from catalog_items where company_id = ${user.companyId} and kind = 'service' order by web_category nulls last, code nulls last, name_km`;
  return writeXlsx(lang === "en" ? "Catalog" : "ទំនិញ និងសេវាកម្ម", catalogTemplateRows(items, lang), [14, 18, 32, 28, 10, 14, 14, 18, 18, 10]);
}

type Parsed = { code: string; web_category: WebCategory; name_km: string; name_en: string | null; unit: string | null; from_price: number | null;
  duration_min: number | null; show_on_website: boolean | null; quote_only: boolean | null; is_active: boolean | null };
export type PreviewRow = { row: number; code: string; name: string; action: "new" | "changed" | "same" | "error"; errors: string[]; changes: Record<string, [unknown, unknown]> };
const bool = (s: string): boolean | null | "bad" => {
  const v = norm(s);
  if (!v) return null;
  if (["1", "yes", "y", "true", "បាទ", "ចាស", "✓", "✔"].includes(v)) return true;
  if (["0", "no", "n", "false", "ទេ"].includes(v)) return false;
  return "bad";
};
const CATEGORY_BY_TEXT = new Map<string, WebCategory>(WEB_CATEGORIES.flatMap((c) => [[c, c], [norm(WEB_CATEGORY_LABEL[c].km), c], [norm(WEB_CATEGORY_LABEL[c].en), c]] as [string, WebCategory][]));

/** the rows of an uploaded file → parsed rows with their errors (row numbers as in Excel) */
export function parseCatalogSheet(rows: string[][]): { header: Partial<Record<Col, number>>; rows: { row: number; data: Parsed | null; code: string; name: string; errors: string[] }[]; fileErrors: string[] } {
  const headAt = rows.findIndex((r) => r.some((c) => c.trim()));
  if (headAt < 0) return { header: {}, rows: [], fileErrors: ["EMPTY"] };
  const header: Partial<Record<Col, number>> = {};
  rows[headAt]!.forEach((cell, i) => {
    const h = norm(cell);
    const col = IMPORT_COLUMNS.find((c) => h === c || h === norm(HEAD[c].km) || h === norm(HEAD[c].en));
    if (col && header[col] === undefined) header[col] = i;
  });
  const missing = (["code", "category", "name_km"] as const).filter((c) => header[c] === undefined);
  if (missing.length) return { header, rows: [], fileErrors: missing.map((c) => `MISSING_COLUMN:${c}`) };
  const out: { row: number; data: Parsed | null; code: string; name: string; errors: string[] }[] = [];
  const seen = new Set<string>();
  for (let i = headAt + 1; i < rows.length && out.length <= 500; i++) {
    const r = rows[i] ?? [];
    if (!r.some((c) => (c ?? "").trim())) continue;
    const get = (c: Col) => (header[c] === undefined ? "" : String(r[header[c]!] ?? "").trim());
    const errors: string[] = [];
    const code = get("code").toUpperCase();
    if (!CATALOG_CODE_RE.test(code)) errors.push("CODE");
    else if (seen.has(code)) errors.push("DUPLICATE");
    seen.add(code);
    const cat = CATEGORY_BY_TEXT.get(norm(get("category")));
    if (!cat) errors.push("CATEGORY");
    const name_km = get("name_km");
    if (!name_km || name_km.length > 120) errors.push("NAME");
    const name_en = get("name_en").slice(0, 120) || null;
    const unit = get("unit").slice(0, 20) || null;
    let from_price: number | null = null;
    const p = get("from_price").replace(/[$,\s]/g, "");
    if (p) { const n = Number(p); if (!Number.isFinite(n) || n < 0 || n > 1_000_000) errors.push("PRICE"); else from_price = Math.round(n * 100); }
    let duration_min: number | null = null;
    const d = get("duration_min");
    if (d) { const n = Number(d); if (!Number.isInteger(n) || n < 15 || n > 1440) errors.push("DURATION"); else duration_min = n; }
    const flags = (["show_on_website", "quote_only", "active"] as const).map((c) => bool(get(c)));
    if (flags.includes("bad")) errors.push("YES_NO");
    const [show, quote, active] = flags as (boolean | null)[];
    out.push({ row: i + 1, code, name: name_km, errors, data: errors.length ? null : { code, web_category: cat!, name_km, name_en, unit, from_price, duration_min, show_on_website: show ?? null, quote_only: quote ?? null, is_active: active ?? null } });
  }
  return { header, rows: out, fileErrors: out.length > 500 ? ["TOO_MANY_ROWS"] : [] };
}

/** what applying the file would do — nothing is written */
async function plan(db: Db, companyId: string, buf: Buffer) {
  let rows: string[][];
  try { rows = readSheet(buf); } catch { throw new AppError("BAD_FILE", 400); }
  const parsed = parseCatalogSheet(rows);
  const existing = new Map((await db<Item[]>`select ${COLS(db)} from catalog_items where company_id = ${companyId} and code is not null`).map((i) => [i.code!, i]));
  const items: { row: PreviewRow; data: Parsed | null; old: Item | null; next: Partial<Item> | null }[] = parsed.rows.map((p) => {
    const row: PreviewRow = { row: p.row, code: p.code, name: p.name, action: "error", errors: [...p.errors], changes: {} };
    const old = existing.get(p.code) ?? null;
    if (old && old.kind !== "service") row.errors.push("NOT_SERVICE");
    if (row.errors.length || !p.data) return { row, data: null, old, next: null };
    const d = p.data;
    const next: Partial<Item> = { name_km: d.name_km, name_en: d.name_en ?? (old ? old.name_en : null), web_category: d.web_category, unit: d.unit ?? old?.unit ?? "unit", from_price: d.from_price,
      duration_min: d.duration_min ?? old?.duration_min ?? 120, show_on_website: d.show_on_website ?? old?.show_on_website ?? true, quote_only: d.quote_only ?? old?.quote_only ?? false,
      is_active: d.is_active ?? old?.is_active ?? true, ...(old ? {} : { code: d.code, kind: "service" as const, category: WEB_CATEGORY_GROUP[d.web_category] }) };
    const ch = diff(old, next);
    if (!old) { row.action = "new"; }
    else if (ch) { row.action = "changed"; for (const k of Object.keys(ch.new)) row.changes[k] = [ch.old[k], ch.new[k]]; }
    else row.action = "same";
    return { row, data: d, old, next };
  });
  const counts = { new: 0, changed: 0, same: 0, error: 0 };
  for (const x of items) counts[x.row.action]++;
  return { items, counts, fileErrors: parsed.fileErrors };
}

export async function previewImport(user: SessionUser, buf: Buffer) {
  assertCatalogEditor(user);
  const p = await plan(sql, user.companyId, buf);
  return { counts: p.counts, file_errors: p.fileErrors, rows: p.items.map((x) => x.row) };
}

/** apply the same file: refused while it has errors; new rows are added, changed rows updated — rows not in the file stay as they are */
export async function applyImport(user: SessionUser, ip: string | null, buf: Buffer) {
  assertCatalogEditor(user);
  return tx(user.id, async (t) => {
    await t`select pg_advisory_xact_lock(hashtextextended(${`catalog-import:${user.companyId}`}, 0))`;
    const p = await plan(t, user.companyId, buf);
    if (p.fileErrors.length || p.counts.error) throw new AppError("IMPORT_HAS_ERRORS", 400, { file_errors: p.fileErrors, rows: p.items.filter((x) => x.row.action === "error").map((x) => x.row) });
    for (const x of p.items) {
      if (x.row.action === "same" || !x.next) continue;
      const n = x.next;
      let id: string;
      if (!x.old) {
        id = (await t<{ id: string }[]>`insert into catalog_items (company_id, code, name_km, name_en, kind, category, web_category, unit, sell_price, duration_min, from_price, show_on_website, quote_only, is_active, created_by, updated_by)
          values (${user.companyId}, ${n.code!}, ${n.name_km!}, ${n.name_en ?? null}, 'service', ${n.category!}::service_category, ${n.web_category!}, ${n.unit!}, 0, ${n.duration_min!}, ${n.from_price ?? null},
            ${n.show_on_website!}, ${n.quote_only!}, ${n.is_active!}, ${user.id}, ${user.id}) returning id`)[0]!.id;
      } else {
        id = x.old.id;
        await t`update catalog_items set name_km = ${n.name_km!}, name_en = ${n.name_en ?? null}, web_category = ${n.web_category!}, unit = ${n.unit!}, from_price = ${n.from_price ?? null},
            duration_min = ${n.duration_min!}, show_on_website = ${n.show_on_website!}, quote_only = ${n.quote_only!}, is_active = ${n.is_active!}, is_sample = false, updated_by = ${user.id} where id = ${id}`;
      }
      const d = diff(x.old, n);
      await audit(t, { companyId: user.companyId, userId: user.id, action: "catalog.import", table: "catalog_items", rowId: id, old: x.old ? d?.old : undefined, new: d?.new ?? n, ip });
    }
    return { ok: true, counts: p.counts };
  });
}

// ---------- sample items (owner brief C3 — One Team still has to confirm them) ----------
type Sample = { code: string; cat: WebCategory; km: string; en: string; unit: string; price?: number; quote?: true; also?: string[] };
export const SAMPLE_ITEMS: Sample[] = [
  { code: "AC-CLEAN", cat: "ac", km: "លាងម៉ាស៊ីនត្រជាក់", en: "AC cleaning", unit: "គ្រឿង", price: 1500 },
  { code: "AC-REPAIR", cat: "ac", km: "ជួសជុលម៉ាស៊ីនត្រជាក់", en: "AC repair", unit: "គ្រឿង", price: 2000 },
  { code: "AC-GAS", cat: "ac", km: "បញ្ចូលហ្គាស", en: "AC gas refill", unit: "គ្រឿង", price: 2500 },
  { code: "AC-INSTALL", cat: "ac", km: "ដំឡើងម៉ាស៊ីនត្រជាក់", en: "AC installation", unit: "គ្រឿង", price: 4500 },
  { code: "AC-BUY", cat: "ac", km: "ចង់ទិញម៉ាស៊ីនត្រជាក់", en: "Buy an air conditioner", unit: "គ្រឿង", quote: true },
  { code: "WT-PIPE", cat: "water", km: "ជួសជុលបំពង់ទឹក", en: "Water pipe repair", unit: "ចំណុច", price: 1500 },
  { code: "WT-PUMP", cat: "water", km: "ដំឡើងម៉ាស៊ីនបូមទឹក", en: "Water pump installation", unit: "គ្រឿង", price: 3000 },
  { code: "EL-REPAIR", cat: "electric", km: "ជួសជុលភ្លើង", en: "Electrical repair", unit: "ចំណុច", price: 1500, also: ["ជួសជុលប្រព័ន្ធភ្លើង"] },
  { code: "EL-INSTALL", cat: "electric", km: "ដំឡើងភ្លើង/ព្រីភ្លើង", en: "Lights and sockets installation", unit: "ចំណុច", price: 1000 },
  { code: "EL-CHECK", cat: "electric", km: "ពិនិត្យប្រព័ន្ធភ្លើង", en: "Electrical inspection", unit: "ផ្ទះ", price: 2000 },
  { code: "CC-INSTALL", cat: "cctv", km: "ដំឡើងកាមេរ៉ា", en: "Camera installation", unit: "គ្រឿង", price: 3500 },
  { code: "CC-REPAIR", cat: "cctv", km: "ជួសជុលកាមេរ៉ា", en: "Camera repair", unit: "គ្រឿង", price: 1500 },
  { code: "CN-QUOTE", cat: "construction", km: "ស្នើសុំតម្លៃ", en: "Construction quote", unit: "គម្រោង", quote: true },
];
/** add the sample items a shop does not have yet (matched by code or name); an item the shop already has only gets the website
 *  fields it is missing. `prices`: demo / test data only — the live shop keeps empty «from» prices (CEO). */
export async function seedWebCatalog(companyId: string, o: { prices: boolean }): Promise<{ added: number; updated: number }> {
  return tx(null, async (t) => {
    let added = 0, updated = 0;
    for (const s of SAMPLE_ITEMS) {
      const names = [s.km, ...(s.also ?? [])];
      const old = (await t<Item[]>`select ${COLS(t)} from catalog_items where company_id = ${companyId} and kind = 'service' and (code = ${s.code} or name_km = any(${t.array(names)})) order by (code = ${s.code}) desc, created_at limit 1`)[0];
      if (old) {
        const codeTaken = (await t`select 1 from catalog_items where company_id = ${companyId} and code = ${s.code} and id <> ${old.id}`).length > 0;
        const code = !codeTaken && (!old.code || /^[SP]-\d{3}$/.test(old.code)) ? s.code : old.code;
        const r = await t`update catalog_items set code = ${code}, web_category = coalesce(web_category, ${s.cat}), quote_only = quote_only or ${!!s.quote},
            from_price = case when ${o.prices} and from_price is null and not ${!!s.quote} then ${s.price ?? null}::int else from_price end
          where id = ${old.id} and (code is distinct from ${code} or web_category is null or (${!!s.quote} and not quote_only) or (${o.prices} and from_price is null and not ${!!s.quote})) returning id`;
        updated += r.length;
        continue;
      }
      const price = o.prices && !s.quote ? s.price ?? null : null;
      await t`insert into catalog_items (company_id, code, name_km, name_en, kind, category, web_category, unit, sell_price, duration_min, from_price, show_on_website, quote_only, is_sample)
        values (${companyId}, ${s.code}, ${s.km}, ${s.en}, 'service', ${WEB_CATEGORY_GROUP[s.cat]}::service_category, ${s.cat}, ${s.unit}, ${o.prices ? s.price ?? 0 : 0}, 120, ${price}, true, ${!!s.quote}, true)`;
      added++;
    }
    if (added || updated) await audit(t, { companyId, userId: null, action: "catalog.seed", source: "system", table: "catalog_items", new: { added, updated, prices: o.prices } });
    return { added, updated };
  });
}
