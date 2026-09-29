// Subscribe + Broadcast (A4/A5 · flag "subscribe" · permission customer.manage).
// Subscribers live in the hub; the shop reads its own list and asks the hub to broadcast to it.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { deepLink, subscribePayload } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { AppError } from "../lib/errors.js";
import { audit } from "../services/audit.js";
import { hubCall } from "../services/hub-client.js";

const broadcastSchema = z.object({
  kind: z.enum(["service", "promo"]),
  text: z.string().trim().min(1, "REQUIRED").max(1000, "TOO_LONG"),
}).strict();

function passHubError(r: { status: number; json: any }): never {
  throw new AppError(String(r.json?.error ?? "HUB_ERROR"), r.status >= 400 && r.status < 500 ? r.status : 502);
}

export const subscribeRoutes: FastifyPluginAsync = async (app) => {
  const guard = [app.requireFeature("subscribe"), app.requirePerm("customer.manage")];

  app.get("/", { preHandler: guard }, async () => {
    const r = await hubCall("GET", "/internal/subscribers");
    if (r.status !== 200) passHubError(r);
    return { link: deepLink(config.telegram.botUsername, subscribePayload(config.shop.code)), bot: config.telegram.botUsername, ...r.json };
  });

  app.get("/broadcasts", { preHandler: guard }, async () => {
    const r = await hubCall("GET", "/internal/broadcasts");
    if (r.status !== 200) passHubError(r);
    return r.json;
  });

  app.post("/broadcast", { preHandler: guard }, async (req) => {
    const b = broadcastSchema.parse(req.body);
    const r = await hubCall("POST", "/internal/broadcast", { ...b, created_by_name: req.user!.fullName });
    if (r.status !== 200) passHubError(r);
    await audit(sql, { companyId: req.user!.companyId, userId: req.user!.id, action: "broadcast.send", table: "hub_broadcasts", rowId: String(r.json.id),
      new: { kind: b.kind, recipients: r.json.recipients, length: b.text.length }, ip: req.ip });
    return r.json;
  });
};
