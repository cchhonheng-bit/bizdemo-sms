// Telegram inline menus rendered by the SHOP (owner I1). The hub forwards the Telegram chat id it received from Telegram;
// the shop decides from its own data who that is (linked staff / registered work group) and what they may see:
// technicians only their assigned jobs, managers the company's jobs, never prices (AC-01).
// Output: { text, buttons } where a button is a view (the hub turns it into callback data) or an https link.
import { config } from "../config.js";
import { sql } from "../db.js";
import { fmtLocal } from "./telegram.js";
import { attendanceMenuText } from "./attendance.js";
import { asLang, LEAD, pick, tx, ZONE, type Lang } from "../lib/i18n.js";

export type MenuButton = { text: string; view?: string; id?: string; back?: "today" | "next"; url?: string };
export type Menu = { text: string; buttons: MenuButton[][]; lang?: Lang } | null; // lang: the staff member's language (the hub labels its own keyboard with it)

const ACTIVE = ["new", "assigned", "en_route", "on_site", "working"];
const appUrl = (path: string) => (config.publicUrl.startsWith("https://") ? `${config.publicUrl}${path}` : null);
const url = (text: string, u: string | null): MenuButton[] => (u ? [{ text, url: u }] : []);

type Staff = { id: string; company_id: string; full_name: string; role: string; timezone: string; language: string };
const T = (u: Staff) => (km: string, en: string) => pick(tx(km, en), asLang(u.language) as Lang);
async function staffByChat(chatId: number): Promise<Staff | null> {
  return (await sql<Staff[]>`select u.id, u.company_id, u.full_name, u.role, c.timezone, u.language from users u join companies c on c.id = u.company_id
    where u.telegram_chat_id = ${chatId} and u.is_active and c.is_active limit 1`)[0] ?? null;
}
async function isApprover(u: Staff): Promise<boolean> {
  return (await sql`select 1 from role_permissions where company_id = ${u.company_id} and role = ${u.role}::user_role and allowed and permission_key like 'leave.approve.%' limit 1`).length > 0;
}
/** jobs this person may see: own assignments (technicians) or the whole company (managers) */
function jobsOf(u: Staff, from: string, to: string | null, limit = 10) {
  const own = u.role === "tech" ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${u.id})` : sql``;
  return sql<{ id: string; number: string; scheduled_at: Date; ends_at: Date | null; cname: string; status: string }[]>`
    select b.id, b.number, b.scheduled_at, b.ends_at, c.name as cname, b.status from bookings b join customers c on c.id = b.customer_id
    where b.company_id = ${u.company_id} and b.status = any(${sql.array(ACTIVE)}::booking_status[]) ${own}
      and b.scheduled_at >= ${from}::timestamptz ${to ? sql`and b.scheduled_at < ${to}::timestamptz` : sql``}
    order by b.scheduled_at limit ${limit}`;
}
/** [today 00:00, tomorrow 00:00) in the company time zone */
async function todayRange(tz: string): Promise<{ from: string; to: string }> {
  const r = (await sql<{ f: Date; t: Date }[]>`select (date_trunc('day', now() at time zone ${tz}) at time zone ${tz}) as f,
    ((date_trunc('day', now() at time zone ${tz}) + interval '1 day') at time zone ${tz}) as t`)[0]!;
  return { from: r.f.toISOString(), to: r.t.toISOString() };
}
const hhmm = (d: Date, tz: string) => fmtLocal(d, tz).slice(-5);
const dmy = (d: Date, tz: string) => fmtLocal(d, tz).slice(0, 10);

async function staffHome(u: Staff): Promise<Menu> {
  const { from, to } = await todayRange(u.timezone);
  const today = await jobsOf(u, from, to, 50), next = await jobsOf(u, to, null, 50);
  const L = T(u);
  const rows: MenuButton[][] = [
    [{ text: L(`📋 ការងារថ្ងៃនេះ (${today.length})`, `📋 Today's jobs (${today.length})`), view: "today" }],
    [{ text: L(`🗓 ការងារខាងមុខ (${next.length})`, `🗓 Upcoming jobs (${next.length})`), view: "next" }],
  ];
  if (await isApprover(u)) {
    const pending = (await sql<{ n: number }[]>`select count(*)::int as n from staff_leaves l join users x on x.id = l.user_id
      where l.company_id = ${u.company_id} and l.status = 'pending' and l.user_id <> ${u.id}`)[0]!.n;
    rows.push(url(L(`🗓 ច្បាប់ឈប់រង់ចាំ (${pending})`, `🗓 Leave waiting (${pending})`), appUrl("/leave")));
  }
  if (await attendanceMenuText(u.id)) rows.push([{ text: L("📍 វត្តមាន (ចូល/ចេញ)", "📍 Attendance (in/out)"), view: "att" }]); // FR-902
  rows.push(url(L("📱 បើកកម្មវិធី", "📱 Open the app"), appUrl(u.role === "tech" ? "/tech" : "/dashboard")));
  return { text: L(`👷 សួស្តី ${u.full_name}\nថ្ងៃនេះ: ${today.length} ការងារ · ខាងមុខ: ${next.length}\nជ្រើសខាងក្រោម 👇`,
    `👷 Hello ${u.full_name}\nToday: ${today.length} jobs · upcoming: ${next.length}\nChoose below 👇`), buttons: rows.filter((r) => r.length) };
}

async function staffList(u: Staff, which: "today" | "next"): Promise<Menu> {
  const { from, to } = await todayRange(u.timezone);
  const jobs = which === "today" ? await jobsOf(u, from, to) : await jobsOf(u, to, null);
  const L = T(u);
  const title = which === "today" ? L("📋 ការងារថ្ងៃនេះ", "📋 Today's jobs") : L("🗓 ការងារខាងមុខ", "🗓 Upcoming jobs");
  const rows: MenuButton[][] = jobs.map((j) => [{ text: `${which === "next" ? dmy(j.scheduled_at, u.timezone) + " " : ""}${hhmm(j.scheduled_at, u.timezone)} · ${j.number} · ${j.cname}`.slice(0, 60), view: "job", id: j.id, back: which }]);
  rows.push([{ text: L("⬅️ ត្រឡប់", "⬅️ Back"), view: "home" }]);
  return { text: jobs.length ? `${title} (${jobs.length})` : `${title}\n${L("មិនមានការងារទេ ✅", "No jobs ✅")}`, buttons: rows };
}

async function staffJob(u: Staff, id: string, back: string): Promise<Menu> {
  const own = u.role === "tech" ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${u.id})` : sql``;
  const b = (await sql<{ id: string; number: string; scheduled_at: Date; ends_at: Date | null; service_text: string; address: string | null; zone: string; notes: string | null;
    lat: number | null; lng: number | null; cname: string; phones: string[]; status: string; vcode: string | null }[]>`
    select b.id, b.number, b.scheduled_at, b.ends_at, b.service_text, b.address, b.zone, b.notes, b.lat, b.lng, b.status, c.name as cname, c.phones, v.code as vcode
    from bookings b join customers c on c.id = b.customer_id left join vehicles v on v.id = b.vehicle_id
    where b.id = ${id} and b.company_id = ${u.company_id} ${own}`)[0];
  const L = T(u), lang = asLang(u.language);
  if (!b) return { text: L("❌ រកមិនឃើញការងារនេះ ឬអ្នកមិនមានសិទ្ធិមើល។", "❌ Job not found, or you may not see it."), buttons: [[{ text: L("⬅️ ត្រឡប់", "⬅️ Back"), view: back }]] };
  const crew = await sql<{ full_name: string; role: string }[]>`select u.full_name, t.role from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${b.id} order by t.role, u.full_name`;
  const tz = u.timezone;
  const text = [
    `🔧 ${b.number}`,
    `📅 ${dmy(b.scheduled_at, tz)} · ${hhmm(b.scheduled_at, tz)}${b.ends_at ? `–${hhmm(b.ends_at, tz)}` : ""}`,
    `👤 ${b.cname}${b.phones?.[0] ? ` · 📞 ${b.phones[0]}` : ""}`,
    `📍 ${b.address ?? "—"} (${pick(ZONE[b.zone] ?? ZONE.outside!, lang)})`,
    `🛠 ${b.service_text}`,
    `👷 ${crew.map((c) => c.full_name + (c.role === "lead" ? ` (${pick(LEAD, lang)})` : "")).join(", ") || "—"}${b.vcode ? ` · 🚐 ${b.vcode}` : ""}`,
    b.notes ? `📝 ${b.notes}` : "",
  ].filter(Boolean).join("\n");
  const rows: MenuButton[][] = [];
  if (b.lat != null && b.lng != null) rows.push([{ text: L("🗺 ផ្លូវទៅ", "🗺 Directions"), url: `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving` }]);
  else rows.push(url(L("⚠️ គ្មានទីតាំង — បើកក្នុងកម្មវិធី", "⚠️ No location — open in the app"), appUrl(`/bookings/${b.id}`)));
  rows.push(url(L("📱 មើលក្នុងកម្មវិធី", "📱 Open in the app"), appUrl(u.role === "tech" ? `/tech/job/${b.id}` : `/bookings/${b.id}`)));
  rows.push([{ text: L("⬅️ ត្រឡប់", "⬅️ Back"), view: back }, { text: L("🏠 ទំព័រដើម", "🏠 Home"), view: "home" }]);
  return { text, buttons: rows.filter((r) => r.length) };
}

async function groupMenu(chatId: number, view: "ghome" | "gtoday"): Promise<Menu> {
  const g = (await sql<{ company_id: string; name: string; timezone: string }[]>`select s.company_id, c.name, c.timezone from company_settings s join companies c on c.id = s.company_id
    where s.telegram_group_chat_id = ${chatId} and c.is_active limit 1`)[0];
  if (!g) return null; // not this shop's work group → the hub shows the /register help
  if (view === "ghome") return { text: `👥 ក្រុមការងារ · ${g.name}\nការងារថ្មី ការប្ដូរម៉ោង និងការលុបចោល ផ្ញើមកទីនេះដោយស្វ័យប្រវត្តិ។`, buttons: [[{ text: "📋 ការងារថ្ងៃនេះ", view: "gtoday" }]] };
  const { from, to } = await todayRange(g.timezone);
  const jobs = await sql<{ number: string; scheduled_at: Date; ends_at: Date | null; cname: string; crew: string | null }[]>`
    select b.number, b.scheduled_at, b.ends_at, c.name as cname,
      (select string_agg(u.full_name, ', ' order by t.role, u.full_name) from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as crew
    from bookings b join customers c on c.id = b.customer_id
    where b.company_id = ${g.company_id} and b.status = any(${sql.array(ACTIVE)}::booking_status[]) and b.scheduled_at >= ${from}::timestamptz and b.scheduled_at < ${to}::timestamptz
    order by b.scheduled_at limit 30`;
  const lines = jobs.map((j) => `• ${hhmm(j.scheduled_at, g.timezone)}${j.ends_at ? `–${hhmm(j.ends_at, g.timezone)}` : ""} ${j.number} · ${j.cname} · 👷 ${j.crew ?? "—"}`);
  return { text: `📋 ការងារថ្ងៃនេះ (${jobs.length})\n${lines.join("\n") || "មិនមានការងារទេ ✅"}`, buttons: [[{ text: "🔄 ធ្វើបច្ចុប្បន្នភាព", view: "gtoday" }, { text: "⬅️ ត្រឡប់", view: "ghome" }]] };
}

/** view: home | today | next | job (+id, back) · ghome | gtoday (groups). null = not staff / not our group. */
export async function renderMenu(chatId: number, view: string, id: string | null, back: "today" | "next" = "next"): Promise<Menu> {
  if (view === "ghome" || view === "gtoday") return groupMenu(chatId, view);
  const u = await staffByChat(chatId);
  if (!u) return null;
  const m = await staffView(u, view, id, back);
  return m ? { ...m, lang: asLang(u.language) } : m;
}
async function staffView(u: Staff, view: string, id: string | null, back: "today" | "next"): Promise<Menu> {
  if (view === "today" || view === "next") return staffList(u, view);
  if (view === "job" && id) return staffJob(u, id, back);
  if (view === "att") { const L = T(u), text = await attendanceMenuText(u.id); return { text: text ?? L("ℹ️ គណនីរបស់អ្នកមិនកត់វត្តមានទេ។", "ℹ️ Your account does not record attendance."), buttons: [[{ text: L("🏠 ទំព័រដើម", "🏠 Home"), view: "home" }]] }; }
  return staffHome(u);
}
