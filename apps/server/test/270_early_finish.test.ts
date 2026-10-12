// D-139 (CEO 12-10): a technician who finishes early is free from the actual finish — the busy window is start → actual finish
// (never longer than planned); Admin / GM can record the finish for him (audited); in the crew picker a technician busy on an
// EARLIER job can be ticked after «ជាងនេះបញ្ចប់ការងារមុនហើយ» + a reason (audited) — never while he is on that job right now
// (checked in, no finish); busy rows say the real state (in progress / finished at).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "../src/db.js";
import { loginAs, makeApp, PLACE, resetDb, seed, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let admin: Client, gm: Client, kim: Client, dara: Client;
let cust: string, van: string;
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
/** ISO for local Phnom Penh time: `d` days from today at hh:mm */
function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * H);
  return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm)).toISOString();
}
const mk = async (start: string, end: string) => (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", scheduled_at: start, ends_at: end })).json.id as string;
const assign = (id: string, body: Record<string, unknown>) => admin.req("POST", `/api/bookings/${id}/assign`, { assistants: [], ...body });
/** a job happening NOW: made for later (a start must be in the future), assigned, then moved to [now − 1 h, now + 2 h) */
async function current(tech: string): Promise<string> {
  const id = await mk(iso(Date.now() + 30 * 24 * H), iso(Date.now() + 30 * 24 * H + 3 * H));
  expect((await assign(id, { lead: tech })).status).toBe(200);
  await sql`update bookings set scheduled_at = ${new Date(Date.now() - H)}, ends_at = ${new Date(Date.now() + 2 * H)} where id = ${id}`;
  return id;
}
const steps = async (c: Client, id: string, list: string[]) => { for (const step of list) expect((await c.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200); };
const avail = async (from: string, to: string) => (await admin.req("GET", `/api/bookings/availability?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)).json;
const person = (a: { people: { user_id: string }[] }, id: string) => a.people.find((p) => p.user_id === id) as any;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await admin.req("POST", "/api/customers", { ...PLACE, name: "ការងារ", phones: [], zone: "inside" })).json.id;
  van = (await sql<{ id: string }[]>`select id from vehicles where company_id = ${s.a} and code = '01'`)[0]!.id;
});
afterAll(async () => { await app.close(); });

describe("D-139 early finish", () => {
  it("the technician's «finish» frees him (and the vehicle) at once — before it the job holds him until its planned end", async () => {
    const job = await current(s.users.kim!);
    await sql`update bookings set vehicle_id = ${van} where id = ${job}`;
    const next = await mk(iso(Date.now() + 30 * 60_000), iso(Date.now() + 90 * 60_000));
    expect((await assign(next, { lead: s.users.kim })).json.error).toBe("TECH_UNAVAILABLE");
    await steps(kim, job, ["depart", "arrive", "start"]);
    let k = person(await avail(iso(Date.now() + 30 * 60_000), iso(Date.now() + 90 * 60_000)), s.users.kim!);
    expect(k).toMatchObject({ available: false, reason: "BUSY", can_override: false });
    expect(k.busy[0]).toMatchObject({ state: "in_progress", finished_at: null });
    await steps(kim, job, ["finish"]);
    const b = (await sql<{ status: string; finished_at: Date | null }[]>`select status, finished_at from bookings where id = ${job}`)[0]!;
    expect(b.status).toBe("work_done"); expect(b.finished_at).not.toBeNull();
    k = person(await avail(iso(Date.now() + 30 * 60_000), iso(Date.now() + 90 * 60_000)), s.users.kim!);
    expect(k.available).toBe(true);
    // a window that still touches the job shows how it really ended
    const past = person(await avail(iso(Date.now() - 30 * 60_000), iso(Date.now() + 60_000)), s.users.kim!);
    expect(past.busy[0]).toMatchObject({ state: "finished" });
    expect(new Date(past.busy[0].finished_at).getTime()).toBe(b.finished_at!.getTime());
    expect((await assign(next, { lead: s.users.kim, vehicle_id: van })).status).toBe(200); // technician and vehicle free
  });

  it("in progress (checked in, no finish) still blocks — even with the override; shown as «កំពុងធ្វើ»", async () => {
    const job = await current(s.users.dara!);
    await steps(dara, job, ["depart", "arrive"]);
    const next = await mk(iso(Date.now() + 40 * 60_000), iso(Date.now() + 100 * 60_000));
    const d = person(await avail(iso(Date.now() + 40 * 60_000), iso(Date.now() + 100 * 60_000)), s.users.dara!);
    expect(d).toMatchObject({ available: false, can_override: false });
    expect(d.busy[0].state).toBe("in_progress");
    expect((await assign(next, { lead: s.users.dara })).json.error).toBe("TECH_UNAVAILABLE");
    const r = await assign(next, { lead: s.users.dara, overrides: [{ user_id: s.users.dara, reason: "ជាងប្រាប់ថារួចហើយ" }] });
    expect(r.status).toBe(409); expect(r.json.error).toBe("TECH_IN_PROGRESS");
    expect(r.json.details.conflicts[0]).toMatchObject({ state: "in_progress" });

    // Admin / GM record the real finish for him → free at once; audited; the technician still sends his report
    expect((await dara.req("POST", `/api/bookings/${job}/finish`, { at: iso(Date.now()) })).status).toBe(403);
    expect((await admin.req("POST", `/api/bookings/${job}/finish`, { at: iso(Date.now() + 10 * 60_000) })).json.error).toBe("FINISH_TIME"); // not in the future
    expect((await admin.req("POST", `/api/bookings/${job}/finish`, { at: iso(Date.now() - 3 * H) })).json.error).toBe("FINISH_TIME");  // not before a step already pressed
    const fin = iso(Date.now()); // after the arrive press (a finish never comes before a step already pressed)
    expect((await gm.req("POST", `/api/bookings/${job}/finish`, { at: fin, note: "ជាងភ្លេចចុច" })).status).toBe(200);
    const b = (await sql<{ status: string; finished_at: Date }[]>`select status, finished_at from bookings where id = ${job}`)[0]!;
    expect(b.status).toBe("work_done"); expect(b.finished_at.toISOString()).toBe(fin);
    expect((await sql`select new_data from audit_log where action = 'job.finish_for' and row_id = ${job}`)[0]!.new_data).toMatchObject({ note: "ជាងភ្លេចចុច" });
    expect((await sql`select by_user from booking_checkpoints where booking_id = ${job} and step = 'finish'`)[0]!.by_user).toBe(s.users.gm01);
    expect((await admin.req("POST", `/api/bookings/${job}/finish`, { at: fin })).json.error).toBe("BOOKING_LOCKED"); // once
    expect((await assign(next, { lead: s.users.dara })).status).toBe(200);
  });

  it("override: a technician busy on an EARLIER job is picked after «ជាងនេះបញ្ចប់ការងារមុនហើយ» + a reason (audited); a later job or leave never", async () => {
    const early = await mk(at(9, 9), at(9, 12));
    expect((await assign(early, { lead: s.users.kim })).status).toBe(200);
    const mid = await mk(at(9, 10), at(9, 11));
    expect((await assign(mid, { lead: s.users.kim })).json.error).toBe("TECH_UNAVAILABLE");
    const k = person(await avail(at(9, 10), at(9, 11)), s.users.kim!);
    expect(k).toMatchObject({ reason: "BUSY", can_override: true });
    expect(k.busy[0]).toMatchObject({ state: "booked" });
    expect((await assign(mid, { lead: s.users.kim, overrides: [{ user_id: s.users.kim, reason: "" }] })).json.error).toBe("REASON_REQUIRED");
    expect((await assign(mid, { lead: s.users.kim, overrides: [{ user_id: s.users.kim, reason: "ជាងប្រាប់ថាការងារមុនធ្វើរួចម៉ោង ១០" }] })).status).toBe(200);
    const rel = (await sql<{ new_data: any; user_id: string }[]>`select new_data, user_id from audit_log where action = 'booking.release' and row_id = ${early}`)[0]!;
    expect(rel.user_id).toBe(s.users.admin);
    expect(rel.new_data).toMatchObject({ user_id: s.users.kim, reason: "ជាងប្រាប់ថាការងារមុនធ្វើរួចម៉ោង ១០" });
    expect((await sql<{ e: Date }[]>`select upper(during) as e from booking_technicians where booking_id = ${early} and user_id = ${s.users.kim!}`)[0]!.e.toISOString()).toBe(at(9, 10));
    // a LATER job is not «finished early»: kim's 09:00 job blocks an 08:00 one
    const before = await mk(at(9, 8), at(9, 9, 30));
    expect(person(await avail(at(9, 8), at(9, 9, 30)), s.users.kim!).can_override).toBe(false);
    expect((await assign(before, { lead: s.users.kim, overrides: [{ user_id: s.users.kim, reason: "ចង់បាន" }] })).json.error).toBe("TECH_UNAVAILABLE");
    // leave / absence: never
    await sql`insert into staff_leaves (company_id, user_id, kind, date_from, date_to, part, starts_at, ends_at, reason, requested_by, status)
      values (${s.a}, ${s.users.dara!}, 'leave', ${at(10, 12).slice(0, 10)}, ${at(10, 12).slice(0, 10)}, 'full', ${at(10, 0)}, ${at(10, 23, 59)}, 'ឈប់', ${s.users.dara!}, 'approved')`;
    const onLeave = await mk(at(10, 9), at(10, 10));
    expect((await assign(onLeave, { lead: s.users.dara, overrides: [{ user_id: s.users.dara, reason: "ចង់បាន" }] })).json.error).toBe("TECH_UNAVAILABLE");
  });

  it("rescheduling a released job gives the release back (it was for the old time)", async () => {
    const early = (await sql<{ booking_id: string }[]>`select booking_id from booking_technicians where released_at is not null limit 1`)[0]!.booking_id;
    expect((await admin.req("POST", `/api/bookings/${early}/reschedule`, { scheduled_at: at(11, 9), ends_at: at(11, 12), requested_by: "customer", reason: "ភ្ញៀវសុំ" })).status).toBe(200);
    expect((await sql`select released_at from booking_technicians where booking_id = ${early}`)[0]!.released_at).toBeNull();
    expect((await sql<{ e: Date }[]>`select upper(during) as e from booking_technicians where booking_id = ${early}`)[0]!.e.toISOString()).toBe(at(11, 12));
  });
});
