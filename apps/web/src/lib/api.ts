// Typed data access — our own REST API (v2, D-43). Shapes are the same the pages used with Supabase views/RPCs.
import type { BookingStatus, BookingType, FeatureFlag, ServiceCategory, WebCategory, Zone } from "@sms/shared";
import { ApiError, del, get, patch, post, put } from "./http";

export type Customer = {
  id: string; company_id: string; name: string; phones: string[]; address: string | null; zone: Zone;
  lat: number | null; lng: number | null; notes: string | null; is_active: boolean; created_at: string; updated_at: string;
};
export type CatalogItem = {
  id: string; name_km: string; name_en: string | null; kind: "service" | "product"; category: ServiceCategory; unit: string;
  sell_price: number | null; cost_price: number | null; duration_min: number; is_active: boolean; reminder_months?: number | null; income_account_id?: string | null;
  /** D-106 website catalog: «from» price (cents; null = told on contact, still bookable), code (the Excel key), website category,
   *  shown on the website, quote only, sample (seeded, the shop still has to confirm it) */
  from_price: number | null; code?: string | null; web_category?: WebCategory | null; show_on_website?: boolean; quote_only?: boolean; is_sample?: boolean;
};
export type CatalogPreviewRow = { row: number; code: string; name: string; action: "new" | "changed" | "same" | "error"; errors: string[]; changes: Record<string, [unknown, unknown]> };
export type CatalogPreview = { counts: { new: number; changed: number; same: number; error: number }; file_errors: string[]; rows: CatalogPreviewRow[] };
export type Technician = { user_id: string; role: "lead" | "assistant"; full_name: string };
export type Booking = {
  id: string; number: string; customer_id: string; customer_name: string; customer_phones: string[];
  type: BookingType; category: ServiceCategory; status: BookingStatus; service_text: string; service_item_id: string | null; scheduled_at: string | null; ends_at: string | null;
  address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; vehicle_code: string | null;
  notes: string | null; survey_notes?: string | null; surveyed_at?: string | null; cancel_reason: string | null; cancelled_at: string | null; closed_at: string | null; created_by: string | null; created_at: string; updated_at: string;
  technicians: Technician[] | null;
  warranty_of?: string | null; warranty_of_number?: string | null; warranty?: { until: string; days_left: number; active: boolean } | null;
  units?: { id: string; label: string }[] | null;
  /** D-96: made on the public website; "pending" = waits for Admin / GM to confirm or decline (Customer requests) */
  origin?: "staff" | "website"; web_status?: "pending" | "confirmed" | "declined" | null;
  /** D-120: from one of the CEO's test phones (listed for the CEO only) */
  is_test?: boolean;
};
export type StatusLog = { id: number; booking_id: string; from_status: BookingStatus | null; to_status: BookingStatus; by: string | null; at: string; note: string | null };
export type UserBasic = { id: string; full_name: string; role: string; is_active: boolean };
export type UserRow = {
  id: string; company_id: string; username: string; phone: string | null; email: string | null; full_name: string; role: string; language: string;
  is_active: boolean; must_change_password: boolean; tracks_attendance: boolean; is_lead: boolean; telegram_linked: boolean; created_at: string; updated_at: string;
};
export type Vehicle = { id: string; code: string; plate: string | null; owner_user_id: string | null; is_active: boolean };
export type Notification = { id: number; kind: string; title: string; body: string | null; link: string | null; read_at: string | null; created_at: string };
export type Busy = { number: string; scheduled_at: string; ends_at: string };
/** R1: who and what is free for a time window (reason BUSY today; leave/absence with M4) */
export type Availability = {
  people: { user_id: string; full_name: string; role: string; available: boolean; reason: string | null; busy: Busy[]; away: { kind: "leave" | "absent"; starts_at: string; ends_at: string } | null }[];
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
export type PayMethod = "cash_usd" | "cash_khr" | "aba" | "acleda";
export type Payment = { id: string; amount: number; currency: "usd" | "khr"; method: PayMethod; fx_rate_khr: number; usd_cents: number; paid_on: string; note: string | null; created_at: string; received_by_name: string | null;
  from_deposit?: boolean; reversal_of?: string | null; voided_at?: string | null; void_reason?: string | null; void_request?: { reason: string; requester_role: string; requested_by_name: string } | null };
export type Deposit = { id: string; amount: number; currency: "usd" | "khr"; method: PayMethod; fx_rate_khr: number; usd_cents: number; paid_on: string; note: string | null; status: "active" | "applied" | "void"; received_by_name: string | null };
export type Uninvoiced = { booking_id: string; number: string; status: string; customer_name: string; phones: string[]; finished_at: string; age_days: number; estimate: number; warranty: boolean };
export type Reminder = { customer_id: string; customer_name: string; phones: string[]; unit_id: string | null; unit_label: string | null; service_item_id: string; service_name: string;
  last_on: string; due_on: string; status: "overdue" | "due"; days_overdue: number; days_left: number; last_action: string | null; last_note: string | null; last_action_at: string | null; telegram: boolean };
export type CustomerUnit = { id: string; label: string; kind: string; brand: string | null; model: string | null; location_note: string | null; installed_on: string | null; is_active: boolean };
export type Invoice = {
  id: string; number: string; status: "draft" | "issued" | "void"; notes: string | null; booking_id: string | null; customer_id: string; fx_rate_khr: number;
  discount: number; discount_status: "none" | "applied" | "pending" | "rejected"; discount_requested: number | null; discount_note: string | null; discount_by_name: string | null;
  created_at: string; issued_at: string | null; voided_at: string | null; void_reason: string | null; voided_by_name: string | null; created_by_name: string | null; issued_by_name: string | null;
  booking_number: string | null; service_text: string | null; address: string | null; customer_name: string; customer_phones: string[];
  lines: QuoteLine[]; payments: Payment[]; subtotal: number; total: number; paid: number; balance: number; payment_status: "unpaid" | "partial" | "paid"; total_khr: number; balance_khr: number;
  void_request: { id: string; reason: string; requested_by: string; requester_role: string; created_at: string; requested_by_name: string } | null;
  company: { name: string; company_info: Record<string, string>; has_logo: boolean; has_qr: boolean; fx_now: number };
  can: { issue: boolean; discount: boolean; discount_approve: boolean; pay: boolean; void_request: boolean; void_approve: boolean };
};
export type InvoiceRow = { id: string; number: string; status: Invoice["status"]; created_at: string; issued_at: string | null; booking_id: string | null; customer_id: string; customer_name: string;
  booking_number: string | null; total: number; paid: number; payment_status: Invoice["payment_status"]; discount_status: Invoice["discount_status"]; void_pending: boolean };
export type DebtRow = { customer_id: string; customer_name: string; phones: string[]; d0_30: number; d31_60: number; d60_plus: number; total: number; invoices: number; oldest: string };
export type InvoicePrefill = { booking_id: string; booking_number: string; customer_id: string; customer_name: string; service_text: string; lines: QuoteLine[] };
export type AttendanceToday = { tracks: boolean; office_set: boolean; geofence_m: number; work_start: string; work_end: string;
  record: { in_at: string; in_distance_m: number | null; in_out_of_range: boolean; in_no_gps: boolean; out_at: string | null; out_distance_m: number | null; out_out_of_range: boolean; out_no_gps: boolean } | null };
export type AttendanceCheck = { kind: "in" | "out"; at: string; distance_m: number | null; out_of_range: boolean; no_gps: boolean; already: boolean };
export type AttendanceDay = { date: string; status: "present" | "late" | "absent" | "leave" | "holiday" | "off" | "pending" | "none"; in?: string; out?: string | null; late_min?: number; ot_min?: number;
  out_of_range?: boolean; no_gps?: boolean; distance_in?: number | null; distance_out?: number | null; leave_part?: "full" | "am" | "pm" | null; missing_out?: boolean; marked?: boolean };
export type AttendancePerson = { user_id: string; full_name: string; role: string; since: string; days: AttendanceDay[]; present: number; late_count: number; late_min: number; absent: number; leave: number; ot_min: number; out_of_range: number };
export type CashClose = { day: string; expected_usd: number; expected_khr: number; counted_usd: number | null; counted_khr: number | null; diff_usd: number | null; diff_khr: number | null;
  note: string | null; closed: boolean; closed_at: string | null; closed_by_name: string | null; verified_at: string | null; verified_by_name: string | null };
export type ReportSummary = { from: string; to: string; cancels: number;
  techs: { user_id: string; full_name: string; jobs: number; work_min: number; revisions: number; late: number }[];
  jobs: { created: number; finished: number; cancelled: number; pending_review: number; in_progress: number };
  attendance?: { people: number; present: number; late: number; absent: number; leave: number; out_of_range: number };
  revenue?: { total: number; invoices: number; inside: number; outside: number; by_category: Record<string, number> };
  payments?: { total: number; count: number; by_method: Record<PayMethod, number>; khr_riel: number };
  new_debt?: number; debt_total?: number; voids?: { count: number; total: number }; discounts?: { count: number; total: number; over_limit: number } };
export type VerifyItem = { type: "void" | "discount" | "cancel" | "payment"; id: string; at: string; ref: string; amount: number | null; reason: string | null; status: string | null; method: PayMethod | null;
  currency: "usd" | "khr" | null; raw_amount: number | null; link: string; requested_by_name: string | null; approved_by_name: string | null; verified_at: string | null; verified_by_name: string | null; verify_note: string | null };
export type Dashboard = { date: string; pending_review: number; today: { jobs: number; done: number; revenue?: number; received?: number }; month?: { revenue: number; received: number };
  debts?: { total: number; d60_plus: number }; approvals: { discounts: number; voids: number; leave: number }; unverified?: number; uninvoiced?: { count: number; estimate: number };
  techs: { user_id: string; full_name: string; status: string; job_number: string | null; job_id: string | null; in_at: string | null; out_at: string | null }[] };
export type AuditRow = { id: number; at: string; action: string; source: string; table_name: string | null; row_id: string | null; old_data: Record<string, unknown> | null; new_data: Record<string, unknown> | null; user_name: string | null };
export type CustomerHistory = { customer: Customer;
  /** D-104: the customer's website login — linked to Telegram, has a password, locked by wrong passwords? (never a secret) */
  login?: { linked: boolean; has_password: boolean; locked: "none" | "timed" | "permanent" };
  bookings: { id: string; number: string; status: BookingStatus; type: BookingType; category: ServiceCategory; service_text: string; scheduled_at: string | null; closed_at: string | null; warranty_of: string | null; warranty: { until: string; days_left: number; active: boolean } | null }[];
  warranties: { booking_id: string; number: string; until: string; days_left: number }[];
  invoices?: { id: string; number: string; status: "draft" | "issued" | "void"; issued_at: string | null; created_at: string; booking_number: string | null; total: number; paid: number; balance: number; payment_status: "unpaid" | "partial" | "paid" }[];
  debt?: number };
export type StockLocation = { id: string; name: string; kind: "warehouse" | "vehicle"; vehicle_id: string | null; vehicle_code: string | null; is_active: boolean };
export type StockItem = { item_id: string; name: string; unit: string; qty: number; value: number; avg_cost: number; reorder_level: number | null; low: boolean; by_location: { location_id: string; name: string; qty: number }[] };
export type StockCardRow = { id: number; date: string; kind: string; qty: number; value: number | null; balance_qty: number; balance_value: number | null; ref_label: string | null; reason: string | null; supplier: string | null; location: string; by_name: string | null };
export type StockCard = { opening: { qty: number; value: number | null }; rows: StockCardRow[]; ending: { qty: number; value: number | null } };
export type PendingJob = { booking_id: string; number: string; status: string; customer_name: string; suggested_location_id: string; materials: { item_id: string; name: string; unit: string; qty: number }[] };
export type StockPay = "cash_usd" | "cash_khr" | "aba" | "acleda" | "credit";
// ---------- accounting (D-88) ----------
export type AcctType = "asset" | "liability" | "equity" | "income" | "expense";
export type Account = { id: string; code: string; name_km: string; name_en: string | null; type: AcctType; role: string | null; is_active: boolean; used: boolean; balance: number; statement: "BS" | "PL" };
export type JournalRow = { id: string; number: string; date: string; memo: string; source: string; source_id: string | null; reversal_of: string | null; amount: number;
  status: "posted" | "reversed"; created_by_name: string | null; attachment_id: string | null };
export type JournalLine = { id: number; account_id: string; code: string; name_km: string; name_en: string | null; type: AcctType; debit: number; credit: number; memo: string | null;
  supplier: string | null; customer_name: string | null; user_name: string | null };
export type JournalEntry = { id: string; number: string; date: string; memo: string; note: string | null; source: string; source_id: string | null; fx_rate_khr: number; khr_amount: number | null;
  attachment_id: string | null; created_at: string; created_by_name: string | null; reversal_of: string | null; reversal_of_number: string | null; reversed_by: { id: string; number: string } | null;
  status: "posted" | "reversed"; lines: JournalLine[]; link: string | null; reversible: boolean };
export type AcctRow = { account_id: string; code: string; name_km: string; name_en: string | null; type: AcctType; amount: number };
export type TrialBalance = { from: string | null; to: string; fx_rate_khr: number; rows: (AcctRow & { debit: number; credit: number; balance: number })[]; total_debit: number; total_credit: number;
  total_debit_khr: number; total_credit_khr: number; balanced: boolean };
export type ProfitLoss = { from: string; to: string; fx_rate_khr: number; income: AcctRow[]; expense: AcctRow[]; income_total: number; expense_total: number; net: number;
  income_total_khr: number; expense_total_khr: number; net_khr: number; zones: { inside: number; outside: number; none: number } };
export type BsRow = AcctRow & { previous: number; variance: number };
export type BalanceSheet = { to: string; previous_to: string; fx_rate_khr: number; assets: BsRow[]; liabilities: BsRow[]; equity: BsRow[]; current_earnings: number; assets_total: number; liabilities_total: number;
  equity_total: number; previous: { assets_total: number; liabilities_total: number; equity_total: number; current_earnings: number };
  assets_total_khr: number; liabilities_total_khr: number; equity_total_khr: number; current_earnings_khr: number };
export type DrCr = { debit: number; credit: number };
export type TrialBalanceMonth = { month: string; from: string; to: string; previous_to: string; fiscal_year_start: string; fx_rate_khr: number; balanced: boolean;
  rows: { account_id: string; code: string; name_km: string; name_en: string | null; type: AcctType; statement: "BS" | "PL"; period: DrCr; ytd_prev: DrCr; ytd: DrCr }[];
  totals: { period: DrCr; ytd_prev: DrCr; ytd: DrCr } };
export type LedgerRow = { entry_id: string; number: string; date: string; memo: string; source: string; line_memo: string | null; debit: number; credit: number; balance: number;
  customer_name: string | null; user_name: string | null; supplier: string | null };
export type Ledger = { account: { id: string; code: string; name_km: string; name_en: string | null; type: AcctType }; from: string; to: string; opening: number; rows: LedgerRow[]; closing: number; fx_rate_khr: number };
export type BooksInfo = { books_start: string | null; lock_date: string | null; today: string; fx_rate_khr: number; fiscal_year_start_month: number; books_closed_through: string | null;
  next_year_end: string | null; can_close: boolean };
export type AcctTxType = "expense" | "purchase" | "supplier_payment" | "other_income" | "owner_contribution" | "owner_withdrawal" | "transfer";
export type PayrollAdj = { id: number; user_id: string; kind: "bonus" | "deduction"; amount: number; reason: string; by_name: string | null; created_at: string };
export type PayrollLine = { user_id: string; full_name: string; role: string; base: number; bonus: number; deduction: number; net: number; adjustments: PayrollAdj[] };
export type PayrollRun = { id: string; period: string; status: "draft" | "approved" | "paid" | "void"; created_at: string; approved_at: string | null; paid_at: string | null; pay_method: string | null;
  void_reason: string | null; created_by_name: string | null; approved_by_name: string | null; paid_by_name: string | null; lines: PayrollLine[]; base: number; bonus: number; gross: number; deductions: number; net: number };
export type PayrollSummary = { id: string; period: string; status: PayrollRun["status"]; people: number; gross: number; deductions: number; net: number };
export type Salary = { user_id: string; full_name: string; role: string; base_salary: number; updated_at: string | null };
export type Conflict = { user_id?: string; full_name?: string; vehicle_id?: string; code?: string; number: string; scheduled_at: string; ends_at: string };
export type CompanySettings = Record<string, unknown> & { company_id: string; fx_rate_khr: number | string; telegram_group_chat_id: number | string | null };

// ---------- public website + customer requests (D-95) ----------
export type SiteSettings = { website: { published?: boolean; hero?: string | null; gallery?: string[] } & Record<string, unknown>; company_info: Record<string, string>; url: string };
export type ServiceRequest = { id: string; source: "telegram" | "website"; kind: "request" | "booking" | "quote" | "reschedule"; name: string | null; phone: string | null; text: string; status: "new" | "done";
  outcome: "confirmed" | "declined" | "approved" | "rejected" | "expired" | null; note: string | null; meta: Record<string, unknown> | null;
  created_at: string; handled_at: string | null; customer_id: string | null; customer_name: string | null; handled_by_name: string | null;
  booking_id: string | null; booking_number: string | null; booking_at: string | null; booking_ends: string | null; booking_status: BookingStatus | null; web_status: "pending" | "confirmed" | "declined" | "expired" | null;
  lat: number | null; lng: number | null; loc_accuracy: number | null; photos: { id: string }[]; is_test?: boolean };

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
export type BroadcastRow = { id: number; kind: "service" | "promo"; text: string; created_by_name: string | null; recipients: number; created_at: string; valid_until: string | null; sent: number; failed: number; pending: number };

export const api = {
  config: () => get<AppConfig>("/api/config"),

  customers: (activeOnly = false) => get<Customer[]>(`/api/customers${q({ active: activeOnly ? "true" : undefined })}`),
  upsertCustomer: async (v: { id?: string | null; name: string; phones: string[]; address?: string | null; zone: Zone; lat?: number | null; lng?: number | null; notes?: string | null }) =>
    (await post<{ id: string }>("/api/customers", { id: v.id ?? null, name: v.name, phones: v.phones, address: v.address ?? "", zone: v.zone, lat: v.lat ?? null, lng: v.lng ?? null, notes: v.notes ?? "" })).id,
  setCustomerActive: (id: string, active: boolean) => post(`/api/customers/${id}/active`, { active }),

  catalog: () => get<CatalogItem[]>("/api/catalog"),
  upsertCatalogItem: async (v: { id?: string | null; name_km: string; name_en?: string | null; kind: "service" | "product"; category: ServiceCategory; unit?: string | null; sell_price: number; cost_price?: number | null; duration_min?: number; reminder_months?: number | null; income_account_id?: string | null;
    code?: string | null; web_category?: WebCategory | null; from_price?: number | null; show_on_website?: boolean; quote_only?: boolean }) =>
    (await post<{ id: string }>("/api/catalog", { id: v.id ?? null, name_km: v.name_km, name_en: v.name_en ?? "", kind: v.kind, category: v.category, unit: v.unit ?? "", sell_price: v.sell_price, cost_price: v.cost_price ?? null, duration_min: v.duration_min, reminder_months: v.reminder_months,
      ...(v.income_account_id !== undefined ? { income_account_id: v.income_account_id } : {}), ...(v.code !== undefined ? { code: v.code ?? "" } : {}), ...(v.web_category !== undefined ? { web_category: v.web_category } : {}),
      ...(v.from_price !== undefined ? { from_price: v.from_price } : {}), ...(v.show_on_website !== undefined ? { show_on_website: v.show_on_website } : {}), ...(v.quote_only !== undefined ? { quote_only: v.quote_only } : {}) })).id,
  setCatalogActive: (id: string, active: boolean) => post(`/api/catalog/${id}/active`, { active }),
  catalogMeta: () => get<{ last: { name: string; at: string } | null; can_edit: boolean }>("/api/catalog/meta"),
  catalogPreview: (data: string) => post<CatalogPreview>("/api/catalog/import/preview", { data }),
  catalogApply: (data: string) => post<{ ok: true; counts: CatalogPreview["counts"] }>("/api/catalog/import/apply", { data }),

  bookings: (opts: { statuses?: BookingStatus[]; from?: string; to?: string } = {}) =>
    get<Booking[]>(`/api/bookings${q({ status: opts.statuses?.join(","), from: opts.from, to: opts.to })}`),
  booking: (id: string) => get<Booking>(`/api/bookings/${id}`),
  statusLog: (id: string) => get<StatusLog[]>(`/api/bookings/${id}/log`),
  createBooking: (v: { customer_id: string; type: BookingType; category: ServiceCategory; service_text: string; service_item_id: string | null; scheduled_at: string | null; ends_at: string | null; address: string | null; lat: number | null; lng: number | null; zone: Zone; vehicle_id: string | null; notes: string | null; warranty_of?: string | null; unit_ids?: string[] }) =>
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
  invoices: {
    list: (status?: string) => get<InvoiceRow[]>(`/api/invoices${status ? `?status=${status}` : ""}`),
    forBooking: async (bookingId: string) => (await get<InvoiceRow[]>(`/api/invoices?booking=${bookingId}`)).find((i) => i.status !== "void") ?? null,
    get: (id: string) => get<Invoice>(`/api/invoices/${id}`),
    prefill: (bookingId: string) => get<InvoicePrefill>(`/api/invoices/prefill?booking=${bookingId}`),
    create: (v: { booking_id?: string; customer_id?: string; lines: QuoteLine[]; notes: string }) => post<{ id: string; number: string }>("/api/invoices", v),
    update: (id: string, v: { lines: QuoteLine[]; notes: string }) => put(`/api/invoices/${id}`, v),
    issue: (id: string) => post(`/api/invoices/${id}/issue`, {}),
    discount: (id: string, amount: number, note: string) => post<{ discount_status: string }>(`/api/invoices/${id}/discount`, { amount, note }),
    decideDiscount: (id: string, approve: boolean, note = "") => post(`/api/invoices/${id}/discount/${approve ? "approve" : "reject"}`, { note }),
    pay: (id: string, v: { amount: number; currency: "usd" | "khr"; method: PayMethod; paid_on: string; note: string }) => post<{ balance: number; payment_status: string }>(`/api/invoices/${id}/payments`, v),
    void: (id: string, reason: string) => post<{ status: "void" | "pending" }>(`/api/invoices/${id}/void`, { reason }),
    decideVoid: (id: string, approve: boolean, note = "") => post(`/api/invoices/${id}/void/${approve ? "approve" : "reject"}`, { note }),
    debts: () => get<DebtRow[]>("/api/invoices/debts"),
  },
  attendance: {
    today: () => get<AttendanceToday>("/api/attendance/today"),
    check: (v: { kind: "in" | "out"; lat: number | null; lng: number | null; accuracy: number | null; no_gps: boolean }) => post<AttendanceCheck>("/api/attendance/check", v),
    me: (from: string, to: string) => get<AttendancePerson | null>(`/api/attendance/me?from=${from}&to=${to}`),
    report: (from: string, to: string) => get<{ from: string; to: string; work_start: string; work_end: string; users: AttendancePerson[] }>(`/api/attendance/report?from=${from}&to=${to}`),
  },
  reports: {
    summary: (from: string, to: string) => get<ReportSummary>(`/api/reports/summary?from=${from}&to=${to}`),
    dashboard: () => get<Dashboard>("/api/reports/dashboard"),
    verification: (from: string, to: string, unverified: boolean) => get<VerifyItem[]>(`/api/reports/verification?from=${from}&to=${to}${unverified ? "&unverified=1" : ""}`),
    verify: (type: VerifyItem["type"], id: string, note = "") => post("/api/reports/verify", { type, id, note }),
    cash: (from: string, to: string) => get<CashClose[]>(`/api/reports/cash-close?from=${from}&to=${to}`),
    closeCash: (v: { day: string; counted_usd: number; counted_khr: number; note: string }) => post<{ diff_usd: number; diff_khr: number }>("/api/reports/cash-close", v),
    verifyCash: (day: string) => post(`/api/reports/cash-close/${day}/verify`, {}),
    exportUrl: (kind: "invoices" | "payments" | "jobs" | "attendance", from: string, to: string) => `/api/reports/export?kind=${kind}&from=${from}&to=${to}`,
    audit: (action: string, limit = 200) => get<AuditRow[]>(`/api/reports/audit?limit=${limit}${action ? `&action=${encodeURIComponent(action)}` : ""}`),
  },
  customerHistory: (id: string) => get<CustomerHistory>(`/api/customers/${id}/history`),
  unlockCustomerLogin: (id: string) => post<{ ok: true }>(`/api/customers/${id}/unlock-login`),
  fx: {
    get: () => get<{ current: number; history: { rate: number; note: string | null; set_at: string; set_by_name: string | null }[] }>("/api/settings/fx"),
    set: (rate: number, note: string) => post("/api/settings/fx", { rate, note }),
  },
  uninvoiced: () => get<Uninvoiced[]>("/api/invoices/uninvoiced"),
  deposits: {
    list: (bookingId: string) => get<Deposit[]>(`/api/bookings/${bookingId}/deposits`),
    record: (bookingId: string, v: { amount: number; currency: "usd" | "khr"; method: PayMethod; paid_on: string; note: string }) => post<{ id: string; usd_cents: number }>(`/api/bookings/${bookingId}/deposits`, v),
    void: (id: string, reason: string) => post(`/api/deposits/${id}/void`, { reason }),
  },
  payments: {
    void: (id: string, reason: string) => post<{ status: "void" | "pending" }>(`/api/payments/${id}/void`, { reason }),
    decideVoid: (id: string, approve: boolean, note = "") => post(`/api/payments/${id}/void/${approve ? "approve" : "reject"}`, { note }),
    voidRequests: () => get<{ id: string; payment_id: string; reason: string; invoice_id: string; number: string; usd_cents: number; requested_by_name: string }[]>("/api/payments/void-requests"),
  },
  reminders: {
    list: (days = 14) => get<Reminder[]>(`/api/reminders?days=${days}`),
    action: (v: { customer_id: string; unit_id: string | null; service_item_id: string; due_on: string; action: "contacted" | "snoozed" | "dismissed"; until?: string | null; note?: string | null }) => post("/api/reminders/action", v),
    telegram: (items: { customer_id: string; unit_id: string | null; service_item_id: string; due_on: string }[]) => post<{ sent: number; skipped: number; not_linked: number; limit: number; failed: number }>("/api/reminders/telegram", { items }),
  },
  units: {
    list: (customerId: string) => get<CustomerUnit[]>(`/api/customers/${customerId}/units`),
    save: (customerId: string, v: Partial<CustomerUnit> & { label: string }) => post<{ id: string }>(`/api/customers/${customerId}/units`, v),
  },
  customerTgLink: (customerId: string) => post<{ link: string; expires_days: number }>(`/api/customers/${customerId}/tg-link`, {}),
  inventory: {
    locations: () => get<StockLocation[]>("/api/inventory/locations"),
    saveLocation: (v: { id?: string; name: string; kind: "warehouse" | "vehicle"; is_active?: boolean }) => post<{ id: string }>("/api/inventory/locations", v),
    items: () => get<StockItem[]>("/api/inventory/items"),
    track: (itemId: string, track: boolean, reorder_level?: number | null) => post(`/api/inventory/items/${itemId}/track`, { track, reorder_level }),
    opening: (v: { item_id: string; location_id: string; qty: number; unit_cost: number }) => post("/api/inventory/opening", v),
    stockIn: (v: { item_id: string; location_id: string; qty: number; unit_cost: number; pay: StockPay; supplier: string; note: string }) => post("/api/inventory/in", v),
    adjust: (v: { item_id: string; location_id: string; qty: number; reason: string }) => post("/api/inventory/adjust", v),
    transfer: (v: { item_id: string; from: string; to: string; qty: number }) => post("/api/inventory/transfer", v),
    card: (item: string, from: string, to: string, location?: string) => get<StockCard>(`/api/inventory/card?item=${item}&from=${from}&to=${to}${location ? `&location=${location}` : ""}`),
    pendingJobs: () => get<PendingJob[]>("/api/inventory/jobs/pending"),
    confirmJob: (bookingId: string, location_id: string | null) => post(`/api/inventory/jobs/${bookingId}/confirm`, { location_id }),
  },
  settingsImage: (kind: "logo" | "qr", data: string) => post(`/api/settings/image/${kind}`, { data }),
  website: {
    get: () => get<SiteSettings>("/api/website"),
    save: (v: Record<string, unknown>) => put<{ ok: true }>("/api/website", v),
    addPhoto: (slot: "hero" | "gallery", data: string) => post<{ id: string }>("/api/website/photos", { slot, data }),
    removePhoto: (id: string) => del<{ ok: true }>(`/api/website/photos/${id}`),
  },
  requests: {
    list: (all: boolean) => get<ServiceRequest[]>(`/api/requests${all ? "?all=1" : ""}`),
    /** done · decline (an online booking) · approve / reject (a reschedule request); decline and reject carry the reason */
    act: (id: string, action: "done" | "decline" | "approve" | "reject", reason?: string) => post<{ ok: true }>(`/api/requests/${id}/${action}`,
      action === "decline" || action === "reject" ? { reason: reason ?? "" } : {}),
    /** CEO 04-10: confirm = confirmed + assigned + technicians told (the job length may change too) */
    confirm: (id: string, v: { minutes?: number; lead: string | null; assistants: string[] }) => post<{ ok: true }>(`/api/requests/${id}/confirm`, v),
  },
  accounting: {
    info: () => get<BooksInfo>("/api/accounting/lock"),
    setLock: (lock_date: string, reason?: string) => post<{ lock_date: string }>("/api/accounting/lock", { lock_date, reason: reason || null }),
    opening: (v: { date: string; cash_usd?: number; cash_khr?: number; banks?: Record<string, number>; stock?: number; retained_earnings?: number; receivables?: { customer_id: string; amount: number; note?: string }[];
      payables?: { supplier: string; amount: number }[] }) => post<{ opening_equity: number; retained_earnings: number; entries: number; open_invoices: number; opening_invoices: string[] }>("/api/accounting/opening", v),
    setFiscalYear: (start_month: number) => post<{ start_month: number }>("/api/accounting/fiscal-year", { start_month }),
    closeYear: (year_end: string) => post<{ year_end: string; net_profit: number; entry: { id: string; number: string } | null }>("/api/accounting/close-year", { year_end }),
    accounts: () => get<Account[]>("/api/accounting/accounts"),
    saveAccount: (v: { id?: string; code: string; name_km: string; name_en?: string | null; type: AcctType; is_active?: boolean }) => post<{ id: string }>("/api/accounting/accounts", v),
    deleteAccount: (id: string) => del(`/api/accounting/accounts/${id}`),
    journal: (from: string, to: string, source?: string) => get<JournalRow[]>(`/api/accounting/journal?from=${from}&to=${to}${source ? `&source=${source}` : ""}`),
    entry: (id: string) => get<JournalEntry>(`/api/accounting/journal/${id}`),
    post: (v: { date: string; memo: string; note?: string | null; attachment?: string | null; lines: { account_id: string; debit?: number; credit?: number; memo?: string | null }[] }) =>
      post<{ id: string; number: string }>("/api/accounting/journal", v),
    reverse: (id: string, reason: string) => post<{ id: string; number: string }>(`/api/accounting/journal/${id}/reverse`, { reason }),
    transaction: (v: { date: string; type: AcctTxType; amount: number; currency?: "usd" | "khr"; pay?: string; from?: string; to?: string; account_code?: string; supplier?: string | null;
      memo?: string | null; attachment?: string | null }) => post<{ id: string; number: string }>("/api/accounting/transactions", v),
    tb: (to: string) => get<TrialBalance>(`/api/accounting/trial-balance?to=${to}`),
    tbMonth: (month: string) => get<TrialBalanceMonth>(`/api/accounting/trial-balance?month=${month}`),
    pl: (from: string, to: string) => get<ProfitLoss>(`/api/accounting/income-statement?from=${from}&to=${to}`),
    bs: (to: string) => get<BalanceSheet>(`/api/accounting/balance-sheet?to=${to}`),
    ledger: (account: string, from: string, to: string) => get<Ledger>(`/api/accounting/ledger?account=${account}&from=${from}&to=${to}`),
    ledgerByCode: (code: string, from: string, to: string) => get<Ledger>(`/api/accounting/ledger?code=${code}&from=${from}&to=${to}`),
    csvUrl: (kind: "trial-balance" | "income-statement" | "balance-sheet" | "ledger" | "journal", from: string | null, to: string, account?: string, month?: string) =>
      `/api/accounting/${kind}.csv?to=${to}${from ? `&from=${from}` : ""}${account ? `&account=${account}` : ""}${month ? `&month=${month}` : ""}`,
    fileUrl: (id: string) => `/api/accounting/files/${id}`,
    payroll: {
      salaries: () => get<Salary[]>("/api/accounting/payroll/salaries"),
      setSalary: (userId: string, base_salary: number) => post(`/api/accounting/payroll/salary/${userId}`, { base_salary }),
      runs: () => get<PayrollSummary[]>("/api/accounting/payroll"),
      create: (period: string) => post<PayrollRun>("/api/accounting/payroll", { period }),
      run: (id: string) => get<PayrollRun>(`/api/accounting/payroll/${id}`),
      adjust: (id: string, v: { user_id: string; kind: "bonus" | "deduction"; amount: number; reason: string }) => post(`/api/accounting/payroll/${id}/adjust`, v),
      removeAdj: (id: string, adj: number) => post(`/api/accounting/payroll/${id}/adjust/${adj}/remove`, {}),
      approve: (id: string) => post(`/api/accounting/payroll/${id}/approve`, {}),
      pay: (id: string, pay: string) => post(`/api/accounting/payroll/${id}/pay`, { pay }),
      void: (id: string, reason: string) => post(`/api/accounting/payroll/${id}/void`, { reason }),
    },
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
  /** D-120 (CEO only) */
  testPhones: { get: () => get<{ phones: string[]; max: number }>("/api/settings/test-phones"), save: (phones: string[]) => put<{ ok: true; phones: string[] }>("/api/settings/test-phones", { phones }) },
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
    preview: (text: string) => post<{ text: string; button: string; recipients: number; gap_days: number }>("/api/subscribe/broadcast/preview", { text }),
    send: (text: string, valid_days: number) => post<{ id: number; recipients: number }>("/api/subscribe/broadcast", { text, valid_days }),
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
