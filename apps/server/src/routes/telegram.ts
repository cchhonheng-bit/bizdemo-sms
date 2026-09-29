// Telegram (shop side, v2.1): staff link code (deep link), group code (settings.manage), manual flush.
// The webhook lives in the hub (hub.hangkh.com/telegram/webhook) — D-50/D-51.
import type { FastifyPluginAsync } from "fastify";
import { config } from "../config.js";
import { createGroupCode, createLinkCode, flushOutbox } from "../services/telegram.js";

export const telegramRoutes: FastifyPluginAsync = async (app) => {
  // app button «ភ្ជាប់ Telegram» → t.me/hangkh_bot?start=ONETEAM-S-XXXXXX
  app.post("/link-code", { preHandler: app.requireAuth }, async (req) => ({ ...(await createLinkCode(req.user!.id, req.user!.companyId)), bot: config.telegram.botUsername }));

  // Settings → Telegram group: "/register ONETEAM-G-XXXXXX" (24 h, single use)
  app.post("/group-code", { preHandler: app.requirePerm("settings.manage") }, async (req) => ({ ...(await createGroupCode(req.user!.id, req.user!.companyId)), bot: config.telegram.botUsername }));

  // any authenticated user may trigger delivery (harmless; nothing but counts returned — F-M2-08)
  app.post("/flush", { preHandler: app.requireAuth }, async () => flushOutbox());
};
