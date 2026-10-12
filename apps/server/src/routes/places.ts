// Places (D-137): the official gazetteer for the cascading pickers (province → khan → sangkat → village) and the shop's borey list.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { boreySchema } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import { geoChildren, geoInfo } from "../lib/gazetteer.js";
import { listBoreys, saveBorey, setBoreyActive } from "../services/boreys.js";

const staffOnly = (role: string) => { if (role === "tech") throw new AppError("FORBIDDEN", 403); };
const idParam = z.object({ id: z.string().uuid() });

export const geoRoutes: FastifyPluginAsync = async (app) => {
  // GET /api/geo?parent=<code> → the units directly under it ("" or none = the 25 provinces); the source in the header
  app.get("/", { preHandler: app.requireAuth }, async (req, reply) => {
    staffOnly(req.user!.role);
    const { parent } = z.object({ parent: z.string().regex(/^([0-9]{2}|[0-9]{4}|[0-9]{6})?$/).optional() }).parse(req.query ?? {});
    reply.header("Cache-Control", "private, max-age=86400");
    return { ...geoInfo(), units: geoChildren(parent ?? "") };
  });
};

export const boreysRoutes: FastifyPluginAsync = async (app) => {
  app.get("/", { preHandler: app.requireAuth }, async (req) => {
    staffOnly(req.user!.role);
    return listBoreys(req.user!, (req.query as { all?: string } | undefined)?.all === "1");
  });
  app.post("/", { preHandler: app.requirePerm("customer.manage") }, async (req) => saveBorey(req.user!, req.ip, null, boreySchema.parse(req.body)));
  app.patch("/:id", { preHandler: app.requirePerm("customer.manage") }, async (req) => saveBorey(req.user!, req.ip, idParam.parse(req.params).id, boreySchema.parse(req.body)));
  app.post("/:id/active", { preHandler: app.requirePerm("customer.manage") }, async (req) =>
    setBoreyActive(req.user!, req.ip, idParam.parse(req.params).id, z.object({ active: z.boolean() }).strict().parse(req.body).active));
};
