// Typed data access — our own REST API (v2, D-43). Shapes are the same the pages used with Supabase views/RPCs.
import type { BookingStatus, BookingType, FeatureFlag, ServiceCategory, Zone } from "@sms/shared";
import { ApiError, get, patch, post } from "./http";

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
export type UserRow = {
  id: string; company_id: string; username: string; phone: string | null; email: string | null; full_name: string; role: string; language: string;
  is_active: boolean; must_change_password: boolean; tracks_attendance: boolean; telegram_linked: boolean; created_at: string; updated_at: string;
};
export type Vehicle = { id: string; code: string; plate: string | null; owner_user_id: string | null; is_active: boolean };
export type Notification = { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
export type Availability = { user_id: string; full_name: string; role: string; busy: { number: string; scheduled_at: string }[] };
export type CompanySettings = Record<string, unknown> & { company_id: string; fx_rate_khr: number | string; telegram_group_chat_id: number | string | null };

/** API errors carry a stable code ("FORBIDDEN", "NOT_FOUND", "BOOKING_LOCKED", …) */
export function errCode(e: unknown): string {
  if (e instanceof ApiError) return e.code;
  const m = e instanceof Error ? e.message : String(e);
  return m.match(/[A-Z][A-Z_]{3,}/)?.[0] ?? "ERROR";
}

const q = (o: Record<string, string | number | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export type AppConfig = { appName: string; companyName: string; telegramBot: string | null; shopCode: string; features: FeatureFlag[] };
export type SubscribeInfo = { link: string; bot: string; shop: string; enabled: boolean; total: number; promo: number; stopped: number;
  subscribers: { first_name: string | null; username: string | null; subscribed_at: string; promo: boolean; stopped: boolean }[] };
export type BroadcastRow = { id: number; kind: "service" | "promo"; text: string; created_by_name: string | null; recipients: number; created_at: string; sent: number; failed: number; pending: number };

export const api = {
  config: () => get<AppConfig>("/api/config"),

  customers: (activeOnly = false) => get<Customer[]>(`/api/customers${q({ active: activeOnly ? "true" : undefined })}`),
  upsertCustomer: async (v: { id?: string | null; name: string; phones: string[]; address?: string | null; zone: Zone; lat?: number | null; lng?: number | null; notes?: string | null }) =>
    (await post<{ id: string }>("/api/customers", { id: v.id ?? null, name: v.name, phones: v.phones, address: v.address ?? "", zone: v.zone, lat: v.lat ?? null, lng: v.lng ?? null, notes: v.notes ?? "" })).id,
  setCustomerActive: (id: string, active: boolean) => post(`/api/customers/${id}/active`, { active }),

  catalog: () => get<CatalogItem[]>("/api/catalog"),
  upsertCatalogItem: async (v: { id?: string | null; name_km: string; name_en?: string | null; kind: "service" | "product"; category: ServiceCategory; unit?: string | null; sell_price: number; cost_price?: number | null }) =>
    (await post<{ id: string }>("/api/catalog", { id: v.id ?? null, name_km: v.name_km, name_en: v.name_en ?? "", kind: v.kind, category: v.category, unit: v.unit ?? "", sell_price: v.sell_price, cost_price: v.cost_price ?? null })).id,
  setCatalogActive: (id: string, active: boolean) => post(`/api/catalog/${id}/active`, { active }),

  bookings: (opts: { statuses?: BookingStatus[]; from?: string; to?: string } = {}) =>
    get<Booking[]>(`/api/bookings${q({ status: opts.statuses?.join(","), from: opts.from, to: opts.to })}`),
  booking: (id: string) => get<Booking>(`/api/bookings/${id}`),
  statusLog: (id: string) => get<StatusLog[]>(`/api/bookings/${id}/log`),
  createBooking: (v: { customer_id: string; type: BookingType; category: ServiceCategory; service_text: string; scheduled_at: string | null; address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; notes: string | null }) =>
    post<{ id: string; number: string; status: BookingStatus }>("/api/bookings", { ...v, scheduled_at: v.scheduled_at ?? "", address: v.address ?? "", vehicle_id: v.vehicle_id ?? "", notes: v.notes ?? "" }),
  updateBooking: (id: string, patchBody: Record<string, unknown>) => patch(`/api/bookings/${id}`, patchBody),
  assignBooking: (v: { id: string; lead: string; assistants: string[]; vehicle_id: string | null; scheduled_at: string }) =>
    post<{ id: string; status: BookingStatus; conflicts: { user_id: string; number: string; scheduled_at: string }[] }>(`/api/bookings/${v.id}/assign`, { lead: v.lead, assistants: v.assistants, vehicle_id: v.vehicle_id ?? "", scheduled_at: v.scheduled_at }),
  availability: (at: string) => get<Availability[]>(`/api/bookings/availability${q({ at })}`),

  usersBasic: async () => (await get<UserBasic[]>("/api/users/basic")).filter((u) => u.is_active),
  users: () => get<UserRow[]>("/api/users"),
  createUser: (v: { username: string; full_name: string; role: string; phone?: string; email?: string; password?: string }) => post<{ id: string; temp_password?: string }>("/api/users", v),
  updateUser: (id: string, patchBody: Record<string, unknown>) => patch<{ ok: true }>(`/api/users/${id}`, patchBody),
  resetPassword: (id: string) => post<{ temp_password?: string }>(`/api/users/${id}/reset-password`, {}),

  settings: () => get<CompanySettings | null>("/api/settings/company"),
  updateSettings: (patchBody: Record<string, unknown>) => patch("/api/settings/company", patchBody),
  setFx: (rate: number) => post("/api/settings/fx", { rate }),
  vehicles: async (): Promise<Vehicle[]> => (await get<Vehicle[]>("/api/settings/vehicles")).filter((v) => v.is_active),
  vehiclesAll: (): Promise<Vehicle[]> => get<Vehicle[]>("/api/settings/vehicles"),
  upsertVehicle: (v: { id: string | null; code: string; plate: string | null; owner: string | null; active: boolean }) =>
    post<{ id: string }>("/api/settings/vehicles", { id: v.id, code: v.code, plate: v.plate, owner_user_id: v.owner, is_active: v.active }),

  notifications: () => get<Notification[]>("/api/notifications"),
  unreadCount: async () => (await get<{ count: number }>("/api/notifications/unread-count")).count,
  markRead: (id: number) => post(`/api/notifications/${id}/read`, {}),
  telegramLinkCode: () => post<{ code: string; link: string; bot: string | null; expires_at: string }>("/api/telegram/link-code", {}),
  telegramGroupCode: () => post<{ code: string; command: string; bot: string | null; expires_at: string }>("/api/telegram/group-code", {}),

  subscribe: {
    info: () => get<SubscribeInfo>("/api/subscribe"),
    broadcasts: () => get<BroadcastRow[]>("/api/subscribe/broadcasts"),
    send: (kind: "service" | "promo", text: string) => post<{ id: number; recipients: number }>("/api/subscribe/broadcast", { kind, text }),
  },

  me: {
    setLanguage: (language: "km" | "en") => post("/api/me/language", { language }),
    changePassword: (new_password: string, current_password?: string) => post("/api/me/password", { new_password, current_password }),
    updateName: (full_name: string) => patch("/api/me", { full_name }),
  },

  /** fire-and-forget: deliver queued Telegram messages right away (cron is the backstop) */
  flushTelegram: () => { void post("/api/telegram/flush", {}).catch(() => undefined); },
  resolveMapsLink: async (url: string): Promise<{ data?: { lat: number; lng: number; resolved_url: string }; error?: string; status: number }> => {
    try { return { data: await post<{ lat: number; lng: number; resolved_url: string }>("/api/maps/resolve", { url }), status: 200 }; }
    catch (e) { return { error: errCode(e), status: e instanceof ApiError ? e.status : 0 }; }
  },
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
