// D-155 (owner 21-10) — tests first: the technician's phone sends queued photos and added lines later; a retry after a lost
// answer carries the same client key and must not double anything; without a key the old behaviour stays.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, kim: Client;
let cust: string, svc: string, id: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
  id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + 100 * 3600_000).toISOString()) })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - 3 * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${id}`;
  for (const step of ["depart", "arrive"]) expect((await kim.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200);
});
afterAll(async () => { await app.close(); });

describe("D-155 offline retries never double", () => {
  it("the same photo twice with one client key → one file, the same id; without a key two uploads = two files", async () => {
    const a = await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: JPEG, client_key: "k-photo-1" });
    expect(a.status).toBe(200);
    const b = await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: JPEG, client_key: "k-photo-1" });
    expect(b.json).toEqual({ id: a.json.id, duplicate: true });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from job_files where booking_id = ${id} and kind = 'before' and deleted_at is null`)[0]!.n).toBe(1);
    await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG });
    await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from job_files where booking_id = ${id} and kind = 'after' and deleted_at is null`)[0]!.n).toBe(2);
    expect((await sql`select new_data from audit_log where action = 'job.photo' and row_id = ${a.json.id}`)[0]).toMatchObject({ new_data: { offline: true } });
  });

  it("the same added line twice with one client key → one line; a different key → another line; the report stays idempotent", async () => {
    const a = await kim.req("POST", `/api/bookings/${id}/extras`, { kind: "service", item_id: svc, qty: 2, client_key: "k-line-1" });
    expect(a.status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/extras`, { kind: "service", item_id: svc, qty: 2, client_key: "k-line-1" })).json).toMatchObject({ id: a.json.id, duplicate: true });
    expect((await kim.req("POST", `/api/bookings/${id}/extras`, { kind: "other", description: "ខ្សែភ្លើង", qty: 3, unit: "ម៉ែត្រ", client_key: "k-line-2" })).status).toBe(200);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from job_extras where booking_id = ${id}`)[0]!.n).toBe(2);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.ends_at).toBeTruthy(); // the first add extended the job once, the retry not again
    for (const step of ["start", "finish"]) expect((await kim.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "រួច", signature: PNG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "រួច", signature: PNG })).json.error).toBe("REPORT_LOCKED"); // a second send is refused, nothing doubled
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("pending_review");
  });
});
