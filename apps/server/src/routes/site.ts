// Public shop website (flag "website", D-96 · final combined brief D-106) — no staff login anywhere here.
//   pages      /  (wired in app.ts) · /book · /book/done/<ref> · /quote · /quote/done/<ref> · /my · /my/bookings · /my/b/<id> · /my/login · /my/reset · /privacy · /terms · /robots.txt
//   public API /api/public/slots · bookings · quotes · login · account · pin-code · pin-reset · track · tg-login · maps   (form token, honeypot, rate limits, locks)
//   Telegram   /api/customer/tg-auth — the Mini App's launch data → customer session, BEFORE the page is shown (D-121)
//   customer   /api/my …                                                  (customer session cookie "otc" — own data only)
//   files      /pub/<file> + /pub/fonts/<file> (the site's css, js, fonts) · /pub/img/<id> (website photos) · /pub/logo
// And the staff side: Settings → Website, and the customer requests inbox with its decisions (confirm / decline / approve / reject).
// D-191 (owner): the customer account = phone + a 4-digit PIN chosen on the website; nothing is ever sent by Telegram but a one-time
// reset code. Customer form posts from another site are refused (Origin check) on top of the SameSite cookie.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CUSTOMER_SESSION_DAYS, formatKhPhone, isAllowedMapsHost, WEB_CATEGORIES, WEB_MAX_BOOKING_PHOTOS, isNight, overridesSchema, parseLatLng, parseWebLines, webLinesParam } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { clock } from "../lib/clock.js";
import { AppError, unauthenticated } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { changeCustomerPin, createAccountFromBooking, logoutEverywhere, pinLogin, resetPinWithCode, sendPinCode } from "../services/customer-auth.js";
import { cancelByCustomer, CUSTOMER_COOKIE, customerLogin, customerLogout, decideReschedule, myBookingDetail, myHome, myPrefs, mySlots, rateBooking, rebookPlace, requestReschedule, resolveCustomerSession,
  setMyPrefs, type CustomerSession } from "../services/customer-home.js";
import { listRequests, markRequestDone } from "../services/requests.js";
import { addSitePhoto, formToken, getSiteSettings, readSiteImage, readSiteLogo, removeSitePhoto, saveSite, siteData, sitePatch, type SiteView } from "../services/site.js";
import { flushOutbox } from "../services/telegram.js";
import { decideWebBooking, doneView, publicSlots, quoteDoneView, readRequestPhoto, resolveLines, slotGrid, submitQuote, submitWebBooking } from "../services/web-booking.js";
import { deletePost, listPosts, postPhoto, publicPost, publicPosts, savePost } from "../services/site-posts.js";
import { assets, bookingPage, bookPage, categoryPage, donePage, gatePage, guidePage, helpPage, homePage, newsPage, postPage, legalSitePage, loginPage, myPage, notFoundPage, quoteDonePage, quotePage, resetPage, robotsTxt, trackHtml, type Prefill, type SiteLang } from "../site/pages.js";
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
const customerCookie = () => ({ path: "/", httpOnly: true, sameSite: "lax" as const, secure: secure(), maxAge: CUSTOMER_SESSION_DAYS * 86400 });
/** the customer session of this device; a session renewed just now gets its cookie again (180 days from today — D-191) */
async function sessionOf(req: FastifyRequest, reply: FastifyReply): Promise<CustomerSession | null> {
  const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
  if (s?.renewed) reply.setCookie(CUSTOMER_COOKIE, req.cookies[CUSTOMER_COOKIE]!, customerCookie());
  return s;
}
/** the lines of the address: ?items=<id>:<qty>,… (or ?service=<id> of older links) */
const linesOf = (req: FastifyRequest) => {
  const q = (req.query as { items?: string; service?: string } | undefined) ?? {};
  return parseWebLines(q.items ?? (q.service && /^[0-9a-f-]{36}$/.test(q.service) ? `${q.service}:1` : null));
};
/** the session's customer record (its PIN account, else the record linked to its Telegram chat): name + phone for the booking form */
async function customerOf(companyId: string, who: { customerId?: string | null; subscriberId?: number | null }): Promise<Prefill | null> {
  if (!who.customerId && !who.subscriberId) return null;
  const c = (await sql<{ name: string; phone: string | null }[]>`select name, phones[1] as phone from customers where company_id = ${companyId} and is_active and
    ${who.customerId ? sql`id = ${who.customerId}` : sql`tg_subscriber_id = ${who.subscriberId!}`} order by created_at limit 1`)[0];
  return c ? { name: c.name, phone: formatKhPhone(c.phone) } : null;
}
/** a signed-in customer: name and phone are filled in, and the booking is linked at once (signed = there is a customer session) */
async function prefillOf(req: FastifyRequest, reply: FastifyReply): Promise<{ prefill: Prefill | null; signed: boolean; s: CustomerSession | null }> {
  const s = await sessionOf(req, reply);
  return s ? { prefill: await customerOf(s.companyId, s), signed: true, s } : { prefill: null, signed: false, s: null };
}
/** D-121: where the sign-in page returns to — a customer page only (never another site) */
const NEXT_OK = new Set(["/my", "/my/bookings", "/book"]);
const safeNext = (v: unknown) => (typeof v === "string" && (NEXT_OK.has(v) || /^\/my\/b\/[0-9a-f-]{36}$/.test(v)) ? v : "/my");

/** screen 1 — "/" (app.ts) */
export async function siteHome(req: FastifyRequest, reply: FastifyReply) {
  const lang = langOf(req, reply);
  // D-191: a device signed in to its account opens «ការកក់របស់ខ្ញុំ» straight away (the plain address only — a link with lines books)
  const s = await sessionOf(req, reply);
  if (!req.url.includes("?") && s?.customerId) return reply.redirect("/my/bookings", 302);
  const d = await site(), refs = linesOf(req);
  // D-192: a link with lines (older pages, «change») opens the service page of its first line
  const first = refs?.length ? d.services.find((x) => x.id === refs[0]!.id) : null;
  if (first) return reply.redirect(`/s/${first.web_category ?? "other"}?items=${webLinesParam(refs!)}`, 302);
  return html(reply, 200, homePage(d, lang, pathOf(req), { signed: !!s, posts: await publicPosts(d.companyId, 4) }));
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
  note: z.string().max(600).nullable().optional(), photos: z.array(z.string().max(1_400_000)).max(WEB_MAX_BOOKING_PHOTOS + 2).optional(), ...formGuard }).strict();
const quoteBody = z.object({ items: items.nullable().optional(), category: z.string().max(20).default("other"), description: z.string().max(2000).default(""), photos: z.array(z.string().max(1_400_000)).max(20).optional(),
  name: z.string().max(200).default(""), phone: z.string().max(40).default(""), location: z.string().max(500).optional(), ...coord, ...formGuard }).strict();

export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("website"));
  // D-191 (CSRF): a customer form sent from another site is refused — the browser always names the page's origin on a POST
  const own = new URL(config.publicUrl).origin;
  app.addHook("preHandler", async (req) => {
    if (req.method !== "POST" || !req.url.startsWith("/api/")) return;
    const o = req.headers.origin;
    if (o && o !== own) throw new AppError("FORBIDDEN", 403);
  });
  const customer = async (req: FastifyRequest) => {
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    if (!s) throw unauthenticated();
    return s;
  };

  // ---- pages ----
  app.get("/book", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), refs = linesOf(req);
    // D-121: the bot's «📅» opens /book — the service picker itself (never "/")
    if (!refs) return html(reply, 200, homePage(d, lang, pathOf(req), { start: true, signed: (await prefillOf(req, reply)).signed }));
    const q = req.query as { items?: string; from?: string };
    if (!q.items) return reply.redirect(`/book?items=${webLinesParam(refs)}`, 302); // an older ?service= link
    const r = await resolveLines(sql, d.companyId, refs).catch(() => null);
    if (!r) return reply.redirect("/", 302);
    if (r.quote) return reply.redirect(`/quote?items=${webLinesParam(refs)}`, 302); // quote-only items: the quote screen
    const who = await prefillOf(req, reply);
    // D-191 «book again»: the place of that earlier booking — only when it is this session's own
    const place = who.s && q.from && /^[0-9a-f-]{36}$/.test(q.from) ? await rebookPlace(who.s, q.from) : null;
    const prefill = place ? { name: who.prefill?.name ?? "", phone: who.prefill?.phone ?? "", ...place } : who.prefill;
    return html(reply, 200, bookPage(d, lang, { lines: r, days: await slotGrid(sql, d.companyId, r.minutes), token: formToken(), path: pathOf(req), prefill, signed: who.signed, night: isNight(clock.now(), d.tz, clock.day) }));
  });
  app.get("/book/done/:ref", async (req, reply) => {
    const lang = langOf(req, reply), ref = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).safeParse(req.params);
    if (!ref.success) throw new AppError("NOT_FOUND", 404);
    const v = await doneView(ref.data.ref, await sessionOf(req, reply));
    if (v.account === "mine") return reply.redirect(`/my/b/${v.id}`, 302); // signed in to its account: the booking's own page
    return html(reply, 200, donePage(await site(), lang, v, pathOf(req), ref.data.ref), "no-store");
  });
  /** D-192 one service category (FixME's service page): its services with price + quantity → «continue» → /book?items=… */
  app.get("/s/:cat", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), cat = String((req.params as { cat?: string }).cat ?? "");
    if (!([...WEB_CATEGORIES, "other"] as string[]).includes(cat) || !d.services.some((x) => (x.web_category ?? "other") === cat)) return reply.redirect("/?tab=home", 302);
    return html(reply, 200, categoryPage(d, lang, cat as (typeof WEB_CATEGORIES)[number] | "other", linesOf(req) ?? [], pathOf(req), !!(await sessionOf(req, reply))));
  });
  /** D-193 the shop's posts (FixME's NEWS): the list and one post; the cover photo of a published post is public */
  app.get("/news", async (req, reply) => { const d = await site(); return html(reply, 200, newsPage(d, langOf(req, reply), await publicPosts(d.companyId, 60), pathOf(req), !!(await sessionOf(req, reply)))); });
  app.get("/news/:id", async (req, reply) => {
    const id = z.object({ id: uuid }).safeParse(req.params), d = await site();
    if (!id.success) throw new AppError("NOT_FOUND", 404);
    return html(reply, 200, postPage(d, langOf(req, reply), await publicPost(d.companyId, id.data.id), pathOf(req), !!(await sessionOf(req, reply))));
  });
  app.get("/pub/post/:id", async (req, reply) => image(reply, await postPhoto((await site()).companyId, z.object({ id: uuid }).parse(req.params).id), "public, max-age=3600"));
  /** D-192 «ជំនួយ» — the tab bar's support page */
  app.get("/help", async (req, reply) => html(reply, 200, helpPage(await site(), langOf(req, reply), pathOf(req), !!(await sessionOf(req, reply)))));
  app.get("/quote", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), refs = linesOf(req);
    const r = refs ? await resolveLines(sql, d.companyId, refs).catch(() => null) : null;
    const who = await prefillOf(req, reply);
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
    const s = await sessionOf(req, reply);
    if (!s) return html(reply, 200, gatePage(d, lang, path), "no-store");
    return html(reply, 200, myPage(d, lang, await myHome(s), view === "home" ? await myPrefs(s) : null, path, view), "no-store");
  };
  app.get("/my", customerPage("home"));
  app.get("/my/bookings", customerPage("bookings"));
  /** D-191 one booking (Grab-style): own bookings only — another one is «not found»; without a session the skeleton as on /my */
  app.get("/my/b/:id", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), id = z.object({ id: uuid }).safeParse(req.params);
    if (!id.success) throw new AppError("NOT_FOUND", 404);
    const s = await sessionOf(req, reply);
    if (!s) return html(reply, 200, gatePage(d, lang, `/my/b/${id.data.id}`), "no-store");
    return html(reply, 200, bookingPage(d, lang, await myBookingDetail(s, id.data.id), pathOf(req)), "no-store");
  });
  /** D-191 forgot PIN: a code by Telegram (or from the shop) → a new PIN */
  app.get("/my/reset", async (req, reply) => html(reply, 200, resetPage(await site(), langOf(req, reply), pathOf(req)), "no-store"));
  /** outside Telegram only: phone + password, then back to the page that asked (a live session goes there at once) */
  app.get("/my/login", async (req, reply) => {
    const lang = langOf(req, reply), d = await site(), next = safeNext((req.query as { next?: unknown } | undefined)?.next);
    if (await sessionOf(req, reply)) return reply.redirect(next, 302);
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
  app.post("/api/public/bookings", { bodyLimit: 6_500_000, onRequest: async (req) => { if (!checkRate(`site:book-try:ip:${req.ip}`, 30, 3600)) throw new AppError("RATE_LIMITED", 429); } }, async (req) => {
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
  /** browser sign-in (D-191): phone + PIN (an older password still works). Every failure looks the same; 5 wrong → 15 minutes */
  app.post("/api/public/login", async (req, reply) => {
    const b = z.object({ phone: z.string().max(40), pin: z.string().max(200).optional(), password: z.string().max(200).optional() }).strict().parse(req.body);
    const r = await pinLogin(req.ip, b.phone, b.pin ?? b.password ?? "");
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return { ok: true };
  });
  /** D-191 right after a booking: the account (PIN twice) — the booking's own address is the key; this device is signed in */
  app.post("/api/public/account", async (req, reply) => {
    const b = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/), name: z.string().max(200).default(""), phone: z.string().max(40), address: z.string().max(500).nullable().optional(), ...coord,
      pin: z.string().max(20), pin2: z.string().max(20) }).strict().parse(req.body);
    const r = await createAccountFromBooking(req.ip, b);
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return { ok: true, next: `/my/b/${r.booking_id}` };
  });
  /** D-191 forgot PIN: a code into the Telegram chat linked to the number (the same answer for every number) */
  app.post("/api/public/pin-code", async (req) => sendPinCode(req.ip, z.object({ phone: z.string().max(40) }).strict().parse(req.body).phone));
  app.post("/api/public/pin-reset", async (req, reply) => {
    const b = z.object({ phone: z.string().max(40), code: z.string().max(20), pin: z.string().max(20), pin2: z.string().max(20) }).strict().parse(req.body);
    const r = await resetPinWithCode(req.ip, b);
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return { ok: true };
  });
  /** D-191 the guest's tracking page asks every 30 s: the state + the timeline (no personal data) */
  app.get("/api/public/track/:ref", async (req, reply) => {
    if (!checkRate(`site:track:ip:${req.ip}`, 120, 60)) throw new AppError("RATE_LIMITED", 429);
    const ref = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).parse(req.params).ref, d = await site(), lang = langOf(req, reply);
    const v = await doneView(ref);
    reply.header("Cache-Control", "no-store");
    return { state: v.state, html: trackHtml(lang, v.track, d.tz) };
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
    const c = await customerOf(r.companyId, { subscriberId: r.subscriberId });
    return { ok: true, name: c?.name ?? null, phone: c?.phone || null };
  };
  app.post("/api/customer/tg-auth", tgAuth);
  app.post("/api/public/tg-login", tgAuth);

  // ---- customer home API: every call is bound to the session's own bookings ----
  app.get("/api/my", async (req, reply) => { reply.header("Cache-Control", "no-store"); return myHome(await customer(req)); });
  /** D-191 one booking + its timeline as HTML (the page swaps it in every 30 s) */
  app.get("/api/my/bookings/:id", async (req, reply) => {
    const s = await customer(req), d = await site();
    const b = await myBookingDetail(s, z.object({ id: uuid }).parse(req.params).id);
    reply.header("Cache-Control", "no-store");
    return { ...b, html: trackHtml(langOf(req, reply), b.track, d.tz) };
  });
  app.post("/api/my/bookings/:id/rating", async (req) => {
    const s = await customer(req);
    const b = z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(500).default("") }).strict().parse(req.body);
    return rateBooking(s, req.ip, z.object({ id: uuid }).parse(req.params).id, b.stars, b.comment);
  });
  /** sign out on every device (this one too) */
  app.post("/api/my/logout-all", async (req, reply) => {
    const r = await logoutEverywhere(await customer(req), req.ip);
    reply.clearCookie(CUSTOMER_COOKIE, { path: "/" });
    return r;
  });
  app.post("/api/my/logout", async (req, reply) => {
    await customerLogout(req.cookies[CUSTOMER_COOKIE]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: "/" });
    return { ok: true };
  });
  /** profile → change the PIN (the current one first; a Telegram session without a PIN makes one); the other sessions end */
  const changePin = async (req: FastifyRequest) => {
    const s = await customer(req);
    const b = z.object({ current: z.string().max(200).default(""), next: z.string().max(20), next2: z.string().max(20).optional() }).strict().parse(req.body);
    return changeCustomerPin(s, req.ip, b.current, b.next, b.next2);
  };
  app.post("/api/my/pin", changePin);
  app.post("/api/my/password", changePin); // pages loaded before D-191
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

/** D-193 the shop's posts — staff with «site.post» (default CEO, GM, Admin) write them; every change audited */
export const postsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("website"));
  const can = { preHandler: app.requirePerm("site.post") };
  const body = z.object({ id: uuid.nullable().optional(), title: z.string().max(200), body: z.string().max(3000).nullable().optional(), video_url: z.string().max(500).nullable().optional(),
    published: z.boolean().optional(), photo: z.string().max(2_800_000).nullable().optional() }).strict();
  app.get("/", can, async (req) => listPosts(req.user!));
  app.post("/", { ...can, bodyLimit: 3_000_000 }, async (req) => savePost(req.user!, req.ip, body.parse(req.body)));
  app.delete("/:id", can, async (req) => deletePost(req.user!, req.ip, z.object({ id: uuid }).parse(req.params).id));
  app.get("/:id/photo", can, async (req, reply) => image(reply, await postPhoto(req.user!.companyId, z.object({ id: uuid }).parse(req.params).id, true), "private, max-age=600"));
};

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
    const b = z.object({ minutes: z.number().int().min(15).max(1440).optional(), lead: uuid.nullable().optional(), assistants: z.array(uuid).max(10).optional(), vehicle_id: uuid.nullable().optional(), overrides: overridesSchema }).strict().parse(req.body ?? {});
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
