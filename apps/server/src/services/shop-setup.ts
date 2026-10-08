// shop-setup (CLI · D-131): what a shop sends for its start (catalog Excel, booking hours, logo, ACLEDA QR, work photos, phone,
// address) loaded through the same functions as the app — Settings → Website (texts, booking hours, photos), Settings → Company
// (invoice logo, ACLEDA QR), Catalog → Excel (same preview, never deletes) and the catalog form (a field by item code). It acts as
// the shop's HangKH Support account (users.is_platform), so the audit log shows every change like one made in the app. It never
// publishes the website (the search-engine tick box stays the shop's). Without `apply` nothing is written: every file is checked
// first and the plan is printed; a bad file stops it before anything is written.
// D-132 (final handover): also a field by code for the invoice price / cost, staff accounts turned off / on by username (the Users
// page's own rules) and existing rows marked as tests (demo customers by phone, demo bookings by number) — never a delete.
// D-136 (test phase): a shared test password on chosen accounts (strength rules waived, audited, ends at a set moment — afterwards a
// new password before anything else) and new test accounts that start on it; the password is read from STDIN, never printed.
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { CATALOG_CODE_RE, createUserSchema, normalizeKhPhone, usernameSchema, type CatalogItemInput } from "@sms/shared";
import { sql } from "../db.js";
import { hashPassword } from "../lib/password.js";
import type { SessionUser } from "./auth.js";
import { applyImport, previewImport, upsertItem } from "./catalog.js";
import { checkImage } from "./jobs.js";
import { addSitePhoto, INFO_KEYS, MAX_GALLERY, removeSitePhoto, saveCompanyImage, saveSite, sitePatch, type SiteContent } from "./site.js";
import { markAsTest } from "./test-mode.js";
import { insertUser, setPasswordRules, setTestPassword, updateUser } from "./users.js";

const image = z.string().min(10).max(2_800_000);
export const shopSetupInput = z.object({
  website: sitePatch.omit({ published: true }).optional(),
  logo: image.optional(), qr: image.optional(), hero: image.optional(),
  gallery: z.array(image).min(1).max(MAX_GALLERY).optional(),
  /** D-134: the new photos take the place of the current ones (each removed as in Settings → Website — the file stays on disk) */
  gallery_replace: z.boolean().optional(),
  catalog_xlsx: z.string().min(10).max(14_000_000).optional(),
  /** after the Excel: a field by item code, like the catalog form (prices in cents, as the API; sell_price = the invoice line's default) */
  catalog: z.array(z.object({ code: z.string().regex(CATALOG_CODE_RE), duration_min: z.number().int().min(15).max(1440).optional(),
    from_price: z.number().int().min(0).max(100_000_000).nullable().optional(), sell_price: z.number().int().min(0).max(100_000_000).optional(),
    cost_price: z.number().int().min(0).max(100_000_000).nullable().optional() }).strict()).max(500).optional(),
  /** staff accounts turned off / on by username — the Users page's rules: never the platform account, a CEO account only by a CEO */
  users: z.array(z.object({ username: z.string().min(1).max(40), active: z.boolean().optional(),
    /** D-135: a new password at the next sign-in · the temporary password stops working at this moment (null = no deadline) */
    must_change: z.literal(true).optional(), temp_expires: z.string().datetime({ offset: true }).nullable().optional(),
    /** D-136: a new account (the Users page's fields, never a CEO) — it gets the test password below, never a printed one */
    create: createUserSchema.pick({ full_name: true, role: true, phone: true, email: true }).strict().optional(),
    /** D-136 (test phase): a simple shared password, the strength rules waived, until `temp_expires` (in the future); afterwards the
     *  account sets its own before anything else. Read from the input only — never printed, never stored but as its hash. */
    test_password: z.string().min(6).max(72).optional() }).strict()).max(50).optional(),
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
  const current = s.website?.gallery ?? [], replace = input.gallery_replace === true && gallery.length > 0;
  const have = replace ? 0 : current.length;
  if (have + gallery.length > MAX_GALLERY) throw new Error(`website photos: ${have} now + ${gallery.length} new > ${MAX_GALLERY}`);
  if (gallery.length) out.push(`website photos: ${current.length} → ${have + gallery.length} of ${MAX_GALLERY}${replace ? ` (the ${current.length} current ones replaced)` : ""}`);

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
  const people: { id: string; active: boolean }[] = [], rules: { id: string; mustChange?: boolean; tempExpires?: Date | null }[] = [];
  const made: { username: string; full_name: string; role: string; phone?: string; email?: string }[] = [];
  const testPw: { username: string; id: string | null; password: string; until: Date }[] = []; // id null = made in this run
  if (input.users?.length) {
    const rows = new Map((await sql<{ id: string; username: string; full_name: string; role: string; is_active: boolean; is_platform: boolean; must_change_password: boolean; temp_password_expires_at: Date | null }[]>`
      select id, username, full_name, role::text as role, is_active, is_platform, must_change_password, temp_password_expires_at from users where company_id = ${c.id}`).map((u) => [u.username, u]));
    const yn = (b: boolean) => (b ? "yes" : "no"), when = (d: Date | null) => (d ? d.toISOString() : "—");
    const seen = new Set<string>();
    for (const x of input.users) {
      if (seen.has(x.username)) throw new Error(`user ${x.username}: listed twice`);
      seen.add(x.username);
      const u = rows.get(x.username);
      // D-136: a test password needs its end, in the future; until then no new password is asked (so never with must_change)
      let until: Date | undefined;
      if (x.test_password !== undefined) {
        if (!x.temp_expires) throw new Error(`user ${x.username}: a test password needs temp_expires (its end)`);
        until = new Date(x.temp_expires);
        if (until.getTime() <= Date.now()) throw new Error(`user ${x.username}: the test password's end must be in the future`);
        if (x.must_change) throw new Error(`user ${x.username}: a test password and must_change exclude each other`);
      }
      const bits: string[] = [];
      if (x.create) {
        if (u) throw new Error(`user ${x.username}: the account exists already`);
        if (usernameSchema.safeParse(x.username).data !== x.username) throw new Error(`user ${x.username}: not a valid username (3–30 of a-z 0-9 . _ -)`);
        if (x.create.role === "ceo") throw new Error(`user ${x.username}: a CEO account only by a CEO`);
        if (!until) throw new Error(`user ${x.username}: a new account here needs a test_password (+ temp_expires)`);
        if (x.active === false) throw new Error(`user ${x.username}: a new account starts active`);
        made.push({ username: x.username, ...x.create });
        bits.push(`new account · role ${x.create.role}`);
      } else {
        if (!u) throw new Error(`user: no account "${x.username}"`);
        if (u.is_platform || u.id === user.id) throw new Error(`user ${x.username}: the HangKH Support account is never changed here`);
        // turning an account off / on follows the Users page (a CEO account only by a CEO); the password rules may touch it (as the server's reset-password)
        if (x.active !== undefined && u.role === "ceo" && user.role !== "ceo") throw new Error(`user ${x.username}: a CEO account only by a CEO`);
        if (x.active !== undefined) {
          bits.push(`active ${u.is_active === x.active ? "same" : `${yn(u.is_active)} → ${yn(x.active)}`}`);
          if (u.is_active !== x.active) people.push({ id: u.id, active: x.active });
        }
        if (x.must_change || (x.temp_expires !== undefined && !until)) {
          const exp = x.temp_expires === undefined ? undefined : x.temp_expires === null ? null : new Date(x.temp_expires);
          if (x.must_change) bits.push(`new password at sign-in ${u.must_change_password ? "same" : "no → yes"}`);
          if (exp !== undefined) bits.push(`first password ends ${when(u.temp_password_expires_at)} → ${when(exp)}`);
          rules.push({ id: u.id, mustChange: x.must_change, tempExpires: exp });
        }
      }
      if (until) {
        testPw.push({ username: x.username, id: u?.id ?? null, password: x.test_password!, until });
        bits.push(`test password until ${until.toISOString()} (strength rules waived; then a new password before anything else)`);
      }
      if (!bits.length) throw new Error(`user ${x.username}: nothing to change`);
      out.push(`user ${x.username} (${u?.full_name ?? x.create!.full_name}): ${bits.join(" · ")}`);
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
    const reqs = (await sql<{ n: number }[]>`select count(*)::int as n from service_requests where booking_id = ${b.id} and not is_test`)[0]!.n;
    out.push(`booking ${n} (${b.status}): test ${b.is_test ? "same" : `no → yes${reqs ? ` (+${reqs} customer request${reqs > 1 ? "s" : ""})` : ""}`}`);
    if (!b.is_test) tests.bookings.push(b.id);
  }
  if (!apply) return out;

  // 2 · write, each step through the app's own function (its own transaction + audit row)
  if (input.website) await saveSite(user, null, input.website);
  if (logo) await saveCompanyImage(user, null, "logo", logo);
  if (qr) await saveCompanyImage(user, null, "qr", qr);
  if (hero) await addSitePhoto(user, null, "hero", hero);
  if (replace) for (const id of current) await removeSitePhoto(user, null, id).catch(() => undefined); // gone already = nothing to remove
  for (const g of gallery) await addSitePhoto(user, null, "gallery", g);
  if (input.catalog_xlsx) await applyImport(user, null, Buffer.from(input.catalog_xlsx, "base64"));
  for (const p of input.catalog ?? []) {
    const it = (await catRows(c.id, p.code))[0];
    if (!it) throw new Error(`catalog: no item with code ${p.code}`);
    await upsertItem(user, null, { id: it.id, code: it.code, name_km: it.name_km, name_en: it.name_en ?? "", kind: it.kind as CatalogItemInput["kind"], category: it.category as CatalogItemInput["category"],
      unit: it.unit, sell_price: p.sell_price ?? it.sell_price, duration_min: p.duration_min ?? it.duration_min, ...(p.from_price !== undefined ? { from_price: p.from_price } : {}),
      ...(p.cost_price !== undefined ? { cost_price: p.cost_price } : {}) }, p.cost_price !== undefined);
  }
  const newIds = new Map<string, string>(); // a new account has no usable password until its test password below
  for (const m of made) newIds.set(m.username, await insertUser(user, null, m, await hashPassword(randomBytes(24).toString("base64url"))));
  for (const x of people) await updateUser(user, null, x.id, { is_active: x.active });
  for (const x of testPw) await setTestPassword(user, null, x.id ?? newIds.get(x.username)!, x.password, x.until);
  for (const x of rules) await setPasswordRules(user, null, x.id, x);
  if (tests.customers.length || tests.bookings.length) await markAsTest(user, null, tests);
  out.push("applied ✓");
  return out;
}
