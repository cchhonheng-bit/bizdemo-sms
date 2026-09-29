// Typed data access for M2 (views + RPCs exposed in schema `api`).
import type { BookingStatus, BookingType, ServiceCategory, Zone } from "@sms/shared";
import { callFunction, supabase } from "./supabase";

export type Customer = {
  id: string; company_id: string; name: string; phones: string[]; address: string | null; zone: Zone;
  lat: number | null; lng: number | null; notes: string | null; is_active: boolean; created_at: string; updated_at: string;
};
export type CatalogItem = {
  id: string; name_km: string; name_en: string | null; kind: "service" | "product"; category: ServiceCategory; unit: string;
  sell_price: number | null; cost_price: number | null; is_active: boolean;
};
export type Technician = { user_id: string; role: "lead" | "assistant"; full_name: string };
export type Booking = {
  id: string; number: string; customer_id: string; customer_name: string; customer_phones: string[];
  type: BookingType; category: ServiceCategory; status: BookingStatus; service_text: string; scheduled_at: string | null;
  address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; vehicle_code: string | null;
  notes: string | null; cancel_reason: string | null; closed_at: string | null; created_by: string | null; created_at: string; updated_at: string;
  technicians: Technician[] | null;
};
export type StatusLog = { id: number; booking_id: string; from_status: BookingStatus | null; to_status: BookingStatus; by: string | null; at: string; note: string | null };
export type UserBasic = { id: string; full_name: string; role: string; is_active: boolean };
export type Vehicle = { id: string; code: string; plate: string | null; owner_user_id: string | null; is_active: boolean };
export type Notification = { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
export type PlatformCompany = { id: string; name: string; slug: string; plan: string; is_active: boolean; created_at: string; users: number; bookings: number; last_activity: string | null; telegram_group: boolean };
export type SupportSession = { id: string; company_id: string; company_name: string | null; admin_username: string; admin_name: string; reason: string; started_at: string; expires_at: string; ended_at: string | null; active: boolean };
export type ProfileRow = { id: string; username: string; phone: string | null; email: string | null; full_name: string; role: string; is_active: boolean; telegram_linked: boolean; must_change_password: boolean };
export type Availability = { user_id: string; full_name: string; role: string; busy: { number: string; scheduled_at: string }[] };

function unwrap<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}
/** Postgres RAISE messages look like "FORBIDDEN" or "NOT_FOUND: …" → code */
export function errCode(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  const code = m.match(/[A-Z][A-Z_]{3,}/)?.[0];
  return code ?? "ERROR";
}

export const api = {
  customers: async (activeOnly = false) => {
    let q = supabase.from("customers").select("*").order("name");
    if (activeOnly) q = q.eq("is_active", true);
    return unwrap<Customer[]>(await q);
  },
  upsertCustomer: async (v: { id?: string | null; name: string; phones: string[]; address?: string | null; zone: Zone; lat?: number | null; lng?: number | null; notes?: string | null }) =>
    unwrap<string>(await supabase.rpc("upsert_customer", { p_id: v.id ?? null, p_name: v.name, p_phones: v.phones, p_address: v.address ?? null, p_zone: v.zone, p_lat: v.lat ?? null, p_lng: v.lng ?? null, p_notes: v.notes ?? null })),
  setCustomerActive: async (id: string, active: boolean) => unwrap(await supabase.rpc("set_customer_active", { p_id: id, p_active: active })),

  catalog: async () => unwrap<CatalogItem[]>(await supabase.from("catalog_items").select("*").order("category").order("name_km")),
  upsertCatalogItem: async (v: { id?: string | null; name_km: string; name_en?: string | null; kind: "service" | "product"; category: ServiceCategory; unit?: string | null; sell_price: number; cost_price?: number | null }) =>
    unwrap<string>(await supabase.rpc("upsert_catalog_item", { p_id: v.id ?? null, p_name_km: v.name_km, p_name_en: v.name_en ?? null, p_kind: v.kind, p_category: v.category, p_unit: v.unit ?? null, p_sell_price: v.sell_price, p_cost_price: v.cost_price ?? null })),
  setCatalogActive: async (id: string, active: boolean) => unwrap(await supabase.rpc("set_catalog_active", { p_id: id, p_active: active })),

  bookings: async (opts: { statuses?: BookingStatus[]; from?: string; to?: string } = {}) => {
    let q = supabase.from("bookings").select("*").order("scheduled_at", { ascending: true, nullsFirst: false }).order("created_at", { ascending: false }).limit(300);
    if (opts.statuses?.length) q = q.in("status", opts.statuses);
    if (opts.from) q = q.gte("scheduled_at", opts.from);
    if (opts.to) q = q.lt("scheduled_at", opts.to);
    return unwrap<Booking[]>(await q);
  },
  booking: async (id: string) => unwrap<Booking>(await supabase.from("bookings").select("*").eq("id", id).single()),
  statusLog: async (id: string) => unwrap<StatusLog[]>(await supabase.from("booking_status_log").select("*").eq("booking_id", id).order("at")),
  createBooking: async (v: { customer_id: string; type: BookingType; category: ServiceCategory; service_text: string; scheduled_at: string | null; address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; notes: string | null }) =>
    unwrap<{ id: string; number: string; status: BookingStatus }>(await supabase.rpc("create_booking", {
      p_customer_id: v.customer_id, p_type: v.type, p_category: v.category, p_service_text: v.service_text, p_scheduled_at: v.scheduled_at,
      p_address: v.address, p_lat: v.lat, p_lng: v.lng, p_zone: v.zone, p_vehicle_id: v.vehicle_id, p_notes: v.notes,
    })),
  updateBooking: async (id: string, patch: Record<string, unknown>) => unwrap(await supabase.rpc("update_booking", { p_id: id, p_patch: patch })),
  assignBooking: async (v: { id: string; lead: string; assistants: string[]; vehicle_id: string | null; scheduled_at: string }) =>
    unwrap<{ id: string; status: BookingStatus; conflicts: { user_id: string; number: string; scheduled_at: string }[] }>(
      await supabase.rpc("assign_booking", { p_id: v.id, p_lead: v.lead, p_assistants: v.assistants, p_vehicle_id: v.vehicle_id, p_scheduled_at: v.scheduled_at })),
  availability: async (at: string) => unwrap<Availability[]>(await supabase.rpc("technician_availability", { p_at: at })),

  usersBasic: async () => unwrap<UserBasic[]>(await supabase.from("users_basic").select("*").eq("is_active", true).order("full_name")),
  vehicles: async () => unwrap<Vehicle[]>(await supabase.from("vehicles").select("*").eq("is_active", true).order("code")),

  notifications: async () => unwrap<Notification[]>(await supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(50)),
  markRead: async (id: number) => unwrap(await supabase.rpc("mark_notification_read", { p_id: id })),
  telegramLinkCode: async () => unwrap<string>(await supabase.rpc("create_telegram_link_code")),

  // ---- platform_admin / Support mode (S-15) ----
  platformOverview: async () => unwrap<PlatformCompany[]>(await supabase.rpc("platform_overview")),
  startSupport: async (v: { company_id: string; reason: string; minutes: number }) =>
    unwrap<{ id: string; company_id: string; company_name: string; expires_at: string }>(await supabase.rpc("start_support_session", { p_company: v.company_id, p_reason: v.reason, p_minutes: v.minutes })),
  endSupport: async () => unwrap<boolean>(await supabase.rpc("end_support_session")),
  supportSessions: async () => unwrap<SupportSession[]>(await supabase.from("support_sessions").select("*").order("started_at", { ascending: false }).limit(50)),
  /** read-only user list of the company in Support (RLS decides the rows) */
  profilesOf: async (companyId: string) => unwrap<ProfileRow[]>(await supabase.from("profiles").select("id,username,phone,email,full_name,role,is_active,telegram_linked,must_change_password").eq("company_id", companyId).order("role").order("full_name")),

  /** fire-and-forget: deliver queued Telegram messages right away (cron is the backstop) */
  flushTelegram: () => { void callFunction("telegram-sender", {}); },
  resolveMapsLink: (url: string) => callFunction<{ lat: number; lng: number; resolved_url: string }>("resolve-maps-link", { url }),
};

// ---------- formatting ----------
const pad = (n: number) => String(n).padStart(2, "0");
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}
export function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${fmtDate(iso)} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** ISO → value for <input type="datetime-local"> (local time) */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** datetime-local value → ISO (or null) */
export function fromLocalInput(v: string | null | undefined): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function todayRange(): { from: string; to: string } {
  const s = new Date(); s.setHours(0, 0, 0, 0);
  const e = new Date(s); e.setDate(e.getDate() + 1);
  return { from: s.toISOString(), to: e.toISOString() };
}
