// Hub → shop internal API (D-51). Reachable only on the compose network (caddy answers 404 for /internal/*),
// and every call must carry this shop's key (x-hub-key, constant-time compare).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { safeEqual } from "../lib/secure.js";
import { consumeGroupCode, consumeLinkCode } from "../services/telegram.js";

const tgSchema = z.object({
  kind: z.enum(["link", "group"]),
  code: z.string().max(40),
  tg_user: z.number().int(),
  chat_id: z.number().int(),
  chat_title: z.string().max(200).optional().default(""),
}).strict();

export const internalRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("onRequest", async (req) => {
    const key = config.shop.hubKey;
    if (!key || !safeEqual(String(req.headers["x-hub-key"] ?? ""), key)) throw new AppError("FORBIDDEN", 403);
  });

  app.post("/telegram", async (req) => {
    const b = tgSchema.parse(req.body);
    if (!b.code.toUpperCase().startsWith(`${config.shop.code}-`)) return { ok: false, error: "WRONG_SHOP", reply: "❌ កូដនេះមិនមែនសម្រាប់ហាងនេះទេ។" };
    const code = b.code.toUpperCase();
    return b.kind === "link" ? consumeLinkCode(code, b.tg_user, b.chat_id) : consumeGroupCode(code, b.chat_id, b.chat_title.slice(0, 120));
  });

  /** aggregate numbers only (A4: non-subscriber data stays in the shop; the platform sees totals) */
  app.get("/stats", async () => {
    const r = (await sql<{ companies: number; users: number; customers: number; bookings: number; bookings_30d: number; last_booking: Date | null }[]>`
      select (select count(*) from companies where is_active)::int as companies,
             (select count(*) from users where is_active)::int as users,
             (select count(*) from customers)::int as customers,
             (select count(*) from bookings)::int as bookings,
             (select count(*) from bookings where created_at > now() - interval '30 days')::int as bookings_30d,
             (select max(created_at) from bookings) as last_booking`)[0]!;
    return { shop: config.shop.code, ...r };
  });
};
