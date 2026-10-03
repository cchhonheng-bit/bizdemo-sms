// Public shop website (flag "website", D-95) — no login: the page ("/site"; "/" is wired in app.ts), the request form, the
// thank-you page, website photos + company logo, robots.txt. And the authenticated side: Settings → Website and the list of
// customer requests (Telegram + website) for Admin / GM.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { listRequests, markRequestDone } from "../services/requests.js";
import { addSitePhoto, formToken, getSiteSettings, readSiteImage, readSiteLogo, removeSitePhoto, saveSite, siteData, submitSiteRequest } from "../services/site.js";
import { homePage, robotsTxt, thanksPage, type SiteLang } from "../site/pages.js";

const langOf = (req: FastifyRequest): SiteLang => ((req.query as { lang?: string } | undefined)?.lang === "en" ? "en" : "km");
const html = (reply: FastifyReply, status: number, body: string) => reply.status(status).type("text/html; charset=utf-8").header("Cache-Control", "no-cache").send(body);
const image = (reply: FastifyReply, f: { mime: string; data: Buffer }) => reply.type(f.mime).header("Cache-Control", "public, max-age=86400").header("X-Content-Type-Options", "nosniff").send(f.data);

/** the page itself — also served at "/" to visitors without a session (app.ts) */
export async function siteHome(req: FastifyRequest, reply: FastifyReply, path: "/" | "/site" = "/") {
  const d = await siteData();
  if (!d) throw new AppError("NOT_FOUND", 404);
  return html(reply, 200, homePage(d, langOf(req), { token: formToken(), path }));
}

export const siteRoutes: FastifyPluginAsync = async (app) => {
  // the form posts as a normal HTML form (the page has no script)
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 20_000 }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(String(body))));
  });
  app.addHook("preHandler", app.requireFeature("website"));

  app.get("/site", async (req, reply) => siteHome(req, reply, "/site"));
  app.post("/site/request", async (req, reply) => {
    const f = z.record(z.string().max(2000)).parse(req.body ?? {});
    const lang = langOf(req);
    const r = await submitSiteRequest(req.ip, { ...f, lang });
    if (r.ok) return reply.redirect(`/site/thanks${lang === "en" ? "?lang=en" : ""}`, 303);
    const d = await siteData();
    if (!d) throw new AppError("NOT_FOUND", 404);
    return html(reply, r.status, homePage(d, lang, { token: formToken(), path: "/site", errors: r.errors, values: f }));
  });
  app.get("/site/thanks", async (req, reply) => {
    const d = await siteData();
    if (!d) throw new AppError("NOT_FOUND", 404);
    return html(reply, 200, thanksPage(d, langOf(req)));
  });
  app.get("/site/img/:id", async (req, reply) => image(reply, await readSiteImage(z.object({ id: z.string().uuid() }).parse(req.params).id)));
  app.get("/site/logo", async (_req, reply) => image(reply, await readSiteLogo()));
  app.get("/robots.txt", async (_req, reply) => reply.type("text/plain; charset=utf-8").header("Cache-Control", "no-cache").send(robotsTxt((await siteData())?.website.published === true)));
};

const text = (n: number) => z.string().trim().max(n);
const sitePatch = z.object({
  published: z.boolean().optional(),
  name_km: text(120).optional(), name_en: text(120).optional(), phone: text(80).optional(), address: text(300).optional(),
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

/** customer requests from Telegram and the website — the same people as in the bot (booking.create or customer.manage) */
export const requestsRoutes: FastifyPluginAsync = async (app) => {
  const guard = { preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
    await app.requireAuth(req, reply);
    if (!req.perms.includes("booking.create") && !req.perms.includes("customer.manage")) throw new AppError("FORBIDDEN", 403);
  } };
  app.get("/", guard, async (req) => listRequests(req.user!, (req.query as { all?: string } | undefined)?.all === "1"));
  app.post("/:id/done", guard, async (req) => markRequestDone(req.user!, req.ip, z.object({ id: z.string().uuid() }).parse(req.params).id));
};
