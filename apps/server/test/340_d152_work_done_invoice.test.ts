// D-152 (One Team's feedback 21-10) — tests first: the technician's lines carry no price (the office types it; the list price is a
// hint), the invoice takes the work actually done (the booked service only when nothing was added), quantity and unit are
// optional on invoice and quote lines, the technician fixes own lines and notes while the job waits for review.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, repair: string, clean: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const extras = async (c: Client, b: string) => (await c.req("GET", `/api/bookings/${b}/job`)).json.extras as any[];
let slotN = 0;
/** a job booked as «repair», kim on site (depart + arrive); `report` = sent for review too */
async function job(h: number, report = false): Promise<string> {
  const b = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់", zone: "inside", service_item_id: repair, ...span(new Date(Date.now() + h * 3600_000).toISOString()) })).json.id;
  expect((await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - (3 + 4 * slotN++) * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${b}`;
  for (const step of ["depart", "arrive", ...(report ? ["start", "finish"] : [])]) expect((await kim.req("POST", `/api/bookings/${b}/checkpoint`, { step, no_gps: true })).status).toBe(200);
  if (report) {
    for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${b}/photos`, { kind, data: JPEG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${b}/report`, { notes: "លាងរួច", signature: PNG })).status).toBe(200);
  }
  return b;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  repair = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុលម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 3000, duration_min: 120 })).json.id;
  clean = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
});
afterAll(async () => { await app.close(); });

describe("D-152 the invoice is the work done, priced by the office", () => {
  it("booked «repair», the technician did «cleaning»: the line has no price (list price = a hint), the office must type one; the invoice shows cleaning only", async () => {
    const b = await job(100);
    expect((await kim.req("POST", `/api/bookings/${b}/extras`, { kind: "service", item_id: clean, qty: 1 })).status).toBe(200);
    const [x] = await extras(admin, b);
    expect(x).toMatchObject({ description: "លាងម៉ាស៊ីនត្រជាក់", unit_price: null, list_price: 1500, status: "pending" });
    expect((await extras(kim, b))[0].list_price).toBeNull(); // technicians never see prices
    for (const step of ["start", "finish"]) expect((await kim.req("POST", `/api/bookings/${b}/checkpoint`, { step, no_gps: true })).status).toBe(200);
    for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${b}/photos`, { kind, data: JPEG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${b}/report`, { notes: "លាងរួច", signature: PNG })).status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${b}/review`, { decision: "approve" })).status).toBe(200);
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${b}`)).json.error).toBe("EXTRAS_PENDING");
    expect((await admin.req("POST", `/api/bookings/${b}/extras/${x.id}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${b}/extras/${x.id}/review`, { action: "confirm", unit_price: 1200 })).status).toBe(200);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${b}`)).json;
    expect(p.lines.map((l: any) => [l.description, l.unit_price])).toEqual([["លាងម៉ាស៊ីនត្រជាក់", 1200]]); // the booked repair is NOT on the invoice
  });

  it("nothing added on site → the booked service is still suggested; an accepted quote comes first", async () => {
    const b = await job(130, true);
    expect((await gm.req("POST", `/api/bookings/${b}/review`, { decision: "approve" })).status).toBe(200);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${b}`)).json;
    expect(p.lines.map((l: any) => [l.catalog_item_id, l.unit_price])).toEqual([[repair, 3000]]);
  });

  it("quantity and unit are optional: a line without them is saved, counts as 1, keeps a blank unit; the price is edited on the invoice", async () => {
    const b = await job(160, true);
    expect((await gm.req("POST", `/api/bookings/${b}/review`, { decision: "approve" })).status).toBe(200);
    const r = await admin.req("POST", "/api/invoices", { booking_id: b, lines: [{ description: "ជួសជុលប្រព័ន្ធភ្លើង", kind: "service", qty: 1, unit: "", unit_price: 3000 }, { description: "ដឹកជញ្ជូន", kind: "service", qty: 1, unit_price: 500 }] });
    expect(r.status).toBe(200);
    const d = (await admin.req("GET", `/api/invoices/${r.json.id}`)).json;
    expect(d.lines.map((l: any) => [l.qty, l.unit, l.unit_price])).toEqual([[1, "", 3000], [1, "", 500]]);
    expect(d.total).toBe(3500);
    expect((await admin.req("PUT", `/api/invoices/${r.json.id}`, { lines: [{ description: "ជួសជុលប្រព័ន្ធភ្លើង", kind: "service", qty: 1, unit: "", unit_price: 2500 }], notes: "" })).status).toBe(200);
    expect((await admin.req("GET", `/api/invoices/${r.json.id}`)).json.total).toBe(2500);
  });

  it("while the job waits for review the technician still adds, takes back own lines and corrects the notes; after the review no more", async () => {
    const b = await job(190, true);
    expect((await ceo.req("GET", `/api/bookings/${b}`)).json.status).toBe("pending_review");
    const a = await kim.req("POST", `/api/bookings/${b}/extras`, { kind: "other", description: "ប្ដូរខ្សែភ្លើង", qty: 2, unit: "ម៉ែត្រ" });
    expect(a.status).toBe(200);
    expect((await kim.req("DELETE", `/api/bookings/${b}/extras/${a.json.id}`)).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${b}/extras`, { kind: "service", item_id: clean, qty: 1 })).status).toBe(200);
    expect((await kim.req("PATCH", `/api/bookings/${b}/report`, { notes: "លាងរួច · ប្ដូរខ្សែ" })).status).toBe(200);
    expect((await kim.req("GET", `/api/bookings/${b}/job`)).json.report.notes).toBe("លាងរួច · ប្ដូរខ្សែ");
    expect((await gm.req("POST", `/api/bookings/${b}/review`, { decision: "approve" })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${b}/extras`, { kind: "service", item_id: clean, qty: 1 })).json.error).toBe("REPORT_LOCKED");
    expect((await kim.req("PATCH", `/api/bookings/${b}/report`, { notes: "x" })).json.error).toBe("REPORT_LOCKED");
  });
});
