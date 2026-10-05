// Public shop website (flag "website", D-96 · final combined brief D-106) — no staff login anywhere here.
//   pages      /  (wired in app.ts) · /book · /book/done/<ref> · /quote · /quote/done/<ref> · /my · /my/bookings · /my/login · /privacy · /terms · /robots.txt
//   public API /api/public/slots · bookings · quotes · login · tg-login · maps   (form token, honeypot, rate limits, locks)
//   Telegram   /api/customer/tg-auth — the Mini App's launch data → customer session, BEFORE the page is shown (D-121)
//   customer   /api/my …                                                  (customer session cookie "otc" — own data only)
//   files      /pub/<file> + /pub/fonts/<file> (the site's css, js, fonts) · /pub/img/<id> (website photos) · /pub/logo
// And the staff side: Settings → Website, and the customer requests inbox with its decisions (confirm / decline / approve / reject).
// CEO (D-106): a new password comes only from the bot — the website has no reset form; its «forgot password» opens the bot.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isAllowedMapsHost, isNight, parseLatLng, parseWebLines, webLinesParam } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { clock } from "../lib/clock.js";
import { AppError, unauthenticated } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { changeCustomerPassword, passwordLogin } from "../services/customer-auth.js";
import { cancelByCustomer, CUSTOMER_COOKIE, customerLogin, customerLogout, decideReschedule, myHome, myPrefs, mySlots, requestReschedule, resolveCustomerSession, setMyPrefs } from "../services/customer-home.js";
import { listRequests, markRequestDone } from "../services/requests.js";
import { addSitePhoto, formToken, getSiteSettings, readSiteImage, readSiteLogo, removeSitePhoto, saveSite, siteData, type SiteView } from "../services/site.js";
import { flushOutbox } from "../services/telegram.js";
import { decideWebBooking, doneView, publicSlots, quoteDoneView, readRequestPhoto, resolveLines, slotGrid, submitQuote, submitWebBooking } from "../services/web-booking.js";
import { assets, bookPage, donePage, gatePage, guidePage, homePage, legalSitePage, loginPage, myPage, notFoundPage, quoteDonePage, quotePage, robotsTxt, type Prefill, type SiteLang } from "../site/pages.js";
import { customerGuide, customerVideoPath, sendGuideFile } from "../services/guide.js";
import { expandMapsLink } from "./maps.js";

const LANG_COOKIE = "sl";
const secure = () => config.publicUrl.startsWith("https://");
/** ?lang=en|km wins and is remembered; else the cookie; else Khmer */
function langOf(req: FastifyRequest, reply: FastifyReply): SiteLang {
  const q = (req.query as { lang?: string } | undefined)?.lang;
  if (q === "en" || q === "km") { reply.setCookie(LANG_COOKIE, q, { path: "/", maxAge: 365 * 86400, sameSite: "lax", secure: secure() }); return q; }
  return req.cookies[LANG_COOKIE] === "en" ? "en" : "km";
}
const html = (reply: FastifyReply, status: number, body: string, cache = "no-cache") => reply.status(status).type("text/html; charset=utf-8").header("Cache-Control", cache).send(body);
const image = (reply: FastifyReply, f: { mime: string; data: Buffer }, cache = "public, max-age=86400") => reply.type(f.mime).header("Cache-Control", cache).header("X-Content-Type-Options", "nosniff").send(f.data);
/** the path a language switch comes back to (the lang parameter itself removed) */
const pathOf = (req: FastifyRequest) => { const [p, q = ""] = req.url.split("?"); const rest = q.split("&").filter((x) => x && !x.startsWith("lang=")).join("&"); return rest ? `${p}?${rest}` : p!; };
async function site(): Promise<SiteView> {
  const d = await siteData();
  if (!d) throw new AppError("NOT_FOUND", 404);
  return d;
}
const customerCookie = () => ({ path: "/", httpOnly: true, sameSite: "lax" as const, secure: secure(), maxAge: config.sessionDays * 86400 });
/** the lines of the address: ?items=<id>:<qty>,… (or ?service=<id> of older links) */
const linesOf = (req: FastifyRequest) => {
  const q = (req.query as { items?: string; service?: string } | undefined) ?? {};
  return parseWebLines(q.items ?? (q.service && /^[0-9a-f-]{36}$/.test(q.service) ? `${q.service}:1` : null));
};
/** the customer record linked to a Telegram subscriber: name + phone for the booking form */
async function customerOf(companyId: string, subscriberId: number): Promise<Prefill | null> {
  const c = (await sql<{ name: string; phone: string | null }[]>`select name, phones[1] as phone from customers where company_id = ${companyId} and tg_subscriber_id = ${subscriberId} and is_active order by created_at limit 1`)[0];
  return c ? { name: c.name, phone: c.phone ?? "" } : null;
}
/** a signed-in customer: name and phone are filled in, and the booking is linked at once (signed = there is a customer session) */
async function prefillOf(req: FastifyRequest): Promise<{ prefill: Prefill | null; signed: boolean }> {
  const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
  return s ? { prefill: await customerOf(s.companyId, s.subscriberId), signed: true } : { prefill: null, signed: false };
}
/** D-121: where the sign-in page returns to — a customer page only (never another site) */
const NEXT_OK = new Set(["/my", "/my/bookings", "/book"]);
const safeNext = (v: unknown) => (typeof v === "string" && NEXT_OK.has(v) ? v : "/my");

/** screen 1 — "/" (app.ts) */
export async function siteHome(req: FastifyRequest, reply: FastifyReply) {
  const lang = langOf(req, reply);
  return html(reply, 200, homePage(await site(), lang, pathOf(req), linesOf(req)));
}
/** an unknown address on the public side: the site's own «not found» for browsers, JSON for everything else */
export async function siteNotFound(req: FastifyRequest, reply: FastifyReply) {
  const d = String(req.headers.accept ?? "").includes("text/html") ? await siteData().catch(() => null) : null;
  if (!d) return reply.status(404).send({ error: "NOT_FOUND" });
  return html(reply, 404, notFoundPage(d, req.cookies[LANG_COOKIE] === "en" ? "en" : "km"));
}
/** /privacy and /terms: public, never a login; back = the previous page, else "/" (D-106) */
export async function siteLegal(req: FastifyRequest, reply: FastifyReply, which: "privacy" | "terms") {
  const lang = langOf(req, reply);
  return html(reply, 200, legalSitePage(await site(), lang, which, pathOf(req)), "public, max-age=600");
}

// ---------- /pub: the site's own static files (always there; the pages that use them are behind the flag) ----------
const PUB_MIME: Record<string, string> = { css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", woff2: "font/woff2", png: "image/png", svg: "image/svg+xml" };
export const pubRoutes: FastifyPluginAsync = async (app) => {
  try { // one version for css + js: the pages link them as ?v=<hash>, so a deploy is picked up at once
    assets.v = createHash("sha256").update(readFileSync(join(config.pubDir, "site.css"))).update(readFileSync(join(config.pubDir, "site.js"))).digest("hex").slice(0, 10);
  } catch { /* no pub folder (hub mode never serves it) */ }
  const serve = async (reply: FastifyReply, dir: string, file: string, re: RegExp, cache: string) => {
    const m = re.exec(file);
    if (!m) return reply.status(404).send({ error: "NOT_FOUND" });
    try {
      const data = await readFile(join(dir, file));
      return reply.type(PUB_MIME[m[1]!]!).header("Cache-Control", cache).header("X-Content-Type-Options", "nosniff").send(data);
    } catch { return reply.status(404).send({ error: "NOT_FOUND" }); }
  };
  app.get("/:file", async (req, reply) => serve(reply, config.pubDir, String((req.params as { file?: string }).file ?? ""), /^[a-z0-9_-]{1,40}\.(css|js|png|svg)$/, "public, max-age=604800"));
  app.get("/fonts/:file", async (req, reply) => serve(reply, join(config.pubDir, "fonts"), String((req.params as { file?: string }).file ?? ""), /^[a-z0-9_-]{1,60}\.(woff2)$/, "public, max-age=31536000, immutable"));
};

const uuid = z.string().uuid();
const coord = { lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional(), accuracy: z.number().min(0).max(1_000_000).nullable().optional() };
const formGuard = { ts: z.string().max(60).optional(), company_url: z.string().max(300).optional(), lang: z.enum(["km", "en"]).optional(), consent: z.boolean().optional(), init_data: z.string().max(4000).nullable().optional() };
const items = z.string().max(400);
const bookingBody = z.object({ items, at: z.string().max(40), address: z.string().max(500).default(""), ...coord, name: z.string().max(200).default(""), phone: z.string().max(40).default(""),
  note: z.string().max(600).nullable().optional(), ...formGuard }).strict();
const quoteBody = z.object({ items: items.nullable().optional(), category: z.string().max(20).default("other"), description: z.string().max(2000).default(""), photos: z.array(z.string().max(1_400_000)).max(20).optional(),
  name: z.string().max(200).default(""), phone: z.string().max(40).default(""), location: z.string().max(500).optional(), ...coord, ...formGuard }).strict();

export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("website"));
  const customer = async (req: FastifyRequest) => {
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    if (!s) throw unauthenticated();
    return s;
  };

  // ---- pages ----
  app.get("/book", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), refs = linesOf(req);
    // D-121: the bot's «📅» opens /book — the service picker itself (never "/")
    if (!refs) return html(reply, 200, homePage(d, lang, pathOf(req), null, { start: true, signed: (await prefillOf(req)).signed }));
    const q = req.query as { items?: string };
    if (!q.items) return reply.redirect(`/book?items=${webLinesParam(refs)}`, 302); // an older ?service= link
    const r = await resolveLines(sql, d.companyId, refs).catch(() => null);
    if (!r) return reply.redirect("/", 302);
    if (r.quote) return reply.redirect(`/quote?items=${webLinesParam(refs)}`, 302); // quote-only items: the quote screen
    const who = await prefillOf(req);
    return html(reply, 200, bookPage(d, lang, { lines: r, days: await slotGrid(sql, d.companyId, r.minutes), token: formToken(), path: pathOf(req), prefill: who.prefill, signed: who.signed, night: isNight(clock.now(), d.tz, clock.day) }));
  });
  app.get("/book/done/:ref", async (req, reply) => {
    const lang = langOf(req, reply), ref = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).safeParse(req.params);
    if (!ref.success) throw new AppError("NOT_FOUND", 404);
    return html(reply, 200, donePage(await site(), lang, await doneView(ref.data.ref), pathOf(req)), "no-store");
  });
  app.get("/quote", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), refs = linesOf(req);
    const r = refs ? await resolveLines(sql, d.companyId, refs).catch(() => null) : null;
    const who = await prefillOf(req);
    return html(reply, 200, quotePage(d, lang, { lines: r, token: formToken(), path: pathOf(req), prefill: who.prefill, signed: who.signed }));
  });
  app.get("/quote/done/:ref", async (req, reply) => {
    const lang = langOf(req, reply), ref = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).safeParse(req.params);
    if (!ref.success) throw new AppError("NOT_FOUND", 404);
    return html(reply, 200, quoteDonePage(await site(), lang, await quoteDoneView(ref.data.ref), pathOf(req)), "no-store");
  });
  app.get("/quote/done", async (_req, reply) => reply.redirect("/", 302)); // the old static «sent» screen
  // D-121 (CEO): the customer's pages — a live session renders at once (no sign-in call); without one, ONLY the skeleton: inside
  // Telegram the page signs in from the launch data and loads again, outside Telegram the sign-in page follows. Never a login form
  // first, never the staff app. /my = the menu button (bookings + settings) · /my/bookings = «📍» (the bookings and their status).
  const customerPage = (view: "home" | "bookings") => async (req: FastifyRequest, reply: FastifyReply) => {
    const lang = langOf(req, reply), d = await site(), path = view === "home" ? "/my" : "/my/bookings";
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    if (!s) return html(reply, 200, gatePage(d, lang, path), "no-store");
    return html(reply, 200, myPage(d, lang, await myHome(s), view === "home" ? await myPrefs(s) : null, path, view), "no-store");
  };
  app.get("/my", customerPage("home"));
  app.get("/my/bookings", customerPage("bookings"));
  /** outside Telegram only: phone + password, then back to the page that asked (a live session goes there at once) */
  app.get("/my/login", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), next = safeNext((req.query as { next?: unknown } | undefined)?.next);
    if (await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE])) return reply.redirect(next, 302);
    return html(reply, 200, loginPage(d, lang, pathOf(req), next), "no-store");
  });
  // D-129: the customers' video guide — public; the videos keep in any cache (the address carries the file's version)
  app.get("/guide", async (req, reply) => {
    const lang = langOf(req, reply);
    return html(reply, 200, guidePage(await site(), lang, await customerGuide(), pathOf(req)));
  });
  app.get("/guide/v/:id", async (req, reply) => sendGuideFile(req, reply, customerVideoPath(z.object({ id: z.string().regex(/^L5-\d{2}$/) }).parse(req.params).id), "video/mp4", "public, max-age=31536000, immutable"));
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").header("Cache-Control", "no-cache").send(robotsTxt((await siteData())?.website.published === true)));
  app.get("/pub/img/:id", async (req, reply) => image(reply, await readSiteImage(z.object({ id: uuid }).parse(req.params).id)));
  app.get("/pub/logo", async (_req, reply) => image(reply, await readSiteLogo(), "public, max-age=3600"));
  // v1 addresses (D-95): everything under /site now lives at "/"
  for (const p of ["/site", "/site/*"]) app.all(p, async (_req, reply) => reply.redirect("/", 301));

  // ---- public API ----
  app.get("/api/public/slots", async (req) => {
    if (!checkRate(`site:slots:ip:${req.ip}`, 120, 60)) throw new AppError("RATE_LIMITED", 429);
    return publicSlots(z.object({ items }).parse(req.query).items);
  });
  /** ONE tap: save (pending, slot held) + consent + the bot link — or, signed in / inside Telegram, linked at once */
  app.post("/api/public/bookings", async (req) => {
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    const r = await submitWebBooking(req.ip, bookingBody.parse(req.body), { session: s });
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush")); // Admin + GM hear about it right away
    return r;
  });
  // photos arrive made smaller by the browser (≤ ~1 MB each); attempts are counted per visitor before the body is read
  app.post("/api/public/quotes", { bodyLimit: 8_000_000, onRequest: async (req) => { if (!checkRate(`site:quote-try:ip:${req.ip}`, 30, 3600)) throw new AppError("RATE_LIMITED", 429); } }, async (req) => {
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    const r = await submitQuote(req.ip, quoteBody.parse(req.body), { session: s });
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
  /** a pasted Google Maps link → coordinates (short links are followed on allowlisted hosts only — S-12) */
  app.post("/api/public/maps", async (req) => {
    if (!checkRate(`site:maps:ip:${req.ip}`, 20, 600)) throw new AppError("RATE_LIMITED", 429);
    const { url } = z.object({ url: z.string().trim().min(1).max(2048) }).strict().parse(req.body);
    const direct = parseLatLng(url);
    if (direct) return direct;
    if (!/^https?:\/\//i.test(url) || !isAllowedMapsHost(url)) throw new AppError("MAP_LINK_INVALID", 400);
    const resolved = await expandMapsLink(url);
    const p = resolved ? parseLatLng(resolved) : null;
    if (!p) throw new AppError("MAP_LINK_INVALID", 400);
    return p;
  });
  /** browser login (D-103): phone + password. Every failure looks the same; the locks are per phone (services/customer-auth.ts) */
  app.post("/api/public/login", async (req, reply) => {
    const b = z.object({ phone: z.string().max(40), password: z.string().max(200) }).strict().parse(req.body);
    const r = await passwordLogin(req.ip, b.phone, b.password);
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return { ok: true };
  });
  /** opened inside Telegram (Mini App): the launch data is the login (D-121: the page calls this BEFORE it shows anything). A live
   *  session of the same person is kept. Answers with the linked customer's name + phone for the booking form. /api/public/tg-login
   *  is the same call for pages loaded before D-121. */
  const tgAuth = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!checkRate(`site:login:ip:${req.ip}`, 10, 60)) throw new AppError("RATE_LIMITED", 429);
    const r = await customerLogin(z.object({ init_data: z.string().min(1).max(4000) }).strict().parse(req.body), req.cookies[CUSTOMER_COOKIE]);
    if ("error" in r) throw new AppError(r.error === "nolink" ? "NOT_LINKED" : "INVALID_CREDENTIALS", r.error === "nolink" ? 409 : 401);
    if (r.token) reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    reply.header("Cache-Control", "no-store");
    const c = await customerOf(r.companyId, r.subscriberId);
    return { ok: true, name: c?.name ?? null, phone: c?.phone || null };
  };
  app.post("/api/customer/tg-auth", tgAuth);
  app.post("/api/public/tg-login", tgAuth);

  // ---- customer home API: every call is bound to the session's own bookings ----
  app.get("/api/my", async (req, reply) => { reply.header("Cache-Control", "no-store"); return myHome(await customer(req)); });
  app.post("/api/my/logout", async (req, reply) => {
    await customerLogout(req.cookies[CUSTOMER_COOKIE]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: "/" });
    return { ok: true };
  });
  /** profile → change password: needs the current one; the other sessions of this customer end */
  app.post("/api/my/password", async (req) => {
    const s = await customer(req);
    const b = z.object({ current: z.string().max(200), next: z.string().max(200) }).strict().parse(req.body);
    return changeCustomerPassword(s, req.ip, b.current, b.next);
  });
  /** notification settings (service messages / promotions) — kept by the hub with its consent log */
  app.get("/api/my/prefs", async (req) => (await myPrefs(await customer(req))) ?? { service: false, promo: false });
  app.post("/api/my/prefs", async (req) => {
    const s = await customer(req);
    return setMyPrefs(s, req.ip, z.object({ service: z.boolean(), promo: z.boolean() }).strict().parse(req.body));
  });
  app.get("/api/my/bookings/:id/slots", async (req) => mySlots(await customer(req), z.object({ id: uuid }).parse(req.params).id));
  app.post("/api/my/bookings/:id/cancel", async (req) => {
    const s = await customer(req);
    const { reason } = z.object({ reason: z.string().trim().min(3, "REASON_REQUIRED").max(200) }).strict().parse(req.body);
    const r = await cancelByCustomer(s, req.ip, z.object({ id: uuid }).parse(req.params).id, reason);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
  app.post("/api/my/bookings/:id/reschedule", async (req) => {
    const s = await customer(req);
    const b = z.object({ at: z.string().max(40), reason: z.string().max(300).optional() }).strict().parse(req.body);
    const r = await requestReschedule(s, req.ip, z.object({ id: uuid }).parse(req.params).id, b.at, b.reason ?? "");
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
};

const text = (n: number) => z.string().trim().max(n);
const hm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "BAD_TIME");
const sitePatch = z.object({
  published: z.boolean().optional(),
  name_km: text(120).optional(), name_en: text(120).optional(), short_name: text(40).optional(), phone: text(80).optional(), address: text(300).optional(),
  tagline_km: text(160).optional(), tagline_en: text(160).optional(), about_km: text(1200).optional(), about_en: text(1200).optional(),
  area_km: text(300).optional(), area_en: text(300).optional(), hours_km: text(120).optional(), hours_en: text(120).optional(),
  highlights_km: z.array(text(120)).max(6).optional(), highlights_en: z.array(text(120)).max(6).optional(),
  facebook: z.union([z.literal(""), z.string().max(200).regex(/^https:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\s]+$/, "BAD_URL")]).optional(),
  // D-106 (CEO): online booking hours with the lunch break (One Team to confirm), and the gap between two promotions per customer
  hours: z.object({ open: hm, close: hm, lunch_start: hm, lunch_end: hm }).strict()
    .refine((h) => h.open < h.close && h.lunch_start <= h.lunch_end && (h.lunch_start === h.lunch_end || (h.lunch_start >= h.open && h.lunch_end <= h.close)), "BAD_HOURS").optional(),
  promo_gap_days: z.number().int().min(1).max(60).optional(),
}).strict();

/** Settings → Website (settings.manage) */
export const websiteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("website"));
  const manage = { preHandler: app.requirePerm("settings.manage") };
  app.get("/", manage, async (req) => getSiteSettings(req.user!));
  app.put("/", manage, async (req) => saveSite(req.user!, req.ip, sitePatch.parse(req.body)));
  app.post("/photos", { ...manage, bodyLimit: 3_000_000 }, async (req) => {
    const b = z.object({ slot: z.enum(["hero", "gallery"]), data: z.string().min(10).max(2_800_000) }).strict().parse(req.body);
    return addSitePhoto(req.user!, req.ip, b.slot, b.data);
  });
  app.delete("/photos/:id", manage, async (req) => removeSitePhoto(req.user!, req.ip, z.object({ id: z.string().uuid() }).parse(req.params).id));
};

/** customer requests from Telegram and the website. Reading + «done»: the same people as in the bot (booking.create or
 *  customer.manage). Decisions about a booking (confirm / decline, approve / reject a new time): the staff who take bookings. */
export const requestsRoutes: FastifyPluginAsync = async (app) => {
  const guard = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!req.perms.includes("booking.create") && !req.perms.includes("customer.manage")) throw new AppError("FORBIDDEN", 403);
  } };
  const decide = { preHandler: app.requirePerm("booking.create") };
  const id = (req: FastifyRequest) => z.object({ id: uuid }).parse(req.params).id;
  const reason = (req: FastifyRequest, required: boolean) => z.object({ reason: required ? z.string().trim().min(3, "REASON_REQUIRED").max(200) : z.string().trim().max(200).optional() }).strict().parse(req.body ?? {}).reason ?? "";
  const flush = (req: FastifyRequest) => void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
  app.get("/", guard, async (req) => listRequests(req.user!, (req.query as { all?: string } | undefined)?.all === "1"));
  app.post("/:id/done", guard, async (req) => markRequestDone(req.user!, req.ip, id(req)));
  /** confirm = confirmed + assigned + technicians told (CEO 04-10); the job length may change here too (D-106, minutes) */
  app.post("/:id/confirm", decide, async (req) => {
    const b = z.object({ minutes: z.number().int().min(15).max(1440).optional(), lead: uuid.nullable().optional(), assistants: z.array(uuid).max(10).optional() }).strict().parse(req.body ?? {});
    const r = await decideWebBooking(req.user!, req.ip, id(req), "confirm", "", b); flush(req); return r;
  });
  app.post("/:id/decline", decide, async (req) => { const r = await decideWebBooking(req.user!, req.ip, id(req), "decline", reason(req, true)); flush(req); return r; });
  app.post("/:id/approve", decide, async (req) => { const r = await decideReschedule(req.user!, req.ip, id(req), "approve"); flush(req); return r; });
  app.post("/:id/reject", decide, async (req) => { const r = await decideReschedule(req.user!, req.ip, id(req), "reject", reason(req, false)); flush(req); return r; });
  app.get("/:id/photos/:file", guard, async (req, reply) => {
    const p = z.object({ id: uuid, file: uuid }).parse(req.params);
    return image(reply, await readRequestPhoto(req.user!, p.id, p.file), "private, max-age=3600");
  });
};
