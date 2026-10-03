// Public shop website v2 (flag "website", D-96) — no staff login anywhere here.
//   pages      /  (wired in app.ts) · /book · /book/done/<ref> · /quote · /quote/done · /my · /my/auth · /robots.txt
//   public API /api/public/slots · bookings · quotes · tg-login          (signed form token, honeypot, rate limits)
//   customer   /api/my …                                                  (customer session cookie "otc" — own data only)
//   files      /pub/<file> + /pub/fonts/<file> (the site's css, js, fonts) · /pub/img/<id> (website photos) · /pub/logo
// And the staff side: Settings → Website, and the customer requests inbox with its decisions (confirm / decline / approve / reject).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError, unauthenticated } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { cancelByCustomer, CUSTOMER_COOKIE, customerLogin, customerLogout, decideReschedule, myHome, mySlots, requestReschedule, resolveCustomerSession } from "../services/customer-home.js";
import { listRequests, markRequestDone } from "../services/requests.js";
import { addSitePhoto, formToken, getSiteSettings, readSiteImage, readSiteLogo, removeSitePhoto, saveSite, siteData, type SiteView } from "../services/site.js";
import { flushOutbox } from "../services/telegram.js";
import { decideWebBooking, doneView, publicSlots, readRequestPhoto, slotGrid, submitQuote, submitWebBooking } from "../services/web-booking.js";
import { assets, bookPage, donePage, homePage, loginPage, myPage, notFoundPage, quoteDonePage, quotePage, robotsTxt, type SiteLang } from "../site/pages.js";

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

/** screen 1 — "/" (app.ts) */
export async function siteHome(req: FastifyRequest, reply: FastifyReply) {
  const lang = langOf(req, reply);
  return html(reply, 200, homePage(await site(), lang, pathOf(req)));
}
/** an unknown address on the public side: the site's own «not found» for browsers, JSON for everything else */
export async function siteNotFound(req: FastifyRequest, reply: FastifyReply) {
  const d = String(req.headers.accept ?? "").includes("text/html") ? await siteData().catch(() => null) : null;
  if (!d) return reply.status(404).send({ error: "NOT_FOUND" });
  return html(reply, 404, notFoundPage(d, req.cookies[LANG_COOKIE] === "en" ? "en" : "km"));
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
const coord = { lat: z.number().min(-90).max(90).nullable().optional(), lng: z.number().min(-180).max(180).nullable().optional() };
const formGuard = { ts: z.string().max(60).optional(), company_url: z.string().max(300).optional(), lang: z.enum(["km", "en"]).optional(), consent: z.boolean().optional() };
const bookingBody = z.object({ service_id: uuid, at: z.string().max(40), address: z.string().max(500).default(""), ...coord, name: z.string().max(200).default(""), phone: z.string().max(40).default(""),
  note: z.string().max(600).nullable().optional(), ...formGuard }).strict();
const quoteBody = z.object({ category: z.string().max(20).default("other"), description: z.string().max(2000).default(""), photos: z.array(z.string().max(2_800_000)).max(20).optional(), name: z.string().max(200).default(""),
  phone: z.string().max(40).default(""), location: z.string().max(500).optional(), ...coord, service_id: uuid.nullable().optional(), ...formGuard }).strict();
const WIDGET_KEYS = ["id", "first_name", "last_name", "username", "photo_url", "auth_date", "hash"] as const;

export const siteRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireFeature("website"));
  const customer = async (req: FastifyRequest) => {
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    if (!s) throw unauthenticated();
    return s;
  };

  // ---- pages ----
  app.get("/book", async (req, reply) => {
    const lang = langOf(req, reply), d = await site();
    const id = uuid.safeParse((req.query as { service?: string } | undefined)?.service);
    const first = d.services.find((s) => s.from_price != null);
    if (!id.success) return reply.redirect(first ? `/book?service=${first.id}` : "/quote", 302);
    const svc = d.services.find((s) => s.id === id.data);
    if (!svc) return reply.redirect("/", 302);
    if (svc.from_price == null) return reply.redirect(`/quote?service=${svc.id}`, 302); // no price → the quote screen
    return html(reply, 200, bookPage(d, lang, { service: { ...svc, from_price: svc.from_price }, days: await slotGrid(sql, d.companyId, svc.duration_min), token: formToken(), path: pathOf(req) }));
  });
  app.get("/book/done/:ref", async (req, reply) => {
    const lang = langOf(req, reply), ref = z.object({ ref: z.string().regex(/^[A-Za-z0-9_-]{22}$/) }).safeParse(req.params);
    if (!ref.success) throw new AppError("NOT_FOUND", 404);
    return html(reply, 200, donePage(await site(), lang, await doneView(ref.data.ref), pathOf(req)), "no-store");
  });
  app.get("/quote", async (req, reply) => {
    const lang = langOf(req, reply), d = await site();
    const id = uuid.safeParse((req.query as { service?: string } | undefined)?.service);
    return html(reply, 200, quotePage(d, lang, { service: id.success ? d.services.find((s) => s.id === id.data) ?? null : null, token: formToken(), path: pathOf(req) }));
  });
  app.get("/quote/done", async (req, reply) => { const lang = langOf(req, reply); return html(reply, 200, quoteDonePage(await site(), lang, pathOf(req))); });
  app.get("/my", async (req, reply) => {
    const lang = langOf(req, reply), d = await site();
    const s = await resolveCustomerSession(req.cookies[CUSTOMER_COOKIE]);
    if (!s) return html(reply, 200, loginPage(d, lang, { error: (req.query as { e?: string } | undefined)?.e ?? null, path: "/my" }), "no-store");
    return html(reply, 200, myPage(d, lang, await myHome(s), "/my"), "no-store");
  });
  /** the Telegram Login Widget sends the visitor back here with the signed fields; the hub checks them with the bot token */
  app.get("/my/auth", async (req, reply) => {
    if (!checkRate(`site:login:ip:${req.ip}`, 10, 60)) throw new AppError("RATE_LIMITED", 429);
    const q = (req.query ?? {}) as Record<string, unknown>, data: Record<string, string> = {};
    for (const k of WIDGET_KEYS) if (typeof q[k] === "string" && (q[k] as string).length <= 400) data[k] = q[k] as string;
    const r = await customerLogin({ widget: data });
    if ("error" in r) return reply.redirect(`/my?e=${r.error}`, 302);
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return reply.redirect("/my", 302);
  });
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").header("Cache-Control", "no-cache").send(robotsTxt((await siteData())?.website.published === true)));
  app.get("/pub/img/:id", async (req, reply) => image(reply, await readSiteImage(z.object({ id: uuid }).parse(req.params).id)));
  app.get("/pub/logo", async (_req, reply) => image(reply, await readSiteLogo(), "public, max-age=3600"));
  // v1 addresses (D-95): everything under /site now lives at "/"
  for (const p of ["/site", "/site/*"]) app.all(p, async (_req, reply) => reply.redirect("/", 301));

  // ---- public API ----
  app.get("/api/public/slots", async (req) => {
    if (!checkRate(`site:slots:ip:${req.ip}`, 120, 60)) throw new AppError("RATE_LIMITED", 429);
    return publicSlots(z.object({ service: uuid }).parse(req.query).service);
  });
  app.post("/api/public/bookings", async (req) => {
    const r = await submitWebBooking(req.ip, bookingBody.parse(req.body));
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush")); // Admin + GM hear about it right away
    return r;
  });
  app.post("/api/public/quotes", { bodyLimit: 15_000_000 }, async (req) => {
    const r = await submitQuote(req.ip, quoteBody.parse(req.body));
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
  /** opened inside Telegram (Mini App): the launch data is the login */
  app.post("/api/public/tg-login", async (req, reply) => {
    if (!checkRate(`site:login:ip:${req.ip}`, 10, 60)) throw new AppError("RATE_LIMITED", 429);
    const r = await customerLogin(z.object({ init_data: z.string().min(1).max(4000) }).strict().parse(req.body));
    if ("error" in r) throw new AppError(r.error === "nolink" ? "NOT_LINKED" : "INVALID_CREDENTIALS", r.error === "nolink" ? 409 : 401);
    reply.setCookie(CUSTOMER_COOKIE, r.token, customerCookie());
    return { ok: true };
  });

  // ---- customer home API: every call is bound to the session's own bookings ----
  app.get("/api/my", async (req, reply) => { reply.header("Cache-Control", "no-store"); return myHome(await customer(req)); });
  app.post("/api/my/logout", async (req, reply) => {
    await customerLogout(req.cookies[CUSTOMER_COOKIE]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: "/" });
    return { ok: true };
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
const sitePatch = z.object({
  published: z.boolean().optional(),
  name_km: text(120).optional(), name_en: text(120).optional(), short_name: text(40).optional(), phone: text(80).optional(), address: text(300).optional(),
  tagline_km: text(160).optional(), tagline_en: text(160).optional(), about_km: text(1200).optional(), about_en: text(1200).optional(),
  area_km: text(300).optional(), area_en: text(300).optional(), hours_km: text(120).optional(), hours_en: text(120).optional(),
  highlights_km: z.array(text(120)).max(6).optional(), highlights_en: z.array(text(120)).max(6).optional(),
  facebook: z.union([z.literal(""), z.string().max(200).regex(/^https:\/\/(www\.|m\.|web\.)?facebook\.com\/[^\s]+$/, "BAD_URL")]).optional(),
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
  app.post("/:id/confirm", decide, async (req) => { const r = await decideWebBooking(req.user!, req.ip, id(req), "confirm"); flush(req); return r; });
  app.post("/:id/decline", decide, async (req) => { const r = await decideWebBooking(req.user!, req.ip, id(req), "decline", reason(req, true)); flush(req); return r; });
  app.post("/:id/approve", decide, async (req) => { const r = await decideReschedule(req.user!, req.ip, id(req), "approve"); flush(req); return r; });
  app.post("/:id/reject", decide, async (req) => { const r = await decideReschedule(req.user!, req.ip, id(req), "reject", reason(req, false)); flush(req); return r; });
  app.get("/:id/photos/:file", guard, async (req, reply) => {
    const p = z.object({ id: uuid, file: uuid }).parse(req.params);
    return image(reply, await readRequestPhoto(req.user!, p.id, p.file), "private, max-age=3600");
  });
};
