// D-172: one filter for the list screens AND their Excel export — the screen filters the rows it loaded, the export filters the very same
// API rows on the server with this function, so the file is the screen. Date range (open ends allowed = «គ្រប់ថ្ងៃ»), status (any of), kind,
// role, category, search text (the screens' own fields, Khmer keyboard + phones in any form).
import { matchesSearch } from "./phone";

export type ListParams = { from?: string; to?: string; q?: string; status?: string[]; kind?: string; role?: string; category?: string };
export type ListSpec = { date?: string; month?: boolean; search?: string[]; phones?: string; status?: string; kind?: string; role?: string; category?: string };

/** the list screens without a report of their own (D-172) — key = the export report */
export const LIST_SPECS = {
  boreys: { date: "created_at", search: ["name", "area_km", "area_en"] },
  requests: { date: "created_at", search: ["name", "phone", "text", "customer_name", "booking_number"], status: "status", kind: "kind" },
  catalog: { date: "created_at", search: ["name_km", "name_en", "code"], category: "category", kind: "kind" },
  broadcasts: { date: "created_at", search: ["text", "created_by_name"], kind: "kind" },
  subscribers: { date: "subscribed_at", search: ["first_name", "username"] },
  notifications: { date: "created_at", search: ["title", "body"], kind: "kind" },
  "leave-mine": { date: "date_from", search: ["reason"], status: "status", kind: "kind" },
  "leave-approve": { date: "date_from", search: ["full_name", "reason"], status: "status", kind: "kind" },
  "payroll-runs": { date: "period", month: true, status: "status" },
  "payroll-salaries": { search: ["full_name"], role: "role" },
  reminders: { date: "due_on", search: ["customer_name", "service_name", "unit_label"], phones: "phones", status: "status" },
  "cash-close": { date: "day" },
  verification: { date: "at", search: ["ref", "reason", "requested_by_name"], kind: "type" },
  audit: { date: "at", search: ["action", "subject", "user_name"] },
  quotes: { date: "created_at", search: ["number", "booking_number", "customer_name"], phones: "customer_phones", status: "status" },
  uninvoiced: { date: "finished_at", search: ["number", "customer_name"], phones: "phones" },
  users: { date: "created_at", search: ["full_name", "username"], phones: "phone", role: "role" },
} as const satisfies Record<string, ListSpec>;
export type ListReport = keyof typeof LIST_SPECS;
export const LIST_REPORTS = Object.keys(LIST_SPECS) as ListReport[];

/** the local day (YYYY-MM-DD) of a date or a timestamp in the shop's time zone */
export function localDay(v: unknown, tz = "Asia/Phnom_Penh"): string {
  if (v === null || v === undefined || v === "") return "";
  const s = v instanceof Date ? v.toISOString() : String(v);
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-CA", { timeZone: tz });
}
const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export function filterList<T>(rows: readonly T[], spec: ListSpec, p: ListParams, tz = "Asia/Phnom_Penh"): T[] {
  const from = spec.month ? p.from?.slice(0, 7) : p.from, to = spec.month ? p.to?.slice(0, 7) : p.to;
  return rows.filter((row) => {
    const r = row as Record<string, unknown>;
    if (spec.date && (from || to)) { const d = localDay(r[spec.date], tz).slice(0, spec.month ? 7 : 10); if (!d || (from && d < from) || (to && d > to)) return false; }
    if (spec.status && p.status?.length && !p.status.includes(str(r[spec.status]))) return false;
    if (spec.kind && p.kind && str(r[spec.kind]) !== p.kind) return false;
    if (spec.role && p.role && str(r[spec.role]) !== p.role) return false;
    if (spec.category && p.category && str(r[spec.category]) !== p.category) return false;
    if (spec.search && p.q?.trim()) {
      const ph = spec.phones ? r[spec.phones] : null;
      if (!matchesSearch(p.q, spec.search.map((k) => str(r[k])), Array.isArray(ph) ? ph.map(str) : ph ? [str(ph)] : [])) return false;
    }
    return true;
  });
}
