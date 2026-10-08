// shop-setup (CLI · D-131): what a shop sends for its start (catalog Excel, booking hours, logo, ACLEDA QR, work photos, phone,
// address) loaded through the same functions as the app — Settings → Website (texts, booking hours, photos), Settings → Company
// (invoice logo, ACLEDA QR), Catalog → Excel (same preview, never deletes) and the catalog form (a field by item code). It acts as
// the shop's HangKH Support account (users.is_platform), so the audit log shows every change like one made in the app. It never
// publishes the website (the search-engine tick box stays the shop's). Without `apply` nothing is written: every file is checked
// first and the plan is printed; a bad file stops it before anything is written.
// D-132 (final handover): also a field by code for the invoice price / cost, staff accounts turned off / on by username (the Users
// page's own rules) and existing rows marked as tests (demo customers by phone, demo bookings by number) — never a delete.
import { z } from "zod";
import { CATALOG_CODE_RE, normalizeKhPhone, type CatalogItemInput } from "@sms/shared";
import { sql } from "../db.js";
import type { SessionUser } from "./auth.js";
import { applyImport, previewImport, upsertItem } from "./catalog.js";
import { checkImage } from "./jobs.js";
import { addSitePhoto, INFO_KEYS, MAX_GALLERY, saveCompanyImage, saveSite, sitePatch, type SiteContent } from "./site.js";
import { markAsTest } from "./test-mode.js";
import { updateUser } from "./users.js";

const image = z.string().min(10).max(2_800_000);
export const shopSetupInput = z.object({
  website: sitePatch.omit({ published: true }).optional(),
  logo: image.optional(), qr: image.optional(), hero: image.optional(),
  gallery: z.array(image).min(1).max(MAX_GALLERY).optional(),
  catalog_xlsx: z.string().min(10).max(14_000_000).optional(),
  /** after the Excel: a field by item code, like the catalog form (prices in cents, as the API; sell_price = the invoice line's default) */
  catalog: z.array(z.object({ code: z.string().regex(CATALOG_CODE_RE), duration_min: z.number().int().min(15).max(1440).optional(),
    from_price: z.number().int().min(0).max(100_000_000).nullable().optional(), sell_price: z.number().int().min(0).max(100_000_000).optional(),
    cost_price: z.number().int().min(0).max(100_000_000).nullable().optional() }).strict()).max(500).optional(),
  /** staff accounts turned off / on by username — the Users page's rules: never the platform account, a CEO account only by a CEO */
  users: z.array(z.object({ username: z.string().min(1).max(40), active: z.boolean() }).strict()).max(50).optional(),
  /** existing rows that are tests (demo data): customers by phone, bookings by number — hidden like any test (D-120) */
  test: z.object({ customers: z.array(z.string().max(40)).max(100).default([]), bookings: z.array(z.string().max(20)).max(100).default([]) }).strict().optional(),
}).strict();

type CatRow = { id: string; code: string; name_km: string; name_en: string | null; kind: string; category: string; unit: string; sell_price: number; cost_price: number | null; duration_min: number; from_price: number | null };
const catRows = (companyId: string, code?: string) => sql<CatRow[]>`select id, code, name_km, name_en, kind::text as kind, category::text as category, unit, sell_price, cost_price, duration_min, from_price
  from catalog_items where company_id = ${companyId} and ${code ? sql`code = ${code}` : sql`code is not null`}`;
const show = (k: string, v: unknown) => (v == null || v === "" ? "—" : /_price$/.test(k) && typeof v === "number" ? `$${(v / 100).toFixed(2)}` : typeof v === "string" ? v : JSON.stringify(v));

async function platformUser(companyId: string): Promise<SessionUser> {
  const u = (await sql<{ id: string; role: string; username: string; full_name: string; language: "km" | "en" }[]>`
    select id, role::text as role, username, full_name, language from users where company_id = ${companyId} and is_platform and is_active order by created_at limit 1`)[0];
  if (!u) throw new Error("this shop has no active HangKH Support account (users.is_platform)");
  return { id: u.id, companyId, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: u.language, sessionId: "cli" };
}

/** the plan (dry run) or the plan + «applied ✓», one line each */
export async function shopSetup(slug: string, raw: unknown, apply: boolean): Promise<string[]> {
  const input = shopSetupInput.parse(raw);
  const c = (await sql<{ id: string; name: string }[]>`select id, name from companies where slug = ${slug}`)[0];
  if (!c) throw new Error(`company "${slug}" not found`);
  const user = await platformUser(c.id);
  const s = (await sql<{ website: SiteContent | null; info: Record<string, string> | null; logo: string | null; qr: string | null }[]>`
    select website, company_info as info, logo_path as logo, qr_image_path as qr from company_settings where company_id = ${c.id}`)[0];
  if (!s) throw new Error("company settings missing");
  const out = [`${c.name} (${slug}) · as ${user.fullName} (${user.username})${apply ? "" : " · DRY RUN — nothing is written (add --apply)"}`];

  // 1 · check everything first
  if (input.website) {
    const w = (s.website ?? {}) as Record<string, unknown>, info = s.info ?? {};
    for (const [k, v] of Object.entries(input.website)) {
      if (v === undefined) continue;
      const old = (INFO_KEYS as readonly string[]).includes(k) ? info[k] : w[k];
      out.push(`website ${k}: ${JSON.stringify(old ?? null) === JSON.stringify(v) ? "same" : `${show(k, old)} → ${show(k, v)}`}`);
    }
  }
  // photos are public: stored without camera position, comments or other metadata (like a visitor's photo, D-96)
  const pic = (label: string, data: string, strip: boolean) => {
    const i = checkImage(data, undefined, "BAD_IMAGE", strip);
    out.push(`${label}: ${i.mime} ${Math.max(1, Math.round(i.buf.length / 1024))} KB`);
    return i.buf.toString("base64");
  };
  const logo = input.logo ? pic(`logo${s.logo ? " (replaces the current one)" : ""}`, input.logo, false) : null;
  const qr = input.qr ? pic(`ACLEDA QR${s.qr ? " (replaces the current one)" : ""}`, input.qr, false) : null;
  const hero = input.hero ? pic(`website hero photo${s.website?.hero ? " (replaces the current one)" : ""}`, input.hero, true) : null;
  const gallery = (input.gallery ?? []).map((g, i) => pic(`website photo ${i + 1}`, g, true));
  const have = (s.website?.gallery ?? []).length;
  if (have + gallery.length > MAX_GALLERY) throw new Error(`website photos: ${have} now + ${gallery.length} new > ${MAX_GALLERY}`);
  if (gallery.length) out.push(`website photos: ${have} → ${have + gallery.length} of ${MAX_GALLERY}`);

  const planned = new Map<string, Record<string, unknown>>(); // code → the fields the Excel changes
  if (input.catalog_xlsx) {
    const p = await previewImport(user, Buffer.from(input.catalog_xlsx, "base64"));
    const bad = p.rows.filter((r) => r.action === "error");
    if (p.file_errors.length || bad.length) throw new Error(`catalog Excel has errors: ${[...p.file_errors, ...bad.map((r) => `row ${r.row} ${r.code}: ${r.errors.join(",")}`)].join(" · ")}`);
    out.push(`catalog Excel: ${p.counts.new} new · ${p.counts.changed} changed · ${p.counts.same} same`);
    for (const r of p.rows) {
      if (r.action === "new") out.push(`  ${r.code} new: ${r.name}`);
      if (r.action === "changed") out.push(`  ${r.code}: ${Object.entries(r.changes).map(([k, [a, b]]) => `${k} ${show(k, a)} → ${show(k, b)}`).join(" · ")}`);
      planned.set(r.code, Object.fromEntries(Object.entries(r.changes).map(([k, [, b]]) => [k, b])));
    }
  }
  if (input.catalog?.length) {
    const items = new Map((await catRows(c.id)).map((i) => [i.code, i]));
    for (const p of input.catalog) {
      const it = items.get(p.code);
      if (!it && !planned.has(p.code)) throw new Error(`catalog: no item with code ${p.code}`);
      const after: Record<string, unknown> = { ...(it ?? {}), ...(planned.get(p.code) ?? {}) };
      const ch = (["duration_min", "from_price", "sell_price", "cost_price"] as const).filter((k) => p[k] !== undefined).map((k) => `${k} ${show(k, after[k])} → ${show(k, p[k])}`);
      out.push(`catalog ${p.code}: ${ch.join(" · ") || "nothing to change"}`);
    }
  }
  const people: { id: string; active: boolean }[] = [];
  if (input.users?.length) {
    const rows = new Map((await sql<{ id: string; username: string; full_name: string; role: string; is_active: boolean; is_platform: boolean }[]>`
      select id, username, full_name, role::text as role, is_active, is_platform from users where company_id = ${c.id}`).map((u) => [u.username, u]));
    for (const x of input.users) {
      const u = rows.get(x.username);
      if (!u) throw new Error(`user: no account "${x.username}"`);
      if (u.is_platform || u.id === user.id) throw new Error(`user ${x.username}: the HangKH Support account is never changed here`);
      if (u.role === "ceo" && user.role !== "ceo") throw new Error(`user ${x.username}: a CEO account only by a CEO`);
      out.push(`user ${u.username} (${u.full_name}): active ${u.is_active === x.active ? "same" : `${u.is_active ? "yes" : "no"} → ${x.active ? "yes" : "no"}`}`);
      if (u.is_active !== x.active) people.push({ id: u.id, active: x.active });
    }
  }
  const tests = { customers: [] as string[], bookings: [] as string[] };
  for (const raw of input.test?.customers ?? []) {
    const p = normalizeKhPhone(raw);
    const m = p ? await sql<{ id: string; name: string; is_test: boolean }[]>`select id, name, is_test from customers where company_id = ${c.id} and ${p} = any(phones)` : [];
    if (m.length !== 1) throw new Error(`test customer ${raw}: ${m.length} customers have this phone`);
    out.push(`customer ${p} (${m[0]!.name}): test ${m[0]!.is_test ? "same" : "no → yes"}`);
    if (!m[0]!.is_test) tests.customers.push(m[0]!.id);
  }
  for (const n of input.test?.bookings ?? []) {
    const b = (await sql<{ id: string; status: string; is_test: boolean }[]>`select id, status::text as status, is_test from bookings where company_id = ${c.id} and number = ${n}`)[0];
    if (!b) throw new Error(`test booking ${n}: not found`);
    out.push(`booking ${n} (${b.status}): test ${b.is_test ? "same" : "no → yes"}`);
    if (!b.is_test) tests.bookings.push(b.id);
  }
  if (!apply) return out;

  // 2 · write, each step through the app's own function (its own transaction + audit row)
  if (input.website) await saveSite(user, null, input.website);
  if (logo) await saveCompanyImage(user, null, "logo", logo);
  if (qr) await saveCompanyImage(user, null, "qr", qr);
  if (hero) await addSitePhoto(user, null, "hero", hero);
  for (const g of gallery) await addSitePhoto(user, null, "gallery", g);
  if (input.catalog_xlsx) await applyImport(user, null, Buffer.from(input.catalog_xlsx, "base64"));
  for (const p of input.catalog ?? []) {
    const it = (await catRows(c.id, p.code))[0];
    if (!it) throw new Error(`catalog: no item with code ${p.code}`);
    await upsertItem(user, null, { id: it.id, code: it.code, name_km: it.name_km, name_en: it.name_en ?? "", kind: it.kind as CatalogItemInput["kind"], category: it.category as CatalogItemInput["category"],
      unit: it.unit, sell_price: p.sell_price ?? it.sell_price, duration_min: p.duration_min ?? it.duration_min, ...(p.from_price !== undefined ? { from_price: p.from_price } : {}),
      ...(p.cost_price !== undefined ? { cost_price: p.cost_price } : {}) }, p.cost_price !== undefined);
  }
  for (const x of people) await updateUser(user, null, x.id, { is_active: x.active });
  if (tests.customers.length || tests.bookings.length) await markAsTest(user, null, tests);
  out.push("applied ✓");
  return out;
}
