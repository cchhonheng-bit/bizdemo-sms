// Flow 4: invoices + payments (M8 · FR-801…807 · BR-09 · BR-10…21 · AC-02…07, AC-10, AC-11, AC-20, AC-21) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { sql, tx } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { nextInvoiceNumber } from "../src/services/invoices.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, gm2: Client, admin: Client, cfo: Client, kim: Client;
let cust: string, cust2: string, svc: string, prod: string;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0)]).toString("base64");
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const line = (unit_price: number, qty = 1, kind: "service" | "product" = "service") => ({ description: kind === "service" ? "សេវាកម្ម" : "ទំនិញ", kind, qty, unit: "unit", unit_price });
const yymm = () => { const d = new Date(Date.now() + 7 * 3600_000); return `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };

/** a type A job that the GM reviewed (BR-09): assigned to kim, then stepped through the allowed statuses; 3 × product used */
async function reviewed(status = "reviewed"): Promise<string> {
  const id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់", zone: "inside", scheduled_at: when(), service_item_id: svc })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const path = ["on_site", "work_done", "pending_review", "reviewed"];
  for (const st of path.slice(0, path.indexOf(status) + 1)) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
  await sql`insert into booking_materials (booking_id, catalog_item_id, qty) values (${id}, ${prod}, 3)`;
  return id;
}
const direct = async (c: Client, lines = [line(64000)], customer = cust2) => c.req("POST", "/api/invoices", { customer_id: customer, lines });
const issue = (c: Client, id: string) => c.req("POST", `/api/invoices/${id}/issue`);
const pay = (c: Client, id: string, amount: number, currency: "usd" | "khr", method: string, extra: Record<string, unknown> = {}) =>
  c.req("POST", `/api/invoices/${id}/payments`, { amount, currency, method, ...extra });
const inv = async (id: string) => (await ceo.req("GET", `/api/invoices/${id}`)).json;
const bstatus = async (id: string) => (await ceo.req("GET", `/api/bookings/${id}`)).json.status;
const notes = async (user: string, kind: string) => (await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${s.users[user]!} and kind = ${kind}`)[0]!.n;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const hash = await hashPassword(PW);
  for (const [u, role, phone] of [["cfo", "cfo", "012000008"], ["gm02", "gm", "012000009"]] as const)
    s.users[u] = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, telegram_chat_id)
      values (${s.a}, ${u}, ${u.toUpperCase()}, ${role}::user_role, ${phone}, ${hash}, false, ${u === "cfo" ? 940001 : null}) returning id`)[0]!.id;
  await sql`update users set telegram_chat_id = 940002 where id = ${s.users.ceo!}`;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); gm2 = await loginAs(app, "gm02"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក វណ្ណៈ", phones: ["012777888"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  cust2 = (await ceo.req("POST", "/api/customers", { name: "ហាង ស្រីមុំ", phones: ["012999000"], zone: "outside" })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុលម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "job", sell_price: 2500 })).json.id;
  prod = (await ceo.req("POST", "/api/catalog", { name_km: "ហ្គាស R32", kind: "product", category: "mep", unit: "kg", sell_price: 1200, cost_price: 700 })).json.id;
  await ceo.req("POST", "/api/settings/fx", { rate: 4100 });
});
afterAll(async () => { await app.close(); });

describe("numbering INV-YYMM-#### (BR-13 · AC-11 · AC-21)", () => {
  it("first invoice of the month is 0001 with the local YYMM; the counter restarts each month and is per company", async () => {
    const r = await direct(admin);
    expect(r.status).toBe(200);
    expect(r.json.number).toBe(`INV-${yymm()}-0001`);
    // AC-21: 00:30 on 1 Oct in Phnom Penh (still 30 Sep in UTC) starts INV-2610-0001; September keeps counting (company B's own counter)
    const n = await tx(null, async (t) => {
      await t`insert into invoice_counters (company_id, yymm, last_no) values (${s.b}, '2609', 57)`;
      return [await nextInvoiceNumber(t, s.b, new Date("2026-09-30T10:00:00Z")), await nextInvoiceNumber(t, s.b, new Date("2026-09-30T17:30:00Z")), await nextInvoiceNumber(t, s.b, new Date("2026-10-15T03:00:00Z"))];
    });
    expect(n).toEqual(["INV-2609-0058", "INV-2610-0001", "INV-2610-0002"]);
  });

  it("two users creating invoices at the same moment never share a number (AC-11)", async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => direct(i % 2 ? admin : ceo)));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    const nums = rs.map((r) => r.json.number as string);
    expect(new Set(nums).size).toBe(8);
    expect(nums.map((x) => Number(x.slice(-4))).sort((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9]);
  });
});

describe("invoice from a reviewed job (FR-801 · BR-09 · AC-02 · BR-10)", () => {
  let job: string, id: string;
  it("an invoice is refused until the GM reviewed the job, with the reason (AC-02)", async () => {
    const pending = await reviewed("pending_review");
    const r = await admin.req("POST", "/api/invoices", { booking_id: pending, lines: [line(1000)] });
    expect(r.status).toBe(400); expect(r.json.error).toBe("NOT_REVIEWED");
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${pending}`)).json.error).toBe("NOT_REVIEWED");
  });

  it("prefill = the booked service + the materials from the technician report, at catalog prices", async () => {
    job = await reviewed();
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines).toEqual([
      expect.objectContaining({ catalog_item_id: svc, kind: "service", qty: 1, unit_price: 2500 }),
      expect.objectContaining({ catalog_item_id: prod, kind: "product", qty: 3, unit_price: 1200 }),
    ]);
    expect(p.customer_name).toBe("លោក វណ្ណៈ");
  });

  it("Admin creates the draft; one open invoice per job; the booking waits in reviewed until the invoice is issued", async () => {
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    const r = await admin.req("POST", "/api/invoices", { booking_id: job, lines: p.lines, notes: "អរគុណ" });
    expect(r.status).toBe(200); id = r.json.id;
    const d = await inv(id);
    expect(d).toMatchObject({ status: "draft", booking_id: job, customer_name: "លោក វណ្ណៈ", subtotal: 6100, discount: 0, total: 6100, paid: 0, balance: 6100, payment_status: "unpaid" });
    expect(d.total_khr).toBe(250100);
    expect(await bstatus(job)).toBe("reviewed");
    expect((await admin.req("POST", "/api/invoices", { booking_id: job, lines: p.lines })).json.error).toBe("INVOICE_EXISTS");
  });

  it("permissions: technicians never see invoices; GM and CFO view only; other companies get 404", async () => {
    for (const [m, u] of [["GET", "/api/invoices"], ["GET", `/api/invoices/${id}`], ["GET", "/api/invoices/debts"], ["POST", "/api/invoices"]] as const)
      expect((await kim.req(m, u, m === "POST" ? { customer_id: cust, lines: [line(1)] } : undefined)).status).toBe(403);
    expect((await gm.req("GET", `/api/invoices/${id}`)).status).toBe(200);
    expect((await cfo.req("GET", `/api/invoices/${id}`)).status).toBe(200);
    expect((await gm.req("POST", "/api/invoices", { customer_id: cust, lines: [line(100)] })).status).toBe(403);
    expect((await cfo.req("PUT", `/api/invoices/${id}`, { lines: [line(100)] })).status).toBe(403);
    expect((await cfo.req("POST", `/api/invoices/${id}/issue`)).status).toBe(403);
    const ceoB = await loginAs(app, "ceo_b");
    expect((await ceoB.req("GET", `/api/invoices/${id}`)).status).toBe(404);
    expect((await ceoB.req("POST", `/api/invoices/${id}/issue`)).status).toBe(404);
  });

  it("validation: no lines, zero qty, negative price, unknown catalog item, both / neither of booking and customer", async () => {
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [] })).status).toBe(400);
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ ...line(100), qty: 0 }] })).status).toBe(400);
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [line(-1)] })).status).toBe(400);
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ ...line(100), catalog_item_id: "00000000-0000-4000-8000-000000000000" }] })).json.error).toBe("ITEM_NOT_FOUND");
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [line(100_000_000, 1_000)] })).json.error).toBe("LINE_TOO_LARGE"); // sums never overflow
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: Array.from({ length: 3 }, () => line(100_000_000, 10)) })).json.error).toBe("TOTAL_TOO_LARGE");
    expect((await admin.req("POST", "/api/invoices", { lines: [line(100)] })).status).toBe(400);
    expect((await admin.req("POST", "/api/invoices", { booking_id: job, customer_id: cust, lines: [line(100)] })).status).toBe(400);
  });

  it("type B job: prefill takes the accepted quote lines", async () => {
    const b = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "B", category: "construction", service_text: "របង", zone: "outside", scheduled_at: when() })).json.id;
    const q = (await gm.req("POST", "/api/quotes", { booking_id: b, lines: [{ description: "ដំឡើងរបង", kind: "service", qty: 20, unit: "m", unit_price: 1500 }] })).json.id;
    await gm.req("POST", `/api/quotes/${q}/accept`);
    await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.dara, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${b}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${b}`)).json;
    expect(p.lines).toEqual([expect.objectContaining({ description: "ដំឡើងរបង", qty: 20, unit: "m", unit_price: 1500, kind: "service" })]);
  });
});

describe("discount (BR-12 · AC-03 · AC-04 · AC-05)", () => {
  let id: string;
  it("Admin has no discount (AC-05): the API refuses even a direct call", async () => {
    id = (await direct(admin, [line(20000)])).json.id;
    expect((await admin.req("POST", `/api/invoices/${id}/discount`, { amount: 1000 })).status).toBe(403);
    expect((await admin.req("GET", `/api/invoices/${id}`)).json.can.discount).toBe(false);
    expect((await gm.req("GET", `/api/invoices/${id}`)).json.can.discount).toBe(true);
  });

  it("GM $49.99 → applied at once + audit (AC-03)", async () => {
    const r = await gm.req("POST", `/api/invoices/${id}/discount`, { amount: 4999, note: "អតិថិជនចាស់" });
    expect(r.status).toBe(200); expect(r.json.discount_status).toBe("applied");
    expect(await inv(id)).toMatchObject({ discount: 4999, total: 15001, discount_status: "applied" });
    expect((await ceo.req("GET", "/api/settings/audit?limit=500")).json.map((a: any) => a.action)).toContain("invoice.discount");
    expect(await notes("ceo", "invoice.discount")).toBe(0); // below $50: nobody is disturbed
  });

  it("GM $50.00 → waiting for the CEO; CEO + CFO get Telegram; the invoice cannot be issued until decided (AC-04)", async () => {
    const r = await gm.req("POST", `/api/invoices/${id}/discount`, { amount: 5000, note: "ខូចពេលវេលា" });
    expect(r.json.discount_status).toBe("pending");
    expect(await inv(id)).toMatchObject({ discount: 0, discount_requested: 5000, discount_status: "pending", total: 20000 });
    expect(await notes("ceo", "invoice.discount")).toBe(1);
    expect(await notes("cfo", "invoice.discount")).toBe(1);
    expect((await sql`select 1 from telegram_outbox where chat_id in (940001, 940002) and text like '%$50.00%'`).length).toBe(2);
    expect((await issue(admin, id)).json.error).toBe("DISCOUNT_PENDING");
    expect((await gm.req("POST", `/api/invoices/${id}/discount/approve`)).status).toBe(403); // GM cannot approve his own request
    expect((await gm2.req("POST", `/api/invoices/${id}/discount/approve`)).status).toBe(403);
  });

  it("CEO rejects → no discount; CEO approves a new request → applied; the GM is told", async () => {
    expect((await ceo.req("POST", `/api/invoices/${id}/discount/reject`, { note: "ច្រើនពេក" })).status).toBe(200);
    expect(await inv(id)).toMatchObject({ discount: 0, discount_status: "rejected", total: 20000 });
    await gm.req("POST", `/api/invoices/${id}/discount`, { amount: 6000 });
    expect((await ceo.req("POST", `/api/invoices/${id}/discount/approve`)).status).toBe(200);
    expect(await inv(id)).toMatchObject({ discount: 6000, discount_status: "applied", total: 14000 });
    expect(await notes("gm01", "invoice.discount_decided")).toBe(2);
    expect((await ceo.req("POST", `/api/invoices/${id}/discount/approve`)).json.error).toBe("NOT_PENDING");
  });

  it("CEO gives a discount directly (BR-19); ≥ $50 → CFO told; limits: not above the subtotal, lines cannot drop below it, locked after issue", async () => {
    const before = await notes("cfo", "invoice.discount");
    expect((await ceo.req("POST", `/api/invoices/${id}/discount`, { amount: 8000 })).json.discount_status).toBe("applied");
    expect(await notes("cfo", "invoice.discount")).toBe(before + 1);
    expect((await ceo.req("POST", `/api/invoices/${id}/discount`, { amount: 20001 })).json.error).toBe("DISCOUNT_TOO_HIGH");
    expect((await admin.req("PUT", `/api/invoices/${id}`, { lines: [line(5000)] })).json.error).toBe("DISCOUNT_TOO_HIGH");
    expect((await gm.req("POST", `/api/invoices/${id}/discount`, { amount: -1 })).status).toBe(400);
    expect((await issue(admin, id)).status).toBe(200);
    expect((await gm.req("POST", `/api/invoices/${id}/discount`, { amount: 100 })).json.error).toBe("INVOICE_LOCKED");
    expect(await inv(id)).toMatchObject({ status: "issued", subtotal: 20000, discount: 8000, total: 12000, balance: 12000 });
  });
});

describe("issue + payments (FR-805 · BR-14 · BR-15 · AC-10)", () => {
  let job: string, id: string;
  it("issue locks the lines; the booking becomes invoiced; the rate is frozen for the ៛ total", async () => {
    job = await reviewed();
    id = (await admin.req("POST", "/api/invoices", { booking_id: job, lines: [line(64000)] })).json.id;
    expect((await pay(admin, id, 1000, "usd", "cash_usd")).json.error).toBe("NOT_ISSUED");
    const r = await issue(admin, id);
    expect(r.status).toBe(200);
    expect(await bstatus(job)).toBe("invoiced");
    expect((await admin.req("PUT", `/api/invoices/${id}`, { lines: [line(1)] })).json.error).toBe("INVOICE_LOCKED");
    expect((await issue(admin, id)).json.error).toBe("INVOICE_LOCKED");
    expect(await inv(id)).toMatchObject({ status: "issued", total: 64000, fx_rate_khr: 4100, total_khr: 2624000, payment_status: "unpaid" });
  });

  it("AC-10: $640 · customer pays $300 + 410,000៛ at 4,100 → $240.00 left, partially paid", async () => {
    expect((await pay(admin, id, 30000, "usd", "cash_usd")).status).toBe(200);
    expect(await bstatus(job)).toBe("partially_paid");
    const r = await pay(admin, id, 410000, "khr", "cash_khr");
    expect(r.status).toBe(200);
    const d = await inv(id);
    expect(d).toMatchObject({ paid: 40000, balance: 24000, payment_status: "partial" });
    expect(d.payments).toHaveLength(2);
    expect(d.payments[1]).toMatchObject({ amount: 410000, currency: "khr", method: "cash_khr", fx_rate_khr: 4100, usd_cents: 10000, received_by_name: "Admin A" });
  });

  it("guards: method must match the currency; amount > 0; no future date; no overpayment; GM / tech / CFO cannot record", async () => {
    expect((await pay(admin, id, 1000, "khr", "cash_usd")).json.error).toBe("BAD_METHOD");
    expect((await pay(admin, id, 0, "usd", "aba")).status).toBe(400);
    expect((await pay(admin, id, 100, "usd", "aba", { paid_on: "2099-01-01" })).json.error).toBe("BAD_DATE");
    expect((await pay(admin, id, 24001, "usd", "aba")).json.error).toBe("OVERPAY");
    expect((await pay(gm, id, 100, "usd", "aba")).status).toBe(403);
    expect((await pay(kim, id, 100, "usd", "aba")).status).toBe(403);
    expect((await pay(cfo, id, 100, "usd", "aba")).status).toBe(403);
  });

  it("the rest by ABA in ៛ → paid; the booking closes; nothing more can be paid", async () => {
    expect((await pay(admin, id, 984000, "khr", "aba")).status).toBe(200);
    expect(await inv(id)).toMatchObject({ paid: 64000, balance: 0, payment_status: "paid" });
    expect(await bstatus(job)).toBe("closed");
    expect((await pay(admin, id, 100, "usd", "acleda")).json.error).toBe("OVERPAY");
  });

  it("៛ rounding: paying the ៛ figure shown (rounded to 100៛) settles the last cents; a real overpayment is still refused", async () => {
    const d = (await direct(admin, [line(1001)])).json.id; // $10.01 ≈ 41,041៛ → shown as 41,000៛
    await issue(admin, d);
    expect((await pay(admin, d, 41000, "khr", "cash_khr")).status).toBe(200);
    expect(await inv(d)).toMatchObject({ paid: 1001, balance: 0, payment_status: "paid" });
    const e = (await direct(admin, [line(1001)])).json.id;
    await issue(admin, e);
    expect((await pay(admin, e, 45000, "khr", "cash_khr")).json.error).toBe("OVERPAY");
    expect((await pay(admin, e, 41100, "khr", "cash_khr")).status).toBe(200);
    expect(await inv(e)).toMatchObject({ paid: 1001, payment_status: "paid" });
  });

  it("direct sale (FR-802): no job; a 100 % discount by the CEO makes a $0 invoice that is paid on issue", async () => {
    const d = (await direct(admin, [line(3000, 2, "product")])).json.id;
    expect((await inv(d)).booking_id).toBeNull();
    await ceo.req("POST", `/api/invoices/${d}/discount`, { amount: 6000 });
    expect((await issue(admin, d)).status).toBe(200);
    expect(await inv(d)).toMatchObject({ total: 0, payment_status: "paid" });
  });
});

describe("void (BR-18 … BR-21 · AC-06 · AC-07 · AC-20)", () => {
  it("Admin asks → reason required → GM approves (not the Admin) → VOID, number kept, CEO + CFO told; the job can be invoiced again (AC-06)", async () => {
    const job = await reviewed();
    const id = (await admin.req("POST", "/api/invoices", { booking_id: job, lines: [line(5000)] })).json.id;
    await issue(admin, id);
    const number = (await inv(id)).number;
    expect((await admin.req("POST", `/api/invoices/${id}/void`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    const r = await admin.req("POST", `/api/invoices/${id}/void`, { reason: "វាយតម្លៃខុស" });
    expect(r.json.status).toBe("pending");
    expect(await notes("gm01", "invoice.void_request")).toBe(1);
    expect((await admin.req("POST", `/api/invoices/${id}/void`, { reason: "ម្ដងទៀត" })).json.error).toBe("VOID_PENDING");
    expect((await admin.req("POST", `/api/invoices/${id}/void/approve`)).status).toBe(403); // Admin has no void.approve
    const cfoBefore = await notes("cfo", "invoice.void");
    expect((await gm.req("POST", `/api/invoices/${id}/void/approve`)).status).toBe(200);
    const d = await inv(id);
    expect(d).toMatchObject({ status: "void", number, void_reason: "វាយតម្លៃខុស" });
    expect(await notes("cfo", "invoice.void")).toBe(cfoBefore + 1);
    expect(await notes("ceo", "invoice.void")).toBeGreaterThanOrEqual(1);
    expect(await bstatus(job)).toBe("reviewed");
    expect((await admin.req("POST", "/api/invoices", { booking_id: job, lines: [line(4500)] })).status).toBe(200);
    expect((await admin.req("GET", "/api/invoices?status=void")).json.map((x: any) => x.number)).toContain(number); // still listed (BR-20)
  });

  it("GM asks and cannot approve himself, nor can another GM: it goes to the CEO (AC-07)", async () => {
    const id = (await direct(admin, [line(7000)])).json.id;
    await issue(admin, id);
    expect((await gm.req("POST", `/api/invoices/${id}/void`, { reason: "ភ្ញៀវបោះបង់" })).json.status).toBe("pending");
    expect((await gm.req("POST", `/api/invoices/${id}/void/approve`)).json.error).toBe("OWN_REQUEST");
    expect((await gm2.req("POST", `/api/invoices/${id}/void/approve`)).json.error).toBe("NEEDS_CEO");
    expect(await notes("ceo", "invoice.void_request")).toBeGreaterThanOrEqual(1);
    expect((await ceo.req("POST", `/api/invoices/${id}/void/approve`)).status).toBe(200);
    expect((await inv(id)).status).toBe("void");
  });

  it("CEO voids directly, reason required, no approver (AC-20); a rejected request leaves the invoice as it was", async () => {
    const id = (await direct(admin, [line(2000)])).json.id;
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "បង្កើតស្ទួន" })).json.status).toBe("void"); // a draft can be voided too
    expect((await inv(id)).status).toBe("void");
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "ម្ដងទៀត" })).json.error).toBe("INVOICE_VOID");
    const k = (await direct(admin, [line(2000)])).json.id;
    await admin.req("POST", `/api/invoices/${k}/void`, { reason: "សាកល្បង" });
    expect((await gm.req("POST", `/api/invoices/${k}/void/reject`, { note: "មិនចាំបាច់" })).status).toBe(200);
    expect((await inv(k))).toMatchObject({ status: "draft", void_request: null });
  });

  it("an invoice with payments cannot be voided; payments on a void invoice are refused", async () => {
    const id = (await direct(admin, [line(9000)])).json.id;
    await issue(admin, id);
    await pay(admin, id, 1000, "usd", "cash_usd");
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "ខុស" })).json.error).toBe("HAS_PAYMENTS");
    const v = (await direct(admin, [line(9000)])).json.id;
    await issue(admin, v); await ceo.req("POST", `/api/invoices/${v}/void`, { reason: "ខុស" });
    expect((await pay(admin, v, 100, "usd", "cash_usd")).json.error).toBe("NOT_ISSUED");
  });
});

describe("debts by customer and age (FR-807) + print data (FR-803)", () => {
  it("only issued, unpaid balances count; buckets 0–30 / 31–60 / > 60 days by issue date", async () => {
    const c3 = (await ceo.req("POST", "/api/customers", { name: "ក្រុមហ៊ុន ជំពាក់", phones: ["012123123"], zone: "outside" })).json.id;
    const mk = async (cents: number, daysAgo: number) => { const id = (await direct(admin, [line(cents)], c3)).json.id; await issue(admin, id); await sql`update invoices set issued_at = now() - make_interval(days => ${daysAgo}) where id = ${id}`; return id; };
    await mk(10000, 5); const b = await mk(20000, 45); await mk(40000, 90);
    await pay(admin, b, 5000, "usd", "aba");
    await direct(admin, [line(99900)], c3); // draft: not a debt
    const rows = (await cfo.req("GET", "/api/invoices/debts")).json;
    const r = rows.find((x: any) => x.customer_id === c3);
    expect(r).toMatchObject({ customer_name: "ក្រុមហ៊ុន ជំពាក់", d0_30: 10000, d31_60: 15000, d60_plus: 40000, total: 65000, invoices: 3 });
    expect(rows.every((x: any) => x.total > 0)).toBe(true);
  });

  it("settings: CEO uploads the logo + ACLEDA QR (PNG/JPEG only); Admin cannot; the invoice print data carries company info", async () => {
    expect((await admin.req("POST", "/api/settings/image/qr", { data: PNG })).status).toBe(403);
    expect((await ceo.req("POST", "/api/settings/image/qr", { data: EXE })).json.error).toBe("BAD_IMAGE");
    expect((await ceo.req("POST", "/api/settings/image/qr", { data: PNG })).status).toBe(200);
    expect((await ceo.req("POST", "/api/settings/image/logo", { data: PNG })).status).toBe(200);
    const img = await app.inject({ method: "GET", url: "/api/settings/image/qr", headers: { cookie: admin.cookie! } });
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/png");
    expect((await app.inject({ method: "GET", url: "/api/settings/image/qr" })).statusCode).toBe(401);
    const id = (await direct(admin, [line(1000)])).json.id;
    const d = (await admin.req("GET", `/api/invoices/${id}`)).json;
    expect(d.company).toMatchObject({ has_logo: true, has_qr: true });
    expect(d.customer_phones).toEqual(["012999000"]);
  });

  it("list filters: draft / unpaid (incl. partial) / paid / void; newest first", async () => {
    const all = async (st: string) => (await admin.req("GET", `/api/invoices?status=${st}`)).json as any[];
    expect((await all("draft")).every((x) => x.status === "draft")).toBe(true);
    expect((await all("unpaid")).every((x) => x.status === "issued" && x.payment_status !== "paid")).toBe(true);
    expect((await all("paid")).every((x) => x.payment_status === "paid" && x.status === "issued")).toBe(true);
    expect((await all("void")).length).toBeGreaterThanOrEqual(3);
    expect((await admin.req("GET", "/api/invoices?status=bogus")).status).toBe(400);
  });
});
