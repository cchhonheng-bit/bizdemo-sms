// Booking Rules v1.3 (owner R1–R5) — written before the implementation (tests first).
// Times are relative to "now" in Asia/Phnom_Penh (UTC+7, no DST) so the suite never goes stale.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { consumeLinkCode } from "../src/services/telegram.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, v1: string, v2: string;

/** ISO for local Phnom Penh time: `d` days from today at hh:mm */
function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * 3600_000); // wall clock in Phnom Penh, as UTC fields
  const t = Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm);
  return new Date(t).toISOString();
}
const mk = async (c: Client, extra: Record<string, unknown> = {}) =>
  c.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...extra });
const assign = (c: Client, id: string, body: Record<string, unknown>) => c.req("POST", `/api/bookings/${id}/assign`, { assistants: [], ...body });
/** D2: the only way to move the appointment */
const resched = (c: Client, id: string, body: Record<string, unknown>) => c.req("POST", `/api/bookings/${id}/reschedule`, { requested_by: "customer", reason: "ភ្ញៀវសុំ", ...body });

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក សុខា", phones: ["012345678"], address: "ផ្ទះ 12", zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  const vs = (await ceo.req("GET", "/api/settings/vehicles")).json;
  v1 = vs[0].id; v2 = vs[1].id;
  await ceo.req("PATCH", "/api/settings/company", { telegram_group_chat_id: "-100777" });
  const code = (await kim.req("POST", "/api/telegram/link-code")).json.code;
  expect((await consumeLinkCode(code, 910002, 910002)).ok).toBe(true);
});
afterAll(async () => { await app.close(); });

describe("R3 schedule control", () => {
  it("create: start in the past is rejected (API, not only the UI); end defaults to start + 2 h; end before start rejected", async () => {
    expect((await mk(ceo, { scheduled_at: at(-1, 21) })).json.error).toBe("START_IN_PAST");
    expect((await mk(ceo, { scheduled_at: new Date(Date.now() - 60_000).toISOString() })).json.error).toBe("START_IN_PAST");
    const r = await mk(ceo, { scheduled_at: at(2, 9) });
    expect(r.status).toBe(200);
    const b = (await ceo.req("GET", `/api/bookings/${r.json.id}`)).json;
    expect(new Date(b.ends_at).toISOString()).toBe(at(2, 11));
    expect((await mk(ceo, { scheduled_at: at(2, 9), ends_at: at(2, 8) })).json.error).toBe("END_BEFORE_START");
    expect((await mk(ceo, { scheduled_at: at(2, 9), ends_at: at(2, 9) })).json.error).toBe("END_BEFORE_START");
    expect((await mk(ceo, { ends_at: at(2, 9) })).json.error).toBe("START_REQUIRED");
    expect((await mk(ceo, {})).json.error).toBe("SCHEDULE_REQUIRED"); // D2: the agreed time is required
  });

  it("duration comes from the catalog service (placeholder 120 min, configurable); an explicit end wins", async () => {
    const item = (await ceo.req("POST", "/api/catalog", { name_km: "ដំឡើងកាមេរ៉ា", kind: "service", category: "camera", sell_price: 25000, duration_min: 180 })).json.id;
    expect((await ceo.req("GET", "/api/catalog")).json.find((i: any) => i.id === item).duration_min).toBe(180);
    const plain = (await ceo.req("POST", "/api/catalog", { name_km: "សេវាថ្មី", kind: "service", category: "mep", sell_price: 1000 })).json.id;
    expect((await ceo.req("GET", "/api/catalog")).json.find((i: any) => i.id === plain).duration_min).toBe(120);
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "service", category: "mep", sell_price: 1, duration_min: 5 })).json.error).toBe("DURATION_RANGE");
    const r = await mk(ceo, { category: "camera", service_item_id: item, scheduled_at: at(3, 8) });
    expect(new Date((await ceo.req("GET", `/api/bookings/${r.json.id}`)).json.ends_at).toISOString()).toBe(at(3, 11));
    const r2 = await mk(ceo, { category: "camera", service_item_id: item, scheduled_at: at(3, 8), ends_at: at(3, 8, 45) });
    expect(new Date((await ceo.req("GET", `/api/bookings/${r2.json.id}`)).json.ends_at).toISOString()).toBe(at(3, 8, 45));
  });

  it("reschedule: a booking today 21:00 cannot be moved to yesterday; moving the start keeps the duration", async () => {
    const id = (await mk(ceo, { scheduled_at: at(0, 23, 50) > new Date().toISOString() ? at(0, 23, 50) : at(1, 21) })).json.id;
    expect((await resched(ceo, id, { scheduled_at: at(-1, 21) })).json.error).toBe("START_IN_PAST");
    expect((await resched(ceo, id, { scheduled_at: at(4, 14) })).status).toBe(200);
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(new Date(b.ends_at).toISOString()).toBe(at(4, 16));
    expect((await resched(ceo, id, { scheduled_at: at(4, 14), ends_at: at(4, 13) })).json.error).toBe("END_BEFORE_START");
    expect((await ceo.req("PATCH", `/api/bookings/${id}`, { notes: "ok" })).status).toBe(200); // other fields: no time check
  });
});

describe("R1/R2 availability + server-side blocking", () => {
  let a1: string;
  it("picker lists only technicians free for the window, and says why the others are not", async () => {
    a1 = (await mk(ceo, { scheduled_at: at(5, 9) })).json.id; // 09:00–11:00
    expect((await assign(gm, a1, { lead: s.users.kim, assistants: [s.users.dara], vehicle_id: v1, scheduled_at: at(5, 9) })).status).toBe(200);
    await sql`update users set is_active = false where id = ${s.users.newbie!}`;
    const av = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(5, 10))}&to=${encodeURIComponent(at(5, 12))}`)).json;
    const kimRow = av.people.find((p: any) => p.user_id === s.users.kim);
    expect(kimRow.available).toBe(false); expect(kimRow.reason).toBe("BUSY"); expect(kimRow.busy[0].number).toMatch(/^BK-/);
    expect(av.people.find((p: any) => p.user_id === s.users.gm01)).toBeUndefined(); // technicians only (CEO 04-10)
    expect(av.people.find((p: any) => p.user_id === s.users.newbie)).toBeUndefined(); // inactive = never offered
    expect(av.vehicles.find((v: any) => v.id === v1).available).toBe(false);
    expect(av.vehicles.find((v: any) => v.id === v2).available).toBe(true);
    // back-to-back 11:00–13:00 → kim is available
    const next = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(5, 11))}&to=${encodeURIComponent(at(5, 13))}`)).json;
    expect(next.people.find((p: any) => p.user_id === s.users.kim).available).toBe(true);
    // the booking being edited does not block itself
    const self = (await gm.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(5, 9))}&to=${encodeURIComponent(at(5, 11))}&exclude=${a1}`)).json;
    expect(self.people.find((p: any) => p.user_id === s.users.kim).available).toBe(true);
    expect((await kim.req("GET", `/api/bookings/availability?from=${encodeURIComponent(at(5, 9))}&to=${encodeURIComponent(at(5, 11))}`)).status).toBe(403);
  });

  it("API bypass of the UI: assigning a busy technician or vehicle is rejected with who/what blocks it", async () => {
    const b = (await mk(admin, { scheduled_at: at(5, 10) })).json.id;
    const r = await assign(admin, b, { lead: s.users.kim });
    expect(r.status).toBe(409); expect(r.json.error).toBe("TECH_UNAVAILABLE");
    expect(r.json.details.conflicts[0]).toMatchObject({ user_id: s.users.kim, full_name: "Kim" });
    expect((await assign(admin, b, { assistants: [s.users.gm01] })).json.error).toBe("TECH_NOT_FOUND"); // never the GM (CEO 04-10)
    const tom = (await ceo.req("POST", "/api/users", { username: "tom", full_name: "Tom", role: "tech", phone: "012000008", password: "Tom-pass-2026" })).json.id as string; // a free technician
    const r2 = await assign(admin, b, { assistants: [tom], vehicle_id: v1 });
    expect(r2.status).toBe(409); expect(r2.json.error).toBe("VEHICLE_UNAVAILABLE");
    expect((await assign(admin, b, { assistants: [s.users.newbie] })).json.error).toBe("TECH_NOT_FOUND"); // inactive
    // exact boundary: 11:00 start next to 09:00–11:00 is fine
    const c = (await mk(admin, { scheduled_at: at(5, 11) })).json.id;
    expect((await assign(admin, c, { lead: s.users.kim, vehicle_id: v1 })).status).toBe(200);
    // one minute into the other job overlaps
    const d = (await mk(admin, { scheduled_at: at(5, 12, 59) })).json.id;
    expect((await assign(admin, d, { assistants: [s.users.kim] })).json.error).toBe("TECH_UNAVAILABLE");
    const d2 = (await mk(admin, { scheduled_at: at(5, 10, 59), ends_at: at(5, 11) })).json.id;
    expect((await assign(admin, d2, { assistants: [s.users.kim] })).json.error).toBe("TECH_UNAVAILABLE");
    // assign cannot move the agreed time (D2)
    expect((await assign(admin, d2, { assistants: [s.users.gm01], scheduled_at: at(6, 9) })).json.error).toBe("USE_RESCHEDULE");
  });

  it("vehicle on create/edit/reschedule is checked too", async () => {
    expect((await mk(ceo, { scheduled_at: at(5, 9, 30), vehicle_id: v1 })).json.error).toBe("VEHICLE_UNAVAILABLE");
    const e = (await mk(ceo, { scheduled_at: at(7, 9), vehicle_id: v1 })).json.id;
    expect((await resched(ceo, e, { scheduled_at: at(5, 10) })).json.error).toBe("VEHICLE_UNAVAILABLE");
    const e2 = (await mk(ceo, { scheduled_at: at(5, 10) })).json.id;
    expect((await ceo.req("PATCH", `/api/bookings/${e2}`, { vehicle_id: v1 })).json.error).toBe("VEHICLE_UNAVAILABLE");
  });

  it("reschedule into conflict: moving an assigned booking onto a technician's other job is rejected", async () => {
    const x = (await mk(ceo, { scheduled_at: at(8, 9) })).json.id;
    expect((await assign(gm, x, { lead: s.users.kim })).status).toBe(200);
    const r = await resched(ceo, x, { scheduled_at: at(5, 9, 30) });
    expect(r.status).toBe(409); expect(r.json.error).toBe("TECH_UNAVAILABLE");
    // longer end that runs into the next job is rejected as well
    expect((await resched(ceo, a1, { scheduled_at: at(5, 9), ends_at: at(5, 11, 30) })).json.error).toBe("TECH_UNAVAILABLE");
  });

  it("reassign into conflict is rejected; reassign re-runs the past-time check", async () => {
    const y = (await mk(ceo, { scheduled_at: at(8, 10) })).json.id;
    expect((await assign(gm, y, { lead: s.users.dara })).status).toBe(200);
    expect((await assign(gm, y, { lead: s.users.kim })).json.error).toBe("TECH_UNAVAILABLE"); // kim is on x 09:00–11:00
    await sql`update bookings set scheduled_at = ${at(-1, 9)}, ends_at = ${at(-1, 11)} where id = ${y}`; // the appointment has passed
    expect((await assign(gm, y, { lead: s.users.dara })).json.error).toBe("START_IN_PAST"); // → reschedule first
    expect((await ceo.req("GET", `/api/bookings/${y}`)).json.technicians).toEqual([expect.objectContaining({ full_name: "Dara", role: "lead" })]); // unchanged
  });

  it("concurrent double-save: two assigns of the same technician at the same time → exactly one wins (DB constraint)", async () => {
    const p = (await mk(ceo, { scheduled_at: at(10, 9) })).json.id;
    const q = (await mk(ceo, { scheduled_at: at(10, 10) })).json.id;
    const [r1, r2] = await Promise.all([
      assign(gm, p, { lead: s.users.dara }),
      assign(admin, q, { lead: s.users.dara }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect((r1.status === 409 ? r1 : r2).json.error).toBe("TECH_UNAVAILABLE");
    // the database itself refuses an overlapping row, whatever the writer
    await expect(sql`insert into booking_technicians (booking_id, user_id, role) values (${q}, ${s.users.dara!}, 'assistant')`.then(async () => {
      await sql`update bookings set scheduled_at = ${at(10, 9)}, ends_at = ${at(10, 11)} where id = ${q}`;
    })).rejects.toThrow();
  });
});

describe("R5 crew", () => {
  it("lead is optional, at least one technician, crew of several; Telegram text without a lead", async () => {
    const id = (await mk(ceo, { scheduled_at: at(11, 9) })).json.id;
    expect((await assign(gm, id, { lead: "", assistants: [], scheduled_at: at(11, 9) })).json.error).toBe("TEAM_REQUIRED");
    const r = await assign(gm, id, { lead: "", assistants: [s.users.kim, s.users.dara], scheduled_at: at(11, 9) });
    expect(r.status).toBe(200);
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(b.technicians.map((t: any) => t.role)).toEqual(["assistant", "assistant"]);
    const out = (await sql<{ text: string }[]>`select text from telegram_outbox where dedupe_key like ${"booking:" + id + "%"} limit 1`)[0]!.text;
    expect(out).not.toContain("មេជាង"); expect(out).toContain("Kim"); expect(out).toContain("Dara");
  });
});

describe("R4 cancel", () => {
  it("CEO/GM/Admin with a reason; tech cannot; frees technician + vehicle; audit; Telegram to team + group; filterable", async () => {
    const id = (await mk(ceo, { scheduled_at: at(12, 9) })).json.id;
    expect((await assign(gm, id, { lead: s.users.kim, vehicle_id: v2, scheduled_at: at(12, 9) })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/cancel`, { reason: "test" })).status).toBe(403);
    expect((await admin.req("POST", `/api/bookings/${id}/cancel`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    const before = (await sql`select count(*)::int as n from telegram_outbox`)[0]!.n;
    const r = await admin.req("POST", `/api/bookings/${id}/cancel`, { reason: "អតិថិជនសុំប្ដូរថ្ងៃ" });
    expect(r.status).toBe(200);
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(b.status).toBe("cancelled"); expect(b.cancel_reason).toBe("អតិថិជនសុំប្ដូរថ្ងៃ"); expect(b.cancelled_at).toBeTruthy();
    // never hard-deleted, visible with the filter
    expect((await ceo.req("GET", "/api/bookings?status=cancelled")).json.map((x: any) => x.id)).toContain(id);
    // freed: kim + v2 can take the same slot
    const n = (await mk(ceo, { scheduled_at: at(12, 9), vehicle_id: v2 })).json.id;
    expect((await assign(gm, n, { lead: s.users.kim, vehicle_id: v2, scheduled_at: at(12, 9) })).status).toBe(200);
    // audit + Telegram cancel notice to the group and to kim (linked)
    const audit = (await ceo.req("GET", "/api/settings/audit?limit=500")).json;
    expect(audit.find((a: any) => a.action === "booking.cancel" && a.row_id === id)).toBeTruthy();
    const msgs = await sql<{ chat_id: string; text: string }[]>`select chat_id, text from telegram_outbox where dedupe_key like ${"cancel:" + id + "%"}`;
    expect(msgs.map((m) => m.chat_id).sort()).toEqual(["-100777", "910002"]);
    expect(msgs[0]!.text).toContain("❌"); expect(msgs[0]!.text).toContain("អតិថិជនសុំប្ដូរថ្ងៃ");
    expect((await sql`select count(*)::int as n from telegram_outbox`)[0]!.n).toBeGreaterThan(before);
    expect((await kim.req("GET", "/api/notifications")).json.some((x: any) => x.kind === "booking.cancelled")).toBe(true);
    // cancelling twice is refused
    expect((await admin.req("POST", `/api/bookings/${id}/cancel`, { reason: "again" })).json.error).toBe("BOOKING_NOT_CANCELLABLE");
  });

  it("a completed or invoiced booking can never be cancelled; en_route can (customer cancels on the way)", async () => {
    const id = (await mk(ceo, { scheduled_at: at(13, 9) })).json.id;
    await assign(gm, id, { lead: s.users.dara, scheduled_at: at(13, 9) });
    for (const st of ["en_route", "on_site", "working", "work_done"]) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
    expect((await ceo.req("POST", `/api/bookings/${id}/cancel`, { reason: "late cancel" })).json.error).toBe("BOOKING_NOT_CANCELLABLE");
    await sql`update bookings set status = 'pending_review' where id = ${id}`; await sql`update bookings set status = 'reviewed' where id = ${id}`; await sql`update bookings set status = 'invoiced' where id = ${id}`;
    expect((await ceo.req("POST", `/api/bookings/${id}/cancel`, { reason: "late cancel" })).json.error).toBe("BOOKING_NOT_CANCELLABLE");
    const e = (await mk(ceo, { scheduled_at: at(14, 9) })).json.id;
    await assign(gm, e, { lead: s.users.dara, scheduled_at: at(14, 9) });
    await sql`update bookings set status = 'en_route' where id = ${e}`;
    expect((await gm.req("POST", `/api/bookings/${e}/cancel`, { reason: "customer not home" })).status).toBe(200);
    // the database guard agrees, whatever the writer
    await expect(sql`update bookings set status = 'cancelled' where id = ${id}`).rejects.toThrow(/INVALID_TRANSITION/);
  });

  it("a cancelled booking is locked: no edit, no assign", async () => {
    const id = (await mk(ceo, { scheduled_at: at(15, 9) })).json.id;
    await ceo.req("POST", `/api/bookings/${id}/cancel`, { reason: "duplicate booking" });
    expect((await ceo.req("PATCH", `/api/bookings/${id}`, { notes: "x" })).json.error).toBe("BOOKING_LOCKED");
    expect((await assign(gm, id, { lead: s.users.kim, scheduled_at: at(15, 9) })).json.error).toBe("BOOKING_LOCKED");
  });
});
