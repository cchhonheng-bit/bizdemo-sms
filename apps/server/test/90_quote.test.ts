// Flow 3: Quote for type B jobs (M5 · FR-501…504 · BR-02 · BR-10) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, svc: string, prod: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 5)]).toString("base64");
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const mkB = async (c: Client = admin) => (await c.req("POST", "/api/bookings", { customer_id: cust, type: "B", category: "construction", service_text: "សាងសង់របង 20m", zone: "outside", scheduled_at: when() })).json.id as string;
const lines = () => [
  { catalog_item_id: svc, description: "ដំឡើងរបង", kind: "service", qty: 20, unit: "m", unit_price: 1500 },  // $15.00 × 20 = $300.00
  { catalog_item_id: prod, description: "ដែកកាឡៃ", kind: "product", qty: 10, unit: "pcs", unit_price: 1250 }, // $12.50 × 10 = $125.00
];

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { name: "Quote Customer", phones: ["012555666"], zone: "outside", lat: 11.5, lng: 104.9 })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "ដំឡើងរបង", kind: "service", category: "construction", unit: "m", sell_price: 1500 })).json.id;
  prod = (await ceo.req("POST", "/api/catalog", { name_km: "ដែកកាឡៃ", kind: "product", category: "construction", unit: "pcs", sell_price: 1250, cost_price: 900 })).json.id;
  await ceo.req("POST", "/api/settings/fx", { rate: 4100 });
});
afterAll(async () => { await app.close(); });

describe("survey (FR-501)", () => {
  it("GM records survey notes + photos on a type B booking; technicians cannot; type A has no survey", async () => {
    const id = await mkB();
    expect((await gm.req("POST", `/api/bookings/${id}/survey`, { notes: "វាស់ 20m · ដីរាបស្មើ" })).status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${id}/survey-photos`, { data: JPEG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/survey`, { notes: "x" })).status).toBe(403);
    const b = (await gm.req("GET", `/api/bookings/${id}`)).json;
    expect(b.survey_notes).toBe("វាស់ 20m · ដីរាបស្មើ");
    expect((await gm.req("GET", `/api/bookings/${id}/job`)).json.photos.filter((p: any) => p.kind === "survey")).toHaveLength(1);
    const a = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x x", zone: "inside", scheduled_at: when() })).json.id;
    expect((await gm.req("POST", `/api/bookings/${a}/survey`, { notes: "x" })).json.error).toBe("NOT_TYPE_B");
  });
});

describe("quote (FR-502 · BR-10)", () => {
  let id: string, q: any;
  it("GM or Admin creates Q-#### from catalog lines; totals in cents + KHR reference; booking → quoted", async () => {
    id = await mkB();
    const r = await gm.req("POST", "/api/quotes", { booking_id: id, lines: lines(), notes: "តម្លៃនេះមានសុពលភាព 15 ថ្ងៃ", valid_days: 15 });
    expect(r.status).toBe(200); expect(r.json.number).toBe("Q-0001");
    q = (await admin.req("GET", `/api/quotes/${r.json.id}`)).json;
    expect(q).toMatchObject({ number: "Q-0001", status: "sent", subtotal: 42500, total: 42500, total_khr: 1742500, customer_name: "Quote Customer" });
    expect(q.lines.map((l: any) => l.line_total)).toEqual([30000, 12500]);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("quoted");
    const second = await admin.req("POST", "/api/quotes", { booking_id: await mkB(), lines: lines().slice(0, 1) });
    expect(second.json.number).toBe("Q-0002");
  });

  it("validation + permissions: technicians never see or make quotes; no quote for type A; one open quote per booking", async () => {
    expect((await kim.req("POST", "/api/quotes", { booking_id: id, lines: lines() })).status).toBe(403);
    expect((await kim.req("GET", `/api/quotes/${q.id}`)).status).toBe(403);
    expect((await kim.req("GET", "/api/quotes")).status).toBe(403);
    expect((await gm.req("POST", "/api/quotes", { booking_id: id, lines: [] })).status).toBe(400);
    expect((await gm.req("POST", "/api/quotes", { booking_id: id, lines: [{ ...lines()[0], qty: 0 }] })).status).toBe(400);
    expect((await gm.req("POST", "/api/quotes", { booking_id: id, lines: [{ ...lines()[0], unit_price: -1 }] })).status).toBe(400);
    expect((await gm.req("POST", "/api/quotes", { booking_id: id, lines: lines() })).json.error).toBe("QUOTE_EXISTS");
    const a = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x x", zone: "inside", scheduled_at: when() })).json.id;
    expect((await gm.req("POST", "/api/quotes", { booking_id: a, lines: lines() })).json.error).toBe("NOT_TYPE_B");
    const ceoB = await loginAs(app, "ceo_b");
    expect((await ceoB.req("GET", `/api/quotes/${q.id}`)).status).toBe(404);
  });

  it("edit lines while waiting; totals recomputed; audit", async () => {
    const r = await gm.req("PUT", `/api/quotes/${q.id}`, { lines: [...lines(), { description: "ដឹកជញ្ជូន", kind: "service", qty: 1, unit: "trip", unit_price: 2000 }], notes: "កែតម្លៃ" });
    expect(r.status).toBe(200);
    const q2 = (await gm.req("GET", `/api/quotes/${q.id}`)).json;
    expect(q2.total).toBe(44500); expect(q2.lines).toHaveLength(3);
    expect((await ceo.req("GET", "/api/settings/audit?limit=500")).json.map((a: any) => a.action)).toEqual(expect.arrayContaining(["quote.create", "quote.update"]));
  });

  it("type B cannot be assigned before the customer accepts (BR-02); accept → assignable; decided quotes are locked", async () => {
    const assign = () => gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] });
    expect((await assign()).json.error).toBe("QUOTE_NOT_ACCEPTED");
    expect((await admin.req("POST", `/api/quotes/${q.id}/accept`, {})).status).toBe(200);
    expect((await assign()).status).toBe(200);
    expect((await gm.req("PUT", `/api/quotes/${q.id}`, { lines: lines() })).json.error).toBe("QUOTE_DECIDED");
    expect((await gm.req("POST", `/api/quotes/${q.id}/reject`, { reason: "late" })).json.error).toBe("QUOTE_DECIDED");
  });

  it("reject with a reason → booking cancelled with that reason (BR-02, BR-18)", async () => {
    const b = await mkB();
    const r = (await gm.req("POST", "/api/quotes", { booking_id: b, lines: lines() })).json;
    expect((await gm.req("POST", `/api/quotes/${r.id}/reject`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    expect((await gm.req("POST", `/api/quotes/${r.id}/reject`, { reason: "តម្លៃខ្ពស់ពេក" })).status).toBe(200);
    const bk = (await ceo.req("GET", `/api/bookings/${b}`)).json;
    expect(bk.status).toBe("cancelled"); expect(bk.cancel_reason).toContain("តម្លៃខ្ពស់ពេក");
    expect((await gm.req("GET", `/api/quotes/${r.id}`)).json.status).toBe("rejected");
  });

  it("waiting list with days (FR-504) + concurrent quotes never share a number", async () => {
    const list = (await gm.req("GET", "/api/quotes?status=sent")).json;
    expect(list.every((x: any) => x.status === "sent")).toBe(true);
    expect(list[0]).toHaveProperty("days_waiting");
    const [b1, b2] = [await mkB(), await mkB()];
    const [r1, r2] = await Promise.all([gm.req("POST", "/api/quotes", { booking_id: b1, lines: lines() }), admin.req("POST", "/api/quotes", { booking_id: b2, lines: lines() })]);
    expect(r1.json.number).not.toBe(r2.json.number);
    expect((await sql`select count(distinct number)::int as n, count(*)::int as c from quotes`)[0]).toMatchObject({ n: expect.any(Number) });
    const nums = (await sql<{ number: string }[]>`select number from quotes`).map((x) => x.number);
    expect(new Set(nums).size).toBe(nums.length);
  });
});
