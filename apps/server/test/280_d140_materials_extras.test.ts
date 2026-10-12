// D-140 (CEO 12-10) E · F — tests first.
// E: materials keep their flow (technician / GM record, «បញ្ជាក់សម្ភារៈ» takes the stock) + 4 gaps: the daily daytime reminder to
//    Admin + GM after 24 h and the dashboard count · a cancelled job asks «សម្ភារៈបានប្រើរួចឬទេ?» (yes = a job cost to confirm, never
//    invoiced; no = unused) · a quoted job's invoice offers the materials outside the quote apart (unticked) · the Admin records too.
// F: the technician adds work on site — a catalog service (+ qty, catalog price, its length extends the job) or «ការងារផ្សេងៗ» (text
//    + photo, no price) — flagged «បន្ថែមដោយជាង»; Admin / GM review before the invoice (confirm / edit price / remove); a longer job
//    that runs into the technician's next job → Admin / GM told at once + the crew warned; the invoice and «ការងាររួចរាល់» list it.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { setHubTransport } from "../src/services/hub-client.js";
import { customerNotices } from "../src/services/customer-notify.js";
import { materialsReminders } from "../src/services/inventory.js";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, svc: string, longSvc: string, gas: string, pipe: string;
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
const checkIn = async (id: string, startMs = Date.now() - H, minutes = 120) => {
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
  gas = (await ceo.req("POST", "/api/catalog", { name_km: "ហ្គាស R32", kind: "product", category: "mep", unit: "kg", sell_price: 1000 })).json.id;
  pipe = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់", kind: "product", category: "mep", unit: "m", sell_price: 300 })).json.id;
  for (const i of [gas, pipe]) expect((await admin.req("POST", `/api/inventory/items/${i}/track`, { track: true })).status).toBe(200);
  await sql`update company_settings set allow_negative_stock = true where company_id = ${s.a}`; // the stock count is not this test's subject
});
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-140 E materials", () => {
  it("the Admin records / corrects a job's materials (GM rules); who recorded each line is kept; audit old → new", async () => {
    const job = await onSite();
    await checkIn(job);
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: gas, qty: 1 }] })).status).toBe(200);
    expect((await admin.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: gas, qty: 2 }, { catalog_item_id: pipe, qty: 3 }] })).status).toBe(200);
    const m = (await info(admin, job)).materials;
    expect(m.map((x: any) => [x.catalog_item_id, x.qty, x.added_by_name])).toEqual(expect.arrayContaining([[gas, 2, expect.any(String)], [pipe, 3, expect.any(String)]]));
    const byName = Object.fromEntries(m.map((x: any) => [x.catalog_item_id, x.added_by_name]));
    expect(byName[pipe]).not.toBe(byName[gas]); // gas stays kim's line, pipe is the Admin's
    const a = (await sql<{ old_data: any; new_data: any; user_id: string }[]>`select old_data, new_data, user_id from audit_log where action = 'job.materials' and row_id = ${job} order by id desc limit 1`)[0]!;
    expect(a.user_id).toBe(s.users.admin);
    expect(a.old_data.items).toEqual([{ catalog_item_id: gas, qty: 1 }]);
    expect((await ceo.req("PUT", `/api/bookings/${job}/materials`, { items: [] })).status).toBe(403); // the CEO does not record on site
  });

  it("cancel with recorded materials asks «used?»: yes → the confirm list as a job cost (stock out on confirm, never invoiced); no → nothing", async () => {
    const used = await onSite({ h: 520 });
    await checkIn(used);
    expect((await kim.req("PUT", `/api/bookings/${used}/materials`, { items: [{ catalog_item_id: gas, qty: 1.5 }] })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${used}/cancel`, { reason: "អតិថិជនបោះបង់" })).json.error).toBe("MATERIALS_ANSWER_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${used}/cancel`, { reason: "អតិថិជនបោះបង់", materials_used: true })).status).toBe(200);
    const unused = await onSite({ h: 540 });
    await checkIn(unused, Date.now() - H / 2);
    expect((await kim.req("PUT", `/api/bookings/${unused}/materials`, { items: [{ catalog_item_id: pipe, qty: 2 }] })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${unused}/cancel`, { reason: "ខុសអាសយដ្ឋាន", materials_used: false })).status).toBe(200);
    // a job without materials needs no answer
    const plain = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", ...span(later(560)) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${plain}/cancel`, { reason: "មិនត្រូវការ" })).status).toBe(200);
    const list = (await admin.req("GET", "/api/inventory/jobs/pending")).json;
    expect(list.find((j: any) => j.booking_id === used)).toMatchObject({ cancelled: true });
    expect(list.find((j: any) => j.booking_id === unused)).toBeUndefined();
    expect((await sql`select new_data from audit_log where action = 'booking.materials_used' and row_id = ${used}`)[0]).toMatchObject({ new_data: { materials_used: true } });
    const c = await admin.req("POST", `/api/inventory/jobs/${used}/confirm`, {});
    expect(c.status).toBe(200);
    expect((await sql`select qty::float as qty, kind from stock_moves where ref_id = ${used}`).map((x: any) => [x.kind, x.qty])).toEqual([["out_job", -1.5]]);
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${used}`)).json.error).toBe("NOT_REVIEWED"); // never invoiced
  });

  it("not confirmed 24 h after the job ended → one daytime reminder a day to Admin + GM; the dashboard counts the waiting jobs", async () => {
    const job = await onSite({ h: 580 });
    await checkIn(job);
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: pipe, qty: 4 }] })).status).toBe(200);
    await sql`update bookings set status = 'work_done', finished_at = now() - interval '25 hours' where id = ${job}`;
    const dash = (await admin.req("GET", "/api/reports/dashboard")).json;
    expect(dash.materials_pending).toBeGreaterThanOrEqual(1);
    const day = (hh: number) => { const pp = new Date(Date.now() + 7 * H); return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate(), hh - 7, 5)); };
    expect(await materialsReminders(day(21))).toBe(0); // night: never
    expect(await materialsReminders(day(10))).toBe(1);
    expect(await materialsReminders(day(14))).toBe(0); // once a day
    const told = await sql<{ user_id: string; title: string }[]>`select user_id, title from notifications where kind = 'materials.waiting'`;
    expect(told.map((x) => x.user_id).sort()).toEqual([s.users.admin, s.users.gm].sort());
    expect(told[0]!.title).toMatch(/សម្ភារៈរង់ចាំបញ្ជាក់ \(\d+\)|Materials to confirm \(\d+\)/);
  });

  it("a quoted job's invoice: the quote's lines, and the materials outside the quote offered apart (unticked)", async () => {
    const job = await onSite({ h: 600 });
    await checkIn(job);
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: gas, qty: 2 }, { catalog_item_id: pipe, qty: 5 }] })).status).toBe(200);
    const q = (await sql<{ id: string }[]>`insert into quotes (company_id, booking_id, number, status, fx_rate_khr) values (${s.a}, ${job}, 'QT-T1', 'accepted', 4100) returning id`)[0]!.id;
    await sql`insert into quote_lines (quote_id, sort, catalog_item_id, description, kind, qty, unit, unit_price) values (${q}, 0, ${svc}, 'លាង', 'service', 1, 'job', 9000), (${q}, 1, ${gas}, 'ហ្គាស', 'product', 2, 'kg', 1200)`;
    await sql`update bookings set status = 'reviewed' where id = ${job}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines.map((l: any) => [l.catalog_item_id, l.unit_price])).toEqual([[svc, 9000], [gas, 1200]]);
    expect(p.extra_materials).toEqual([expect.objectContaining({ catalog_item_id: pipe, qty: 5, unit_price: 300 })]);
  });
});

describe("D-140 F work added on site", () => {
  let job: string;
  it("the technician adds a catalog service (+qty, catalog price) and «ការងារផ្សេងៗ» (text + photo, no price); the job gets longer", async () => {
    job = await onSite({ h: 700 });
    await checkIn(job, Date.now() - H, 120);
    const before = new Date((await booking(job)).ends_at).getTime();
    const a = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "service", item_id: svc, qty: 2 });
    expect(a.status).toBe(200);
    expect(a.json.overlap).toBeNull();
    expect(new Date((await booking(job)).ends_at).getTime()).toBe(before + 60 * 60_000); // + the service's length (once per line)
    const o = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "ប្ដូរខ្សែភ្លើងចាស់", photo: PNG });
    expect(o.status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "x" })).json.error).toBe("DESCRIPTION_REQUIRED");
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "តម្លៃ", unit_price: 500 })).status).toBe(400); // no price from the technician
    const mine = (await info(kim, job)).extras;
    expect(mine.map((x: any) => [x.kind, x.qty, x.status, x.unit_price, x.added_by])).toEqual([["service", 2, "pending", null, s.users.kim], ["other", 1, "pending", null, s.users.kim]]);
    expect(mine[1].photo_file).toBeTruthy();
    const office = (await info(admin, job)).extras;
    expect(office.map((x: any) => x.unit_price)).toEqual([1500, null]); // the office sees the catalog price
    expect((await sql`select new_data from audit_log where action = 'job.extra_add' and row_id = ${a.json.id}`)[0]).toMatchObject({ new_data: { kind: "service", qty: 2, minutes: 60, unit_price: 1500 } });
  });

  it("Admin / GM review before the invoice: confirm (price kept / edited), remove (reason); the invoice waits until all are reviewed", async () => {
    const [x1, x2] = (await info(admin, job)).extras.map((x: any) => x.id);
    const x3 = (await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "លាងបំពង់ទឹក" })).json.id;
    expect((await kim.req("DELETE", `/api/bookings/${job}/extras/${x3}`)).status).toBe(200); // own pending line: taken back
    const x4 = (await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "ជួសជុលបន្ថែម" })).json.id;
    await sql`update bookings set status = 'reviewed' where id = ${job}`;
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json.error).toBe("EXTRAS_PENDING");
    expect((await kim.req("POST", `/api/bookings/${job}/extras/${x1}/review`, { action: "confirm" })).status).toBe(403);
    expect((await gm.req("POST", `/api/bookings/${job}/extras/${x2}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED");
    expect((await gm.req("POST", `/api/bookings/${job}/extras/${x2}/review`, { action: "confirm", unit_price: 2000 })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x1}/review`, { action: "confirm", unit_price: 1200 })).status).toBe(200); // edited price
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x4}/review`, { action: "remove" })).json.error).toBe("REASON_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x4}/review`, { action: "remove", reason: "មិនបានធ្វើ" })).status).toBe(200);
    const audit = (await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = 'job.extra_review' and row_id = ${x1}`)[0]!;
    expect([audit.old_data.unit_price, audit.new_data.unit_price]).toEqual([1500, 1200]);
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
    const done = hubCalls.find((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === 8001);
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
    expect(told.map((x) => x.user_id)).toEqual(expect.arrayContaining([s.users.admin, s.users.gm, s.users.kim]));
    // before arrive / after the report: no adding
    const later2 = await onSite({ h: 900 });
    expect((await kim.req("POST", `/api/bookings/${later2}/extras`, { kind: "service", item_id: svc, qty: 1 })).json.error).toBe("NOT_ON_SITE");
  });
});
