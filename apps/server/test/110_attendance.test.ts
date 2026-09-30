// Flow 5: attendance (M9 · FR-901 · FR-904 · BR-22 · BR-22a · BR-23 · AC-12) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, dara: Client, cfo: Client, sok: Client, noatt: Client;
const OFFICE = { lat: 11.5564, lng: 104.9282 };
const near = { lat: OFFICE.lat + 0.00027, lng: OFFICE.lng, accuracy: 8 };   // ≈ 30 m north
const far = { lat: OFFICE.lat + 0.0027, lng: OFFICE.lng, accuracy: 12 };    // ≈ 300 m north (AC-12)
const check = (c: Client, kind: "in" | "out", pos: Record<string, unknown> = near) => c.req("POST", "/api/attendance/check", { kind, ...pos });
/** local Phnom Penh time → timestamptz */
const local = (date: string, hhmm: string) => new Date(`${date}T${hhmm}:00+07:00`);

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const hash = await hashPassword(PW);
  for (const [u, role, phone, tracks] of [["cfo", "cfo", "012000008", false], ["sok", "tech", "012000010", true], ["noatt", "tech", "012000011", false]] as const)
    s.users[u] = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
      values (${s.a}, ${u}, ${u.toUpperCase()}, ${role}::user_role, ${phone}, ${hash}, false, ${tracks}) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cfo = await loginAs(app, "cfo"); sok = await loginAs(app, "sok"); noatt = await loginAs(app, "noatt");
});
afterAll(async () => { await app.close(); });

describe("check in / out by GPS (FR-901 · BR-23 · AC-12)", () => {
  it("office not set yet: the press is kept, no distance, no flag; the page tells the user", async () => {
    const t = (await dara.req("GET", "/api/attendance/today")).json;
    expect(t).toMatchObject({ tracks: true, office_set: false, record: null });
    const r = await check(dara, "in");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ kind: "in", distance_m: null, out_of_range: false, no_gps: false });
  });

  it("inside 100 m → no flag; pressing twice keeps the first time", async () => {
    await ceo.req("PATCH", "/api/settings/company", { office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_m: 100 });
    const r = await check(kim, "in");
    expect(r.status).toBe(200);
    expect(r.json.out_of_range).toBe(false);
    expect(r.json.distance_m).toBeGreaterThan(20); expect(r.json.distance_m).toBeLessThan(40);
    const again = await check(kim, "in", far);
    expect(again.status).toBe(200); expect(again.json.already).toBe(true);
    expect(again.json.at).toBe(r.json.at); expect(again.json.out_of_range).toBe(false);
    const t = (await kim.req("GET", "/api/attendance/today")).json;
    expect(t).toMatchObject({ tracks: true, office_set: true, geofence_m: 100 });
    expect(t.record.in_at).toBe(r.json.at);
  });

  it("AC-12: 300 m away → recorded with the «out of range» flag; no GPS → recorded and flagged too", async () => {
    const r = await check(admin, "in", far);
    expect(r.status).toBe(200);
    expect(r.json.out_of_range).toBe(true);
    expect(r.json.distance_m).toBeGreaterThan(280); expect(r.json.distance_m).toBeLessThan(320);
    const g = await check(gm, "in", { lat: null, lng: null, accuracy: null, no_gps: true });
    expect(g.status).toBe(200); expect(g.json).toMatchObject({ no_gps: true, out_of_range: true, distance_m: null });
  });

  it("check out: not before check in; then recorded (distance + flag of its own); twice keeps the first", async () => {
    expect((await check(sok, "out")).json.error).toBe("NOT_CHECKED_IN");
    const o = await check(kim, "out", far);
    expect(o.status).toBe(200); expect(o.json.out_of_range).toBe(true);
    const again = await check(kim, "out", near);
    expect(again.json.already).toBe(true); expect(again.json.at).toBe(o.json.at);
    const t = (await kim.req("GET", "/api/attendance/today")).json;
    expect(t.record).toMatchObject({ in_out_of_range: false, out_out_of_range: true });
  });

  it("CEO / CFO never record attendance (BR-22a), nor anyone switched off; bad coordinates are refused", async () => {
    expect((await check(ceo, "in")).json.error).toBe("NO_ATTENDANCE_ROLE");
    expect((await check(cfo, "in")).json.error).toBe("NO_ATTENDANCE_ROLE");
    expect((await check(noatt, "in")).json.error).toBe("NO_ATTENDANCE_ROLE");
    expect((await ceo.req("GET", "/api/attendance/today")).json.tracks).toBe(false);
    expect((await check(sok, "in", { lat: 95, lng: 104.9, accuracy: 5 })).status).toBe(400);
    expect((await check(sok, "in", { lat: 11.5, lng: null, accuracy: 5 })).status).toBe(400);
    expect((await sok.req("POST", "/api/attendance/check", { kind: "lunch", ...near })).status).toBe(400);
    expect((await sok.req("POST", "/api/attendance/check", { kind: "in", ...near, at: "2026-01-01T00:00:00Z" })).status).toBe(400); // server time only
  });
});

describe("attendance report (FR-904)", () => {
  // Mon 14 … Sun 20 Sep 2026 · holiday Thu 17 · kim: full leave Wed 16, morning leave Fri 18
  const week = { from: "2026-09-14", to: "2026-09-20" };
  beforeAll(async () => {
    await sql`update users set created_at = '2026-09-01T00:00:00+07:00' where id in (${s.users.kim!}, ${s.users.dara!})`;
    await ceo.req("PATCH", "/api/settings/company", { holidays: ["2026-09-17"] });
    const ins = (date: string, inAt: string, outAt: string | null, inFar = false) => sql`insert into attendance (company_id, user_id, work_date, in_at, in_distance_m, in_out_of_range, out_at, out_distance_m, out_out_of_range)
      values (${s.a}, ${s.users.kim!}, ${date}, ${local(date, inAt)}, ${inFar ? 300 : 30}, ${inFar}, ${outAt ? local(date, outAt) : null}, ${outAt ? 25 : null}, false)`;
    await ins("2026-09-14", "07:25", "17:30");
    await ins("2026-09-15", "07:45", "18:10", true);
    await ins("2026-09-18", "12:10", "17:30");
    const leave = (date: string, part: string, from: string, to: string) => sql`insert into staff_leaves (company_id, user_id, kind, date_from, date_to, part, starts_at, ends_at, reason, requested_by, status)
      values (${s.a}, ${s.users.kim!}, 'leave', ${date}, ${date}, ${part}::leave_part, ${local(date, from)}, ${to === "24:00" ? local(date, "23:59") : local(date, to)}, 'ផ្ទាល់ខ្លួន', ${s.users.kim!}, 'approved')`;
    await leave("2026-09-16", "full", "00:00", "24:00");
    await leave("2026-09-18", "am", "00:00", "12:00");
  });

  it("per day: present / late minutes / out of range / leave / holiday / Sunday / absent; minutes after 17:30", async () => {
    const r = await gm.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`);
    expect(r.status).toBe(200);
    const k = r.json.users.find((u: any) => u.user_id === s.users.kim);
    const byDate = Object.fromEntries(k.days.map((d: any) => [d.date, d]));
    expect(byDate["2026-09-14"]).toMatchObject({ status: "present", in: "07:25", out: "17:30", late_min: 0, ot_min: 0 });
    expect(byDate["2026-09-15"]).toMatchObject({ status: "late", in: "07:45", out: "18:10", late_min: 15, ot_min: 40, out_of_range: true });
    expect(byDate["2026-09-16"]).toMatchObject({ status: "leave", leave_part: "full" });
    expect(byDate["2026-09-17"].status).toBe("holiday");
    expect(byDate["2026-09-18"]).toMatchObject({ status: "late", in: "12:10", late_min: 10, leave_part: "am" }); // morning off → expected at 12:00
    expect(byDate["2026-09-19"].status).toBe("absent");
    expect(byDate["2026-09-20"].status).toBe("off"); // Sunday is never an absence
    expect(k).toMatchObject({ present: 3, late_count: 2, late_min: 25, absent: 1, leave: 1, ot_min: 40, out_of_range: 1 });
  });

  it("someone who never came: absent only on working days; days before the account existed are not counted; CEO/CFO/switched-off are not listed", async () => {
    const r = (await ceo.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`)).json;
    const d = r.users.find((u: any) => u.user_id === s.users.dara);
    expect(d).toMatchObject({ absent: 5, present: 0, leave: 0 });
    const g = r.users.find((u: any) => u.user_id === s.users.gm01);
    expect(g).toMatchObject({ absent: 0 }); // account created today
    expect(g.days.every((x: any) => x.status === "none")).toBe(true);
    const ids = r.users.map((u: any) => u.user_id);
    for (const u of ["ceo", "cfo", "noatt"]) expect(ids).not.toContain(s.users[u]);
    expect(ids).toEqual(expect.arrayContaining([s.users.kim, s.users.dara, s.users.admin, s.users.gm01, s.users.sok]));
  });

  it("today: the out-of-range check-in appears in the report for GM/CEO (AC-12); today is not an absence before 17:30", async () => {
    const today = (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;
    const r = (await ceo.req("GET", `/api/attendance/report?from=${today}&to=${today}`)).json;
    const a = r.users.find((u: any) => u.user_id === s.users.admin).days[0];
    expect(a.out_of_range).toBe(true); expect(a.distance_in).toBeGreaterThan(280);
    const g = r.users.find((u: any) => u.user_id === s.users.gm01).days[0];
    expect(g.no_gps).toBe(true);
  });

  it("permissions + limits: report needs report.ops (not technicians); own history for everyone who records; range checks; companies separated", async () => {
    expect((await kim.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`)).status).toBe(403);
    expect((await admin.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`)).status).toBe(200);
    expect((await cfo.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`)).status).toBe(200);
    const mine = (await kim.req("GET", `/api/attendance/me?from=${week.from}&to=${week.to}`)).json;
    expect(mine).toMatchObject({ user_id: s.users.kim, present: 3, absent: 1 });
    expect((await gm.req("GET", "/api/attendance/report?from=2026-09-20&to=2026-09-14")).json.error).toBe("BAD_RANGE");
    expect((await gm.req("GET", "/api/attendance/report?from=2026-01-01&to=2026-09-14")).json.error).toBe("RANGE_TOO_LONG");
    expect((await gm.req("GET", "/api/attendance/report?from=x&to=y")).status).toBe(400);
    const ceoB = await loginAs(app, "ceo_b");
    const other = (await ceoB.req("GET", `/api/attendance/report?from=${week.from}&to=${week.to}`)).json;
    expect(other.users.map((u: any) => u.user_id)).not.toContain(s.users.kim);
  });
});
