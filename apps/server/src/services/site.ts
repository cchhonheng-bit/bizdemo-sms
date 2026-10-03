// Public shop website (flag "website", D-95 · v2 D-96): what the pages show comes from what the shop already keeps — company
// name and logo, the services of the catalog with their «from» price (never the sell price), the working hours, the Telegram
// bot — plus the texts and photos edited in Settings → Website. Only photos uploaded for the website (kind "website") and the
// logo are ever served without a login. The forms (booking, quote) carry a signed timestamp + a hidden field against bots.
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { config } from "../config.js";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { shopBotUsername } from "./hub-client.js";
import { MIME_BY_EXT, saveImage } from "./jobs.js";

export type SiteContent = { published?: boolean; short_name?: string; tagline_km?: string; tagline_en?: string; about_km?: string; about_en?: string; area_km?: string; area_en?: string;
  hours_km?: string; hours_en?: string; facebook?: string; highlights_km?: string[]; highlights_en?: string[]; hero?: string | null; gallery?: string[] };
export type SiteService = { id: string; name_km: string; name_en: string | null; category: string; from_price: number | null; duration_min: number };
export const MAX_GALLERY = 12;

const company = () => (config.siteCompany ? sql`and c.slug = ${config.siteCompany}` : sql``);

/** the company this box shows to the public: SITE_COMPANY (slug) or the first active one (one company per shop box) */
export async function siteCompanyId(): Promise<string | null> {
  return (await sql<{ id: string }[]>`select c.id from companies c where c.is_active ${company()} order by c.created_at limit 1`)[0]?.id ?? null;
}

export async function siteData() {
  const c = (await sql<{ company_id: string; name: string; tz: string; info: Record<string, string> | null; website: SiteContent | null; logo: boolean; lat: string | null; lng: string | null; today: string }[]>`
    select c.id as company_id, c.name, c.timezone as tz, s.company_info as info, s.website, s.logo_path is not null as logo, s.office_lat::text as lat, s.office_lng::text as lng,
      (now() at time zone c.timezone)::date::text as today
    from companies c join company_settings s on s.company_id = c.id where c.is_active ${company()} order by c.created_at limit 1`)[0];
  if (!c) return null;
  // services a visitor can ask for: priced ones first (online booking), then the ones that need a quote
  const services = await sql<SiteService[]>`select id, name_km, name_en, category::text as category, from_price, duration_min from catalog_items
    where company_id = ${c.company_id} and kind = 'service' and is_active order by (from_price is null), category, name_km limit 60`;
  const w = c.website ?? {};
  const ids = [w.hero, ...(w.gallery ?? [])].filter((x): x is string => !!x);
  const live = new Set(ids.length ? (await sql<{ id: string }[]>`select id from job_files where company_id = ${c.company_id} and kind = 'website' and deleted_at is null and id = any(${sql.array(ids)}::uuid[])`).map((r) => r.id) : []);
  return { companyId: c.company_id, name: c.name, tz: c.tz, today: c.today, info: c.info ?? {}, hasLogo: c.logo, services, bot: await shopBotUsername().catch(() => null),
    website: { ...w, hero: w.hero && live.has(w.hero) ? w.hero : null, gallery: (w.gallery ?? []).filter((g) => live.has(g)) } as SiteContent,
    office: c.lat != null && c.lng != null ? { lat: Number(c.lat), lng: Number(c.lng) } : null };
}
export type SiteView = NonNullable<Awaited<ReturnType<typeof siteData>>>;

// ---------- forms without a login: signed timestamp (page age 2 s … 6 h) + honeypot + rate limits instead of a CAPTCHA ----------
const sign = (ts: number) => createHmac("sha256", config.sessionSecret).update(`site-form:${ts}`).digest("base64url").slice(0, 22);
export const formToken = (now = Date.now()): string => { const ts = Math.floor(now / 1000); return `${ts}.${sign(ts)}`; };
export function checkFormToken(tok: string, now = Date.now()): "ok" | "fresh" | "bad" {
  const m = /^(\d{9,11})\.([A-Za-z0-9_-]{22})$/.exec(tok);
  if (!m) return "bad";
  const ts = Number(m[1]), want = Buffer.from(sign(ts)), got = Buffer.from(m[2]!);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return "bad";
  const age = now / 1000 - ts;
  return age < 2 ? "fresh" : age > 6 * 3600 ? "bad" : "ok";
}

// ---------- Settings → Website (settings.manage) ----------
export type SitePatch = Partial<Omit<SiteContent, "hero" | "gallery">> & { name_km?: string; name_en?: string; phone?: string; address?: string };
const INFO_KEYS = ["name_km", "name_en", "phone", "address"] as const;

export async function getSiteSettings(user: SessionUser) {
  const r = (await sql<{ website: SiteContent | null; info: Record<string, string> | null }[]>`select website, company_info as info from company_settings where company_id = ${user.companyId}`)[0];
  if (!r) throw notFound();
  return { website: r.website ?? {}, company_info: r.info ?? {}, url: `${config.publicUrl}/` };
}

/** texts of the page; the company's public name / phone / address live in company_info (the invoice prints the same) */
export async function saveSite(user: SessionUser, ip: string | null, v: SitePatch) {
  return tx(user.id, async (t) => {
    const old = (await t<{ website: SiteContent | null; info: Record<string, string> | null }[]>`select website, company_info as info from company_settings where company_id = ${user.companyId} for update`)[0];
    if (!old) throw notFound();
    const info: Record<string, string> = { ...(old.info ?? {}) };
    const website: Record<string, unknown> = { ...(old.website ?? {}) };
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) continue;
      if ((INFO_KEYS as readonly string[]).includes(k)) { if (val === "") delete info[k]; else info[k] = String(val); }
      else website[k] = val;
    }
    await t`update company_settings set website = ${t.json(website as never)}, company_info = ${t.json(info as never)}, updated_by = ${user.id} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "website.update", table: "company_settings", rowId: user.companyId, old: { website: old.website, company_info: old.info }, new: { website, company_info: info }, ip });
    return { ok: true };
  });
}

export async function addSitePhoto(user: SessionUser, ip: string | null, slot: "hero" | "gallery", data: string) {
  const img = await saveImage(user.companyId, data);
  return tx(user.id, async (t) => {
    const cur = (await t<{ website: SiteContent | null }[]>`select website from company_settings where company_id = ${user.companyId} for update`)[0];
    if (!cur) throw notFound();
    const w: SiteContent = { ...(cur.website ?? {}) };
    if (slot === "gallery" && (w.gallery ?? []).length >= MAX_GALLERY) throw new AppError("TOO_MANY_PHOTOS", 400);
    await t`insert into job_files (id, company_id, booking_id, kind, path, mime, bytes, created_by) values (${img.id}, ${user.companyId}, null, 'website'::job_file_kind, ${img.rel}, ${img.mime}, ${img.bytes}, ${user.id})`;
    if (slot === "hero") {
      if (w.hero) await t`update job_files set deleted_at = now() where id = ${w.hero} and company_id = ${user.companyId} and kind = 'website'`;
      w.hero = img.id;
    } else w.gallery = [...(w.gallery ?? []), img.id];
    await t`update company_settings set website = ${t.json(w as never)}, updated_by = ${user.id} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "website.photo", table: "job_files", rowId: img.id, new: { slot, bytes: img.bytes, mime: img.mime }, ip });
    return { id: img.id };
  });
}

export async function removeSitePhoto(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    const r = await t`update job_files set deleted_at = now() where id = ${id} and company_id = ${user.companyId} and kind = 'website' and deleted_at is null returning id`;
    if (!r.length) throw notFound();
    const cur = (await t<{ website: SiteContent | null }[]>`select website from company_settings where company_id = ${user.companyId} for update`)[0]!;
    const w: SiteContent = { ...(cur.website ?? {}) };
    if (w.hero === id) w.hero = null;
    w.gallery = (w.gallery ?? []).filter((g) => g !== id);
    await t`update company_settings set website = ${t.json(w as never)}, updated_by = ${user.id} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "website.photo_remove", table: "job_files", rowId: id, ip });
    return { ok: true };
  });
}

// ---------- public files: website photos and the company logo only ----------
export async function readUpload(path: string | null | undefined): Promise<{ mime: string; data: Buffer }> {
  if (!path) throw notFound();
  const data = await readFile(join(config.uploadsDir, path)).catch(() => null);
  if (!data) throw notFound();
  return { mime: MIME_BY_EXT[extname(path).slice(1)] ?? "application/octet-stream", data };
}
export async function readSiteImage(id: string) {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  return readUpload((await sql<{ path: string }[]>`select path from job_files where id = ${id} and company_id = ${companyId} and kind = 'website' and deleted_at is null`)[0]?.path);
}
export async function readSiteLogo() {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  return readUpload((await sql<{ path: string | null }[]>`select logo_path as path from company_settings where company_id = ${companyId}`)[0]?.path);
}
