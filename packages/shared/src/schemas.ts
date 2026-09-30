import { z } from "zod";
import { ROLES } from "./permissions";

export const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,30}$/, "INVALID_USERNAME");
export const phoneSchema = z.string().trim().regex(/^0[0-9]{8,9}$/, "INVALID_PHONE");
export const emailSchema = z.string().trim().toLowerCase().email("INVALID_EMAIL");
export const passwordSchema = z.string().min(8, "PASSWORD_TOO_SHORT").max(72, "PASSWORD_TOO_LONG");
export const roleSchema = z.enum(ROLES);

export const loginSchema = z.object({
  identifier: z.string().trim().min(1, "REQUIRED").max(120),
  password: z.string().min(1, "REQUIRED").max(72),
  company: z.string().trim().toLowerCase().optional(),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const createUserSchema = z.object({
  username: usernameSchema,
  full_name: z.string().trim().min(1, "REQUIRED").max(80),
  role: roleSchema,
  phone: z.union([phoneSchema, z.literal("")]).optional(),
  email: z.union([emailSchema, z.literal("")]).optional(),
  password: z.union([passwordSchema, z.literal("")]).optional(),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = createUserSchema.omit({ password: true }).partial().extend({
  tracks_attendance: z.boolean().optional(),
  language: z.enum(["km", "en"]).optional(),
});

export const companySettingsSchema = z.object({
  work_start: z.string().regex(/^\d{2}:\d{2}$/),
  work_end: z.string().regex(/^\d{2}:\d{2}$/),
  work_days: z.array(z.number().int().min(1).max(7)).min(1),
  office_lat: z.number().min(-90).max(90).nullable(),
  office_lng: z.number().min(-180).max(180).nullable(),
  geofence_m: z.number().int().min(20).max(2000),
  out_of_range_m: z.number().int().min(50).max(5000),
  fx_rate_khr: z.number().min(1000).max(20000),
  discount_approval_limit: z.number().int().min(0),
  late_alert_min: z.number().int().min(0).max(240),
  telegram_group_chat_id: z.union([z.string().regex(/^-?\d+$/), z.literal("")]).optional(),
  invoice_prefix: z.string().regex(/^[A-Z]{2,5}$/),
});
export type CompanySettingsInput = z.infer<typeof companySettingsSchema>;

// ---------- M2: customers / catalog / bookings ----------
import { BOOKING_TYPES, SERVICE_CATEGORIES, ZONES } from "./booking";

export const customerSchema = z.object({
  name: z.string().trim().min(1, "REQUIRED").max(120, "TOO_LONG"),
  phones: z.array(phoneSchema).max(3),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  zone: z.enum(ZONES),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});
export type CustomerInput = z.infer<typeof customerSchema>;

export const catalogItemSchema = z.object({
  name_km: z.string().trim().min(1, "REQUIRED").max(120, "TOO_LONG"),
  name_en: z.string().trim().max(120).optional().or(z.literal("")),
  kind: z.enum(["service", "product"]),
  category: z.enum(SERVICE_CATEGORIES),
  unit: z.string().trim().max(20).optional().or(z.literal("")),
  sell_price: z.number().int().min(0),
  cost_price: z.number().int().min(0).nullable().optional(),
  /** Booking Rules v1.3 R3: default job length of a service (placeholder 120 min until One Team confirms) */
  duration_min: z.number().int().min(15, "DURATION_RANGE").max(1440, "DURATION_RANGE").optional(),
});
export type CatalogItemInput = z.infer<typeof catalogItemSchema>;

export const bookingSchema = z.object({
  customer_id: z.string().uuid("REQUIRED"),
  type: z.enum(BOOKING_TYPES),
  category: z.enum(SERVICE_CATEGORIES),
  service_text: z.string().trim().min(1, "REQUIRED").max(1000, "TOO_LONG"),
  /** optional catalog service → default duration (R3) */
  service_item_id: z.string().uuid().optional().or(z.literal("")).nullable(),
  scheduled_at: z.string().optional().or(z.literal("")),
  /** end of the job; empty = start + service duration (R3) */
  ends_at: z.string().optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  zone: z.enum(ZONES),
  vehicle_id: z.string().uuid().optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});
export type BookingInput = z.infer<typeof bookingSchema>;

/** R5: lead technician (មេជាង) optional · at least ONE technician · crew 1..n */
export const assignSchema = z.object({
  lead: z.string().uuid().optional().or(z.literal("")).nullable(),
  assistants: z.array(z.string().uuid()).max(10),
  vehicle_id: z.string().uuid().optional().or(z.literal("")),
  /** D2: the agreed time is kept; a different time here is refused (USE_RESCHEDULE) */
  scheduled_at: z.string().optional().or(z.literal("")),
  ends_at: z.string().optional().or(z.literal("")),
})
  .refine((v) => !v.lead || !v.assistants.includes(v.lead), { message: "LEAD_IN_ASSISTANTS", path: ["assistants"] })
  .refine((v) => !!v.lead || v.assistants.length > 0, { message: "TEAM_REQUIRED", path: ["assistants"] });
export type AssignInput = z.infer<typeof assignSchema>;

/** R4: cancel with a reason (CEO / GM / Admin) */
export const cancelSchema = z.object({ reason: z.string().trim().min(3, "REASON_REQUIRED").max(500, "TOO_LONG") }).strict();
export type CancelInput = z.infer<typeof cancelSchema>;

/** D2: who asked to move the appointment */
export const RESCHEDULE_REQUESTERS = ["customer", "creator", "technician", "lead", "gm"] as const;
export type RescheduleRequester = (typeof RESCHEDULE_REQUESTERS)[number];
export const rescheduleSchema = z.object({
  scheduled_at: z.string().min(1, "SCHEDULE_REQUIRED"),
  ends_at: z.string().optional().or(z.literal("")),
  requested_by: z.enum(RESCHEDULE_REQUESTERS, { errorMap: () => ({ message: "REQUESTER_REQUIRED" }) }).optional(),
  reason: z.string().trim().max(500, "TOO_LONG").optional().default(""),
}).strict();

/** D3 / FR-903: leave request (own) or absence (marked by an approver) — whole day(s) or half a day */
export const LEAVE_PARTS = ["full", "am", "pm"] as const;
export type LeavePart = (typeof LEAVE_PARTS)[number];
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "INVALID_DATE");
export const leaveRequestSchema = z.object({
  kind: z.literal("leave").optional().default("leave"),
  date_from: isoDate,
  date_to: isoDate,
  part: z.enum(LEAVE_PARTS).default("full"),
  reason: z.string().trim().min(2, "REASON_REQUIRED").max(500, "TOO_LONG"),
}).strict();
export const absenceSchema = z.object({
  user_id: z.string().uuid(),
  date_from: isoDate,
  date_to: isoDate,
  part: z.enum(LEAVE_PARTS).default("full"),
  reason: z.string().trim().min(2, "REASON_REQUIRED").max(500, "TOO_LONG"),
}).strict();
