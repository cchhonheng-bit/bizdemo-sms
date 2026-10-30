// D-172: the Excel export of the list screens that had none — each reads the SAME API the screen reads (as the signed-in user, so the
// permission is the screen's), filters with the shared `filterList` (the screen's own filter) and writes the D-169 standard file.
import { AUDIT_ACTION, type ListReport } from "@sms/shared";
import { X, type ListCol, type Q } from "./excel.js";

const { D, M, K, INT } = X;
const yes = (b: unknown) => (b ? "✓" : "");
/** a timestamp as dd/mm/yyyy HH:MM in the shop's time zone */
const dt = (v: unknown) => {
  if (!v) return null;
  const d = new Date(String(v)); if (Number.isNaN(d.getTime())) return String(v);
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value ?? "";
  return `${g("day")}/${g("month")}/${g("year")} ${g("hour")}:${g("minute")}`;
};
const day = (v: unknown) => D(v ? new Date(String(v)).toLocaleDateString("en-CA", { timeZone: "Asia/Phnom_Penh" }) : null);
type R = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
export type ListDef = { path: (q: Q) => string; pick?: (json: R) => R[]; title: [string, string]; sheet: string; cols: ListCol[] };
const col = (h: string, v: (r: R) => ReturnType<typeof D> | string | number | null | undefined, o: Partial<ListCol> = {}): ListCol => ({ h, v, w: 14, ...o });
const range = (q: Q) => `${q.from ? `&from=${q.from}` : ""}${q.to ? `&to=${q.to}` : ""}`;

export const LIST_DEFS: Record<ListReport, ListDef> = {
  posts: { path: () => "/api/site-posts", title: ["ប្រកាសលើគេហទំព័រ", "Website posts"], sheet: "Posts", // D-193
    cols: [col("ពេល", (r) => dt(r.created_at), { w: 16 }), col("ចំណងជើង", (r) => r.title, { w: 36 }), col("អត្ថបទ", (r) => r.body, { w: 48 }), col("វីដេអូ", (r) => r.video_url, { w: 30 }),
      col("រូបថត", (r) => yes(r.has_photo), { w: 7 }), col("បង្ហាញ", (r) => yes(r.published), { w: 8 }), col("អ្នកសរសេរ", (r) => r.author, { w: 18 })] },
  boreys: { path: (q) => `/api/boreys${q.all === "1" ? "?all=1" : ""}`, title: ["គម្រោងបុរី", "Borey projects"], sheet: "Boreys",
    cols: [col("ឈ្មោះ", (r) => r.name, { w: 28 }), col("តំបន់", (r) => r.area_km, { w: 36 }), col("អតិថិជន", (r) => INT(r.customers), { w: 10, s: "int", sum: true }), col("បង្កើត", (r) => day(r.created_at), { w: 11, s: "date" }), col("សកម្ម", (r) => yes(r.is_active), { w: 7 })] },
  requests: { path: (q) => `/api/requests${q.all === "1" ? "?all=1" : ""}`, title: ["សំណើអតិថិជន", "Customer requests"], sheet: "Requests",
    cols: [col("ពេល", (r) => dt(r.created_at), { w: 16 }), col("ប្រភព", (r) => r.source, { w: 9 }), col("ប្រភេទ", (r) => r.kind, { w: 11 }), col("ឈ្មោះ", (r) => r.name ?? r.customer_name, { w: 20 }), col("ទូរស័ព្ទ", (r) => r.phone, { w: 14 }),
      col("សំណើ", (r) => r.text, { w: 40 }), col("ស្ថានភាព", (r) => r.status, { w: 9 }), col("លទ្ធផល", (r) => r.outcome, { w: 11 }), col("ការងារ", (r) => r.booking_number, { w: 10 }), col("ម៉ោងការងារ", (r) => dt(r.booking_at), { w: 16 }),
      col("ដោះស្រាយដោយ", (r) => r.handled_by_name, { w: 16 }), col("ដោះស្រាយពេល", (r) => dt(r.handled_at), { w: 16 }), col("កំណត់ចំណាំ", (r) => r.note, { w: 24 })] },
  catalog: { path: () => "/api/catalog", title: ["សេវាកម្ម និងតម្លៃ", "Services and prices"], sheet: "Catalog",
    cols: [col("កូដ", (r) => r.code, { w: 10 }), col("ឈ្មោះ", (r) => r.name_km, { w: 30 }), col("English", (r) => r.name_en, { w: 24 }), col("ប្រភេទ", (r) => r.kind, { w: 9 }), col("ក្រុម", (r) => r.category, { w: 12 }), col("ខ្នាត", (r) => r.unit, { w: 8 }),
      col("តម្លៃលក់", (r) => M(r.sell_price), { w: 12, s: "money" }), col("ចាប់ពី", (r) => M(r.from_price), { w: 12, s: "money" }), col("ថ្លៃដើម", (r) => M(r.cost_price), { w: 12, s: "money" }), col("រយៈពេល (នាទី)", (r) => INT(r.duration_min), { w: 11, s: "int" }),
      col("បង្កើត", (r) => day(r.created_at), { w: 11, s: "date" }), col("សកម្ម", (r) => yes(r.is_active), { w: 7 })] },
  broadcasts: { path: () => "/api/subscribe/broadcasts", title: ["ប្រវត្តិផ្ញើសារ", "Broadcast history"], sheet: "Broadcasts",
    cols: [col("ពេល", (r) => dt(r.created_at), { w: 16 }), col("ប្រភេទ", (r) => r.kind, { w: 9 }), col("អត្ថបទ", (r) => r.text, { w: 50 }), col("ដោយ", (r) => r.created_by_name, { w: 16 }), col("អ្នកទទួល", (r) => INT(r.recipients), { w: 10, s: "int", sum: true }),
      col("បានផ្ញើ", (r) => INT(r.sent), { w: 9, s: "int", sum: true }), col("បរាជ័យ", (r) => INT(r.failed), { w: 9, s: "int", sum: true }), col("រង់ចាំ", (r) => INT(r.pending), { w: 9, s: "int", sum: true })] },
  subscribers: { path: () => "/api/subscribe", pick: (j) => j.subscribers ?? [], title: ["អ្នកតាមដាន Telegram", "Telegram subscribers"], sheet: "Subscribers",
    cols: [col("ឈ្មោះ", (r) => r.first_name, { w: 22 }), col("Telegram", (r) => (r.username ? `@${r.username}` : null), { w: 18 }), col("តាំងពី", (r) => day(r.subscribed_at), { w: 11, s: "date" }), col("ប្រូម៉ូសិន", (r) => yes(r.promo), { w: 9 }), col("ឈប់", (r) => yes(r.stopped), { w: 7 })] },
  notifications: { path: () => "/api/notifications", title: ["ដំណឹង", "Notifications"], sheet: "Notifications",
    cols: [col("ពេល", (r) => dt(r.created_at), { w: 16 }), col("ប្រភេទ", (r) => r.kind, { w: 14 }), col("ចំណងជើង", (r) => r.title, { w: 36 }), col("ខ្លឹមសារ", (r) => r.body, { w: 50 }), col("អានរួច", (r) => yes(r.read_at), { w: 8 })] },
  "leave-mine": { path: () => "/api/leave?scope=mine", title: ["ច្បាប់របស់ខ្ញុំ", "My leave"], sheet: "My leave", cols: [] },
  "leave-approve": { path: () => "/api/leave?scope=approve", title: ["ច្បាប់ត្រូវអនុម័ត", "Leave to approve"], sheet: "Leave", cols: [] },
  "payroll-runs": { path: () => "/api/accounting/payroll", title: ["បញ្ជីបើកប្រាក់ខែ", "Payroll runs"], sheet: "Payroll",
    cols: [col("ខែ", (r) => r.period, { w: 9 }), col("ស្ថានភាព", (r) => r.status, { w: 10 }), col("បុគ្គលិក", (r) => INT(r.people), { w: 9, s: "int", sum: true }), col("សរុប", (r) => M(r.gross), { w: 13, s: "money", sum: true }),
      col("កាត់", (r) => M(r.deductions), { w: 12, s: "money", sum: true }), col("ទទួល", (r) => M(r.net), { w: 13, s: "money", sum: true })] },
  "payroll-salaries": { path: () => "/api/accounting/payroll/salaries", title: ["ប្រាក់ខែគោល", "Base salaries"], sheet: "Salaries",
    cols: [col("ឈ្មោះ", (r) => r.full_name, { w: 22 }), col("តួនាទី", (r) => r.role, { w: 9 }), col("ប្រាក់ខែ", (r) => M(r.base_salary), { w: 13, s: "money", sum: true }), col("កែចុងក្រោយ", (r) => day(r.updated_at), { w: 12, s: "date" })] },
  reminders: { path: (q) => `/api/reminders?days=${q.days ?? "14"}`, title: ["រំលឹកថែទាំ", "Service reminders"], sheet: "Reminders",
    cols: [col("អតិថិជន", (r) => r.customer_name, { w: 22 }), col("ទូរស័ព្ទ", (r) => (r.phones ?? []).join(" / "), { w: 16 }), col("ម៉ាស៊ីន", (r) => r.unit_label, { w: 18 }), col("សេវា", (r) => r.service_name, { w: 24 }),
      col("លើកមុន", (r) => D(r.last_on), { w: 11, s: "date" }), col("ដល់ពេល", (r) => D(r.due_on), { w: 11, s: "date" }), col("ស្ថានភាព", (r) => r.status, { w: 9 }), col("ហួស (ថ្ងៃ)", (r) => INT(r.days_overdue || null), { w: 9, s: "int" }),
      col("នៅសល់ (ថ្ងៃ)", (r) => INT(r.days_left || null), { w: 9, s: "int" }), col("សកម្មភាពចុងក្រោយ", (r) => r.last_action, { w: 14 }), col("Telegram", (r) => yes(r.telegram), { w: 9 })] },
  "cash-close": { path: (q) => `/api/reports/cash-close?from=${q.from ?? q.to}&to=${q.to ?? q.from}`, title: ["បិទសាច់ប្រាក់ប្រចាំថ្ងៃ", "Daily cash close"], sheet: "Cash close",
    cols: [col("ថ្ងៃ", (r) => D(r.day), { w: 11, s: "date" }), col("រំពឹង $", (r) => M(r.expected_usd), { w: 12, s: "money", sum: true }), col("រំពឹង ៛", (r) => K(r.expected_khr), { w: 12, s: "khr", sum: true }), col("រាប់ $", (r) => M(r.counted_usd), { w: 12, s: "money", sum: true }),
      col("រាប់ ៛", (r) => K(r.counted_khr), { w: 12, s: "khr", sum: true }), col("ខុស $", (r) => M(r.diff_usd), { w: 11, s: "money", sum: true }), col("ខុស ៛", (r) => K(r.diff_khr), { w: 11, s: "khr", sum: true }), col("បិទដោយ", (r) => r.closed_by_name, { w: 14 }),
      col("ផ្ទៀងផ្ទាត់ដោយ", (r) => r.verified_by_name, { w: 14 }), col("កំណត់ចំណាំ", (r) => r.note, { w: 24 })] },
  verification: { path: (q) => `/api/reports/verification?from=${q.from ?? q.to}&to=${q.to ?? q.from}${q.open === "1" ? "&unverified=1" : ""}`, title: ["ផ្ទៀងផ្ទាត់", "Verification"], sheet: "Verification",
    cols: [col("ពេល", (r) => dt(r.at), { w: 16 }), col("ប្រភេទ", (r) => r.type, { w: 10 }), col("យោង", (r) => r.ref, { w: 14 }), col("ចំនួន", (r) => M(r.amount), { w: 12, s: "money", sum: true }), col("វិធី", (r) => r.method, { w: 9 }),
      col("មូលហេតុ", (r) => r.reason, { w: 28 }), col("ស្ថានភាព", (r) => r.status, { w: 10 }), col("ស្នើដោយ", (r) => r.requested_by_name, { w: 14 }), col("អនុម័តដោយ", (r) => r.approved_by_name, { w: 14 }),
      col("ផ្ទៀងផ្ទាត់ដោយ", (r) => r.verified_by_name, { w: 14 }), col("កំណត់ចំណាំ", (r) => r.verify_note, { w: 22 })] },
  audit: { path: (q) => `/api/reports/audit?limit=200${q.user ? `&user=${q.user}` : ""}${q.type ? `&type=${q.type}` : ""}${range(q)}`, title: ["កំណត់ហេតុសកម្មភាព", "Audit log"], sheet: "Audit",
    cols: [col("ពេល", (r) => dt(r.at), { w: 16 }), col("អ្នក", (r) => r.user_name ?? r.source, { w: 18 }), col("សកម្មភាព", (r) => AUDIT_ACTION[r.action]?.km ?? r.action, { w: 28 }), col("ប្រធានបទ", (r) => r.subject, { w: 24 }),
      col("តារាង", (r) => r.table_name, { w: 14 }), col("ប្រភព", (r) => r.source, { w: 9 })] },
  quotes: { path: (q) => `/api/quotes${q.status?.[0] ? `?status=${q.status[0]}` : ""}`, title: ["សម្រង់តម្លៃ", "Quotes"], sheet: "Quotes",
    cols: [col("លេខ", (r) => r.number, { w: 14 }), col("ស្ថានភាព", (r) => r.status, { w: 10 }), col("ថ្ងៃ", (r) => day(r.created_at), { w: 11, s: "date" }), col("ការងារ", (r) => r.booking_number, { w: 10 }), col("អតិថិជន", (r) => r.customer_name, { w: 22 }),
      col("ទូរស័ព្ទ", (r) => (r.customer_phones ?? []).join(" / "), { w: 16 }), col("សរុប", (r) => M(r.total), { w: 13, s: "money", sum: true }), col("រង់ចាំ (ថ្ងៃ)", (r) => INT(r.days_waiting), { w: 10, s: "int" })] },
  uninvoiced: { path: () => "/api/invoices/uninvoiced", title: ["ការងាររួច មិនទាន់ចេញវិក្កយបត្រ", "Done, not invoiced"], sheet: "Uninvoiced",
    cols: [col("ការងារ", (r) => r.number, { w: 10 }), col("ស្ថានភាព", (r) => r.status, { w: 12 }), col("អតិថិជន", (r) => r.customer_name, { w: 22 }), col("ទូរស័ព្ទ", (r) => (r.phones ?? []).join(" / "), { w: 16 }),
      col("បញ្ចប់", (r) => day(r.finished_at), { w: 11, s: "date" }), col("អាយុ (ថ្ងៃ)", (r) => INT(r.age_days), { w: 9, s: "int" }), col("ប្រហែល", (r) => M(r.estimate), { w: 12, s: "money", sum: true }), col("ធានា", (r) => yes(r.warranty), { w: 7 })] },
  users: { path: () => "/api/users", title: ["អ្នកប្រើ", "Users"], sheet: "Users",
    cols: [col("ឈ្មោះ", (r) => r.full_name, { w: 22 }), col("ឈ្មោះចូល", (r) => r.username, { w: 14 }), col("តួនាទី", (r) => r.role, { w: 9 }), col("ទូរស័ព្ទ", (r) => r.phone, { w: 14 }), col("Telegram", (r) => yes(r.telegram_linked), { w: 9 }),
      col("វត្តមាន", (r) => yes(r.tracks_attendance), { w: 8 }), col("មេជាង", (r) => yes(r.is_lead), { w: 7 }), col("សកម្ម", (r) => yes(r.is_active), { w: 7 }), col("បង្កើត", (r) => day(r.created_at), { w: 11, s: "date" })] },
};
const leaveCols: ListCol[] = [col("ឈ្មោះ", (r) => r.full_name, { w: 20 }), col("តួនាទី", (r) => r.role, { w: 8 }), col("ប្រភេទ", (r) => r.kind, { w: 8 }), col("ពី", (r) => D(r.date_from), { w: 11, s: "date" }), col("ដល់", (r) => D(r.date_to), { w: 11, s: "date" }),
  col("ផ្នែក", (r) => r.part, { w: 7 }), col("មូលហេតុ", (r) => r.reason, { w: 28 }), col("ស្ថានភាព", (r) => r.status, { w: 10 }), col("សម្រេចដោយ", (r) => r.decided_by_name, { w: 14 }), col("សម្រេចពេល", (r) => dt(r.decided_at), { w: 16 }), col("កំណត់ចំណាំ", (r) => r.decision_note, { w: 22 })];
LIST_DEFS["leave-mine"].cols = leaveCols; LIST_DEFS["leave-approve"].cols = leaveCols;
