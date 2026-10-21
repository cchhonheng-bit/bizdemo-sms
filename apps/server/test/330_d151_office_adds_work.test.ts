// D-151 (owner 21-10) — tests first: the Admin / GM add work lines themselves — also after the technician sent the report —
// confirmed at once (list price, or the price they type), the job never goes back to the technician, the invoice follows directly.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, svc: string, copper: string, id: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const extras = async (c: Client, b: string) => (await c.req("GET", `/api/bookings/${b}/job`)).json.extras as any[];
let slotN = 0;
/** a job sent for review by kim */
async function sent(h: number): Promise<string> {
  const b = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + h * 3600_000).toISOString()) })).json.id;
  expect((await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - (3 + 4 * slotN++) * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${b}`;
  for (const step of ["depart", "arrive", "start", "finish"]) expect((await kim.req("POST", `/api/bookings/${b}/checkpoint`, { step, no_gps: true })).status).toBe(200);
  for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${b}/photos`, { kind, data: JPEG })).status).toBe(200);
  expect((await kim.req("POST", `/api/bookings/${b}/report`, { notes: "រួចរាល់", signature: PNG })).status).toBe(200);
  return b;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
  copper = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", category: "mep", unit: "ម៉ែត្រ", sell_price: 1500 })).json.id;
  id = await sent(100);
});
afterAll(async () => { await app.close(); });

describe("D-151 the office adds work without sending the job back", () => {
  it("after the report: the Admin adds a price-list line and a priced free line → confirmed at once, flagged as the office's; the job's end stays; no EXTRAS_PENDING; the invoice follows", async () => {
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("pending_review");
    const end0 = (await ceo.req("GET", `/api/bookings/${id}`)).json.ends_at;
    const a = await admin.req("POST", `/api/bookings/${id}/extras`, { kind: "service", item_id: svc, qty: 2 });
    expect(a.status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${id}/extras`, { kind: "other", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ" })).json.error).toBe("PRICE_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${id}/extras`, { kind: "other", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ", unit_price: 100, item_kind: "product" })).status).toBe(200);
    const x = await extras(admin, id);
    expect(x.map((e) => [e.status, e.unit_price, e.added_by_role, e.kind])).toEqual([["confirmed", 1500, "admin", "service"], ["confirmed", 100, "admin", "material"]]);
    expect(x.every((e) => e.reviewed_by_name === "Admin A")).toBe(true);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.ends_at).toBe(end0); // a finished job does not get longer
    expect((await sql`select new_data from audit_log where action = 'job.extra_add' and row_id = ${a.json.id}`)[0]).toMatchObject({ new_data: { office: true, unit_price: 1500 } });
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).status).toBe(200);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${id}`)).json;
    expect(p.error).toBeUndefined();
    expect(p.lines.slice(-2).map((l: any) => [l.description, l.kind, l.qty, l.unit_price])).toEqual([["លាងម៉ាស៊ីនត្រជាក់", "service", 2, 1500], ["ខ្សែភ្លើង 2.5", "product", 20, 100]]);
    expect((await kim.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "job.revision")).toBe(false); // nothing went back
  });

  it("the GM and the CEO add too (also on a reviewed job, with their own price on a list line); the technician's own lines still wait for review; after the invoice nothing more", async () => {
    expect((await gm.req("POST", `/api/bookings/${id}/extras`, { kind: "service", item_id: copper, qty: 6, unit_price: 1400 })).status).toBe(200);
    expect((await ceo.req("POST", `/api/bookings/${id}/extras`, { kind: "other", description: "ដឹកជញ្ជូន", unit_price: 500, item_kind: "service" })).status).toBe(200);
    const x = await extras(admin, id);
    expect(x.slice(-2).map((e) => [e.status, e.unit_price, e.added_by_role, e.kind])).toEqual([["confirmed", 1400, "gm", "service"], ["confirmed", 500, "ceo", "other"]]);
    const other = await sent(130);
    await sql`update bookings set status = 'revision' where id = ${other}`; // the technician's turn again (sent back)
    expect((await kim.req("POST", `/api/bookings/${other}/extras`, { kind: "service", item_id: svc, qty: 1 })).status).toBe(200);
    expect((await extras(admin, other))[0]).toMatchObject({ status: "pending", added_by_role: "tech" });
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: id, lines: (await admin.req("GET", `/api/invoices/prefill?booking=${id}`)).json.lines })).json.id;
    expect((await admin.req("POST", `/api/invoices/${inv}/issue`, {})).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${id}/extras`, { kind: "service", item_id: svc, qty: 1 })).json.error).toBe("INVOICE_EXISTS");
  });

  it("before the technician arrives the office cannot add (NOT_ON_SITE, as before); a cancelled job never", async () => {
    const early = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", ...span(new Date(Date.now() + 300 * 3600_000).toISOString()) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${early}/extras`, { kind: "service", item_id: svc, qty: 1 })).json.error).toBe("NOT_ON_SITE");
  });
});
