// Hub → shop internal API (D-51). Reachable only on the compose network (caddy answers 404 for /internal/*),
// and every call must carry this shop's key (x-hub-key, constant-time compare).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { safeEqual } from "../lib/secure.js";
import { shopBotCode } from "@sms/shared";
import { consumeGroupCode, consumeLinkCode } from "../services/telegram.js";
import { renderMenu } from "../services/telegram-menu.js";
import { telegramAttendance } from "../services/attendance.js";

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
    // T3: plain codes from this shop's own bot; old prefixed codes only when they carry THIS shop's prefix
    const code = shopBotCode(b.code, config.shop.code, b.kind === "link" ? "staff" : "group");
    if (!code) return { ok: false, error: "WRONG_SHOP", reply: "❌ កូដនេះមិនមែនសម្រាប់ហាងនេះទេ។" };
    return b.kind === "link" ? consumeLinkCode(code, b.tg_user, b.chat_id) : consumeGroupCode(code, b.chat_id, b.chat_title.slice(0, 120));
  });

  /** owner I1: inline menu for a Telegram chat (staff / work group). The chat id comes from Telegram via the hub; the shop decides. */
  app.post("/tg-menu", async (req) => {
    const b = z.object({ chat_id: z.number().int(), view: z.enum(["home", "today", "next", "job", "att", "ghome", "gtoday"]), id: z.string().uuid().optional(), back: z.enum(["today", "next"]).optional() }).strict().parse(req.body);
    return { menu: await renderMenu(b.chat_id, b.view, b.id ?? null, b.back) };
  });

  /** FR-902: a location sent to the shop bot in a private chat → check in / out (the shop identifies the linked staff member) */
  app.post("/tg-attendance", async (req) => {
    const b = z.object({ chat_id: z.number().int(), tg_user: z.number().int(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      accuracy: z.number().min(0).max(100_000).nullable(), sent_at: z.number().int() }).strict().parse(req.body);
    return { reply: await telegramAttendance(b) };
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
