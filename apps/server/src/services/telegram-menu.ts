// Telegram bot menus rendered by the SHOP (D-74 inline views · D-91 reply keyboards per role). The hub forwards the chat id,
// the Telegram user and (for customers) the hub subscriber id; the shop decides who that is from its own data and what they
// may see — the same permissions as the app, technicians only their own jobs, never prices for technicians (AC-01).
// A screen = { text, buttons (inline), keyboard (reply keyboard), ask_location, remove_keyboard, lang }. Labels are Khmer with
// icons (English for English-mode staff); a label is dispatched by its text. Location sending happens only in private chats.
import { formatUsd } from "@sms/shared";
import { config } from "../config.js";
import { sql } from "../db.js";
import { APP_BASE } from "../lib/app-url.js";
import { AppError } from "../lib/errors.js";
import { featureOn } from "../lib/features.js";
import { asLang, LEAD, pick, tx, ZONE, type Lang } from "../lib/i18n.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { attendanceMenuText, telegramAttendance } from "./attendance.js";
import { warrantyJson } from "./bookings.js";
import { hubCall, hubConfigured } from "./hub-client.js";
import { uninvoiced } from "./invoices.js";
import { items as stockItems } from "./inventory.js";
import { recordCheckpoint, reviewReport, STEPS, type Step } from "./jobs.js";
import { permissionsFor } from "./permissions.js";
import { createRequest, markRequestDone } from "./requests.js";
import { decideReschedule } from "./customer-home.js";
import { decideWebBooking } from "./web-booking.js";
import { listReminders } from "./reminders.js";
import { summaryData, summaryText, verification } from "./reports.js";
import { cashCloses } from "./reports-extra.js";
import { fmtLocal, hubForgetChat } from "./telegram.js";

export type MenuButton = { text: string; view?: string; id?: string; arg?: string; url?: string; web_app?: string };
export type KbButton = { text: string; web_app?: string };
export type Menu = { text: string; buttons?: MenuButton[][]; keyboard?: KbButton[][]; ask_location?: boolean; remove_keyboard?: boolean; lang?: Lang } | null;
export type BotReply = { kind: "staff" | "customer" | "customer_menu" | "none" } & Partial<NonNullable<Menu>>;

const ACTIVE = ["new", "assigned", "en_route", "on_site", "working"];
const miniApp = (path: string) => (config.publicUrl.startsWith("https://") ? `${config.publicUrl}${APP_BASE}/tg?to=${encodeURIComponent(path)}` : undefined);
const appUrl = (path: string) => (config.publicUrl.startsWith("https://") ? `${config.publicUrl}${APP_BASE}${path}` : null);
const url = (text: string, u: string | null): MenuButton[] => (u ? [{ text, url: u }] : []);
const appBtn = (text: string, path: string): MenuButton => ({ text, web_app: miniApp(path) });

// ---------- who is this chat ----------
type Staff = { id: string; company_id: string; full_name: string; role: string; timezone: string; language: string; is_lead: boolean; username: string };
type Customer = { id: string; company_id: string; name: string; timezone: string };
async function staffByChat(chatId: number): Promise<Staff | null> {
  return (await sql<Staff[]>`select u.id, u.company_id, u.full_name, u.role, c.timezone, u.language, u.is_lead, u.username from users u join companies c on c.id = u.company_id
    where u.telegram_chat_id = ${chatId} and u.is_active and c.is_active limit 1`)[0] ?? null;
}
async function customerBySubscriber(subscriberId: number | null | undefined): Promise<Customer | null> {
  if (!subscriberId) return null;
  return (await sql<Customer[]>`select cu.id, cu.company_id, cu.name, c.timezone from customers cu join companies c on c.id = cu.company_id
    where cu.tg_subscriber_id = ${subscriberId} and cu.is_active and c.is_active limit 1`)[0] ?? null;
}
const sessionOf = (u: Staff): SessionUser => ({ id: u.id, companyId: u.company_id, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: asLang(u.language), sessionId: "telegram" });
const T = (u: { language: string }) => (km: string, en: string) => pick(tx(km, en), asLang(u.language));

// ---------- labels (one language per text: Khmer with icons, English for English-mode staff) ----------
type Action = "today" | "steps" | "report" | "att" | "leave" | "tomorrow" | "review" | "survey" | "team"
  | "new_booking" | "waiting_invoice" | "due_cleaning" | "find_customer" | "receive_payment" | "requests"
  | "approvals" | "where_techs" | "summary_today" | "summary" | "alerts" | "staff_today" | "cash_today" | "to_verify" | "finance" | "low_stock"
  | "c_bookings" | "c_warranty" | "c_contact" | "c_history" | "c_request" | "c_promo" | "me" | "help";
const LABEL: Record<Action, { km: string; en: string; app?: string }> = {
  today: { km: "📋 ការងារថ្ងៃនេះ", en: "📋 Today's jobs" }, steps: { km: "🔧 ជំហានការងារ", en: "🔧 Job steps" },
  report: { km: "📝 របាយការណ៍ការងារ", en: "📝 Job report" }, att: { km: "📍 វត្តមាន", en: "📍 Attendance" },
  leave: { km: "🗓 សុំច្បាប់ឈប់", en: "🗓 Leave request", app: "/leave" }, tomorrow: { km: "📅 ការងារថ្ងៃស្អែក", en: "📅 Tomorrow's jobs" },
  review: { km: "🔎 ពិនិត្យការងារ", en: "🔎 Review jobs" }, survey: { km: "📐 សិក្សាទីតាំង", en: "📐 Site survey" }, team: { km: "👥 ក្រុមខ្ញុំថ្ងៃនេះ", en: "👥 My team today" },
  new_booking: { km: "📝 ការងារថ្មី", en: "📝 New booking", app: "/bookings/new" }, waiting_invoice: { km: "🧾 រង់ចាំវិក្កយបត្រ", en: "🧾 Waiting for invoice" },
  due_cleaning: { km: "🔔 ដល់ពេលលាង", en: "🔔 Due for cleaning" }, find_customer: { km: "🔍 រកអតិថិជន", en: "🔍 Find customer" },
  receive_payment: { km: "💵 ទទួលប្រាក់", en: "💵 Receive payment", app: "/invoices" }, requests: { km: "🌐 សំណើអតិថិជន", en: "🌐 Customer requests" },
  approvals: { km: "✅ រង់ចាំអនុម័ត", en: "✅ Pending approvals" }, where_techs: { km: "📍 ជាងនៅណា", en: "📍 Where are technicians" },
  summary_today: { km: "📊 សង្ខេបថ្ងៃនេះ", en: "📊 Today's summary" }, summary: { km: "📊 សង្ខេប", en: "📊 Summary" },
  alerts: { km: "🚨 ដំណឹងសំខាន់", en: "🚨 Important alerts" }, staff_today: { km: "👷 បុគ្គលិកថ្ងៃនេះ", en: "👷 Staff today" },
  cash_today: { km: "💵 សាច់ប្រាក់ថ្ងៃនេះ", en: "💵 Cash today" }, to_verify: { km: "🔎 ត្រូវផ្ទៀងផ្ទាត់", en: "🔎 To verify" },
  finance: { km: "📒 ហិរញ្ញវត្ថុ", en: "📒 Finance", app: "/accounting" }, low_stock: { km: "📦 ស្តុកជិតអស់", en: "📦 Low stock" },
  c_bookings: { km: "📋 ការកក់របស់ខ្ញុំ", en: "📋 My bookings" }, c_warranty: { km: "🛡 ការធានា", en: "🛡 Warranty" }, c_contact: { km: "📞 ទាក់ទងហាង", en: "📞 Contact shop" },
  c_history: { km: "📜 ប្រវត្តិ", en: "📜 History" }, c_request: { km: "🛠 ស្នើសេវាកម្ម", en: "🛠 Request service" }, c_promo: { km: "🎁 ប្រូម៉ូសិន", en: "🎁 Promotions" },
  me: { km: "👤 ខ្ញុំ", en: "👤 Me" }, help: { km: "❓ របៀបប្រើ", en: "❓ How to use" },
};
const BY_LABEL = new Map<string, Action>();
for (const [a, l] of Object.entries(LABEL) as [Action, { km: string; en: string }][]) { BY_LABEL.set(l.km, a); BY_LABEL.set(l.en, a); }

/** the role's actions, in the brief's order, each only with its permission (the menu follows the app's permission matrix) */
async function actionsFor(u: Staff): Promise<Action[]> {
  const p = await permissionsFor(sql, u.company_id, u.role);
  const has = (k: string) => p.includes(k as never);
  const out: Action[] = [];
  const add = (a: Action, ok: boolean) => { if (ok) out.push(a); };
  if (u.role === "tech") {
    add("today", true); add("steps", has("job.checkpoint")); add("report", has("job.checkpoint")); add("att", !!(await attendanceMenuText(u.id)));
    add("leave", true); add("tomorrow", true);
    if (u.is_lead) { add("review", true); add("survey", true); add("team", true); }
  } else if (u.role === "admin") {
    add("new_booking", has("booking.create")); add("today", true); add("waiting_invoice", has("invoice.issue")); add("due_cleaning", has("customer.manage") && featureOn("reminders"));
    add("find_customer", has("customer.manage")); add("receive_payment", has("payment.record")); add("requests", has("booking.create") || has("customer.manage"));
  } else if (u.role === "gm") {
    add("new_booking", has("booking.create")); add("approvals", true); add("today", true); add("where_techs", has("report.ops")); add("summary_today", has("report.ops"));
    add("requests", has("booking.create") || has("customer.manage"));
  } else if (u.role === "ceo") {
    add("summary", has("report.ops")); add("approvals", true); add("alerts", true); add("staff_today", has("report.ops"));
  } else if (u.role === "cfo") {
    add("cash_today", has("payment.record") || has("report.verify")); add("to_verify", has("report.verify")); add("finance", has("accounting.view") && featureOn("accounting"));
    add("low_stock", has("inventory.view") && featureOn("inventory"));
  }
  out.push("me", "help");
  return out;
}
function rows2<B>(btns: B[]): B[][] { const rows: B[][] = []; for (let i = 0; i < btns.length; i += 2) rows.push(btns.slice(i, i + 2)); return rows; }
async function staffKeyboard(u: Staff): Promise<KbButton[][]> {
  const lang = asLang(u.language);
  return rows2((await actionsFor(u)).map((a) => { const app = LABEL[a].app ? miniApp(LABEL[a].app!) : undefined; return { text: LABEL[a][lang], ...(app ? { web_app: app } : {}) }; }));
}
const CUSTOMER_ACTIONS: Action[] = ["c_bookings", "c_warranty", "c_contact", "c_history", "c_request", "c_promo", "me", "help"];
/** D-96: with the website module, the customer's keyboard opens the booking site and the customer home inside Telegram (Mini App) */
const siteButtons = (): KbButton[][] => (featureOn("website") && config.publicUrl.startsWith("https://")
  ? [[{ text: "🗓 កក់សេវា", web_app: `${config.publicUrl}/` }, { text: "👤 ការកក់របស់ខ្ញុំ", web_app: `${config.publicUrl}/my` }]] : []);
const customerKeyboard = (): KbButton[][] => [...siteButtons(), ...rows2(CUSTOMER_ACTIONS.map((a) => ({ text: LABEL[a].km })))];

// ---------- pending next-message actions (10 min) ----------
type Pending = { kind: "arrive"; booking_id: string } | { kind: "find_customer" } | { kind: "request_service" } | { kind: "review_note"; booking_id: string } | { kind: "decline_note"; request_id: string };
async function setPending(chatId: number, companyId: string, action: Pending): Promise<void> {
  await sql`insert into tg_pending (chat_id, company_id, action, expires_at) values (${chatId}, ${companyId}, ${sql.json(action as never)}, now() + interval '10 minutes')
    on conflict (chat_id) do update set company_id = excluded.company_id, action = excluded.action, expires_at = excluded.expires_at`;
}
async function takePending(chatId: number): Promise<Pending | null> {
  const r = (await sql<{ action: Pending; live: boolean }[]>`delete from tg_pending where chat_id = ${chatId} returning action, expires_at > now() as live`)[0];
  return r && r.live ? r.action : null;
}

// ---------- helpers ----------
/** [day 00:00, day+1 00:00) in the company time zone, day = today + offset */
async function dayRange(tz: string, offset = 0): Promise<{ from: string; to: string; day: string }> {
  const r = (await sql<{ f: Date; t: Date; d: string }[]>`select ((date_trunc('day', now() at time zone ${tz}) + make_interval(days => ${offset}::int)) at time zone ${tz}) as f,
    ((date_trunc('day', now() at time zone ${tz}) + make_interval(days => ${offset + 1}::int)) at time zone ${tz}) as t, ((now() at time zone ${tz})::date + ${offset}::int)::text as d`)[0]!;
  return { from: r.f.toISOString(), to: r.t.toISOString(), day: r.d };
}
const hhmm = (d: Date, tz: string) => fmtLocal(d, tz).slice(-5);
const dmy = (d: Date, tz: string) => fmtLocal(d, tz).slice(0, 10);
type Job = { id: string; number: string; scheduled_at: Date; ends_at: Date | null; cname: string; status: string; crew: string | null };
function jobsOf(u: Staff, from: string | null, to: string | null, limit = 10, statuses = ACTIVE, desc = false) {
  const own = u.role === "tech" ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${u.id})` : sql``;
  return sql<Job[]>`select b.id, b.number, b.scheduled_at, b.ends_at, c.name as cname, b.status,
      (select string_agg(x.full_name, ', ' order by t.role, x.full_name) from booking_technicians t join users x on x.id = t.user_id where t.booking_id = b.id) as crew
    from bookings b join customers c on c.id = b.customer_id
    where b.company_id = ${u.company_id} and b.status = any(${sql.array(statuses)}::booking_status[]) ${own}
      ${from ? sql`and b.scheduled_at >= ${from}::timestamptz` : sql``} ${to ? sql`and b.scheduled_at < ${to}::timestamptz` : sql``}
    order by b.scheduled_at ${desc ? sql`desc` : sql``} limit ${limit}`;
}
const backHome = (u: Staff): MenuButton[] => [{ text: T(u)("🏠 ទំព័រដើម", "🏠 Home"), view: "home" }];
const errText = (u: Staff, e: unknown): string => {
  const code = e instanceof AppError ? e.code : "ERROR";
  const map: Record<string, [string, string]> = {
    FORBIDDEN: ["❌ មិនមែនការងាររបស់អ្នក ឬគ្មានសិទ្ធិ", "❌ Not your job, or no permission"], CHECKPOINT_ORDER: ["❌ សូមចុចជំហានមុនសិន", "❌ Press the previous step first"],
    BOOKING_NOT_ASSIGNED: ["❌ ការងារនេះមិនទាន់ចាត់ជាង", "❌ This job is not assigned"], NOT_PENDING_REVIEW: ["❌ ការងារនេះមិនរង់ចាំពិនិត្យទេ", "❌ This job is not waiting for review"],
    NOTE_REQUIRED: ["❌ ត្រូវការមូលហេតុ", "❌ A note is needed"], NOT_FOUND: ["❌ រកមិនឃើញ", "❌ Not found"],
  };
  const m = map[code] ?? ["❌ មិនអាចធ្វើបាន", "❌ Could not do that"];
  return T(u)(m[0], m[1]);
};

// ---------- staff screens ----------
async function staffHome(u: Staff): Promise<Menu> {
  const L = T(u);
  const { from, to } = await dayRange(u.timezone);
  const today = (await jobsOf(u, from, to, 50)).length, next = (await jobsOf(u, to, null, 50)).length;
  const hi = u.role === "tech" ? "👷" : "👋";
  const text = L(`${hi} សួស្តី ${u.full_name}\nថ្ងៃនេះ: ${today} ការងារ · ខាងមុខ: ${next}\nជ្រើសខាងក្រោម 👇`, `${hi} Hello ${u.full_name}\nToday: ${today} jobs · upcoming: ${next}\nChoose below 👇`);
  const rows: MenuButton[][] = [[{ text: L("📋 ការងារថ្ងៃនេះ", "📋 Today's jobs"), view: "today" }, { text: L("🗓 ការងារខាងមុខ", "🗓 Upcoming jobs"), view: "next" }]];
  rows.push(url(L("📱 បើកកម្មវិធី", "📱 Open the app"), appUrl(u.role === "tech" ? "/tech" : "/dashboard")));
  return { text, buttons: rows.filter((r) => r.length), keyboard: await staffKeyboard(u) };
}
async function jobList(u: Staff, which: "today" | "next" | "tomorrow" | "steps" | "report"): Promise<Menu> {
  const L = T(u);
  const t0 = await dayRange(u.timezone), t1 = await dayRange(u.timezone, 1);
  const jobs = which === "next" ? await jobsOf(u, t0.to, null) : which === "tomorrow" ? await jobsOf(u, t1.from, t1.to)
    : which === "report" ? await jobsOf(u, null, null, 10, ["on_site", "working", "work_done", "revision"], true) // jobs that take a report, newest first
    : await jobsOf(u, t0.from, t0.to, 10, which === "steps" ? ["assigned", "en_route", "on_site", "working"] : ACTIVE);
  const title = { today: L("📋 ការងារថ្ងៃនេះ", "📋 Today's jobs"), next: L("🗓 ការងារខាងមុខ", "🗓 Upcoming jobs"), tomorrow: L("📅 ការងារថ្ងៃស្អែក", "📅 Tomorrow's jobs"),
    steps: L("🔧 ជំហានការងារ — ជ្រើសការងារ", "🔧 Job steps — pick the job"), report: L("📝 របាយការណ៍ការងារ — ជ្រើសការងារ", "📝 Job report — pick the job") }[which];
  const rows: MenuButton[][] = jobs.map((j) => {
    const label = `${which === "next" || which === "report" ? dmy(j.scheduled_at, u.timezone) + " " : ""}${hhmm(j.scheduled_at, u.timezone)} · ${j.number} · ${j.cname}`.slice(0, 60);
    return which === "report" ? [appBtn(label, `/tech/job/${j.id}`)] : [{ text: label, view: "job", id: j.id, arg: which }];
  });
  rows.push(backHome(u));
  return { text: jobs.length ? `${title} (${jobs.length})` : `${title}\n${L("មិនមានការងារទេ ✅", "No jobs ✅")}`, buttons: rows };
}
async function nextStep(bookingId: string): Promise<Step | null> {
  const done = new Set((await sql<{ step: Step }[]>`select step from booking_checkpoints where booking_id = ${bookingId}`).map((c) => c.step));
  for (const s of ["depart", "arrive", "start", "finish"] as Step[]) if (!done.has(s)) return s;
  return null;
}
const STEP_LABEL: Record<string, [string, string]> = { depart: ["🚐 ចេញដំណើរ", "🚐 Depart"], arrive: ["📍 ដល់ទីតាំង (ផ្ញើទីតាំង)", "📍 Arrived (send location)"], start: ["▶️ ចាប់ផ្តើម", "▶️ Start"], finish: ["✅ រួចរាល់", "✅ Done"], return: ["↩️ ត្រឡប់", "↩️ Return"] };
async function canReview(u: Staff, perms?: string[]): Promise<boolean> {
  const p = perms ?? (await permissionsFor(sql, u.company_id, u.role));
  return p.includes("job.review") || (u.role === "tech" && u.is_lead);
}
async function staffJob(u: Staff, id: string, back: string): Promise<Menu> {
  const own = u.role === "tech" ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${u.id})` : sql``;
  const L = T(u), lang = asLang(u.language);
  const b = (await sql<{ id: string; number: string; scheduled_at: Date; ends_at: Date | null; service_text: string; address: string | null; zone: string; notes: string | null;
    lat: number | null; lng: number | null; cname: string; phones: string[]; status: string; vcode: string | null }[]>`
    select b.id, b.number, b.scheduled_at, b.ends_at, b.service_text, b.address, b.zone, b.notes, b.lat, b.lng, b.status, c.name as cname, c.phones, v.code as vcode
    from bookings b join customers c on c.id = b.customer_id left join vehicles v on v.id = b.vehicle_id where b.id = ${id} and b.company_id = ${u.company_id} ${own}`)[0];
  const backBtn: MenuButton = { text: L("⬅️ ត្រឡប់", "⬅️ Back"), view: /^[a-z_]{2,20}$/.test(back) ? back : "next" };
  if (!b) return { text: L("❌ រកមិនឃើញការងារនេះ ឬអ្នកមិនមានសិទ្ធិមើល។", "❌ Job not found, or you may not see it."), buttons: [[backBtn]] };
  const crew = await sql<{ full_name: string; role: string; user_id: string }[]>`select u.full_name, t.role, t.user_id from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${b.id} order by t.role, u.full_name`;
  const tz = u.timezone;
  const text = [`🔧 ${b.number}`, `📅 ${dmy(b.scheduled_at, tz)} · ${hhmm(b.scheduled_at, tz)}${b.ends_at ? `–${hhmm(b.ends_at, tz)}` : ""}`,
    `👤 ${b.cname}${b.phones?.[0] ? ` · 📞 ${b.phones[0]}` : ""}`, `📍 ${b.address ?? "—"} (${pick(ZONE[b.zone] ?? ZONE.outside!, lang)})`, `🛠 ${b.service_text}`,
    `👷 ${crew.map((c) => c.full_name + (c.role === "lead" ? ` (${pick(LEAD, lang)})` : "")).join(", ") || "—"}${b.vcode ? ` · 🚐 ${b.vcode}` : ""}`, b.notes ? `📝 ${b.notes}` : ""].filter(Boolean).join("\n");
  const rows: MenuButton[][] = [];
  const perms = await permissionsFor(sql, u.company_id, u.role);
  if (crew.some((c) => c.user_id === u.id) && perms.includes("job.checkpoint") && ["assigned", "en_route", "on_site", "working"].includes(b.status)) {
    const s = await nextStep(b.id);
    if (s) rows.push([{ text: L(...STEP_LABEL[s]!), view: "step", id: b.id, arg: s }]);
  }
  if (b.status === "pending_review" && (await canReview(u, perms))) rows.push([{ text: L("✅ ត្រឹមត្រូវ", "✅ Approve"), view: "review", id: b.id, arg: "ok" }, { text: L("↩️ ផ្ញើត្រឡប់", "↩️ Send back"), view: "review", id: b.id, arg: "back" }]);
  if (b.lat != null && b.lng != null) rows.push([{ text: L("🗺 ផ្លូវទៅ", "🗺 Directions"), url: `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving` }]);
  rows.push(url(L("📱 មើលក្នុងកម្មវិធី", "📱 Open in the app"), appUrl(u.role === "tech" ? `/tech/job/${b.id}` : `/bookings/${b.id}`)));
  rows.push([backBtn, ...backHome(u)]);
  return { text, buttons: rows.filter((r) => r.length) };
}
async function doStep(u: Staff, chatId: number, id: string, step: string): Promise<Menu> {
  const L = T(u);
  const jobBtn: MenuButton = { text: L("🔧 ការងារ", "🔧 Job"), view: "job", id, arg: "steps" };
  if (!STEPS.includes(step as Step)) return { text: errText(u, new AppError("NOT_FOUND", 404)), buttons: [backHome(u)] };
  const perms = await permissionsFor(sql, u.company_id, u.role);
  if (step === "arrive") {
    const own = (await sql`select 1 from booking_technicians where booking_id = ${id} and user_id = ${u.id}`).length > 0;
    if (!own && u.role !== "gm") return { text: errText(u, new AppError("FORBIDDEN", 403)), buttons: [backHome(u)] };
    await setPending(chatId, u.company_id, { kind: "arrive", booking_id: id });
    return { text: L("📍 ដល់ទីតាំងហើយ? សូមផ្ញើទីតាំងបច្ចុប្បន្នរបស់អ្នក (GPS) ដើម្បីកត់ត្រា។", "📍 Arrived? Send your current location (GPS) to record it."), ask_location: true, buttons: [[jobBtn]] };
  }
  try {
    const r = await recordCheckpoint(sessionOf(u), perms, null, id, { step: step as Step, no_gps: true });
    const when = hhmm(new Date(r.at), u.timezone);
    const text = r.duplicate ? L(`ℹ️ ជំហាននេះបានកត់រួចហើយ (${when}) ✅`, `ℹ️ This step was already recorded (${when}) ✅`) : `${L(...STEP_LABEL[step]!)} · ${when} ✅`;
    const next = await nextStep(id);
    const rows: MenuButton[][] = next ? [[{ text: L(...STEP_LABEL[next]!), view: "step", id, arg: next }]] : [];
    rows.push([jobBtn, ...backHome(u)]);
    return { text, buttons: rows };
  } catch (e) { return { text: errText(u, e), buttons: [[jobBtn, ...backHome(u)]] }; }
}
async function reviewList(u: Staff): Promise<Menu> {
  const L = T(u);
  if (!(await canReview(u))) return { text: errText(u, new AppError("FORBIDDEN", 403)), buttons: [backHome(u)] };
  const jobs = await sql<{ id: string; number: string; cname: string; who: string | null }[]>`select b.id, b.number, c.name as cname, x.full_name as who from bookings b join customers c on c.id = b.customer_id
    left join booking_reports r on r.booking_id = b.id left join users x on x.id = r.submitted_by where b.company_id = ${u.company_id} and b.status = 'pending_review' order by r.submitted_at nulls last limit 10`;
  const rows: MenuButton[][] = jobs.map((j) => [{ text: `${j.number} · ${j.cname}${j.who ? ` · 👷 ${j.who}` : ""}`.slice(0, 60), view: "job", id: j.id, arg: "review" }]);
  for (const j of jobs) rows.push([{ text: `✅ ${j.number}`, view: "review", id: j.id, arg: "ok" }, { text: `↩️ ${j.number}`, view: "review", id: j.id, arg: "back" }]);
  rows.push(backHome(u));
  return { text: jobs.length ? L(`🔎 រង់ចាំពិនិត្យ (${jobs.length})`, `🔎 Waiting for review (${jobs.length})`) : L("🔎 គ្មានការងាររង់ចាំពិនិត្យ ✅", "🔎 Nothing waiting for review ✅"), buttons: rows };
}
async function doReview(u: Staff, chatId: number, id: string, arg: string): Promise<Menu> {
  const L = T(u);
  if (!(await canReview(u))) return { text: errText(u, new AppError("FORBIDDEN", 403)), buttons: [backHome(u)] };
  if (arg === "back") {
    await setPending(chatId, u.company_id, { kind: "review_note", booking_id: id });
    return { text: L("📝 សូមសរសេរមូលហេតុដែលត្រូវកែ (ផ្ញើជាសារ)", "📝 Write the note for the technician (send it as a message)"), buttons: [[{ text: L("⬅️ ត្រឡប់", "⬅️ Back"), view: "review" }]] };
  }
  try { await reviewReport(sessionOf(u), null, id, "approve", ""); return { text: L("✅ ការងារត្រឹមត្រូវ — បានជូនដំណឹងជាង", "✅ Approved — the technician is told"), buttons: [[{ text: L("🔎 បន្ទាប់", "🔎 Next"), view: "review" }, ...backHome(u)]] }; }
  catch (e) { return { text: errText(u, e), buttons: [[{ text: L("🔎 ត្រឡប់", "🔎 Back"), view: "review" }, ...backHome(u)]] }; }
}
async function surveyList(u: Staff): Promise<Menu> {
  const L = T(u);
  const jobs = await sql<{ id: string; number: string; cname: string; scheduled_at: Date }[]>`select b.id, b.number, c.name as cname, b.scheduled_at from bookings b join customers c on c.id = b.customer_id
    where b.company_id = ${u.company_id} and b.type = 'B' and b.surveyed_at is null and b.status in ('new', 'survey', 'assigned') order by b.scheduled_at limit 10`;
  const rows: MenuButton[][] = jobs.map((j) => [appBtn(`${dmy(j.scheduled_at, u.timezone)} · ${j.number} · ${j.cname}`.slice(0, 60), `/bookings/${j.id}`)]);
  rows.push(backHome(u));
  return { text: jobs.length ? L(`📐 ត្រូវសិក្សាទីតាំង (${jobs.length}) — ចុចដើម្បីបើកក្នុងកម្មវិធី`, `📐 Site surveys needed (${jobs.length}) — tap to open in the app`) : L("📐 គ្មានការងារត្រូវសិក្សាទីតាំង ✅", "📐 No site survey needed ✅"), buttons: rows };
}
async function teamToday(u: Staff): Promise<Menu> {
  const L = T(u);
  const { from, to } = await dayRange(u.timezone);
  const jobs = await sql<{ number: string; scheduled_at: Date; cname: string; crew: string | null; status: string }[]>`select b.number, b.scheduled_at, c.name as cname, b.status::text,
      (select string_agg(x.full_name || case when t.role = 'lead' then ' ★' else '' end, ', ' order by t.role, x.full_name) from booking_technicians t join users x on x.id = t.user_id where t.booking_id = b.id) as crew
    from bookings b join customers c on c.id = b.customer_id where b.company_id = ${u.company_id} and b.scheduled_at >= ${from}::timestamptz and b.scheduled_at < ${to}::timestamptz
      and b.status <> 'cancelled' and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${u.id} and t.role = 'lead') order by b.scheduled_at`;
  const lines = jobs.map((j) => `• ${hhmm(j.scheduled_at, u.timezone)} ${j.number} · ${j.cname}\n   👷 ${j.crew ?? "—"} · ${j.status}`);
  return { text: `${L("👥 ក្រុមខ្ញុំថ្ងៃនេះ", "👥 My team today")}\n${lines.join("\n") || L("មិនមានការងារទេ ✅", "No jobs ✅")}`, buttons: [backHome(u)] };
}
// ---------- managers ----------
async function waitingInvoice(u: Staff): Promise<Menu> {
  const L = T(u);
  const rows = (await uninvoiced(u.company_id)).slice(0, 10);
  const lines = rows.map((r) => `• ${r.number} · ${r.customer_name} · ${L(`${r.age_days} ថ្ងៃ`, `${r.age_days} d`)}${r.estimate ? ` · ~${formatUsd(r.estimate)}` : ""}`);
  return { text: `${L("🧾 ធ្វើរួច មិនទាន់វិក្កយបត្រ", "🧾 Done, not invoiced")} (${rows.length})\n${lines.join("\n") || "✅"}`, buttons: [[appBtn(L("📱 វិក្កយបត្រ", "📱 Invoices"), "/invoices")], backHome(u)] };
}
async function dueCleaning(u: Staff): Promise<Menu> {
  const L = T(u);
  const rows = (await listReminders(sessionOf(u), 14)).slice(0, 10);
  const lines = rows.map((r) => `• ${r.customer_name}${r.unit_label ? ` · ${r.unit_label}` : ""} · ${r.service_name} · ${r.due_on}${r.phones?.[0] ? ` · 📞 ${r.phones[0]}` : ""}`);
  return { text: `${L("🔔 ដល់ពេលលាង (14 ថ្ងៃ)", "🔔 Due for cleaning (14 days)")} (${rows.length})\n${lines.join("\n") || "✅"}`, buttons: [[appBtn(L("📱 រំលឹកថែទាំ", "📱 Reminders"), "/reminders")], backHome(u)] };
}
async function findCustomer(u: Staff, q: string): Promise<Menu> {
  const L = T(u);
  const like = `%${q.trim().replace(/[%_]/g, "")}%`;
  const rows = await sql<{ name: string; phones: string[]; address: string | null; last: string | null }[]>`select c.name, c.phones, c.address,
      (select b.number || ' · ' || to_char(b.scheduled_at at time zone ${u.timezone}, 'DD-MM-YYYY') from bookings b where b.customer_id = c.id order by b.scheduled_at desc limit 1) as last
    from customers c where c.company_id = ${u.company_id} and (c.name ilike ${like} or exists (select 1 from unnest(c.phones) p where p like ${like})) order by c.name limit 8`;
  const lines = rows.map((r) => `• ${r.name} · 📞 ${r.phones.join(", ")}${r.address ? `\n   📍 ${r.address}` : ""}${r.last ? `\n   🔧 ${r.last}` : ""}`);
  return { text: rows.length ? `${L("🔍 លទ្ធផល", "🔍 Results")} (${rows.length})\n${lines.join("\n")}` : L("🔍 រកមិនឃើញ", "🔍 No match"), buttons: [[appBtn(L("📱 អតិថិជន", "📱 Customers"), "/customers")], backHome(u)] };
}
/** who handles customer requests in the bot — the same permissions as the app page */
async function requestPerms(u: Staff): Promise<{ see: boolean; decide: boolean }> {
  const p = await permissionsFor(sql, u.company_id, u.role);
  return { see: p.includes("booking.create") || p.includes("customer.manage"), decide: p.includes("booking.create") };
}
/** D-91/D-96: free requests and quotes → ✅ done; an online booking that waits → ✅ confirm / ❌ decline (reason asked);
 *  a customer's wish for another time → ✅ approve / ❌ reject */
async function requestsList(u: Staff): Promise<Menu> {
  const L = T(u);
  const can = await requestPerms(u);
  if (!can.see) return { text: errText(u, new AppError("FORBIDDEN", 403)), buttons: [backHome(u)] };
  const rows = await sql<{ id: string; source: string; kind: string; text: string; name: string | null; phone: string | null; cname: string | null; created_at: Date; number: string | null; web_status: string | null }[]>`
    select r.id, r.source, r.kind, r.text, r.name, r.phone, c.name as cname, r.created_at, b.number, b.web_status
    from service_requests r left join customers c on c.id = r.customer_id left join bookings b on b.id = r.booking_id where r.company_id = ${u.company_id} and r.status = 'new' order by r.created_at desc limit 10`;
  const icon = (r: { kind: string; source: string }) => (r.kind === "booking" ? "🗓" : r.kind === "quote" ? "🧱" : r.kind === "reschedule" ? "🔁" : r.source === "website" ? "🌐" : "✈️");
  const lines = rows.map((r, i) => `${i + 1}. ${icon(r)} ${r.kind === "booking" && r.number ? `${r.number} · ` : ""}${r.name ?? r.cname ?? "—"}${r.phone ? ` · 📞 ${r.phone}` : ""} · ${fmtLocal(r.created_at, u.timezone)}\n   ${r.text}`);
  const pairs: MenuButton[][] = [], done: MenuButton[] = [];
  rows.forEach((r, i) => {
    const decision = r.kind === "booking" && r.web_status === "pending" ? ["confirm", "decline"] : r.kind === "reschedule" ? ["approve", "reject"] : null;
    if (!decision) done.push({ text: `✅ ${i + 1}`, view: "req", id: r.id, arg: "done" });
    else if (can.decide) pairs.push([{ text: `✅ ${i + 1}`, view: "req", id: r.id, arg: decision[0]! }, { text: `❌ ${i + 1}`, view: "req", id: r.id, arg: decision[1]! }]);
  });
  return { text: rows.length ? `${L("🌐 សំណើអតិថិជន", "🌐 Customer requests")} (${rows.length})\n${lines.join("\n")}` : L("🌐 គ្មានសំណើថ្មី ✅", "🌐 No new requests ✅"), buttons: [...pairs, ...rows2(done), backHome(u)] };
}
async function doRequest(u: Staff, chatId: number, id: string, arg: string): Promise<Menu> {
  const L = T(u);
  const can = await requestPerms(u);
  const again: MenuButton[][] = [[{ text: L("🌐 សំណើ", "🌐 Requests"), view: "req" }, ...backHome(u)]];
  if (!can.see || (arg !== "done" && !can.decide)) return { text: errText(u, new AppError("FORBIDDEN", 403)), buttons: [backHome(u)] };
  try {
    switch (arg) {
      case "done": await markRequestDone(sessionOf(u), null, id); return { text: L("✅ បានកត់ថាដោះស្រាយរួច", "✅ Marked as done"), buttons: again };
      case "confirm": await decideWebBooking(sessionOf(u), null, id, "confirm"); return { text: L("✅ បានបញ្ជាក់ការកក់ — អតិថិជនទទួលដំណឹង", "✅ Booking confirmed — the customer is told"), buttons: again };
      case "decline": await setPending(chatId, u.company_id, { kind: "decline_note", request_id: id });
        return { text: L("📝 សូមសរសេរមូលហេតុដែលមិនអាចទទួលការកក់នេះ (ផ្ញើជាសារ)", "📝 Write the reason for declining this booking (send it as a message)"), buttons: again };
      case "approve": await decideReschedule(sessionOf(u), null, id, "approve"); return { text: L("✅ បានប្ដូរម៉ោង — អតិថិជនទទួលដំណឹង", "✅ Rescheduled — the customer is told"), buttons: again };
      case "reject": await decideReschedule(sessionOf(u), null, id, "reject"); return { text: L("↩️ មិនប្ដូរម៉ោងទេ — អតិថិជនទទួលដំណឹង", "↩️ Time kept — the customer is told"), buttons: again };
      default: return requestsList(u);
    }
  } catch (e) { return { text: errText(u, e), buttons: again }; }
}
async function approvals(u: Staff): Promise<Menu> {
  const L = T(u);
  const c = (await sql<{ disc: number; voids: number; pvoids: number; leave: number; review: number }[]>`select
      (select count(*)::int from invoices where company_id = ${u.company_id} and discount_status = 'pending') as disc,
      (select count(*)::int from invoice_void_requests where company_id = ${u.company_id} and status = 'pending') as voids,
      (select count(*)::int from payment_void_requests where company_id = ${u.company_id} and status = 'pending') as pvoids,
      (select count(*)::int from staff_leaves where company_id = ${u.company_id} and status = 'pending') as leave,
      (select count(*)::int from bookings where company_id = ${u.company_id} and status = 'pending_review') as review`)[0]!;
  const text = [L("✅ រង់ចាំអនុម័ត", "✅ Pending approvals"), L(`💸 បញ្ចុះតម្លៃ: ${c.disc}`, `💸 Discounts: ${c.disc}`), L(`🚫 ធ្វើមោឃៈ: ${c.voids + c.pvoids}`, `🚫 Voids: ${c.voids + c.pvoids}`),
    L(`🗓 ច្បាប់ឈប់: ${c.leave}`, `🗓 Leave: ${c.leave}`), L(`🔎 រង់ចាំពិនិត្យការងារ: ${c.review}`, `🔎 Jobs to review: ${c.review}`)].join("\n");
  return { text, buttons: [[appBtn(L("🧾 វិក្កយបត្រ", "🧾 Invoices"), "/invoices"), appBtn(L("🗓 ច្បាប់ឈប់", "🗓 Leave"), "/leave")],
    ...(c.review ? [[{ text: L("🔎 ពិនិត្យការងារ", "🔎 Review jobs"), view: "review" }]] : []), backHome(u)] };
}
async function whereTechs(u: Staff): Promise<Menu> {
  const L = T(u);
  const { from, to, day } = await dayRange(u.timezone);
  // per technician: the last job step they recorded today, else today's attendance
  const rows = await sql<{ full_name: string; number: string | null; cname: string | null; address: string | null; step: string | null; at: Date | null; in_at: Date | null; out_at: Date | null }[]>`
    select x.full_name, k.number, k.cname, k.address, k.step, k.at, a.in_at, a.out_at from users x
    left join lateral (select b.number, c.name as cname, b.address, cp.step::text as step, cp.at from booking_checkpoints cp join bookings b on b.id = cp.booking_id join customers c on c.id = b.customer_id
      where cp.by_user = x.id and cp.at >= ${from}::timestamptz and cp.at < ${to}::timestamptz order by cp.at desc limit 1) k on true
    left join attendance a on a.user_id = x.id and a.work_date = ${day}::date
    where x.company_id = ${u.company_id} and x.is_active and x.role = 'tech' order by x.full_name`;
  const stepKm: Record<string, [string, string]> = { depart: ["🚐 កំពុងធ្វើដំណើរ", "🚐 on the way"], arrive: ["📍 ដល់ទីតាំង", "📍 on site"], start: ["🔧 កំពុងធ្វើ", "🔧 working"], finish: ["✅ រួច", "✅ done"], return: ["↩️ ត្រឡប់", "↩️ returning"] };
  const lines = rows.map((r) => {
    if (r.step) return `• 👷 ${r.full_name} · ${L(...stepKm[r.step]!)} ${hhmm(r.at!, u.timezone)} · ${r.number} · ${r.cname}${r.address ? `\n   📍 ${r.address}` : ""}`;
    if (r.in_at) return `• 👷 ${r.full_name} · ${r.out_at ? L(`ចេញ ${hhmm(r.out_at, u.timezone)}`, `out ${hhmm(r.out_at, u.timezone)}`) : L(`ចូល ${hhmm(r.in_at, u.timezone)}`, `in ${hhmm(r.in_at, u.timezone)}`)} · ${L("មិនទាន់ចេញដំណើរ", "no job step yet")}`;
    return `• 👷 ${r.full_name} · ${L("⏳ មិនទាន់ចូលធ្វើការ", "⏳ not checked in")}`;
  });
  return { text: `${L("📍 ជាងនៅណា (ថ្ងៃនេះ)", "📍 Where are technicians (today)")}\n${lines.join("\n") || L("គ្មានជាង", "No technicians")}`, buttons: [backHome(u)] };
}
async function summaryFor(u: Staff, kind: "daily" | "weekly" | "monthly"): Promise<Menu> {
  const L = T(u);
  const perms = await permissionsFor(sql, u.company_id, u.role);
  const finance = perms.includes("report.finance");
  const { day } = await dayRange(u.timezone);
  const from = kind === "daily" ? day : kind === "weekly" ? (await sql<{ d: string }[]>`select (${day}::date - 6)::text as d`)[0]!.d : day.slice(0, 8) + "01";
  const data = await summaryData(u.company_id, from, day, finance);
  if (finance) return { text: summaryText(kind, from, day, data, asLang(u.language)), buttons: [backHome(u)] };
  const x = data as { jobs: { created: number; finished: number; cancelled: number; pending_review: number; in_progress: number }; attendance?: { present: number; people: number; late: number; absent: number; leave: number } };
  const range = from === day ? day : `${from} → ${day}`;
  const lines = [L(`📊 សង្ខេប · ${range}`, `📊 Summary · ${range}`),
    L(`🔧 ការងារ: ថ្មី ${x.jobs.created} · បញ្ចប់ ${x.jobs.finished} · លុប ${x.jobs.cancelled} · កំពុងធ្វើ ${x.jobs.in_progress} · រង់ចាំពិនិត្យ ${x.jobs.pending_review}`,
      `🔧 Jobs: new ${x.jobs.created} · finished ${x.jobs.finished} · cancelled ${x.jobs.cancelled} · in progress ${x.jobs.in_progress} · waiting for review ${x.jobs.pending_review}`)];
  if (x.attendance) lines.push(L(`👷 វត្តមាន: មក ${x.attendance.present}/${x.attendance.people} · យឺត ${x.attendance.late} · អវត្តមាន ${x.attendance.absent} · ច្បាប់ ${x.attendance.leave}`,
    `👷 Attendance: present ${x.attendance.present}/${x.attendance.people} · late ${x.attendance.late} · absent ${x.attendance.absent} · leave ${x.attendance.leave}`));
  return { text: lines.join("\n"), buttons: [backHome(u)] };
}
async function alerts(u: Staff): Promise<Menu> {
  const L = T(u);
  const rows = await sql<{ title: string; body: string | null; created_at: Date }[]>`select title, body, created_at from notifications where user_id = ${u.id}
    and kind in ('invoice.void', 'invoice.void_request', 'payment.void', 'payment.void_request', 'invoice.discount', 'booking.late', 'stock.low', 'job.review', 'leave.request', 'service.request') order by created_at desc limit 10`;
  const lines = rows.map((r) => `• ${fmtLocal(r.created_at, u.timezone)} ${r.title}${r.body ? `\n   ${r.body.split("\n")[0]}` : ""}`);
  return { text: `${L("🚨 ដំណឹងសំខាន់ (10 ចុងក្រោយ)", "🚨 Important alerts (last 10)")}\n${lines.join("\n") || L("គ្មាន ✅", "None ✅")}`, buttons: [backHome(u)] };
}
async function staffToday(u: Staff): Promise<Menu> {
  const L = T(u);
  const { day } = await dayRange(u.timezone);
  const rows = await sql<{ full_name: string; in_at: Date | null; out_at: Date | null; leave: boolean }[]>`select x.full_name, a.in_at, a.out_at,
      exists (select 1 from staff_leaves l where l.user_id = x.id and l.status = 'approved' and ${day}::date between l.date_from and l.date_to) as leave
    from users x left join attendance a on a.user_id = x.id and a.work_date = ${day}::date where x.company_id = ${u.company_id} and x.is_active and x.tracks_attendance and x.role in ('tech', 'admin', 'gm') order by x.role, x.full_name`;
  const lines = rows.map((r) => r.leave ? `🗓 ${r.full_name} · ${L("ច្បាប់", "leave")}` : r.in_at ? `✅ ${r.full_name} · ${L("ចូល", "in")} ${hhmm(r.in_at, u.timezone)}${r.out_at ? ` · ${L("ចេញ", "out")} ${hhmm(r.out_at, u.timezone)}` : ""}` : `— ${r.full_name} · ${L("មិនទាន់ចូល", "not in yet")}`);
  return { text: `${L("👷 បុគ្គលិកថ្ងៃនេះ", "👷 Staff today")} · ${day}\n${lines.join("\n") || "—"}`, buttons: [backHome(u)] };
}
async function cashToday(u: Staff): Promise<Menu> {
  const L = T(u);
  const { day } = await dayRange(u.timezone);
  const c = (await cashCloses(sessionOf(u), day, day))[0]!;
  const riel = (n: number) => `${Math.round(n).toLocaleString("en-US")}៛`;
  const lines = [L(`💵 សាច់ប្រាក់ថ្ងៃនេះ · ${day}`, `💵 Cash today · ${day}`), L(`គួរមាន: ${formatUsd(c.expected_usd)} · ${riel(c.expected_khr)}`, `Expected: ${formatUsd(c.expected_usd)} · ${riel(c.expected_khr)}`)];
  lines.push(c.counted_usd == null ? L("រាប់: មិនទាន់បិទបញ្ជី", "Counted: not closed yet")
    : L(`រាប់: ${formatUsd(c.counted_usd)} · ${riel(c.counted_khr ?? 0)} · ខុសគ្នា ${formatUsd(c.diff_usd ?? 0)}${c.closed ? " · ✅ បានផ្ទៀងផ្ទាត់" : ""}`, `Counted: ${formatUsd(c.counted_usd)} · ${riel(c.counted_khr ?? 0)} · diff ${formatUsd(c.diff_usd ?? 0)}${c.closed ? " · ✅ verified" : ""}`));
  return { text: lines.join("\n"), buttons: [[appBtn(L("📱 របាយការណ៍", "📱 Reports"), "/reports")], backHome(u)] };
}
async function toVerify(u: Staff): Promise<Menu> {
  const L = T(u);
  const { day } = await dayRange(u.timezone);
  const from = (await sql<{ d: string }[]>`select (${day}::date - 30)::text as d`)[0]!.d;
  const rows = (await verification(sessionOf(u), from, day, true)) as Record<string, unknown>[];
  const lines = rows.slice(0, 8).map((r) => `• ${String(r.type ?? "")} ${String(r.ref ?? "")}${r.amount != null ? ` · ${formatUsd(Number(r.amount))}` : ""}`);
  return { text: `${L("🔎 ត្រូវផ្ទៀងផ្ទាត់ (30 ថ្ងៃ)", "🔎 To verify (30 days)")} (${rows.length})\n${lines.join("\n") || "✅"}`, buttons: [[appBtn(L("📱 ផ្ទៀងផ្ទាត់", "📱 Verify"), "/reports")], backHome(u)] };
}
async function lowStock(u: Staff): Promise<Menu> {
  const L = T(u);
  const rows = (await stockItems(sessionOf(u))).filter((i) => i.low);
  const lines = rows.map((i) => `• ${i.name}: ${i.qty} ${i.unit} (${L("កម្រិត", "level")} ${i.reorder_level})`);
  return { text: `${L("📦 ស្តុកជិតអស់", "📦 Low stock")} (${rows.length})\n${lines.join("\n") || "✅"}`, buttons: [[appBtn(L("📱 ស្តុក", "📱 Stock"), "/inventory")], backHome(u)] };
}
async function meScreen(u: Staff): Promise<Menu> {
  const L = T(u);
  return { text: L(`👤 ${u.full_name} · ${u.role}\nភាសា: ខ្មែរ`, `👤 ${u.full_name} · ${u.role}\nLanguage: English`),
    buttons: [[{ text: "🇰🇭 ខ្មែរ", view: "lang_km" }, { text: "🇬🇧 English", view: "lang_en" }], [{ text: L("🔌 ផ្ដាច់ Telegram", "🔌 Unlink Telegram"), view: "unlink" }], backHome(u)] };
}
async function unlink(u: Staff, chatId: number): Promise<Menu> {
  await sql`update users set telegram_user_id = null, telegram_chat_id = null where id = ${u.id}`;
  await audit(sql, { companyId: u.company_id, userId: u.id, action: "telegram.unlink", source: "telegram", table: "users", rowId: u.id, new: { by: "bot_me" } });
  await hubForgetChat(chatId);
  return { text: T(u)("✅ បានផ្ដាច់ Telegram។ ភ្ជាប់វិញ: កម្មវិធី → ខ្ញុំ → ភ្ជាប់ Telegram។", "✅ Telegram unlinked. Link again: app → Me → Link Telegram."), remove_keyboard: true };
}
const HELP_CUSTOMER = "❓ របៀបប្រើ\n• ចុចប៊ូតុងខាងក្រោម ដើម្បីមើលការកក់ ការធានា ឬប្រវត្តិរបស់អ្នក\n• «ស្នើសេវាកម្ម» → សរសេរអ្វីដែលអ្នកត្រូវការ ហាងនឹងទាក់ទងមកវិញ\n• /stop promo — បិទប្រូម៉ូសិន · /stop — ឈប់ទទួលសារ";
const helpStaff = (u: Staff) => T(u)("❓ របៀបប្រើ\n• ប៊ូតុងខាងក្រោម = ម៉ឺនុយរបស់អ្នក (តាមតួនាទី)\n• ប៊ូតុងដែលបើកកម្មវិធី ត្រូវការអ៊ីនធឺណិត\n• ការផ្ញើទីតាំង ប្រើបានតែក្នុងការជជែកផ្ទាល់ជាមួយ bot\n• ក្រុមការងារ ទទួលតែដំណឹង\n• ខ្ញុំ → ប្តូរភាសា ឬផ្ដាច់ Telegram",
  "❓ How to use\n• The buttons below are your menu (by role)\n• Buttons that open the app need internet\n• Locations are sent only in this private chat with the bot\n• Work groups receive notifications only\n• Me → change language or unlink Telegram");

// ---------- customer screens (Khmer) ----------
const STATUS_KM: Record<string, string> = { new: "ថ្មី", assigned: "បានចាត់ជាង", en_route: "ជាងកំពុងមក", on_site: "ជាងដល់ទីតាំង", working: "កំពុងធ្វើ", work_done: "ធ្វើរួច", pending_review: "ធ្វើរួច", revision: "ធ្វើរួច", reviewed: "ធ្វើរួច", invoiced: "មានវិក្កយបត្រ", partially_paid: "បង់ខ្លះ", closed: "បិទរួច", cancelled: "លុបចោល" };
async function customerBookings(c: Customer, which: "open" | "warranty" | "history"): Promise<Menu> {
  const rows = await sql<{ number: string; scheduled_at: Date | null; service_text: string; status: string; warranty: { until: string; days_left: number; active: boolean } | null }[]>`
    select b.number, b.scheduled_at, b.service_text, b.status::text, ${warrantyJson(sql)} as warranty from bookings b join companies co on co.id = b.company_id where b.customer_id = ${c.id}
      ${which === "open" ? sql`and b.status not in ('cancelled', 'closed')` : which === "warranty" ? sql`and b.status = 'closed'` : sql``} order by b.scheduled_at desc nulls last limit 10`;
  const list = which === "warranty" ? rows.filter((r) => r.warranty?.active) : rows;
  const lines = list.map((r) => `• ${r.number} · ${r.scheduled_at ? dmy(r.scheduled_at, c.timezone) : "—"} · ${r.service_text}` + (which === "warranty" ? `\n   🛡 ធានាដល់ ${r.warranty!.until} (នៅសល់ ${r.warranty!.days_left} ថ្ងៃ)` : ` · ${STATUS_KM[r.status] ?? r.status}`));
  const title = { open: "📋 ការកក់របស់ខ្ញុំ", warranty: "🛡 ការធានា (30 ថ្ងៃក្រោយបិទការងារ)", history: "📜 ប្រវត្តិ (10 ចុងក្រោយ)" }[which];
  return { text: `${title}\n${lines.join("\n") || "គ្មាន"}` };
}
async function customerContact(c: Customer): Promise<Menu> {
  const r = (await sql<{ name: string; info: Record<string, string> | null }[]>`select co.name, s.company_info as info from companies co join company_settings s on s.company_id = co.id where co.id = ${c.company_id}`)[0]!;
  const i = r.info ?? {};
  return { text: [`📞 ${i.name_km || r.name}`, i.phone ? `☎ ${i.phone}` : "", i.address ? `📍 ${i.address}` : "", "សូមទូរស័ព្ទ ឬចុច «🛠 ស្នើសេវាកម្ម» ដើម្បីទុកសារ"].filter(Boolean).join("\n") };
}
async function customerPromos(): Promise<Menu> {
  if (!hubConfigured()) return { text: "🎁 មិនមានប្រូម៉ូសិនពេលនេះ" };
  const r = await hubCall("GET", "/internal/broadcasts").catch(() => null);
  const list = (r && r.status === 200 && Array.isArray(r.json) ? (r.json as { kind: string; text: string }[]) : []).filter((b) => b.kind === "promo").slice(0, 3);
  return { text: list.length ? `🎁 ប្រូម៉ូសិន\n${list.map((b) => `• ${b.text}`).join("\n")}` : "🎁 មិនមានប្រូម៉ូសិនពេលនេះ" };
}
async function saveRequest(c: Customer, subscriberId: number, text: string): Promise<Menu> {
  await createRequest({ companyId: c.company_id, source: "telegram", name: c.name, text, customerId: c.id, subscriberId });
  return { text: "✅ បានទទួលសំណើរបស់អ្នក។ ហាងនឹងទាក់ទងមកវិញឆាប់ៗ។" };
}

// ---------- public API ----------
async function staffAction(u: Staff, chatId: number, a: Action): Promise<Menu> {
  const L = T(u);
  switch (a) {
    case "today": case "tomorrow": case "steps": case "report": return jobList(u, a);
    case "att": { const text = await attendanceMenuText(u.id); return { text: text ?? L("ℹ️ គណនីរបស់អ្នកមិនកត់វត្តមានទេ។", "ℹ️ Your account does not record attendance."), ask_location: !!text, buttons: [backHome(u)] }; }
    case "review": return reviewList(u);
    case "survey": return surveyList(u);
    case "team": return teamToday(u);
    case "waiting_invoice": return waitingInvoice(u);
    case "due_cleaning": return dueCleaning(u);
    case "find_customer": await setPending(chatId, u.company_id, { kind: "find_customer" }); return { text: L("🔍 សរសេរឈ្មោះ ឬលេខទូរស័ព្ទអតិថិជន (ផ្ញើជាសារ)", "🔍 Type the customer's name or phone (send it as a message)") };
    case "requests": return requestsList(u);
    case "approvals": return approvals(u);
    case "where_techs": return whereTechs(u);
    case "summary_today": return summaryFor(u, "daily");
    case "summary": return { text: L("📊 សង្ខេប — ជ្រើសរយៈពេល", "📊 Summary — pick a period"), buttons: [[{ text: L("ថ្ងៃនេះ", "Today"), view: "sum_day" }, { text: L("សប្តាហ៍", "Week"), view: "sum_week" }, { text: L("ខែ", "Month"), view: "sum_month" }], backHome(u)] };
    case "alerts": return alerts(u);
    case "staff_today": return staffToday(u);
    case "cash_today": return cashToday(u);
    case "to_verify": return toVerify(u);
    case "low_stock": return lowStock(u);
    case "me": return meScreen(u);
    case "help": return { text: helpStaff(u) };
    case "new_booking": case "receive_payment": case "finance": case "leave":
      return { text: L("📱 បើកក្នុងកម្មវិធី 👇", "📱 Open in the app 👇"), buttons: [[appBtn(LABEL[a][asLang(u.language)], LABEL[a].app!)], backHome(u)] };
    default: return staffHome(u);
  }
}
const staffReply = (u: Staff, m: Menu): BotReply => ({ kind: "staff", lang: asLang(u.language), ...(m ?? { text: "" }) });

/** /start in a private chat: who is it → greeting + reply keyboard (+ inline quick buttons for staff) */
export async function botStart(chatId: number, subscriberId?: number | null): Promise<BotReply> {
  const u = await staffByChat(chatId);
  if (u) return staffReply(u, await staffHome(u));
  const c = await customerBySubscriber(subscriberId);
  if (c) return { kind: "customer", text: `👋 សួស្តី ${c.name}\nជ្រើសខាងក្រោម 👇`, keyboard: customerKeyboard(), lang: "km" };
  return { kind: "none" };
}

/** a text message in a private chat: a keyboard label, or the answer to a pending question */
export async function botText(chatId: number, text: string, subscriberId?: number | null): Promise<BotReply> {
  const label = BY_LABEL.get(text.trim());
  const u = await staffByChat(chatId);
  if (u) {
    const pending = await takePending(chatId);
    if (pending && !label) {
      if (pending.kind === "find_customer") return staffReply(u, await findCustomer(u, text));
      if (pending.kind === "review_note") {
        try { await reviewReport(sessionOf(u), null, pending.booking_id, "revision", text.trim()); return staffReply(u, { text: T(u)("↩️ បានផ្ញើត្រឡប់ទៅជាង ជាមួយមូលហេតុ", "↩️ Sent back to the technician with your note"), buttons: [[{ text: T(u)("🔎 បន្ទាប់", "🔎 Next"), view: "review" }, ...backHome(u)]] }); }
        catch (e) { return staffReply(u, { text: errText(u, e), buttons: [backHome(u)] }); }
      }
      if (pending.kind === "decline_note") { // D-96: the reason for declining an online booking → cancelled with it, customer told
        const again: MenuButton[][] = [[{ text: T(u)("🌐 សំណើ", "🌐 Requests"), view: "req" }, ...backHome(u)]];
        try {
          if (!(await requestPerms(u)).decide) throw new AppError("FORBIDDEN", 403);
          if (text.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
          await decideWebBooking(sessionOf(u), null, pending.request_id, "decline", text.trim().slice(0, 200));
          return staffReply(u, { text: T(u)("❌ មិនទទួលការកក់នេះ — អតិថិជនទទួលដំណឹង ហើយម៉ោងនោះទំនេរវិញ", "❌ Booking declined — the customer is told and the time is free again"), buttons: again });
        } catch (e) { return staffReply(u, { text: errText(u, e), buttons: again }); }
      }
    }
    if (!label || label.startsWith("c_")) return staffReply(u, { text: T(u)("👇 សូមប្រើប៊ូតុងខាងក្រោម", "👇 Please use the buttons below"), keyboard: await staffKeyboard(u) });
    return staffReply(u, await staffAction(u, chatId, label));
  }
  const c = await customerBySubscriber(subscriberId);
  if (!c) return { kind: "none" };
  const pending = await takePending(chatId);
  const cr = (m: Menu): BotReply => ({ kind: "customer", lang: "km", ...(m ?? { text: "" }) });
  if (pending?.kind === "request_service" && !label) return cr(await saveRequest(c, subscriberId!, text));
  switch (label) {
    case "c_bookings": return cr(await customerBookings(c, "open"));
    case "c_warranty": return cr(await customerBookings(c, "warranty"));
    case "c_history": return cr(await customerBookings(c, "history"));
    case "c_contact": return cr(await customerContact(c));
    case "c_promo": return cr(await customerPromos());
    case "c_request": await setPending(chatId, c.company_id, { kind: "request_service" }); return cr({ text: "🛠 សូមសរសេរប្រាប់យើង៖ ត្រូវការសេវាអ្វី នៅឯណា និងពេលណា (ផ្ញើជាសារ)" });
    case "me": return { kind: "customer_menu" };
    case "help": return cr({ text: HELP_CUSTOMER });
    default: return cr({ text: "👇 សូមប្រើប៊ូតុងខាងក្រោម", keyboard: customerKeyboard() });
  }
}

/** a location in a private chat: the pending «arrive» step of a job, else attendance (FR-902) */
export async function botLocation(b: { chat_id: number; tg_user: number; lat: number; lng: number; accuracy: number | null; sent_at: number }): Promise<string> {
  const u = await staffByChat(b.chat_id);
  const pending = u ? await takePending(b.chat_id) : null;
  if (u && pending?.kind === "arrive") {
    const L = T(u);
    if (Math.abs(Date.now() / 1000 - b.sent_at) > 120) return L("⏳ ទីតាំងនេះចាស់ពេក — សូមចុច «ដល់ទីតាំង» ម្ដងទៀត។", "⏳ This location is too old — press «Arrived» again.");
    try {
      const perms = await permissionsFor(sql, u.company_id, u.role);
      const r = await recordCheckpoint(sessionOf(u), perms, null, pending.booking_id, { step: "arrive", lat: b.lat, lng: b.lng, accuracy: b.accuracy, no_gps: b.accuracy == null });
      return `${L("📍 ដល់ទីតាំង", "📍 Arrived")} · ${hhmm(new Date(r.at), u.timezone)} ✅${b.accuracy == null ? L(" · ⚠️ គ្មាន GPS", " · ⚠️ no GPS") : ""}\n${L("បន្ទាប់: ▶️ ចាប់ផ្តើម (🔧 ជំហានការងារ)", "Next: ▶️ Start (🔧 Job steps)")}`;
    } catch (e) { return errText(u, e); }
  }
  return telegramAttendance(b);
}

/** the role keyboard of a staff chat — sent again after a location, so the one-time location keyboard does not leave the chat bare */
export async function keyboardForChat(chatId: number): Promise<KbButton[][] | null> {
  const u = await staffByChat(chatId);
  return u ? staffKeyboard(u) : null;
}

/** inline callback views (v:<view>[:<uuid>:<arg>]) — null = this chat is not staff */
export async function renderMenu(chatId: number, view: string, id: string | null, arg: string | null): Promise<Menu> {
  const u = await staffByChat(chatId);
  if (!u) return null;
  const L = T(u);
  const m = await (async (): Promise<Menu> => {
    switch (view) {
      case "home": return staffHome(u);
      case "today": case "next": case "tomorrow": case "steps": case "report": return jobList(u, view);
      case "job": return id ? staffJob(u, id, arg ?? "next") : staffHome(u);
      case "step": return id && arg ? doStep(u, chatId, id, arg) : staffHome(u);
      case "review": return id && arg ? doReview(u, chatId, id, arg) : reviewList(u);
      case "survey": return surveyList(u);
      case "req": return id && arg ? doRequest(u, chatId, id, arg) : requestsList(u);
      case "att": return staffAction(u, chatId, "att");
      case "sum_day": return summaryFor(u, "daily");
      case "sum_week": return summaryFor(u, "weekly");
      case "sum_month": return summaryFor(u, "monthly");
      case "me": return meScreen(u);
      case "lang_km": case "lang_en": {
        const lang = view === "lang_en" ? "en" : "km";
        await sql`update users set language = ${lang} where id = ${u.id}`;
        return { ...(await staffHome({ ...u, language: lang }) as NonNullable<Menu>), lang };
      }
      case "unlink": return { text: L("🔌 ផ្ដាច់ Telegram? អ្នកនឹងលែងទទួលការងារនៅទីនេះ។", "🔌 Unlink Telegram? Job messages stop arriving here."), buttons: [[{ text: L("✅ បាទ/ចាស ផ្ដាច់", "✅ Yes, unlink"), view: "unlink_yes" }], backHome(u)] };
      case "unlink_yes": return unlink(u, chatId);
      default: return staffHome(u);
    }
  })();
  return m ? { lang: asLang(u.language), ...m } : m;
}
