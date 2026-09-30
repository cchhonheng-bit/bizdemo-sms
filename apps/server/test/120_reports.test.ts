// Flow 6: reports (M10/M11 · FR-1004 · FR-1101 · FR-1102 · FR-1103 · FR-1106 · FR-1202 · BR-21 · AC-13) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { sendSummaries } from "../src/services/reports.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, cfo: Client, kim: Client;
let inside: string, outside: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const line = (unit_price: number) => ({ description: "សេវាកម្ម", kind: "service", qty: 1, unit: "job", unit_price });
const today = async () => (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;
const notes = async (user: string, kind: string) => (await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${s.users[user]!} and kind = ${kind}`)[0]!.n;

async function reviewedJob(customer: string, category = "mep"): Promise<string> {
  const id = (await ceo.req("POST", "/api/bookings", { customer_id: customer, type: "A", category, service_text: "ការងារ", zone: customer === inside ? "inside" : "outside", scheduled_at: when() })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
  return id;
}
async function issued(bookingOrCustomer: { booking_id?: string; customer_id?: string }, cents: number): Promise<string> {
  const id = (await admin.req("POST", "/api/invoices", { ...bookingOrCustomer, lines: [line(cents)] })).json.id;
  expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
  return id;
}
const pay = (id: string, amount: number, currency: string, method: string) => admin.req("POST", `/api/invoices/${id}/payments`, { amount, currency, method });

let voided: string, discounted: string, paidInv: string, cancelled: string;
beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, telegram_chat_id, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, 950001, false) returning id`)[0]!.id;
  await sql`update users set telegram_chat_id = 950002 where id = ${s.users.ceo!}`;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  inside = (await ceo.req("POST", "/api/customers", { name: "បុរីប៉េងហួត បឹងស្នោ", phones: ["012100100"], zone: "inside", lat: 11.55, lng: 104.95 })).json.id;
  outside = (await ceo.req("POST", "/api/customers", { name: "ព្រែកឯង", phones: ["012200200"], zone: "outside", lat: 11.5, lng: 105.0 })).json.id;

  // today: inside job $100 (paid $40 cash + 200,000៛ ABA = $90) · outside camera job $300 (unpaid) · direct sale $50 (paid ACLEDA)
  paidInv = await issued({ booking_id: await reviewedJob(inside) }, 10000);
  await pay(paidInv, 4000, "usd", "cash_usd"); await pay(paidInv, 200000, "khr", "aba");
  await issued({ booking_id: await reviewedJob(outside, "camera") }, 30000);
  const direct = await issued({ customer_id: outside }, 5000); await pay(direct, 5000, "usd", "acleda");
  // void (Admin asks → GM approves) · discount $60 by GM (CEO approves) · cancelled booking
  voided = await issued({ customer_id: inside }, 7000);
  await admin.req("POST", `/api/invoices/${voided}/void`, { reason: "វាយខុស" });
  await gm.req("POST", `/api/invoices/${voided}/void/approve`);
  discounted = (await admin.req("POST", "/api/invoices", { customer_id: inside, lines: [line(20000)] })).json.id;
  await gm.req("POST", `/api/invoices/${discounted}/discount`, { amount: 6000, note: "អតិថិជនចាស់" });
  await ceo.req("POST", `/api/invoices/${discounted}/discount/approve`);
  cancelled = (await admin.req("POST", "/api/bookings", { customer_id: outside, type: "A", category: "decor", service_text: "x x", zone: "outside", scheduled_at: when() })).json.id;
  await admin.req("POST", `/api/bookings/${cancelled}/cancel`, { reason: "ភ្ញៀវលុបចោល" });
});
afterAll(async () => { await app.close(); });

describe("BR-21: CEO + CFO hear about every deletion", () => {
  it("a cancelled booking notifies CEO and CFO (not the person who cancelled)", async () => {
    expect(await notes("ceo", "booking.cancelled")).toBe(1);
    expect(await notes("cfo", "booking.cancelled")).toBe(1);
    expect(await notes("admin", "booking.cancelled")).toBe(0);
  });
});

describe("summary report (FR-1102 · AC-13)", () => {
  it("revenue = issued invoices (void excluded), inside / outside borey, by category; payments by method; new debt; jobs; voids / discounts / cancels", async () => {
    const d = await today();
    const r = await ceo.req("GET", `/api/reports/summary?from=${d}&to=${d}`);
    expect(r.status).toBe(200);
    const x = r.json;
    expect(x.revenue).toMatchObject({ total: 45000, invoices: 3, inside: 10000, outside: 35000 });
    expect(x.revenue.by_category).toMatchObject({ mep: 10000, camera: 30000, direct: 5000 });
    expect(x.payments).toMatchObject({ total: 14000, count: 3 });
    expect(x.payments.by_method).toMatchObject({ cash_usd: 4000, aba: 5000, acleda: 5000, cash_khr: 0 });
    expect(x.new_debt).toBe(31000); // $10 left on the inside job + $300 camera job
    expect(x.debt_total).toBe(31000);
    expect(x.voids).toMatchObject({ count: 1, total: 7000 });
    expect(x.discounts).toMatchObject({ count: 1, total: 6000, over_limit: 1 });
    expect(x.cancels).toBe(1);
    expect(x.jobs.created).toBeGreaterThanOrEqual(3);
    expect(x.jobs.cancelled).toBe(1);
  });

  it("GM (report.ops, no finance) gets jobs only; technicians nothing; range checks", async () => {
    const d = await today();
    const g = (await gm.req("GET", `/api/reports/summary?from=${d}&to=${d}`)).json;
    expect(g.jobs).toBeDefined(); expect(g.revenue).toBeUndefined(); expect(g.payments).toBeUndefined();
    expect((await kim.req("GET", `/api/reports/summary?from=${d}&to=${d}`)).status).toBe(403);
    expect((await ceo.req("GET", "/api/reports/summary?from=2026-09-30&to=2026-09-01")).json.error).toBe("BAD_RANGE");
    expect((await ceo.req("GET", "/api/reports/summary?from=2025-01-01&to=2026-09-01")).json.error).toBe("RANGE_TOO_LONG");
  });
});

describe("verification report + CFO «verified» (FR-1103 · FR-1106)", () => {
  it("every void / discount / cancel / payment with reason, requester and approver", async () => {
    const d = await today();
    const r = await cfo.req("GET", `/api/reports/verification?from=${d}&to=${d}`);
    expect(r.status).toBe(200);
    const items = r.json as any[];
    const v = items.find((i) => i.type === "void");
    expect(v).toMatchObject({ id: voided, reason: "វាយខុស", requested_by_name: "Admin A", approved_by_name: "GM A", amount: 7000, verified_at: null });
    const dc = items.find((i) => i.type === "discount");
    expect(dc).toMatchObject({ id: discounted, reason: "អតិថិជនចាស់", requested_by_name: "GM A", approved_by_name: "CEO A", amount: 6000, status: "applied" });
    expect(items.find((i) => i.type === "cancel")).toMatchObject({ id: cancelled, reason: "ភ្ញៀវលុបចោល", requested_by_name: "Admin A" });
    expect(items.filter((i) => i.type === "payment")).toHaveLength(3);
  });

  it("CFO marks items verified (idempotent); the unverified list shrinks; GM / Admin cannot see or mark; other companies 404", async () => {
    const d = await today();
    const r = await cfo.req("POST", "/api/reports/verify", { type: "void", id: voided, note: "ត្រឹមត្រូវ" });
    expect(r.status).toBe(200);
    expect((await cfo.req("POST", "/api/reports/verify", { type: "void", id: voided })).status).toBe(200);
    const all = (await cfo.req("GET", `/api/reports/verification?from=${d}&to=${d}`)).json as any[];
    expect(all.find((i) => i.type === "void")).toMatchObject({ verified_by_name: "CFO A" });
    const open = (await cfo.req("GET", `/api/reports/verification?from=${d}&to=${d}&unverified=1`)).json as any[];
    expect(open.find((i) => i.type === "void")).toBeUndefined();
    expect(open.length).toBe(all.length - 1);
    expect((await gm.req("GET", `/api/reports/verification?from=${d}&to=${d}`)).status).toBe(403);
    expect((await admin.req("POST", "/api/reports/verify", { type: "void", id: voided })).status).toBe(403);
    expect((await cfo.req("POST", "/api/reports/verify", { type: "payment", id: "00000000-0000-4000-8000-000000000000" })).status).toBe(404);
    expect((await cfo.req("POST", "/api/reports/verify", { type: "bogus", id: voided })).status).toBe(400);
    const ceoB = await loginAs(app, "ceo_b");
    expect((await ceoB.req("POST", "/api/reports/verify", { type: "void", id: voided })).status).toBe(404);
    expect((await ceo.req("GET", "/api/reports/dashboard")).json.unverified).toBe(open.length);
  });
});

describe("CEO dashboard (FR-1101)", () => {
  it("revenue, jobs, pending review, debts, approvals, technician status; finance only for report.finance", async () => {
    const c = (await ceo.req("GET", "/api/reports/dashboard")).json;
    expect(c.today.revenue).toBe(45000); expect(c.today.received).toBe(14000);
    expect(c.month.revenue).toBeGreaterThanOrEqual(45000);
    expect(c.debts).toMatchObject({ total: 31000 });
    expect(c.pending_review).toBe(0);
    expect(c.techs.map((t: any) => t.full_name)).toEqual(expect.arrayContaining(["Kim", "Dara"]));
    expect(c.techs.find((t: any) => t.full_name === "Dara")).toMatchObject({ status: "free" });
    const g = (await gm.req("GET", "/api/reports/dashboard")).json;
    expect(g.today.revenue).toBeUndefined(); expect(g.debts).toBeUndefined();
    expect(g.techs.length).toBeGreaterThan(0);
    expect((await kim.req("GET", "/api/reports/dashboard")).status).toBe(403);
  });
});

describe("Telegram summaries to CEO + CFO (FR-1004)", () => {
  it("daily after 20:00 once; weekly Monday 08:00 (last week); monthly on the 1st 08:00 (last month); never twice", async () => {
    expect(await sendSummaries(new Date("2026-09-30T12:59:00Z"))).toBe(0);            // 19:59 in Phnom Penh
    expect(await sendSummaries(new Date("2026-09-30T13:01:00Z"))).toBe(2);            // 20:01 → daily, one per company (A and B)
    expect(await sendSummaries(new Date("2026-09-30T15:00:00Z"))).toBe(0);            // again that evening → nothing
    expect(await notes("ceo", "report.daily")).toBe(1); expect(await notes("cfo", "report.daily")).toBe(1);
    const tg = await sql<{ text: string }[]>`select text from telegram_outbox where chat_id = 950001 and text like '%2026-09-30%'`;
    expect(tg).toHaveLength(1); expect(tg[0]!.text).toContain("$");
    expect(await sendSummaries(new Date("2026-10-05T01:05:00Z"))).toBe(2);            // Mon 5 Oct 08:05 → weekly 28 Sep – 4 Oct
    expect((await sql`select 1 from telegram_outbox where chat_id = 950001 and text like '%2026-09-28%2026-10-04%'`).length).toBe(1);
    expect(await sendSummaries(new Date("2026-11-01T01:05:00Z"))).toBe(2);            // Sun 1 Nov 08:05 → monthly October
    expect(await notes("cfo", "report.monthly")).toBe(1);
    expect(await sendSummaries(new Date("2026-11-01T01:30:00Z"))).toBe(0);
  });
});

describe("audit log viewer (FR-1202)", () => {
  it("CEO + CFO read who did what, when, old/new; GM cannot; nothing can change it", async () => {
    const r = await cfo.req("GET", "/api/reports/audit?limit=200");
    expect(r.status).toBe(200);
    const void1 = (r.json as any[]).find((a) => a.action === "invoice.void");
    expect(void1).toMatchObject({ user_name: "GM A", table_name: "invoices" });
    expect(void1.new_data.reason).toBe("វាយខុស");
    expect((await cfo.req("GET", "/api/reports/audit?action=payment.&limit=50")).json.every((a: any) => a.action.startsWith("payment."))).toBe(true);
    expect((await gm.req("GET", "/api/reports/audit")).status).toBe(403);
    expect((await ceo.req("DELETE", "/api/reports/audit")).status).toBe(404);
    await expect(sql`delete from audit_log where true`).rejects.toThrow(); // append-only in the database too
  });
});
