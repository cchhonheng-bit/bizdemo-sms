// Attendance (Flow 5 · M9): check in / out for GM, Admin, technicians; own history; report for report.ops (GM, Admin, CEO, CFO).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { check, myHistory, report, today } from "../services/attendance.js";

const range = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), user: z.string().uuid().optional() });

export const attendanceRoutes: FastifyPluginAsync = async (app) => {
  app.get("/today", { preHandler: app.requireAuth }, async (req) => today(req.user!));
  app.post("/check", { preHandler: app.requireAuth }, async (req) => {
    const v = z.object({
      kind: z.enum(["in", "out"]),
      lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(),
      accuracy: z.number().min(0).max(100_000).nullable().optional(),
      no_gps: z.boolean().optional(),
    }).strict().refine((x) => (x.lat == null) === (x.lng == null), "BAD_GPS").parse(req.body);
    return check(req.user!, req.ip, v);
  });
  app.get("/me", { preHandler: app.requireAuth }, async (req) => {
    const q = range.omit({ user: true }).parse(req.query ?? {});
    return myHistory(req.user!, q.from, q.to);
  });
  app.get("/report", { preHandler: app.requirePerm("report.ops") }, async (req) => {
    const q = range.parse(req.query ?? {});
    return report(req.user!, q.from, q.to, q.user);
  });
};
