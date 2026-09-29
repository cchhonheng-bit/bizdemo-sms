import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assignSchema, bookingSchema, BOOKING_STATUSES } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import { assignBooking, availability, createBooking, getBooking, listBookings, statusLog, updateBooking } from "../services/bookings.js";
import { flushOutbox } from "../services/telegram.js";

const idParam = z.object({ id: z.string().uuid() });

export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (req) => {
    const q = z.object({ status: z.string().optional(), from: z.string().optional(), to: z.string().optional(), limit: z.coerce.number().int().optional() }).parse(req.query ?? {});
    const statuses = q.status ? q.status.split(",").filter((s) => (BOOKING_STATUSES as readonly string[]).includes(s)) as never[] : undefined;
    return listBookings(req.user!, { statuses, from: q.from, to: q.to, limit: q.limit });
  });

  // GET /api/bookings/availability?at=ISO — assigners only (F-M2-02)
  app.get("/availability", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const { at } = z.object({ at: z.string().min(1) }).parse(req.query ?? {});
    return availability(req.user!, at);
  });

  app.get("/:id", async (req) => getBooking(req.user!, idParam.parse(req.params).id));
  app.get("/:id/log", async (req) => statusLog(req.user!, idParam.parse(req.params).id));

  app.post("/", async (req) => {
    if (!req.perms.includes("booking.create")) throw new AppError("FORBIDDEN", 403);
    const b = bookingSchema.parse(req.body);
    return createBooking(req.user!, req.ip, {
      customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, scheduled_at: b.scheduled_at || null,
      address: b.address || null, lat: b.lat ?? null, lng: b.lng ?? null, zone: b.zone, vehicle_id: b.vehicle_id || null, notes: b.notes || null,
    });
  });

  app.patch("/:id", async (req) => {
    if (!req.perms.includes("booking.create")) throw new AppError("FORBIDDEN", 403);
    const patch = z.record(z.unknown()).parse(req.body ?? {});
    await updateBooking(req.user!, req.ip, idParam.parse(req.params).id, patch);
    return { ok: true };
  });

  app.post("/:id/assign", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const a = assignSchema.parse(req.body);
    const r = await assignBooking(req.user!, req.ip, idParam.parse(req.params).id, { lead: a.lead, assistants: a.assistants, vehicle_id: a.vehicle_id || null, scheduled_at: a.scheduled_at });
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush")); // deliver right away; cron is the backstop (D-15)
    return r;
  });
};
