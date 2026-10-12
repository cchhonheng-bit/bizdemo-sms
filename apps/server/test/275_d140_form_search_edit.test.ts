// D-140 (CEO 12-10) A · B · C — tests first.
// A: the customer form's separate address fields: «ក្នុងបុរី» → borey project (fills province / khan / sangkat) + its zone; the full
//    address is built (house, street, borey, zone, village, sangkat, khan, province) and used on the job.
// B: smart phone search — Khmer digits, spaces / dashes, +855 / 855 / 0 / none, any part from 3 digits, «Dara 485»; the indexed
//    digits column; invoices and quotes lists carry the customer's phones for the search box.
// C: one «កែ» screen — customer, service lines + quantity, time (reschedule rules in the same save), place, crew + lead, vehicle,
//    note; locks (in progress → confirm, finished → note only, cancelled → nothing); every changed field audited old → new.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { matchesSearch } from "@sms/shared";
import { sql } from "../src/db.js";
import { setHubTransport } from "../src/services/hub-client.js";
import { customerSearch } from "../src/services/telegram-menu.js";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let borey: string, dara: string, other: string, svcA: string, svcB: string, van: string;
const H = 3_600_000;
const later = (h: number) => new Date(Date.now() + h * H).toISOString();
const hubCalls: { path: string; body: any }[] = [];
const customerRow = async (id: string) => (await admin.req("GET", "/api/customers")).json.find((c: { id: string }) => c.id === id);
const mk = async (h: number, extra: Record<string, unknown> = {}) => {
  const r = await admin.req("POST", "/api/bookings", { customer_id: dara, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(later(h)), ...extra });
  expect(r.status).toBe(200);
  return r.json.id as string;
};
const edit = (c: Client, id: string, body: Record<string, unknown>) => c.req("PUT", `/api/bookings/${id}`, body);
const get = async (id: string) => (await admin.req("GET", `/api/bookings/${id}`)).json;
const lastAudit = async (id: string, action: string) => (await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = ${action} and row_id = ${id} order by id desc limit 1`)[0];

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  setHubTransport(async (_m, path, body) => { hubCalls.push({ path, body }); return { status: 200, json: { ok: true } }; });
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  borey = (await admin.req("POST", "/api/boreys", { name: "បុរីប៉េងហួត", province_code: "12", district_code: "1212", commune_code: "121201" })).json.id;
  svcA = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
  svcB = (await ceo.req("POST", "/api/catalog", { name_km: "ចាក់ហ្គាស", kind: "service", category: "mep", unit: "job", sell_price: 2500, duration_min: 90 })).json.id;
  van = (await sql<{ id: string }[]>`select id from vehicles where company_id = ${s.a} and code = '01'`)[0]!.id;
});
afterAll(async () => { setHubTransport(null); await app.close(); });

describe("D-140 A customer form", () => {
  it("in a borey: the borey fills province / khan / sangkat; the full address = house, street, borey, zone, village, sangkat, khan, province", async () => {
    const r = await admin.req("POST", "/api/customers", { name: "Dara ដារ៉ា", phones: ["016 545 485"], zone: "inside", borey_id: borey, borey_zone: "Zone B", house_no: "12", street: "371" });
    expect(r.status).toBe(200);
    dara = r.json.id;
    const c = await customerRow(dara);
    expect(c).toMatchObject({ province_code: "12", district_code: "1212", commune_code: "121201", borey_id: borey, borey_zone: "Zone B", zone: "inside", address_complete: true });
    const parts = ["ផ្ទះលេខ 12", "ផ្លូវលេខ 371", "បុរីប៉េងហួត", "Zone B", "ច្បារអំពៅ", "ភ្នំពេញ"].map((p) => c.address.indexOf(p));
    expect(parts.every((i) => i >= 0)).toBe(true);
    expect([...parts].sort((a, b) => a - b)).toEqual(parts); // in this order
    // the job takes the full address; the village comes after the borey zone
    const v = await admin.req("POST", "/api/customers", { id: dara, name: "Dara ដារ៉ា", phones: ["016 545 485"], zone: "inside", borey_id: borey, borey_zone: "Zone B", house_no: "12", street: "371", ...PLACE, village_code: "12120101" });
    expect(v.status).toBe(200);
    const full = (await customerRow(dara)).address as string;
    expect(full.indexOf("Zone B")).toBeLessThan(full.indexOf("ភូមិ"));
    const job = await mk(24);
    expect((await get(job)).address).toBe(full);
  });

  it("not in a borey: borey + zone dropped, zone outside; a staff customer still needs province / khan / sangkat", async () => {
    const r = await admin.req("POST", "/api/customers", { name: "ក្រៅបុរី", phones: ["012 345 678"], zone: "outside", borey_id: borey, borey_zone: "Zone C", ...PLACE });
    expect(r.status).toBe(200); // a borey means «in a borey»
    expect(await customerRow(r.json.id)).toMatchObject({ zone: "inside", borey_id: borey, borey_zone: "Zone C" });
    const o = await admin.req("POST", "/api/customers", { name: "ផ្ទះល្វែង", phones: ["012 345 679"], zone: "outside", borey_zone: "Zone D", ...PLACE });
    expect(await customerRow(o.json.id)).toMatchObject({ zone: "outside", borey_id: null, borey_zone: null });
    other = o.json.id;
    expect((await admin.req("POST", "/api/customers", { name: "x", phones: [], zone: "outside" })).json.error).toBe("ADDRESS_INCOMPLETE");
  });
});

describe("D-140 B smart phone search", () => {
  const examples = ["016545485", "016 545485", "016 54 54 85", "16-545-485", "545485", "485", "+855 16 545 485", "85516545485", "16545485", "០១៦ ៥៤៥ ៤៨៥", "(016) 545.485"];
  it("the digits column: stored +855…, searched in the local form", async () => {
    expect((await sql`select phones, phone_digits from customers where id = ${dara}`)[0]).toMatchObject({ phones: ["+85516545485"], phone_digits: "016545485" });
    expect((await sql`select indexname from pg_indexes where tablename = 'customers' and indexname = 'customers_phone_digits_trgm'`).length).toBe(1);
  });
  it("every example finds 016 545 485 — in the app lists and in the bot", async () => {
    for (const q of examples) {
      expect(matchesSearch(q, ["Dara ដារ៉ា"], ["+85516545485"]), q).toBe(true);
      expect((await customerSearch(s.a, "Asia/Phnom_Penh", q)).map((c) => c.id), q).toContain(dara);
    }
    expect(matchesSearch("48", ["Dara"], ["+85516545485"])).toBe(false); // fewer than 3 digits: not a phone search
    expect((await customerSearch(s.a, "Asia/Phnom_Penh", "999")).map((c) => c.id)).not.toContain(dara);
  });
  it("«Dara 485» = name AND phone; «ដារ៉ា 485» too; a wrong name or number finds nothing", async () => {
    for (const q of ["Dara 485", "dara 545 485", "ដារ៉ា 485", "485 Dara"]) {
      expect(matchesSearch(q, ["Dara ដារ៉ា"], ["+85516545485"]), q).toBe(true);
      expect((await customerSearch(s.a, "Asia/Phnom_Penh", q)).map((c) => c.id), q).toEqual([dara]);
    }
    expect(matchesSearch("Sok 485", ["Dara ដារ៉ា"], ["+85516545485"])).toBe(false);
    expect(matchesSearch("Dara 777", ["Dara ដារ៉ា"], ["+85516545485"])).toBe(false);
    expect(await customerSearch(s.a, "Asia/Phnom_Penh", "Sok 485")).toEqual([]);
  });
});

describe("D-140 C one «កែ» screen", () => {
  it("create with service lines: the text, the first item and the lines are stored; the invoice suggests each line × quantity", async () => {
    const empty = await admin.req("POST", "/api/bookings", { customer_id: dara, type: "A", category: "mep", service_text: "", zone: "inside", ...span(later(30)), lines: [{ item_id: svcA, qty: 1 }] });
    expect(empty.json.error).toBe("REQUIRED"); // the form needs a text — the screen fills it from the lines
    const job = await mk(30, { service_text: "លាងម៉ាស៊ីនត្រជាក់ ×2 · ចាក់ហ្គាស", lines: [{ item_id: svcA, qty: 2 }, { item_id: svcB, qty: 1 }] });
    const b = await get(job);
    expect(b.service_item_id).toBe(svcA);
    expect(b.web_lines.map((l: any) => [l.id, l.qty, l.minutes])).toEqual([[svcA, 2, 60], [svcB, 1, 90]]);
    await sql`update bookings set status = 'reviewed' where id = ${job}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines.map((l: any) => [l.catalog_item_id, l.qty, l.unit_price])).toEqual([[svcA, 2, 1500], [svcB, 1, 2500]]);
    // the invoices list carries the customer's phones (smart search in the list)
    const inv = await admin.req("POST", "/api/invoices", { booking_id: job, lines: p.lines });
    expect(inv.status).toBe(200);
    expect((await admin.req("GET", "/api/invoices")).json.find((x: any) => x.id === inv.json.id).customer_phones).toEqual(["+85516545485"]);
  });

  it("lines + quantity, place, note in one save — only what changed is audited, old → new", async () => {
    const job = await mk(48);
    const r = await edit(admin, job, { lines: [{ item_id: svcB, qty: 3 }], service_text: "", notes: "ចូលទ្វារក្រោយ", address: "ផ្ទះថ្មី", lat: 11.5, lng: 104.9, category: "mep" });
    expect(r.status).toBe(200);
    expect(r.json.changed).toEqual(expect.arrayContaining(["lines", "service_text", "notes", "address", "lat", "lng"]));
    expect(r.json.changed).not.toContain("category");
    const b = await get(job);
    expect(b).toMatchObject({ service_text: "ចាក់ហ្គាស ×3", service_item_id: svcB, notes: "ចូលទ្វារក្រោយ", address: "ផ្ទះថ្មី" });
    const a = await lastAudit(job, "booking.update");
    expect(a!.old_data).toMatchObject({ service_text: "ជួសជុល", notes: null });
    expect(a!.new_data).toMatchObject({ service_text: "ចាក់ហ្គាស ×3", notes: "ចូលទ្វារក្រោយ", lines: [{ id: svcB, qty: 3 }] });
    // nothing changed → nothing written
    const n = await edit(admin, job, { notes: "ចូលទ្វារក្រោយ", lines: [{ item_id: svcB, qty: 3 }] });
    expect(n.json.changed).toEqual([]);
  });

  it("a new time follows the reschedule rules: who asked + reason, future start, crew free, history, technicians + customer told", async () => {
    await sql`update customers set tg_subscriber_id = 7001 where id = ${dara}`;
    const job = await mk(72);
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const busy = await mk(100);
    expect((await admin.req("POST", `/api/bookings/${busy}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const move = { ...span(later(100)) };
    expect((await edit(admin, job, move)).json.error).toBe("REQUESTER_REQUIRED");
    expect((await edit(admin, job, { ...move, requested_by: "customer" })).json.error).toBe("REASON_REQUIRED");
    expect((await edit(admin, job, { ...span(later(-2)), requested_by: "customer", reason: "ផ្លាស់ប្ដូរ" })).json.error).toBe("START_IN_PAST");
    const clash = await edit(admin, job, { ...move, requested_by: "customer", reason: "អតិថិជនរវល់" });
    expect([clash.status, clash.json.error]).toEqual([409, "TECH_UNAVAILABLE"]); // kim is on the other job then
    // the same save with another technician (assign rules) is fine
    hubCalls.length = 0;
    const ok = await edit(gm, job, { ...move, requested_by: "customer", reason: "អតិថិជនរវល់", team: { lead: s.users.dara, assistants: [] } });
    expect(ok.status).toBe(200);
    expect(ok.json.rescheduled).toBe(true);
    const b = await get(job);
    expect(new Date(b.scheduled_at).getTime()).toBe(new Date(move.scheduled_at).getTime());
    expect(b.technicians.map((x: any) => x.user_id)).toEqual([s.users.dara]);
    expect((await gm.req("GET", `/api/bookings/${job}/reschedules`)).json).toEqual([expect.objectContaining({ requested_by: "customer", reason: "អតិថិជនរវល់" })]);
    expect(hubCalls.some((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === 7001 && /បានប្ដូរម៉ោង/.test(c.body.text))).toBe(true);
    const audit = await lastAudit(job, "booking.update");
    expect(Object.keys(audit!.new_data)).toEqual(expect.arrayContaining(["scheduled_at", "ends_at", "lead"]));
    // a time move with the same crew tells the technician
    const moved = await edit(admin, job, { ...span(later(130)), requested_by: "creator", reason: "ក្រុមហ៊ុនប្ដូរ" });
    expect(moved.status).toBe(200);
    expect((await sql`select 1 from notifications where user_id = ${s.users.dara!} and kind = 'booking.rescheduled' and link = ${"/tech/job/" + job}`).length).toBeGreaterThan(0);
    // the «ប្ដូរម៉ោង» shortcut stays and tells the customer as well
    hubCalls.length = 0;
    expect((await admin.req("POST", `/api/bookings/${job}/reschedule`, { ...span(later(140)), requested_by: "customer", reason: "ម្ដងទៀត" })).status).toBe(200);
    expect(hubCalls.some((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === 7001)).toBe(true);
  });

  it("customer, vehicle, crew + lead in one save; the old customer's units never follow; a technician cannot edit", async () => {
    const job = await mk(160);
    const r = await edit(admin, job, { customer_id: other, vehicle_id: van, team: { lead: s.users.kim, assistants: [s.users.dara] } });
    expect(r.status).toBe(200);
    const b = await get(job);
    expect(b).toMatchObject({ customer_id: other, vehicle_id: van, status: "assigned" });
    expect(b.address).toBe((await customerRow(other)).address); // the new customer's place
    expect(b.technicians.find((x: any) => x.role === "lead").user_id).toBe(s.users.kim);
    expect((await lastAudit(job, "booking.update"))!.new_data).toMatchObject({ customer_id: other, lead: s.users.kim, assistants: [s.users.dara], vehicle_id: van });
    expect((await edit(kim, job, { notes: "x" })).status).toBe(403);
  });

  it("locks: in progress → time / crew / vehicle only with the tick (never the customer); finished → note only; cancelled → nothing", async () => {
    const job = await mk(200);
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    await sql`update bookings set status = 'on_site' where id = ${job}`;
    const b0 = await get(job);
    const longer = { ends_at: new Date(new Date(b0.ends_at).getTime() + H).toISOString(), requested_by: "creator", reason: "ការងារច្រើនជាងគិត" };
    const no = await edit(admin, job, longer);
    expect([no.status, no.json.error]).toEqual([409, "IN_PROGRESS_CONFIRM"]);
    expect((await edit(admin, job, { team: { lead: s.users.dara, assistants: [] } })).json.error).toBe("IN_PROGRESS_CONFIRM");
    expect((await edit(admin, job, { notes: "ជាងនៅទីនោះ" })).status).toBe(200); // a note needs no tick
    expect((await edit(admin, job, { customer_id: other, confirm_in_progress: true })).json.error).toBe("CUSTOMER_LOCKED");
    const yes = await edit(admin, job, { ...longer, confirm_in_progress: true });
    expect(yes.status).toBe(200);
    expect(new Date((await get(job)).ends_at).getTime()).toBe(new Date(longer.ends_at).getTime());
    const swap = await edit(admin, job, { team: { lead: s.users.dara, assistants: [] }, confirm_in_progress: true });
    expect(swap.status).toBe(200);
    expect((await get(job))).toMatchObject({ status: "on_site", technicians: [expect.objectContaining({ user_id: s.users.dara, role: "lead" })] }); // the status stays
    // finished: the note only (prices: the invoice)
    await sql`update bookings set status = 'work_done' where id = ${job}`;
    expect((await edit(admin, job, { notes: "ចប់ហើយ" })).status).toBe(200);
    expect((await edit(admin, job, { lines: [{ item_id: svcA, qty: 1 }] })).json.error).toBe("FINISHED_NOTE_ONLY");
    expect((await edit(admin, job, { ...span(later(300)), requested_by: "customer", reason: "ម្ដងទៀត" })).json.error).toBe("FINISHED_NOTE_ONLY");
    await sql`update bookings set status = 'invoiced' where id = ${job}`;
    expect((await edit(admin, job, { address: "ផ្សេង" })).json.error).toBe("FINISHED_NOTE_ONLY");
    // cancelled: nothing
    const gone = await mk(220);
    expect((await admin.req("POST", `/api/bookings/${gone}/cancel`, { reason: "អតិថិជនបោះបង់" })).status).toBe(200);
    expect((await edit(admin, gone, { notes: "x" })).json.error).toBe("BOOKING_LOCKED");
  });

  it("a busy technician at the new time can be taken after «finished the earlier job early» (D-139 rules inside the edit)", async () => {
    const early = await mk(400);
    expect((await admin.req("POST", `/api/bookings/${early}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const job = await mk(420);
    const b = await get(early);
    const inside = new Date(new Date(b.scheduled_at).getTime() + H).toISOString(); // kim still booked on «early» then
    const body = { scheduled_at: inside, ends_at: new Date(new Date(inside).getTime() + 2 * H).toISOString(), requested_by: "creator", reason: "បន្ទាន់" };
    expect((await edit(admin, job, { ...body, team: { lead: s.users.kim, assistants: [] } })).json.error).toBe("TECH_UNAVAILABLE");
    const r = await edit(admin, job, { ...body, team: { lead: s.users.kim, assistants: [], overrides: [{ user_id: s.users.kim, reason: "បានបញ្ចប់មុន" }] } });
    expect(r.status).toBe(200);
    expect((await sql`select released_at from booking_technicians where booking_id = ${early} and user_id = ${s.users.kim!}`)[0]!.released_at).not.toBeNull();
  });
});
