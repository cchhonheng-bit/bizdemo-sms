// Owner decisions D2 (reschedule with requester + history + notice) and D3 (leave / absence hides technicians) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { consumeLinkCode } from "../src/services/telegram.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, dara: Client;
let cust: string, v1: string;

function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * 3600_000);
  return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm)).toISOString();
}
const day = (d: number) => at(d, 12).slice(0, 10); // YYYY-MM-DD of that local day (noon is safe)
const mk = async (c: Client, extra: Record<string, unknown> = {}) =>
  c.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...extra });
const assign = (c: Client, id: string, body: Record<string, unknown>) => c.req("POST", `/api/bookings/${id}/assign`, { assistants: [], ...body });
const resched = (c: Client, id: string, body: Record<string, unknown>) => c.req("POST", `/api/bookings/${id}/reschedule`, body);

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  v1 = (await ceo.req("GET", "/api/settings/vehicles")).json[0].id;
  await ceo.req("PATCH", "/api/settings/company", { telegram_group_chat_id: "-100888" });
  const code = (await kim.req("POST", "/api/telegram/link-code")).json.code;
  expect((await consumeLinkCode(code, 920002, 920002)).ok).toBe(true);
});
afterAll(async () => { await app.close(); });

describe("D2 appointment time + reschedule", () => {
  it("every booking needs the agreed appointment date/time (API, not only the UI)", async () => {
    expect((await mk(ceo, {})).json.error).toBe("SCHEDULE_REQUIRED");
    expect((await mk(ceo, { type: "B", category: "construction" })).json.error).toBe("SCHEDULE_REQUIRED"); // type B = survey visit time
    expect((await mk(ceo, { scheduled_at: at(3, 9) })).status).toBe(200);
  });

  it("the time cannot be changed by edit or assign — only by reschedule (who + reason recorded)", async () => {
    const id = (await mk(ceo, { scheduled_at: at(3, 14) })).json.id;
    expect((await ceo.req("PATCH", `/api/bookings/${id}`, { scheduled_at: at(4, 9) })).json.error).toBe("USE_RESCHEDULE");
    expect((await ceo.req("PATCH", `/api/bookings/${id}`, { ends_at: at(3, 18) })).json.error).toBe("USE_RESCHEDULE");
    expect((await ceo.req("PATCH", `/api/bookings/${id}`, { notes: "ok" })).status).toBe(200);
    expect((await assign(gm, id, { lead: s.users.kim, scheduled_at: at(4, 9) })).json.error).toBe("USE_RESCHEDULE");
    expect((await assign(gm, id, { lead: s.users.kim })).status).toBe(200); // assign keeps the agreed time
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(new Date(b.scheduled_at).toISOString()).toBe(at(3, 14));
  });

  it("reschedule: requester + reason required, not into the past, full history old → new, keeps the job length", async () => {
    const id = (await mk(ceo, { scheduled_at: at(5, 9) })).json.id; // 09:00–11:00
    expect((await resched(admin, id, { scheduled_at: at(6, 10), reason: "ភ្ញៀវសុំ" })).json.error).toBe("REQUESTER_REQUIRED");
    expect((await resched(admin, id, { scheduled_at: at(6, 10), requested_by: "boss", reason: "x x" })).status).toBe(400);
    expect((await resched(admin, id, { scheduled_at: at(6, 10), requested_by: "customer", reason: "" })).json.error).toBe("REASON_REQUIRED");
    expect((await resched(admin, id, { scheduled_at: at(-1, 10), requested_by: "customer", reason: "ភ្ញៀវសុំ" })).json.error).toBe("START_IN_PAST");
    expect((await resched(admin, id, { scheduled_at: at(5, 9), requested_by: "customer", reason: "ភ្ញៀវសុំ" })).json.error).toBe("SAME_TIME");
    const r = await resched(admin, id, { scheduled_at: at(6, 10), requested_by: "customer", reason: "ភ្ញៀវមិននៅផ្ទះ" });
    expect(r.status).toBe(200);
    await resched(gm, id, { scheduled_at: at(6, 13), ends_at: at(6, 16), requested_by: "gm", reason: "ជាងជាប់ការងារ" });
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(new Date(b.scheduled_at).toISOString()).toBe(at(6, 13)); expect(new Date(b.ends_at).toISOString()).toBe(at(6, 16));
    const h = (await ceo.req("GET", `/api/bookings/${id}/reschedules`)).json;
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ requested_by: "customer", reason: "ភ្ញៀវមិននៅផ្ទះ", by_name: "Admin A" });
    expect(new Date(h[0].old_start).toISOString()).toBe(at(5, 9)); expect(new Date(h[0].new_start).toISOString()).toBe(at(6, 10));
    expect(new Date(h[0].new_end).toISOString()).toBe(at(6, 12)); // job length kept (2 h)
    expect(h[1]).toMatchObject({ requested_by: "gm", reason: "ជាងជាប់ការងារ" });
    const audit = (await ceo.req("GET", "/api/settings/audit?limit=500")).json;
    expect(audit.filter((a: any) => a.action === "booking.reschedule" && a.row_id === id)).toHaveLength(2);
  });

  it("reschedule re-runs availability (crew + vehicle) and notifies the assigned technicians + group", async () => {
    const a = (await mk(ceo, { scheduled_at: at(7, 9) })).json.id;
    expect((await assign(gm, a, { lead: s.users.kim, vehicle_id: v1 })).status).toBe(200);
    const b = (await mk(ceo, { scheduled_at: at(7, 14) })).json.id;
    expect((await assign(gm, b, { lead: s.users.kim })).status).toBe(200);
    const clash = await resched(admin, b, { scheduled_at: at(7, 10), requested_by: "technician", reason: "ជាងស្នើ" });
    expect(clash.status).toBe(409); expect(clash.json.error).toBe("TECH_UNAVAILABLE");
    const c = (await mk(ceo, { scheduled_at: at(8, 9), vehicle_id: v1 })).json.id;
    expect((await resched(admin, c, { scheduled_at: at(7, 10), requested_by: "customer", reason: "ភ្ញៀវសុំ" })).json.error).toBe("VEHICLE_UNAVAILABLE");
    // ok → Telegram notice to the group + kim (linked), in-app to kim
    expect((await resched(admin, b, { scheduled_at: at(7, 15), requested_by: "lead", reason: "មេជាងស្នើ" })).status).toBe(200);
    const msgs = await sql<{ chat_id: string; text: string }[]>`select chat_id, text from telegram_outbox where dedupe_key like ${"resched:" + b + ":%"}`;
    expect(msgs.map((m) => m.chat_id).sort()).toEqual(["-100888", "920002"]);
    expect(msgs[0]!.text).toContain("🔁"); expect(msgs[0]!.text).toContain("មេជាងស្នើ"); expect(msgs[0]!.text).toContain("15:00");
    expect((await kim.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "booking.rescheduled")).toBe(true);
  });

  it("permissions and locked states: technicians cannot reschedule; finished / cancelled bookings cannot", async () => {
    const id = (await mk(ceo, { scheduled_at: at(9, 9) })).json.id;
    expect((await resched(kim, id, { scheduled_at: at(9, 10), requested_by: "technician", reason: "x x x" })).status).toBe(403);
    await ceo.req("POST", `/api/bookings/${id}/cancel`, { reason: "duplicate" });
    expect((await resched(ceo, id, { scheduled_at: at(9, 10), requested_by: "customer", reason: "x x x" })).json.error).toBe("BOOKING_LOCKED");
  });
});

describe("D3 leave / absence", () => {
  it("leave request → approval chain (tech → GM, Admin/GM → CEO); nobody approves their own; wrong approver refused", async () => {
    const r = await kim.req("POST", "/api/leave", { kind: "leave", date_from: day(10), date_to: day(10), part: "full", reason: "ទៅពេទ្យ" });
    expect(r.status).toBe(200); expect(r.json.status).toBe("pending");
    const lid = r.json.id;
    expect((await kim.req("POST", `/api/leave/${lid}/approve`, {})).status).toBe(403);   // own request
    expect((await admin.req("POST", `/api/leave/${lid}/approve`, {})).status).toBe(403); // admin cannot approve tech leave
    expect((await gm.req("GET", "/api/leave?scope=approve")).json.map((x: any) => x.id)).toContain(lid);
    expect((await gm.req("POST", `/api/leave/${lid}/approve`, {})).json.status).toBe("approved");
    expect((await gm.req("POST", `/api/leave/${lid}/approve`, {})).json.error).toBe("LEAVE_NOT_PENDING");
    // admin's own leave needs the CEO; GM's leave needs the CEO
    const a = (await admin.req("POST", "/api/leave", { kind: "leave", date_from: day(11), date_to: day(11), part: "am", reason: "ការងារផ្ទាល់ខ្លួន" })).json.id;
    expect((await gm.req("POST", `/api/leave/${a}/approve`, {})).status).toBe(403);
    expect((await ceo.req("POST", `/api/leave/${a}/reject`, { note: "ថ្ងៃនោះរវល់" })).json.status).toBe("rejected");
    const g = (await gm.req("POST", "/api/leave", { kind: "leave", date_from: day(12), date_to: day(12), part: "full", reason: "ពិធីគ្រួសារ" })).json.id;
    expect((await gm.req("POST", `/api/leave/${g}/approve`, {})).status).toBe(403);
    expect((await ceo.req("POST", `/api/leave/${g}/approve`, {})).json.status).toBe("approved");
    // CEO/CFO do not request leave (BR-22a)
    expect((await ceo.req("POST", "/api/leave", { kind: "leave", date_from: day(13), date_to: day(13), part: "full", reason: "x x x" })).json.error).toBe("NO_ATTENDANCE_ROLE");
    // validation
    expect((await dara.req("POST", "/api/leave", { kind: "leave", date_from: day(14), date_to: day(13), part: "full", reason: "x x x" })).json.error).toBe("END_BEFORE_START");
    expect((await dara.req("POST", "/api/leave", { kind: "leave", date_from: day(-2), date_to: day(-2), part: "full", reason: "x x x" })).json.error).toBe("START_IN_PAST");
    expect((await kim.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "leave.approved")).toBe(true);
  });

  it("approved leave hides the technician from the picker and the API rejects them; pending leave does not", async () => {
    const av = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(10, 9))}&to=${encodeURIComponent(at(10, 11))}`)).json;
    const k = av.people.find((p: any) => p.user_id === s.users.kim);
    expect(k.available).toBe(false); expect(k.reason).toBe("LEAVE");
    const id = (await mk(ceo, { scheduled_at: at(10, 9) })).json.id;
    const r = await assign(gm, id, { lead: s.users.kim });
    expect(r.status).toBe(409); expect(r.json.error).toBe("TECH_UNAVAILABLE"); expect(r.json.details.conflicts[0].reason).toBe("LEAVE");
    // pending (not approved) leave does not block
    await dara.req("POST", "/api/leave", { kind: "leave", date_from: day(10), date_to: day(10), part: "full", reason: "រង់ចាំ" });
    expect((await assign(gm, id, { lead: s.users.dara })).status).toBe(200);
    // the GM is never offered as crew (CEO 04-10: technicians only), on leave or not
    const av12 = (await ceo.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(12, 14))}&to=${encodeURIComponent(at(12, 15))}`)).json;
    expect(av12.people.find((p: any) => p.user_id === s.users.gm01)).toBeUndefined();
  });

  it("half day: morning leave blocks the morning only", async () => {
    const l = (await dara.req("POST", "/api/leave", { kind: "leave", date_from: day(15), date_to: day(15), part: "am", reason: "ទៅសាលា" })).json.id;
    expect((await gm.req("POST", `/api/leave/${l}/approve`, {})).json.status).toBe("approved");
    const am = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(15, 9))}&to=${encodeURIComponent(at(15, 10))}`)).json;
    const pm = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(15, 14))}&to=${encodeURIComponent(at(15, 15))}`)).json;
    expect(am.people.find((p: any) => p.user_id === s.users.dara).available).toBe(false);
    expect(pm.people.find((p: any) => p.user_id === s.users.dara).available).toBe(true);
  });

  it("absent: an approver marks a technician absent → hidden + rejected; a tech cannot mark absence; absence over a job lists that job", async () => {
    const j = (await mk(ceo, { scheduled_at: at(16, 9) })).json.id;
    expect((await assign(gm, j, { lead: s.users.dara })).status).toBe(200);
    expect((await kim.req("POST", "/api/leave/absent", { user_id: s.users.dara, date_from: day(16), date_to: day(16), part: "full", reason: "ឈឺ" })).status).toBe(403);
    const r = await gm.req("POST", "/api/leave/absent", { user_id: s.users.dara, date_from: day(16), date_to: day(16), part: "full", reason: "ឈឺ" });
    expect(r.status).toBe(200); expect(r.json.status).toBe("approved");
    expect(r.json.affected.map((x: any) => x.id)).toEqual([j]); // the GM sees the job to re-assign
    const av = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(16, 13))}&to=${encodeURIComponent(at(16, 14))}`)).json;
    expect(av.people.find((p: any) => p.user_id === s.users.dara).reason).toBe("ABSENT");
    const n = (await mk(ceo, { scheduled_at: at(16, 13) })).json.id;
    expect((await assign(gm, n, { assistants: [s.users.dara] })).json.error).toBe("TECH_UNAVAILABLE");
    // reschedule into a leave day is refused too
    const x = (await mk(ceo, { scheduled_at: at(17, 9) })).json.id;
    expect((await assign(gm, x, { lead: s.users.kim })).status).toBe(200);
    expect((await resched(gm, x, { scheduled_at: at(10, 14), requested_by: "gm", reason: "ប្ដូរ" })).json.error).toBe("TECH_UNAVAILABLE");
  });

  it("a requester can cancel their pending leave; lists are scoped (tech sees own only)", async () => {
    const l = (await kim.req("POST", "/api/leave", { kind: "leave", date_from: day(20), date_to: day(21), part: "full", reason: "ទៅស្រុក" })).json.id;
    expect((await dara.req("POST", `/api/leave/${l}/cancel`, {})).status).toBe(403);
    expect((await kim.req("POST", `/api/leave/${l}/cancel`, {})).json.status).toBe("cancelled");
    const mine = (await kim.req("GET", "/api/leave")).json;
    expect(mine.every((x: any) => x.user_id === s.users.kim)).toBe(true);
    expect((await kim.req("GET", "/api/leave?scope=approve")).status).toBe(403);
  });
});
