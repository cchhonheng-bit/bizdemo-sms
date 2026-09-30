// Attendance by GPS (Flow 5, D-78 · M9 · FR-901 · FR-904 · BR-22 · BR-22a · BR-23 · AC-12).
// GM, Admin and technicians who track attendance; CEO / CFO never (BR-22a). Server time only. Outside the office circle
// (geofence_m, default 100 m) or without GPS the press is kept and flagged for GM / CEO — never refused.
import { sql, tx, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { asLang, pick } from "../lib/i18n.js";

export const ATTENDANCE_ROLES = ["gm", "admin", "tech"];
const MAX_DAYS = 62;

type Settings = { timezone: string; work_start: string; work_end: string; work_days: number[]; holidays: string[]; office_lat: number | null; office_lng: number | null; geofence_m: number };
async function settingsOf(db: Db, companyId: string): Promise<Settings> {
  return (await db<Settings[]>`select c.timezone, to_char(s.work_start, 'HH24:MI') as work_start, to_char(s.work_end, 'HH24:MI') as work_end, s.work_days,
      coalesce((select array_agg(h::text) from unnest(s.holidays) h), '{}') as holidays, s.office_lat, s.office_lng, s.geofence_m
    from companies c join company_settings s on s.company_id = c.id where c.id = ${companyId}`)[0]!;
}
async function tracks(db: Db, user: SessionUser): Promise<boolean> {
  if (!ATTENDANCE_ROLES.includes(user.role)) return false;
  return (await db`select 1 from users where id = ${user.id} and tracks_attendance and is_active`).length > 0;
}
/** great-circle distance in metres */
export function metres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

const REC = sql`in_at, in_distance_m, in_out_of_range, in_no_gps, out_at, out_distance_m, out_out_of_range, out_no_gps`;

export async function today(user: SessionUser) {
  const st = await settingsOf(sql, user.companyId);
  const on = await tracks(sql, user);
  const record = on ? (await sql`select ${REC} from attendance where user_id = ${user.id} and work_date = (now() at time zone ${st.timezone})::date`)[0] ?? null : null;
  return { tracks: on, office_set: st.office_lat != null && st.office_lng != null, geofence_m: st.geofence_m, work_start: st.work_start, work_end: st.work_end, record };
}

export async function check(user: SessionUser, ip: string | null, v: { kind: "in" | "out"; lat?: number | null; lng?: number | null; accuracy?: number | null; no_gps?: boolean }) {
  if (!(await tracks(sql, user))) throw new AppError("NO_ATTENDANCE_ROLE", 400);
  return tx(user.id, async (t) => {
    const st = await settingsOf(t, user.companyId);
    const gps = !v.no_gps && v.lat != null && v.lng != null;
    const dist = gps && st.office_lat != null && st.office_lng != null ? Math.round(metres({ lat: v.lat!, lng: v.lng! }, { lat: st.office_lat, lng: st.office_lng })) : null;
    const flag = !gps || (dist != null && dist > st.geofence_m);
    const lat = gps ? v.lat! : null, lng = gps ? v.lng! : null, acc = gps && v.accuracy != null ? Math.round(v.accuracy) : null;
    const day = t`(now() at time zone ${st.timezone})::date`;
    if (v.kind === "in") {
      const ins = await t<{ at: Date }[]>`insert into attendance (company_id, user_id, work_date, in_at, in_lat, in_lng, in_accuracy_m, in_distance_m, in_out_of_range, in_no_gps)
        values (${user.companyId}, ${user.id}, ${day}, now(), ${lat}, ${lng}, ${acc}, ${dist}, ${flag}, ${!gps})
        on conflict (user_id, work_date) do nothing returning in_at as at`;
      if (!ins.length) { // pressed twice: the first check-in stays
        const r = (await t<{ at: Date; distance_m: number | null; out_of_range: boolean; no_gps: boolean }[]>`select in_at as at, in_distance_m as distance_m, in_out_of_range as out_of_range, in_no_gps as no_gps
          from attendance where user_id = ${user.id} and work_date = ${day}`)[0]!;
        return { kind: "in" as const, ...r, already: true };
      }
      await audit(t, { companyId: user.companyId, userId: user.id, action: "attendance.in", table: "attendance", rowId: user.id, new: { distance_m: dist, out_of_range: flag, no_gps: !gps }, ip });
      return { kind: "in" as const, at: ins[0]!.at, distance_m: dist, out_of_range: flag, no_gps: !gps, already: false };
    }
    const row = (await t<{ id: number; out_at: Date | null; out_distance_m: number | null; out_out_of_range: boolean; out_no_gps: boolean }[]>`
      select id, out_at, out_distance_m, out_out_of_range, out_no_gps from attendance where user_id = ${user.id} and work_date = ${day} for update`)[0];
    if (!row) throw new AppError("NOT_CHECKED_IN", 400);
    if (row.out_at) return { kind: "out" as const, at: row.out_at, distance_m: row.out_distance_m, out_of_range: row.out_out_of_range, no_gps: row.out_no_gps, already: true };
    const at = (await t<{ at: Date }[]>`update attendance set out_at = now(), out_lat = ${lat}, out_lng = ${lng}, out_accuracy_m = ${acc}, out_distance_m = ${dist},
      out_out_of_range = ${flag}, out_no_gps = ${!gps} where id = ${row.id} returning out_at as at`)[0]!.at;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "attendance.out", table: "attendance", rowId: user.id, new: { distance_m: dist, out_of_range: flag, no_gps: !gps }, ip });
    return { kind: "out" as const, at, distance_m: dist, out_of_range: flag, no_gps: !gps, already: false };
  });
}

// ---------- report (FR-904) ----------
export type DayStatus = "present" | "late" | "absent" | "leave" | "holiday" | "off" | "pending" | "none";
type Rec = { user_id: string; date: string; in_hm: string; out_hm: string | null; in_min: number; out_min: number | null; in_distance_m: number | null; out_distance_m: number | null;
  in_out_of_range: boolean; out_out_of_range: boolean; in_no_gps: boolean; out_no_gps: boolean };
type Leave = { user_id: string; kind: "leave" | "absent"; part: "full" | "am" | "pm"; date_from: string; date_to: string };

function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 86_400_000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

export async function report(user: SessionUser, from: string, to: string, onlyUser?: string) {
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) throw new AppError("BAD_RANGE", 400);
  if (from > to) throw new AppError("BAD_RANGE", 400);
  const dates = daysBetween(from, to);
  if (dates.length > MAX_DAYS) throw new AppError("RANGE_TOO_LONG", 400);
  const st = await settingsOf(sql, user.companyId);
  const tz = st.timezone;
  const people = await sql<{ user_id: string; full_name: string; role: string; since: string }[]>`select id as user_id, full_name, role, (created_at at time zone ${tz})::date::text as since
    from users where company_id = ${user.companyId} and is_active and tracks_attendance and role::text = any(${sql.array(ATTENDANCE_ROLES)})
    ${onlyUser ? sql`and id = ${onlyUser}` : sql``} order by case role when 'gm' then 1 when 'admin' then 2 else 3 end, full_name`;
  const recs = await sql<Rec[]>`select user_id, work_date::text as date, to_char(in_at at time zone ${tz}, 'HH24:MI') as in_hm, to_char(out_at at time zone ${tz}, 'HH24:MI') as out_hm,
      (extract(epoch from (in_at at time zone ${tz})::time) / 60)::int as in_min, (extract(epoch from (out_at at time zone ${tz})::time) / 60)::int as out_min,
      in_distance_m, out_distance_m, in_out_of_range, out_out_of_range, in_no_gps, out_no_gps
    from attendance where company_id = ${user.companyId} and work_date between ${from}::date and ${to}::date`;
  const leaves = await sql<Leave[]>`select user_id, kind::text, part::text, date_from::text, date_to::text from staff_leaves
    where company_id = ${user.companyId} and status = 'approved' and date_from <= ${to}::date and date_to >= ${from}::date`;
  const now = (await sql<{ d: string; m: number }[]>`select (now() at time zone ${tz})::date::text as d, (extract(epoch from (now() at time zone ${tz})::time) / 60)::int as m`)[0]!;
  const startMin = toMin(st.work_start), endMin = toMin(st.work_end);
  const byKey = new Map(recs.map((r) => [`${r.user_id}|${r.date}`, r]));

  const users = people.map((p) => {
    const days = dates.map((date) => {
      if (date < p.since) return { date, status: "none" as DayStatus };
      const iso = ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // Mon 1 … Sun 7
      const holiday = st.holidays.includes(date);
      const workday = st.work_days.includes(iso) && !holiday;
      const r = byKey.get(`${p.user_id}|${date}`);
      const cover = (kind: Leave["kind"]) => leaves.find((l) => l.user_id === p.user_id && l.kind === kind && l.date_from <= date && l.date_to >= date);
      const leave = cover("leave");
      if (r) {
        const expected = leave?.part === "am" ? 12 * 60 : startMin; // morning off → expected at noon
        const late = workday ? Math.max(0, r.in_min - expected) : 0;
        const ot = r.out_min != null ? Math.max(0, r.out_min - endMin) : 0;
        return {
          date, status: (late > 0 ? "late" : "present") as DayStatus, in: r.in_hm, out: r.out_hm, late_min: late, ot_min: ot,
          out_of_range: r.in_out_of_range || r.out_out_of_range, no_gps: r.in_no_gps || r.out_no_gps, distance_in: r.in_distance_m, distance_out: r.out_distance_m,
          leave_part: leave?.part ?? null, missing_out: r.out_hm == null && (date < now.d || (date === now.d && now.m >= endMin)),
        };
      }
      if (!workday) return { date, status: (holiday ? "holiday" : "off") as DayStatus };
      if (leave) return { date, status: "leave" as DayStatus, leave_part: leave.part };
      if (cover("absent")) return { date, status: "absent" as DayStatus, marked: true };
      if (date > now.d || (date === now.d && now.m < endMin)) return { date, status: "pending" as DayStatus };
      return { date, status: "absent" as DayStatus };
    });
    const n = (f: (d: (typeof days)[number]) => boolean) => days.filter(f).length;
    const sum = (k: "late_min" | "ot_min") => days.reduce((s, d) => s + (((d as Record<string, unknown>)[k] as number | undefined) ?? 0), 0);
    return {
      ...p, days,
      present: n((d) => d.status === "present" || d.status === "late"), late_count: n((d) => d.status === "late"), late_min: sum("late_min"),
      absent: n((d) => d.status === "absent"), leave: n((d) => d.status === "leave"), ot_min: sum("ot_min"),
      out_of_range: n((d) => "out_of_range" in d && !!d.out_of_range),
    };
  });
  return { from, to, work_start: st.work_start, work_end: st.work_end, users };
}

export async function myHistory(user: SessionUser, from: string, to: string) {
  if (!(await tracks(sql, user))) throw new AppError("NO_ATTENDANCE_ROLE", 400);
  const r = await report(user, from, to, user.id);
  return r.users[0] ?? null;
}

// ---------- FR-902: check in / out by sending a location to the shop bot ----------
const hmIn = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

/** the hub forwards a location sent in a private chat with the shop bot; the shop decides who it is and records in / out.
 *  No GPS accuracy (a point picked on the map) = «no GPS», flagged; a location older than 2 minutes is refused. */
export async function telegramAttendance(b: { chat_id: number; tg_user: number; lat: number; lng: number; accuracy: number | null; sent_at: number }): Promise<string> {
  const u = (await sql<{ id: string; company_id: string; role: string; full_name: string; username: string; timezone: string; language: string }[]>`
    select u.id, u.company_id, u.role, u.full_name, u.username, c.timezone, u.language from users u join companies c on c.id = u.company_id
    where u.telegram_chat_id = ${b.chat_id} and u.telegram_user_id = ${b.tg_user} and u.is_active and c.is_active limit 1`)[0];
  if (!u) return "ℹ️ ការផ្ញើទីតាំង ប្រើសម្រាប់វត្តមានបុគ្គលិកដែលបានភ្ជាប់ Telegram ប៉ុណ្ណោះ។";
  const L = (km: string, en: string) => pick({ km, en }, asLang(u.language));
  if (Math.abs(Date.now() / 1000 - b.sent_at) > 120) return L("⏳ ទីតាំងនេះចាស់ពេក — សូមចុច «📍 ផ្ញើទីតាំង» ម្ដងទៀត។", "⏳ This location is too old — tap «📍 Send location» again.");
  const user = { id: u.id, companyId: u.company_id, role: u.role, username: u.username, fullName: u.full_name, mustChangePassword: false, language: "km", sessionId: "telegram" } as SessionUser;
  if (!(await tracks(sql, user))) return L("ℹ️ គណនីរបស់អ្នកមិនកត់វត្តមានទេ។", "ℹ️ Your account does not record attendance.");
  const rec = (await sql<{ in_at: Date; out_at: Date | null }[]>`select in_at, out_at from attendance where user_id = ${u.id} and work_date = (now() at time zone ${u.timezone})::date`)[0];
  if (rec?.out_at) return L(`✅ ថ្ងៃនេះកត់រួចហើយ · ចូល ${hmIn(rec.in_at, u.timezone)} · ចេញ ${hmIn(rec.out_at, u.timezone)}`, `✅ Already recorded today · in ${hmIn(rec.in_at, u.timezone)} · out ${hmIn(rec.out_at, u.timezone)}`);
  const kind = rec ? "out" : "in";
  const gps = b.accuracy != null;
  const r = await check(user, null, { kind, lat: gps ? b.lat : null, lng: gps ? b.lng : null, accuracy: b.accuracy, no_gps: !gps });
  const where = r.no_gps ? L("⚠️ គ្មាន GPS (ទីតាំងជ្រើសលើផែនទី) — អ្នកគ្រប់គ្រងនឹងពិនិត្យ", "⚠️ No GPS (point picked on the map) — the GM will check")
    : r.out_of_range ? L(`⚠️ ក្រៅរង្វង់ការិយាល័យ (${r.distance_m} ម៉ែត្រ) — អ្នកគ្រប់គ្រងនឹងពិនិត្យ`, `⚠️ Outside the office area (${r.distance_m} m) — the GM will check`)
      : r.distance_m != null ? L(`📍 ក្នុងរង្វង់ការិយាល័យ (${r.distance_m} ម៉ែត្រ)`, `📍 Inside the office area (${r.distance_m} m)`)
        : L("📍 បានកត់ (នាយកប្រតិបត្តិមិនទាន់កំណត់ទីតាំងការិយាល័យ)", "📍 Recorded (the CEO has not set the office location yet)");
  return `${kind === "in" ? L("✅ ចូលធ្វើការ", "✅ Checked in") : L("👋 ចេញពីការងារ", "👋 Checked out")} ${L("ម៉ោង", "at")} ${hmIn(new Date(r.at), u.timezone)}\n${where}`;
}

/** staff menu screen «📍 វត្តមាន»: today's state (the hub adds the «send my location» keyboard) */
export async function attendanceMenuText(userId: string): Promise<string | null> {
  const u = (await sql<{ role: string; tracks: boolean; timezone: string; language: string }[]>`select u.role, u.tracks_attendance as tracks, c.timezone, u.language from users u join companies c on c.id = u.company_id where u.id = ${userId}`)[0];
  if (!u || !u.tracks || !ATTENDANCE_ROLES.includes(u.role)) return null;
  const rec = (await sql<{ in_at: Date; out_at: Date | null }[]>`select in_at, out_at from attendance where user_id = ${userId} and work_date = (now() at time zone ${u.timezone})::date`)[0];
  const L = (km: string, en: string) => pick({ km, en }, asLang(u.language));
  const state = !rec ? L("មិនទាន់ចូលធ្វើការ", "Not checked in yet") : !rec.out_at ? L(`ចូល ${hmIn(rec.in_at, u.timezone)} · មិនទាន់ចេញ`, `In ${hmIn(rec.in_at, u.timezone)} · not out yet`)
    : L(`ចូល ${hmIn(rec.in_at, u.timezone)} · ចេញ ${hmIn(rec.out_at, u.timezone)} ✅`, `In ${hmIn(rec.in_at, u.timezone)} · out ${hmIn(rec.out_at, u.timezone)} ✅`);
  return L(`📍 វត្តមានថ្ងៃនេះ\n${state}\n\nផ្ញើទីតាំងបច្ចុប្បន្ន (GPS) ដើម្បី${!rec ? "ចូលធ្វើការ" : !rec.out_at ? "ចេញពីការងារ" : " — ថ្ងៃនេះរួចហើយ"}។`,
    `📍 Attendance today\n${state}\n\n${!rec ? "Send your current location (GPS) to check in." : !rec.out_at ? "Send your current location (GPS) to check out." : "Done for today."}`);
}
