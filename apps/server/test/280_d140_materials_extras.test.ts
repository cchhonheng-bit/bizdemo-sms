// D-140 (CEO 12-10) F as D-144 left it — tests first. The technician adds work on site — a price-list line (+ qty, list price, a
// service's length extends the job) or «ការងារ/សម្ភារៈបន្ថែម» (text + qty + unit + photo, no price) — flagged «បន្ថែមដោយជាង»; Admin / GM
// review before the invoice (confirm / edit price / remove); a longer job that runs into the technician's next job → Admin / GM told
// at once + the crew warned; the invoice and «ការងាររួចរាល់» list it. D-140 E (job materials, «បញ្ជាក់សម្ភារៈ», the reminder, the cancel
// question) was replaced by the Admin's stock out (D-144, test 300).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { setHubTransport } from "../src/services/hub-client.js";
import { customerNotices } from "../src/services/customer-notify.js";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, svc: string, longSvc: string;
const H = 3_600_000;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const later = (h: number) => new Date(Date.now() + h * H).toISOString();
const hubCalls: { path: string; body: any }[] = [];
/** a job assigned to kim, moved to «now» and checked in (on site) */
async function onSite(o: { h?: number; minutes?: number } = {}): Promise<string> {
  const id = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(later(o.h ?? 500), o.minutes ?? 120) })).json.id;
  expect((await admin.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  return id;
}
/** each job gets its own past window (4 h apart) so the same technician is never booked twice at once */
let slotN = 0;
const checkIn = async (id: string, startMs = Date.now() - (++slotN * 4 + 2) * H, minutes = 120) => {
  await sql`update bookings set scheduled_at = ${new Date(startMs)}, ends_at = ${new Date(startMs + minutes * 60_000)} where id = ${id}`;
  for (const step of ["depart", "arrive"]) expect((await kim.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200);
};
const info = async (c: Client, id: string) => (await c.req("GET", `/api/bookings/${id}/job`)).json;
const booking = async (id: string) => (await admin.req("GET", `/api/bookings/${id}`)).json;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "inventory,website";
  setHubTransport(async (_m, path, body) => { hubCalls.push({ path, body }); return { status: 200, json: { ok: true } }; });
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await admin.req("POST", "/api/customers", { ...PLACE, name: "អតិថិជន សម្ភារៈ", phones: ["012 600 600"], zone: "inside" })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
  longSvc = (await ceo.req("POST", "/api/catalog", { name_km: "ដំឡើងម៉ាស៊ីន", kind: "service", category: "mep", unit: "job", sell_price: 5000, duration_min: 90 })).json.id;
});
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-140 F work added on site", () => {
  let job: string;
  it("the technician adds a catalog service (+qty, catalog price) and «ការងារផ្សេងៗ» (text + photo, no price); the job gets longer", async () => {
    job = await onSite({ h: 700 });
    await checkIn(job);
    const before = new Date((await booking(job)).ends_at).getTime();
    const a = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "service", item_id: svc, qty: 2 });
    expect(a.status).toBe(200);
    expect(a.json.overlap).toBeNull();
    expect(new Date((await booking(job)).ends_at).getTime()).toBe(before + 60 * 60_000); // + the service's length (once per line)
    const o = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "ប្ដូរខ្សែភ្លើងចាស់", photo: PNG });
    expect(o.status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "x" })).json.error).toBe("DESCRIPTION_REQUIRED");
    const priced = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "តម្លៃ", unit_price: 500 }); // D-151: the field exists for the office — a technician's price is ignored
    expect(priced.status).toBe(200);
    expect(((await info(admin, job)).extras as any[]).find((x) => x.id === priced.json.id)).toMatchObject({ unit_price: null, status: "pending" });
    expect((await kim.req("DELETE", `/api/bookings/${job}/extras/${priced.json.id}`)).status).toBe(200);
    const mine = (await info(kim, job)).extras;
    expect(mine.map((x: any) => [x.kind, x.qty, x.status, x.unit_price, x.added_by])).toEqual([["service", 2, "pending", null, s.users.kim], ["other", 1, "pending", null, s.users.kim]]);
    expect(mine[1].photo_file).toBeTruthy();
    const office = (await info(admin, job)).extras;
    expect(office.map((x: any) => [x.unit_price, x.list_price])).toEqual([[null, 1500], [null, null]]); // D-152: no automatic price — the list price is only a hint for the office
    expect((await sql`select new_data from audit_log where action = 'job.extra_add' and row_id = ${a.json.id}`)[0]).toMatchObject({ new_data: { kind: "service", qty: 2, minutes: 60, unit_price: null } });
  });

  it("Admin / GM review before the invoice: confirm (price kept / edited), remove (reason); the invoice waits until all are reviewed", async () => {
    const [x1, x2] = (await info(admin, job)).extras.map((x: any) => x.id);
    const x3 = (await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "លាងបំពង់ទឹក" })).json.id;
    expect((await kim.req("DELETE", `/api/bookings/${job}/extras/${x3}`)).status).toBe(200); // own pending line: taken back
    const x4 = (await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "ជួសជុលបន្ថែម" })).json.id;
    for (const st of ["work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json.error).toBe("EXTRAS_PENDING");
    expect((await kim.req("POST", `/api/bookings/${job}/extras/${x1}/review`, { action: "confirm" })).status).toBe(403);
    expect((await gm.req("POST", `/api/bookings/${job}/extras/${x2}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED");
    expect((await gm.req("POST", `/api/bookings/${job}/extras/${x2}/review`, { action: "confirm", unit_price: 2000 })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x1}/review`, { action: "confirm", unit_price: 1200 })).status).toBe(200); // edited price
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x4}/review`, { action: "remove" })).json.error).toBe("REASON_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x4}/review`, { action: "remove", reason: "មិនបានធ្វើ" })).status).toBe(200);
    const audit = (await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = 'job.extra_review' and row_id = ${x1}`)[0]!;
    expect([audit.old_data.unit_price, audit.new_data.unit_price]).toEqual([null, 1200]);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines.slice(-2).map((l: any) => [l.description, l.qty, l.unit_price])).toEqual([["លាងម៉ាស៊ីនត្រជាក់", 2, 1200], ["ប្ដូរខ្សែភ្លើងចាស់", 1, 2000]]);
    expect(p.lines.some((l: any) => l.description === "ជួសជុលបន្ថែម")).toBe(false);
    // the invoice + «ការងាររួចរាល់» list the final lines
    await sql`update customers set tg_subscriber_id = 8001 where id = ${cust}`;
    const inv = await admin.req("POST", "/api/invoices", { booking_id: job, lines: p.lines });
    expect(inv.status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${inv.json.id}/issue`, {})).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x1}/review`, { action: "confirm", unit_price: 1 })).json.error).toBe("INVOICE_EXISTS");
    await sql`update bookings set status = 'closed', closed_at = now() where id = ${job}`;
    hubCalls.length = 0;
    await customerNotices();
    const done = hubCalls.find((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === 8001 && String(c.body.text).includes("✅ ការងាររួចរាល់")); // D-194: the invoice notice may land here too
    expect(done?.body.text).toContain("✅ ការងាររួចរាល់");
    expect(done?.body.text).toContain("• លាងម៉ាស៊ីនត្រជាក់ ×2");
    expect(done?.body.text).toContain("• ប្ដូរខ្សែភ្លើងចាស់");
  });

  it("a longer job that runs into the technician's next job stops at its start; Admin + GM told at once, the crew warned", async () => {
    const now = await onSite({ h: 800, minutes: 60 });
    const start = Date.now() - H / 2;
    await checkIn(now, start, 60);
    const next = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "បន្ទាប់", zone: "inside", scheduled_at: new Date(start + 90 * 60_000).toISOString(), ends_at: new Date(start + 180 * 60_000).toISOString() })).json.id;
    expect((await admin.req("POST", `/api/bookings/${next}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const r = await kim.req("POST", `/api/bookings/${now}/extras`, { kind: "service", item_id: longSvc, qty: 1 }); // +90 min would end at start + 150
    expect(r.status).toBe(200);
    expect(r.json.overlap).toMatchObject({ number: (await booking(next)).number });
    expect(new Date((await booking(now)).ends_at).getTime()).toBe(start + 90 * 60_000); // up to the next job's start
    const told = await sql<{ user_id: string }[]>`select user_id from notifications where kind = 'job.extra_clash'`;
    expect(told.map((x) => x.user_id)).toEqual(expect.arrayContaining([s.users.admin, s.users.gm01, s.users.kim]));
    // before arrive / after the report: no adding
    const later2 = await onSite({ h: 900 });
    expect((await kim.req("POST", `/api/bookings/${later2}/extras`, { kind: "service", item_id: svc, qty: 1 })).json.error).toBe("NOT_ON_SITE");
  });
});
