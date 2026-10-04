// /api/guide — the all-guide page (CEO 04-10, D-128): the shop's CEO and the platform account only.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { GUIDE_VIDEO_ID } from "@sms/shared";
import { guideAccess, guideOverview, guidePdfPath, guideVideoPath, saveGuideReview, sendGuideFile } from "../services/guide.js";

export const guideRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  const id = (req: { params: unknown }) => z.object({ id: z.string().regex(GUIDE_VIDEO_ID) }).parse(req.params).id;
  app.get("/", async (req) => { await guideAccess(req.user!); return guideOverview(req.user!); });
  app.put("/reviews/:id", async (req) => {
    const platform = await guideAccess(req.user!);
    const b = z.object({ verdict: z.enum(["ok", "fix"]), comment: z.string().max(1000).nullable().optional() }).strict().parse(req.body);
    return saveGuideReview(req.user!, req.ip, platform, id(req), b);
  });
  app.get("/videos/:id", async (req, reply) => { await guideAccess(req.user!); return sendGuideFile(req, reply, guideVideoPath(id(req)), "video/mp4"); });
  app.get("/pdf/:tab", async (req, reply) => {
    await guideAccess(req.user!);
    const tab = z.object({ tab: z.string().max(20) }).parse(req.params).tab;
    reply.header("Content-Disposition", `attachment; filename="guide-${tab}.pdf"`);
    return sendGuideFile(req, reply, guidePdfPath(tab), "application/pdf");
  });
};
