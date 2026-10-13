import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { assignSchema, bookingEditSchema, bookingSchema, cancelSchema, customerText, rescheduleSchema, BOOKING_STATUSES } from "@sms/shared";
import { AppError } from "../lib/errors.js";
import { sql } from "../db.js";
import { assignBooking, availability, cancelBooking, createBooking, editBooking, getBooking, listBookings, rescheduleBooking, rescheduleHistory, statusLog, updateBooking } from "../services/bookings.js";
import { btn, row } from "../services/customer-bot.js";
import { tellCustomer } from "../services/customer-notify.js";
import { flushOutbox } from "../services/telegram.js";
import { addSurveyPhoto, saveSurvey } from "../services/quotes.js";
import { addExtra, forCrew, listExtras, removeOwnExtra, reviewExtra } from "../services/extras.js";
import { addPhoto, finishForTechnician, jobInfo, recordCheckpoint, removePhoto, reviewReport, setMaterials, STEPS, submitReport } from "../services/jobs.js";

const idParam = z.object({ id: z.string().uuid() });
const iso = z.string().datetime({ offset: true });
/** D-140: the customer hears the new time of a moved job (their linked chat, service messages on — the hub decides) */
const tellRescheduled = (id: string) => tellCustomer(id, (b) => ({ text: customerText.rescheduled(b.number, b.day, b.time), buttons: row(btn.track()) }));

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
    // D-137 (CEO): the staff write the end themselves — needed for the overlap check (the website keeps the catalog length)
    if (b.scheduled_at && !b.ends_at) throw new AppError("END_REQUIRED", 400);
    return createBooking(req.user!, req.ip, {
      customer_id: b.customer_id, type: b.type, category: b.category, service_text: b.service_text, service_item_id: b.service_item_id || null,
      scheduled_at: b.scheduled_at || null, ends_at: b.ends_at || null,
      address: b.address || null, lat: b.lat ?? null, lng: b.lng ?? null, zone: b.zone, vehicle_id: b.vehicle_id || null, notes: b.notes || null,
      warranty_of: b.warranty_of || null, unit_ids: b.unit_ids, lines: b.lines,
    });
  });

  app.patch("/:id", async (req) => {
    if (!req.perms.includes("booking.create")) throw new AppError("FORBIDDEN", 403);
    const patch = bookingSchema.omit({ customer_id: true, type: true }).partial().strict().parse(req.body ?? {});
    await updateBooking(req.user!, req.ip, idParam.parse(req.params).id, patch);
    return { ok: true };
  });

  // D-140: the one «កែ» screen — everything in one save (Admin / GM / CEO); a new time = reschedule rules, a new crew = assign rules
  app.put("/:id", async (req) => {
    if (!req.perms.includes("booking.create") && !req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const e = bookingEditSchema.parse(req.body ?? {});
    const id = idParam.parse(req.params).id;
    const out = await editBooking(req.user!, req.ip, id, {
      ...e, team: e.team ? { lead: e.team.lead || null, assistants: [...new Set(e.team.assistants)], overrides: e.team.overrides } : undefined,
      vehicle_id: e.vehicle_id === undefined ? undefined : e.vehicle_id || null,
    }, req.perms.includes("booking.assign"));
    void flushOutbox().catch((err) => req.log.warn(err, "outbox flush"));
    if (out.rescheduled) await tellRescheduled(id);
    return out;
  });

  // D-139: Admin / GM record the actual finish for the technician → he is free from that time
  app.post("/:id/finish", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const b = z.object({ at: iso, note: z.string().trim().max(200).optional().nullable() }).strict().parse(req.body ?? {});
    const r = await finishForTechnician(req.user!, req.ip, idParam.parse(req.params).id, b);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });

  app.post("/:id/assign", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const a = assignSchema.parse(req.body);
    const r = await assignBooking(req.user!, req.ip, idParam.parse(req.params).id, {
      lead: a.lead || null, assistants: [...new Set(a.assistants)], vehicle_id: a.vehicle_id || null, scheduled_at: a.scheduled_at || null, ends_at: a.ends_at || null, overrides: a.overrides,
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
    await tellRescheduled(out.id);
    return out;
  });

  // ---- Flow 3: survey of a type B job (FR-501) — GM (quote.manage) ----
  app.post("/:id/survey", async (req) => {
    if (!req.perms.includes("quote.manage")) throw new AppError("FORBIDDEN", 403);
    const { notes } = z.object({ notes: z.string().max(2000) }).strict().parse(req.body);
    return saveSurvey(req.user!, req.ip, idParam.parse(req.params).id, notes);
  });
  app.post("/:id/survey-photos", { bodyLimit: 3_000_000 }, async (req) => {
    if (!req.perms.includes("quote.manage")) throw new AppError("FORBIDDEN", 403);
    const { data } = z.object({ data: z.string().min(10) }).strict().parse(req.body);
    return addSurveyPhoto(req.user!, req.ip, idParam.parse(req.params).id, data);
  });

  // ---- Flow 1+2: job execution (checkpoints, photos, materials, report) + GM review ----
  app.get("/:id/job", async (req) => {
    const id = idParam.parse(req.params).id;
    const info = await jobInfo(req.user!, id);
    const extras = await listExtras(sql, id); // D-140 F: work added on site (technicians never see prices)
    return { ...info, extras: req.user!.role === "tech" ? forCrew(extras) : extras };
  });
  // D-140 F: the technician (crew), GM or Admin adds work on site — a catalog service + qty, or «ការងារផ្សេងៗ» (text + photo, no price)
  app.post("/:id/extras", { bodyLimit: 3_000_000 }, async (req) => {
    const v = z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("service"), item_id: z.string().uuid(), qty: z.number().positive().max(999) }).strict(),
      // D-142: «សម្ភារៈផ្សេងៗ» = a material the technician writes (text + quantity + unit), priced by Admin / GM like other work
      z.object({ kind: z.enum(["other", "material"]), description: z.string().trim().min(2, "DESCRIPTION_REQUIRED").max(300, "TOO_LONG"), qty: z.number().positive().max(999).optional(),
        unit: z.string().trim().max(20).nullable().optional(), photo: z.string().max(2_900_000).nullable().optional() }).strict(),
    ]).parse(req.body ?? {});
    const r = await addExtra(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
  app.delete("/:id/extras/:xid", async (req) => {
    const p = z.object({ id: z.string().uuid(), xid: z.string().uuid() }).parse(req.params);
    return removeOwnExtra(req.user!, req.perms, req.ip, p.id, p.xid);
  });
  // Admin / GM review before the invoice: confirm (price kept or edited) / remove (reason)
  app.post("/:id/extras/:xid/review", async (req) => {
    if (!req.perms.includes("booking.assign")) throw new AppError("FORBIDDEN", 403);
    const p = z.object({ id: z.string().uuid(), xid: z.string().uuid() }).parse(req.params);
    const v = z.object({ action: z.enum(["confirm", "remove"]), unit_price: z.number().int().min(0).max(100_000_000).nullable().optional(), reason: z.string().trim().max(300).nullable().optional() }).strict().parse(req.body ?? {});
    return reviewExtra(req.user!, req.ip, p.id, p.xid, v);
  });
  app.post("/:id/checkpoint", async (req) => {
    const v = z.object({ step: z.enum(STEPS), at: z.string().datetime({ offset: true }).optional().nullable(), lat: z.number().min(-90).max(90).nullable().optional(),
      lng: z.number().min(-180).max(180).nullable().optional(), accuracy: z.number().min(0).max(100000).nullable().optional(), no_gps: z.boolean().optional(), offline: z.boolean().optional() }).strict().parse(req.body);
    const r = await recordCheckpoint(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
  const bigBody = { bodyLimit: 3_000_000 }; // base64 of a ≤ 2 MB compressed photo
  app.post("/:id/photos", bigBody, async (req) => {
    const v = z.object({ kind: z.enum(["before", "after"]), data: z.string().min(10) }).strict().parse(req.body);
    return addPhoto(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v.kind, v.data);
  });
  app.delete("/:id/photos/:fid", async (req) => {
    const p = z.object({ id: z.string().uuid(), fid: z.string().uuid() }).parse(req.params);
    return removePhoto(req.user!, req.perms, p.id, p.fid);
  });
  app.put("/:id/materials", async (req) => {
    const v = z.object({ items: z.array(z.object({ catalog_item_id: z.string().uuid(), qty: z.number().positive().max(100000) }).strict()).max(100) }).strict().parse(req.body);
    return setMaterials(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v.items);
  });
  app.post("/:id/report", bigBody, async (req) => {
    const v = z.object({ notes: z.string().max(2000).default(""), signature: z.string().optional().nullable() }).strict().parse(req.body ?? {});
    return submitReport(req.user!, req.perms, req.ip, idParam.parse(req.params).id, v);
  });
  app.post("/:id/review", async (req) => {
    // GM (job.review) or a lead technician (D-91)
    const lead = req.user!.role === "tech" && (await sql<{ l: boolean }[]>`select is_lead as l from users where id = ${req.user!.id}`)[0]?.l === true;
    if (!req.perms.includes("job.review") && !lead) throw new AppError("FORBIDDEN", 403);
    const v = z.object({ decision: z.enum(["approve", "revision"]), note: z.string().max(500).default("") }).strict().parse(req.body);
    const r = await reviewReport(req.user!, req.ip, idParam.parse(req.params).id, v.decision, v.note);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });

  // R4: CEO / GM / Admin (permission cancel.request — all three by default), reason required
  app.post("/:id/cancel", async (req) => {
    if (!req.perms.includes("cancel.request")) throw new AppError("FORBIDDEN", 403);
    const { reason, materials_used } = cancelSchema.parse(req.body ?? {});
    const r = await cancelBooking(req.user!, req.ip, idParam.parse(req.params).id, reason, materials_used);
    void flushOutbox().catch((e) => req.log.warn(e, "outbox flush"));
    return r;
  });
};
