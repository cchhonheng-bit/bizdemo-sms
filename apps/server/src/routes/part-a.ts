// STEP 4 Part A (D-86): deposits, payment void, service reminders + customer units + per-customer Telegram link.
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { AppError } from "../lib/errors.js";
import { listDeposits, recordDeposit, voidDeposit } from "../services/deposits.js";
import { decidePaymentVoid, pendingPaymentVoids, requestPaymentVoid } from "../services/payments.js";
import { customerTgLink, listReminders, listUnits, reminderAction, saveUnit, sendReminderTelegram } from "../services/reminders.js";

const idParam = z.object({ id: z.string().uuid() });
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const note = z.object({ note: z.string().max(500).default("") });
const reason = z.object({ reason: z.string().max(500).default("") });
const money = z.object({
  amount: z.number().int().positive().max(100_000_000_000), currency: z.enum(["usd", "khr"]), method: z.enum(["cash_usd", "cash_khr", "aba", "acleda"]),
  paid_on: day.optional().nullable(), note: z.string().max(500).optional().nullable(),
}).strict();
const item = z.object({ customer_id: z.string().uuid(), unit_id: z.string().uuid().nullable().optional(), service_item_id: z.string().uuid(), due_on: day }).strict();

export const partARoutes: FastifyPluginAsync = async (app) => {
  // ---- deposits (quote accepted) ----
  app.get("/bookings/:id/deposits", { preHandler: app.requireAuth }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    return listDeposits(req.user!, idParam.parse(req.params).id);
  });
  app.post("/bookings/:id/deposits", { preHandler: app.requirePerm("payment.record") }, async (req) => recordDeposit(req.user!, req.ip, idParam.parse(req.params).id, money.parse(req.body)));
  app.post("/deposits/:id/void", { preHandler: app.requirePerm("void.approve") }, async (req) => voidDeposit(req.user!, req.ip, idParam.parse(req.params).id, reason.parse(req.body ?? {}).reason));

  // ---- void a mistyped payment ----
  app.get("/payments/void-requests", { preHandler: app.requirePerm("void.approve") }, async (req) => pendingPaymentVoids(req.user!));
  app.post("/payments/:id/void", { preHandler: app.requirePerm("void.request") }, async (req) => requestPaymentVoid(req.user!, req.ip, idParam.parse(req.params).id, reason.parse(req.body ?? {}).reason));
  app.post("/payments/:id/void/approve", { preHandler: app.requirePerm("void.approve") }, async (req) => decidePaymentVoid(req.user!, req.ip, idParam.parse(req.params).id, true, note.parse(req.body ?? {}).note));
  app.post("/payments/:id/void/reject", { preHandler: app.requirePerm("void.approve") }, async (req) => decidePaymentVoid(req.user!, req.ip, idParam.parse(req.params).id, false, note.parse(req.body ?? {}).note));

  // ---- A2 service reminders (flag reminders · customer.manage) ----
  const rem = { preHandler: [app.requireFeature("reminders"), app.requirePerm("customer.manage")] };
  app.get("/reminders", rem, async (req) => listReminders(req.user!, z.object({ days: z.coerce.number().int().min(0).max(90).default(14) }).parse(req.query ?? {}).days));
  app.post("/reminders/action", rem, async (req) => reminderAction(req.user!, req.ip, item.extend({ action: z.enum(["contacted", "snoozed", "dismissed"]), until: day.nullable().optional(), note: z.string().max(300).nullable().optional() }).parse(req.body)));
  app.post("/reminders/telegram", rem, async (req) => sendReminderTelegram(req.user!, req.ip, z.object({ items: z.array(item).min(1).max(100) }).strict().parse(req.body).items));
  app.get("/customers/:id/units", { preHandler: [app.requireFeature("reminders"), app.requireAuth] }, async (req) => {
    if (req.user!.role === "tech") throw new AppError("FORBIDDEN", 403);
    return listUnits(req.user!, idParam.parse(req.params).id);
  });
  app.post("/customers/:id/units", rem, async (req) => saveUnit(req.user!, req.ip, idParam.parse(req.params).id, z.object({
    id: z.string().uuid().optional(), label: z.string().trim().min(1).max(80), kind: z.string().regex(/^[a-z_]{1,20}$/).optional(),
    brand: z.string().max(60).nullable().optional(), model: z.string().max(60).nullable().optional(), location_note: z.string().max(120).nullable().optional(),
    installed_on: day.nullable().optional(), is_active: z.boolean().optional(),
  }).strict().parse(req.body)));
  app.post("/customers/:id/tg-link", rem, async (req) => customerTgLink(req.user!, req.ip, idParam.parse(req.params).id));
};
