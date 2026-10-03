// Subscribe + Broadcast (A4/A5 · flag "subscribe" · permission customer.manage).
// Subscribers live in the hub; the shop reads its own list and asks the hub to broadcast to it.
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { z } from "zod";
import { deepLink, PROMO_GAP_DAYS_DEFAULT, PROMO_MAX_LINES, PROMO_ROLES, SUBSCRIBE_PAYLOAD } from "@sms/shared";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { hubCall, shopBotUsername } from "../services/hub-client.js";

// D-106: promotions only — service messages are about the customer's own bookings. CEO / GM write them (preview first); at most
// 4 lines; the hub sends one per customer per «days between promotions» (Settings → Website, default 7) and never 20:00–08:00.
const promoText = z.string().trim().min(1, "REQUIRED").max(400, "TOO_LONG").refine((t) => t.split("\n").length <= PROMO_MAX_LINES, "TOO_MANY_LINES");
const broadcastSchema = z.object({ kind: z.literal("promo").optional(), text: promoText, valid_days: z.number().int().min(1).max(90).optional() }).strict();
async function gapDays(companyId: string): Promise<number> {
  const g = (await sql<{ g: number | null }[]>`select (website->>'promo_gap_days')::int as g from company_settings where company_id = ${companyId}`)[0]?.g;
  return g && g >= 1 && g <= 60 ? g : PROMO_GAP_DAYS_DEFAULT;
}

function passHubError(r: { status: number; json: any }): never {
  throw new AppError(String(r.json?.error ?? "HUB_ERROR"), r.status >= 400 && r.status < 500 ? r.status : 502);
}

export const subscribeRoutes: FastifyPluginAsync = async (app) => {
  const guard = [app.requireFeature("subscribe"), app.requirePerm("customer.manage")];

  app.get("/", { preHandler: guard }, async () => {
    const r = await hubCall("GET", "/internal/subscribers");
    if (r.status !== 200) passHubError(r);
    const bot = await shopBotUsername(); // T3: Subscribe = t.me/<shop bot>?start=s
    return { link: bot ? deepLink(bot, SUBSCRIBE_PAYLOAD) : null, bot, ...r.json };
  });

  app.get("/broadcasts", { preHandler: guard }, async () => {
    const r = await hubCall("GET", "/internal/broadcasts");
    if (r.status !== 200) passHubError(r);
    return r.json;
  });

  const promoGuard = [...guard, async (req: FastifyRequest) => { if (!PROMO_ROLES.includes(req.user!.role)) throw new AppError("FORBIDDEN", 403); }];
  /** what the customers will see, and how many get it now (opted in, no promotion in the last N days) */
  app.post("/broadcast/preview", { preHandler: promoGuard }, async (req) => {
    const b = broadcastSchema.pick({ text: true }).parse(req.body);
    const r = await hubCall("POST", "/internal/broadcast/preview", { text: b.text, gap_days: await gapDays(req.user!.companyId) });
    if (r.status !== 200) passHubError(r);
    return { ...r.json, gap_days: await gapDays(req.user!.companyId) };
  });
  app.post("/broadcast", { preHandler: promoGuard }, async (req) => {
    const b = broadcastSchema.parse(req.body);
    const r = await hubCall("POST", "/internal/broadcast", { text: b.text, ...(b.valid_days ? { valid_days: b.valid_days } : {}), gap_days: await gapDays(req.user!.companyId), created_by_name: req.user!.fullName });
    if (r.status !== 200) passHubError(r);
    await audit(sql, { companyId: req.user!.companyId, userId: req.user!.id, action: "broadcast.send", table: "hub_broadcasts", rowId: String(r.json.id),
      new: { kind: "promo", recipients: r.json.recipients, length: b.text.length }, ip: req.ip });
    return r.json;
  });
};
