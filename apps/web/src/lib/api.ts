// Typed data access — our own REST API (v2, D-43). Shapes are the same the pages used with Supabase views/RPCs.
import type { BookingStatus, BookingType, FeatureFlag, ServiceCategory, Zone } from "@sms/shared";
import { ApiError, del, get, patch, post, put } from "./http";

export type Customer = {
  id: string; company_id: string; name: string; phones: string[]; address: string | null; zone: Zone;
  lat: number | null; lng: number | null; notes: string | null; is_active: boolean; created_at: string; updated_at: string;
};
export type CatalogItem = {
  id: string; name_km: string; name_en: string | null; kind: "service" | "product"; category: ServiceCategory; unit: string;
  sell_price: number | null; cost_price: number | null; duration_min: number; is_active: boolean;
};
export type Technician = { user_id: string; role: "lead" | "assistant"; full_name: string };
export type Booking = {
  id: string; number: string; customer_id: string; customer_name: string; customer_phones: string[];
  type: BookingType; category: ServiceCategory; status: BookingStatus; service_text: string; service_item_id: string | null; scheduled_at: string | null; ends_at: string | null;
  address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; vehicle_code: string | null;
  notes: string | null; survey_notes?: string | null; surveyed_at?: string | null; cancel_reason: string | null; cancelled_at: string | null; closed_at: string | null; created_by: string | null; created_at: string; updated_at: string;
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
export type Busy = { number: string; scheduled_at: string; ends_at: string };
/** R1: who and what is free for a time window (reason BUSY today; leave/absence with M4) */
export type Availability = {
  people: { user_id: string; full_name: string; role: string; available: boolean; reason: string | null; busy: Busy[] }[];
  vehicles: { id: string; code: string; plate: string | null; available: boolean; reason: string | null; busy: Busy[] }[];
};
export type Reschedule = { id: number; old_start: string | null; old_end: string | null; new_start: string; new_end: string; requested_by: string; reason: string; at: string; by_name: string | null };
export type LeaveRow = { id: string; user_id: string; full_name: string; role: string; kind: "leave" | "absent"; date_from: string; date_to: string; part: "full" | "am" | "pm"; reason: string;
  status: "pending" | "approved" | "rejected" | "cancelled"; created_at: string; decided_at: string | null; decision_note: string | null; decided_by_name: string | null };
export type Checkpoint = { step: "depart" | "arrive" | "start" | "finish" | "return"; at: string; lat: number | null; lng: number | null; accuracy: number | null; no_gps: boolean; offline: boolean; by_name: string | null };
export type JobInfo = {
  checkpoints: Checkpoint[]; durations: { travel: number | null; wait: number | null; work: number | null; return: number | null };
  photos: { id: string; kind: "before" | "after" | "survey"; created_at: string }[];
  materials: { catalog_item_id: string; name_km: string; name_en: string | null; unit: string; qty: number }[];
  report: { notes: string | null; status: "submitted" | "reviewed" | "revision"; version: number; submitted_at: string; review_note: string | null; reviewed_at: string | null; signature_file: string | null; submitted_by_name: string | null; reviewed_by_name: string | null } | null;
};
export type QuoteLine = { id?: number; catalog_item_id: string | null; description: string; kind: "service" | "product"; qty: number; unit: string; unit_price: number; line_total?: number };
export type Quote = { id: string; number: string; status: "sent" | "accepted" | "rejected"; notes: string | null; valid_until: string | null; fx_rate_khr: number; created_at: string; decided_at: string | null;
  reject_reason: string | null; booking_id: string; booking_number: string; address: string | null; service_text: string; customer_name: string; customer_phones: string[]; created_by_name: string | null;
  lines: QuoteLine[]; subtotal: number; total: number; total_khr: number; company: { name: string; company_info: Record<string, string> } };
export type QuoteRow = { id: string; number: string; status: Quote["status"]; created_at: string; booking_id: string; booking_number: string; customer_name: string; total: number; days_waiting: number };
export type Conflict = { user_id?: string; full_name?: string; vehicle_id?: string; code?: string; number: string; scheduled_at: string; ends_at: string };
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
export type SubscribeInfo = { link: string | null; bot: string | null; shop: string; enabled: boolean; total: number; promo: number; stopped: number;
  subscribers: { first_name: string | null; username: string | null; subscribed_at: string; promo: boolean; stopped: boolean }[] };
export type BroadcastRow = { id: number; kind: "service" | "promo"; text: string; created_by_name: string | null; recipients: number; created_at: string; sent: number; failed: number; pending: number };

export const api = {
  config: () => get<AppConfig>("/api/config"),

  customers: (activeOnly = false) => get<Customer[]>(`/api/customers${q({ active: activeOnly ? "true" : undefined })}`),
  upsertCustomer: async (v: { id?: string | null; name: string; phones: string[]; address?: string | null; zone: Zone; lat?: number | null; lng?: number | null; notes?: string | null }) =>
    (await post<{ id: string }>("/api/customers", { id: v.id ?? null, name: v.name, phones: v.phones, address: v.address ?? "", zone: v.zone, lat: v.lat ?? null, lng: v.lng ?? null, notes: v.notes ?? "" })).id,
  setCustomerActive: (id: string, active: boolean) => post(`/api/customers/${id}/active`, { active }),

  catalog: () => get<CatalogItem[]>("/api/catalog"),
  upsertCatalogItem: async (v: { id?: string | null; name_km: string; name_en?: string | null; kind: "service" | "product"; category: ServiceCategory; unit?: string | null; sell_price: number; cost_price?: number | null; duration_min?: number }) =>
    (await post<{ id: string }>("/api/catalog", { id: v.id ?? null, name_km: v.name_km, name_en: v.name_en ?? "", kind: v.kind, category: v.category, unit: v.unit ?? "", sell_price: v.sell_price, cost_price: v.cost_price ?? null, duration_min: v.duration_min })).id,
  setCatalogActive: (id: string, active: boolean) => post(`/api/catalog/${id}/active`, { active }),

  bookings: (opts: { statuses?: BookingStatus[]; from?: string; to?: string } = {}) =>
    get<Booking[]>(`/api/bookings${q({ status: opts.statuses?.join(","), from: opts.from, to: opts.to })}`),
  booking: (id: string) => get<Booking>(`/api/bookings/${id}`),
  statusLog: (id: string) => get<StatusLog[]>(`/api/bookings/${id}/log`),
  createBooking: (v: { customer_id: string; type: BookingType; category: ServiceCategory; service_text: string; service_item_id: string | null; scheduled_at: string | null; ends_at: string | null; address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; notes: string | null }) =>
    post<{ id: string; number: string; status: BookingStatus }>("/api/bookings", { ...v, service_item_id: v.service_item_id ?? "", scheduled_at: v.scheduled_at ?? "", ends_at: v.ends_at ?? "", address: v.address ?? "", vehicle_id: v.vehicle_id ?? "", notes: v.notes ?? "" }),
  updateBooking: (id: string, patchBody: Record<string, unknown>) => patch(`/api/bookings/${id}`, patchBody),
  assignBooking: (v: { id: string; lead: string | null; assistants: string[]; vehicle_id: string | null; scheduled_at: string | null; ends_at: string | null }) =>
    post<{ id: string; status: BookingStatus }>(`/api/bookings/${v.id}/assign`, { lead: v.lead ?? "", assistants: v.assistants, vehicle_id: v.vehicle_id ?? "", scheduled_at: v.scheduled_at ?? "", ends_at: v.ends_at ?? "" }),
  availability: (from: string, to: string, exclude?: string) => get<Availability>(`/api/bookings/availability${q({ from, to, exclude })}`),
  rescheduleBooking: (id: string, v: { scheduled_at: string; ends_at: string | null; requested_by: string; reason: string }) => post<{ id: string }>(`/api/bookings/${id}/reschedule`, { ...v, ends_at: v.ends_at ?? "" }),
  rescheduleHistory: (id: string) => get<Reschedule[]>(`/api/bookings/${id}/reschedules`),
  leave: {
    list: (scope: "mine" | "approve") => get<LeaveRow[]>(`/api/leave?scope=${scope}`),
    request: (v: { date_from: string; date_to: string; part: string; reason: string }) => post<{ id: string; status: string }>("/api/leave", v),
    absent: (v: { user_id: string; date_from: string; date_to: string; part: string; reason: string }) => post<{ id: string; affected: { id: string; number: string; scheduled_at: string }[] }>("/api/leave/absent", v),
    approve: (id: string) => post<{ status: string; affected: { id: string; number: string; scheduled_at: string }[] }>(`/api/leave/${id}/approve`, {}),
    reject: (id: string, note: string) => post(`/api/leave/${id}/reject`, { note }),
    cancel: (id: string) => post(`/api/leave/${id}/cancel`, {}),
  },
  job: {
    info: (id: string) => get<JobInfo>(`/api/bookings/${id}/job`),
    photo: (id: string, kind: "before" | "after", data: string) => post<{ id: string }>(`/api/bookings/${id}/photos`, { kind, data }),
    removePhoto: (id: string, fid: string) => del(`/api/bookings/${id}/photos/${fid}`),
    materials: (id: string, items: { catalog_item_id: string; qty: number }[]) => put(`/api/bookings/${id}/materials`, { items }),
    report: (id: string, notes: string, signature: string) => post(`/api/bookings/${id}/report`, { notes, signature }),
    review: (id: string, decision: "approve" | "revision", note: string) => post(`/api/bookings/${id}/review`, { decision, note }),
  },
  quotes: {
    list: (status?: string) => get<QuoteRow[]>(`/api/quotes${status ? `?status=${status}` : ""}`),
    get: (id: string) => get<Quote>(`/api/quotes/${id}`),
    create: (v: { booking_id: string; lines: QuoteLine[]; notes: string; valid_days: number | null }) => post<{ id: string; number: string }>("/api/quotes", v),
    update: (id: string, v: { lines: QuoteLine[]; notes: string }) => put(`/api/quotes/${id}`, v),
    accept: (id: string) => post(`/api/quotes/${id}/accept`, {}),
    reject: (id: string, reason: string) => post(`/api/quotes/${id}/reject`, { reason }),
    forBooking: async (bookingId: string) => (await get<QuoteRow[]>(`/api/quotes?booking=${bookingId}`)).find((q) => q.status !== "rejected") ?? null,
  },
  survey: {
    save: (id: string, notes: string) => post(`/api/bookings/${id}/survey`, { notes }),
    photo: (id: string, data: string) => post<{ id: string }>(`/api/bookings/${id}/survey-photos`, { data }),
  },
  cancelBooking: (id: string, reason: string) => post<{ id: string; status: BookingStatus }>(`/api/bookings/${id}/cancel`, { reason }),

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
  telegramLinkCode: () => post<{ code: string; link: string | null; bot: string | null; expires_at: string }>("/api/telegram/link-code", {}),
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
