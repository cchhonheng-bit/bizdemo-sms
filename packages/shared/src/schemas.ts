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
