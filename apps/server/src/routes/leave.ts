// Leave requests / absences (D3, FR-903). Server-side permission checks in services/leave.ts.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { absenceSchema, leaveRequestSchema } from "@sms/shared";
import { cancelLeave, decideLeave, listLeave, markAbsent, requestLeave } from "../services/leave.js";

const idParam = z.object({ id: z.string().uuid() });

export const leaveRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);
  app.get("/", async (req) => {
    const { scope } = z.object({ scope: z.enum(["mine", "approve"]).default("mine") }).parse(req.query ?? {});
    return listLeave(req.user!, req.perms, scope);
  });
  app.post("/", async (req) => requestLeave(req.user!, req.ip, leaveRequestSchema.parse(req.body)));
  app.post("/absent", async (req) => markAbsent(req.user!, req.ip, absenceSchema.parse(req.body)));
  app.post("/:id/approve", async (req) => decideLeave(req.user!, req.ip, idParam.parse(req.params).id, true, null));
  app.post("/:id/reject", async (req) => {
    const { note } = z.object({ note: z.string().trim().max(300).optional() }).parse(req.body ?? {});
    return decideLeave(req.user!, req.ip, idParam.parse(req.params).id, false, note || null);
  });
  app.post("/:id/cancel", async (req) => cancelLeave(req.user!, req.ip, idParam.parse(req.params).id));
};
