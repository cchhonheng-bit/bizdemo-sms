// Telegram (shop side, v2.1): staff link code (deep link), group code (settings.manage), manual flush.
// Webhooks live in the hub (hub.hangkh.com/tg/<shop>) — one bot per shop (T1).
import type { FastifyPluginAsync } from "fastify";

import { createGroupCode, createLinkCode, flushOutbox } from "../services/telegram.js";

export const telegramRoutes: FastifyPluginAsync = async (app) => {
  // app button «ភ្ជាប់ Telegram» → t.me/<shop bot>?start=XXXXXXXX
  app.post("/link-code", { preHandler: app.requireAuth }, async (req) => createLinkCode(req.user!.id, req.user!.companyId));

  // Settings → Telegram group: "/register ONETEAM-G-XXXXXX" (24 h, single use)
  app.post("/group-code", { preHandler: app.requirePerm("settings.manage") }, async (req) => createGroupCode(req.user!.id, req.user!.companyId));

  // any authenticated user may trigger delivery (harmless; nothing but counts returned — F-M2-08)
  app.post("/flush", { preHandler: app.requireAuth }, async () => flushOutbox());
};
