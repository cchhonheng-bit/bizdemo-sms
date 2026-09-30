// Quotes (Flow 3 · M5): GM / Admin / CEO with quote.manage; technicians never (BR-10).
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { acceptQuote, createQuote, getQuote, listQuotes, rejectQuote, updateQuote } from "../services/quotes.js";

const line = z.object({
  catalog_item_id: z.string().uuid().optional().nullable(),
  description: z.string().trim().min(1).max(300),
  kind: z.enum(["service", "product"]),
  qty: z.number().positive().max(1_000_000),
  unit: z.string().trim().max(20).default("unit"),
  unit_price: z.number().int().min(0).max(100_000_000),
}).strict().refine((l) => l.qty * l.unit_price <= 1_000_000_000, "LINE_TOO_LARGE"); // ≤ $10M a line
const lines = z.array(line).min(1).max(100).refine((ls) => ls.reduce((s, l) => s + l.qty * l.unit_price, 0) <= 2_000_000_000, "TOTAL_TOO_LARGE"); // sums stay in int4
const idParam = z.object({ id: z.string().uuid() });

export const quotesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requirePerm("quote.manage"));
  app.get("/", async (req) => {
    const { status, booking } = z.object({ status: z.enum(["sent", "accepted", "rejected"]).optional(), booking: z.string().uuid().optional() }).parse(req.query ?? {});
    return listQuotes(req.user!, status, booking);
  });
  app.get("/:id", async (req) => getQuote(req.user!, idParam.parse(req.params).id));
  app.post("/", async (req) => {
    const v = z.object({ booking_id: z.string().uuid(), lines, notes: z.string().max(2000).optional().nullable(), valid_days: z.number().int().min(1).max(365).optional().nullable() }).strict().parse(req.body);
    return createQuote(req.user!, req.ip, v);
  });
  app.put("/:id", async (req) => {
    const v = z.object({ lines, notes: z.string().max(2000).optional().nullable() }).strict().parse(req.body);
    return updateQuote(req.user!, req.ip, idParam.parse(req.params).id, v);
  });
  app.post("/:id/accept", async (req) => acceptQuote(req.user!, req.ip, idParam.parse(req.params).id));
  app.post("/:id/reject", async (req) => {
    const { reason } = z.object({ reason: z.string().max(500).default("") }).parse(req.body ?? {});
    return rejectQuote(req.user!, req.ip, idParam.parse(req.params).id, reason);
  });
};
