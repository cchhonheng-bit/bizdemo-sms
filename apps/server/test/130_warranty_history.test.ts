// Flow 7a: warranty 30 days (FR-1201 · AC-14) + customer history (FR-203) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let cust: string, other: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const newBooking = (customer = cust, extra: Record<string, unknown> = {}) =>
  admin.req("POST", "/api/bookings", { customer_id: customer, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់", zone: "inside", scheduled_at: when(), ...extra });

/** a job closed `daysAgo` days ago (local days), paid in full */
async function closedJob(daysAgo: number, customer = cust): Promise<string> {
  const id = (await newBooking(customer)).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
  const inv = (await admin.req("POST", "/api/invoices", { booking_id: id, lines: [{ description: "ជួសជុល", kind: "service", qty: 1, unit: "job", unit_price: 5000 }] })).json.id;
  await admin.req("POST", `/api/invoices/${inv}/issue`);
  await admin.req("POST", `/api/invoices/${inv}/payments`, { amount: 5000, currency: "usd", method: "cash_usd" });
  expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("closed");
  await sql`update bookings set closed_at = ((now() at time zone 'Asia/Phnom_Penh')::date - ${daysAgo}::int + time '10:00') at time zone 'Asia/Phnom_Penh' where id = ${id}`;
  return id;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក ធានា", phones: ["012303030"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  other = (await ceo.req("POST", "/api/customers", { name: "អតិថិជនផ្សេង", phones: ["012404040"], zone: "outside" })).json.id;
});
afterAll(async () => { await app.close(); });

describe("warranty 30 days from closing (FR-1201 · AC-14)", () => {
  let recent: string, old: string;
  it("AC-14: closed 24 days ago (e.g. 01-10 → call on 25-10) → «in warranty, 6 days left»; 31 days → expired", async () => {
    recent = await closedJob(24);
    const b = (await admin.req("GET", `/api/bookings/${recent}`)).json;
    expect(b.warranty).toMatchObject({ active: true, days_left: 6 });
    old = await closedJob(31);
    expect((await admin.req("GET", `/api/bookings/${old}`)).json.warranty).toMatchObject({ active: false, days_left: 0 });
    const open = (await newBooking()).json.id;
    expect((await admin.req("GET", `/api/bookings/${open}`)).json.warranty).toBeNull(); // not closed yet
  });

  it("a warranty booking is linked to the original job; refused when expired, not closed, another customer or another company", async () => {
    const r = await newBooking(cust, { warranty_of: recent });
    expect(r.status).toBe(200);
    const w = (await admin.req("GET", `/api/bookings/${r.json.id}`)).json;
    expect(w).toMatchObject({ warranty_of: recent, warranty_of_number: expect.stringMatching(/^BK-/) });
    expect((await newBooking(cust, { warranty_of: old })).json.error).toBe("WARRANTY_EXPIRED");
    const open = (await newBooking()).json.id;
    expect((await newBooking(cust, { warranty_of: open })).json.error).toBe("NOT_CLOSED");
    expect((await newBooking(other, { warranty_of: recent })).json.error).toBe("WARRANTY_OTHER_CUSTOMER");
    const ceoB = await loginAs(app, "ceo_b");
    const custB = (await ceoB.req("POST", "/api/customers", { name: "B", phones: ["012505050"], zone: "inside" })).json.id;
    expect((await ceoB.req("POST", "/api/bookings", { customer_id: custB, type: "A", category: "mep", service_text: "x x", zone: "inside", scheduled_at: when(), warranty_of: recent })).status).toBe(404);
  });

  it("the warranty job is free: the invoice is prefilled at $0 and closes the job on issue", async () => {
    const id = (await newBooking(cust, { warranty_of: recent })).json.id;
    await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${id}`)).json;
    expect(p.lines.length).toBeGreaterThan(0);
    expect(p.lines.every((l: any) => l.unit_price === 0)).toBe(true);
    expect(p.warranty_of_number).toMatch(/^BK-/);
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: id, lines: p.lines })).json.id;
    expect((await admin.req("POST", `/api/invoices/${inv}/issue`)).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("closed");
  });
});

describe("customer history (FR-203)", () => {
  it("bookings, invoices with balance, total debt and active warranties; technicians cannot; other companies 404", async () => {
    const debtJob = (await newBooking()).json.id;
    await gm.req("POST", `/api/bookings/${debtJob}/assign`, { lead: s.users.dara, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${debtJob}`;
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: debtJob, lines: [{ description: "x", kind: "service", qty: 1, unit: "job", unit_price: 12000 }] })).json.id;
    await admin.req("POST", `/api/invoices/${inv}/issue`);
    await admin.req("POST", `/api/invoices/${inv}/payments`, { amount: 2000, currency: "usd", method: "aba" });
    const h = (await admin.req("GET", `/api/customers/${cust}/history`)).json;
    expect(h.customer).toMatchObject({ id: cust, name: "លោក ធានា" });
    expect(h.bookings.length).toBeGreaterThanOrEqual(5);
    expect(h.bookings[0]).toHaveProperty("number");
    expect(h.debt).toBe(10000);
    expect(h.invoices.find((i: any) => i.id === inv)).toMatchObject({ total: 12000, paid: 2000, balance: 10000, payment_status: "partial" });
    expect(h.warranties.map((w: any) => w.days_left)).toContain(6);
    expect(h.warranties.every((w: any) => w.days_left > 0)).toBe(true);
    expect((await kim.req("GET", `/api/customers/${cust}/history`)).status).toBe(403);
    const ceoB = await loginAs(app, "ceo_b");
    expect((await ceoB.req("GET", `/api/customers/${cust}/history`)).status).toBe(404);
  });
});
