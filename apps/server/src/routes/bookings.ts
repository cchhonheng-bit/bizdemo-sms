import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assignSchema, bookingSchema, cancelSchema, rescheduleSchema, BOOKING_STATUSES } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import { assignBooking, availability, cancelBooking, createBooking, getBooking, listBookings, rescheduleBooking, rescheduleHistory, statusLog, updateBooking } from "../services/bookings.js";
import { flushOutbox } from "../services/telegram.js";

const idParam = z.object({ id: z.string().uuid() });
const iso = z.string().datetime({ offset: true });

export const bookingsRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", app.requireAuth);

  app.get("/", async (req) => {
    const q = z.object({ status: z.string().max(300).optional(), from: iso.optional(), to: iso.optional(), limit: z.coerce.number().int().min(1).max(1000).optional() }).parse(req.query ?? {});
    const statuses = q.status ? q.status.split(",").filter((s) => (BOOKING_STATUSES as readonly string[]).includes(s)) as never[] : undefined;
    return listBookings(req.user!, { statuses, from: q.from, to: q.to, limit: q.limit });
  });

  // R1: GET /api/bookings/availability?from=ISO&to=ISO[&exclude=<booking id>] — assigners only (F-M2-02)
  //     (legacy ?at=ISO = a 2-hour window from that time)
  app.get("/availability", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const q = z.object({ from: iso.optional(), to: iso.optional(), at: iso.optional(), exclude: z.string().uuid().optional() }).parse(req.query ?? {});
    const from = q.from ?? q.at;
    if (!from) throw new AppError("SCHEDULE_REQUIRED", 400);
    const to = q.to ?? new Date(new Date(from).getTime() + 2 * 3600_000).toISOString();
    return availability(req.user!, from, to, q.exclude ?? null);
  });

  app.get("/:id", async (req) => getBooking(req.user!, idParam.parse(req.params).id));
  app.get("/:id/log", async (req) => statusLog(req.user!, idParam.parse(req.params).id));
  app.get("/:id/reschedules", async (req) => rescheduleHistory(req.user!, idParam.parse(req.params).id));

  app.post("/", async (req) => {
    if (!req.perms.includes("booking.create")) throw new AppError("FORBIDDEN", 403);
    const b = bookingSchema.parse(req.body);
    return createBooking(req.user!, req.ip, {
      customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, service_item_id: b.service_item_id || null,
      scheduled_at: b.scheduled_at || null, ends_at: b.ends_at || null,
      address: b.address || null, lat: b.lat ?? null, lng: b.lng ?? null, zone: b.zone, vehicle_id: b.vehicle_id || null, notes: b.notes || null,
    });
  });

  app.patch("/:id", async (req) => {
    if (!req.perms.includes("booking.create")) throw new AppError("FORBIDDEN", 403);
    const patch = bookingSchema.omit({ customer_id: true, type: true }).partial().strict().parse(req.body ?? {});
    await updateBooking(req.user!, req.ip, idParam.parse(req.params).id, patch);
    return { ok: true };
  });

  app.post("/:id/assign", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const a = assignSchema.parse(req.body);
    const r = await assignBooking(req.user!, req.ip, idParam.parse(req.params).id, {
      lead: a.lead || null, assistants: [...new Set(a.assistants)], vehicle_id: a.vehicle_id || null, scheduled_at: a.scheduled_at || null, ends_at: a.ends_at || null,
    });
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush")); // deliver right away; cron is the backstop (D-15)
    return r;
  });

  // D2: move the agreed appointment — who asked + reason + history; CEO / GM / Admin (booking.create or booking.assign)
  app.post("/:id/reschedule", async (req) => {
    if (!req.perms.includes("booking.create") && !req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const r = rescheduleSchema.parse(req.body ?? {});
    const out = await rescheduleBooking(req.user!, req.ip, idParam.parse(req.params).id, { scheduled_at: r.scheduled_at, ends_at: r.ends_at || null, requested_by: r.requested_by, reason: r.reason });
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return out;
  });

  // R4: CEO / GM / Admin (permission cancel.request — all three by default), reason required
  app.post("/:id/cancel", async (req) => {
    if (!req.perms.includes("cancel.request")) throw new AppError("FORBIDDEN", 403);
    const { reason } = cancelSchema.parse(req.body ?? {});
    const r = await cancelBooking(req.user!, req.ip, idParam.parse(req.params).id, reason);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
};
