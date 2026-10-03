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
import { botLocation, botStart, botText, keyboardForChat, renderMenu } from "../services/telegram-menu.js";
import { telegramAttendance } from "../services/attendance.js";
import { customerSubscribed } from "../services/reminders.js";

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

  /** inline callback views (D-74/D-91): v:<view>[:<uuid>:<arg>]. The chat id comes from Telegram via the hub; the shop decides who it is. */
  app.post("/tg-menu", async (req) => {
    const b = z.object({ chat_id: z.number().int(), view: z.string().regex(/^[a-z_]{2,20}$/), id: z.string().uuid().optional(), arg: z.string().regex(/^[a-z_]{1,12}$/).optional(), back: z.string().regex(/^[a-z_]{1,12}$/).optional() }).strict().parse(req.body);
    return { menu: await renderMenu(b.chat_id, b.view, b.id ?? null, b.arg ?? b.back ?? null) };
  });
  const who = z.object({ chat_id: z.number().int(), tg_user: z.number().int(), subscriber_id: z.number().int().positive().optional().nullable() });
  /** D-91: /start in a private chat → role menu (staff) or customer menu (a hub subscriber linked to a customer) */
  app.post("/tg-start", async (req) => { const b = who.strict().parse(req.body); return botStart(b.chat_id, b.subscriber_id); });
  /** D-91: a keyboard label or a free text in a private chat (answers to «find customer», «request service», a review note) */
  app.post("/tg-text", async (req) => { const b = who.extend({ text: z.string().min(1).max(1000) }).strict().parse(req.body); return botText(b.chat_id, b.text, b.subscriber_id); });
  /** D-91: a location in a private chat → the pending «arrive» step, else attendance (FR-902); the role keyboard comes back with the answer */
  app.post("/tg-location", async (req) => {
    const b = z.object({ chat_id: z.number().int(), tg_user: z.number().int(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      accuracy: z.number().min(0).max(100_000).nullable(), sent_at: z.number().int() }).strict().parse(req.body);
    return { reply: await botLocation(b), keyboard: await keyboardForChat(b.chat_id) };
  });

  /** FR-902: a location sent to the shop bot in a private chat → check in / out (the shop identifies the linked staff member) */
  app.post("/tg-attendance", async (req) => {
    const b = z.object({ chat_id: z.number().int(), tg_user: z.number().int(), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180),
      accuracy: z.number().min(0).max(100_000).nullable(), sent_at: z.number().int() }).strict().parse(req.body);
    return { reply: await telegramAttendance(b) };
  });

  /** A2: the customer ticked the consent from their own link t.me/<bot>?start=s_<code> → the shop links the hub subscriber */
  app.post("/customer-subscribed", async (req) => {
    const b = z.object({ code: z.string().regex(/^[A-HJ-NP-Z2-9]{8}$/), subscriber_id: z.number().int().positive() }).strict().parse(req.body);
    return customerSubscribed(b.code, b.subscriber_id);
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
