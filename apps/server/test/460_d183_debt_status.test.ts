// D-183 the debt-state filter — ជំពាក់សុទ្ធ (nothing paid) · ជំពាក់ខ្លះ (paid in part) · ទូទាត់ហើយ (paid in full) — on every debt screen and
// download: the account report on a debt account (the customers' 12002, a supplier's payable), invoices, receivables, payables, the debts list.
// D-184 an issued invoice's line typed as a service that was goods (the client's INV-2610-0001: the $500 AC unit) is switched on the invoice:
// its revenue moves 40005 → 40004 by one entry, the total, the receivable and the payments stay.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { isDebtAccount } from "@sms/shared";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client, gm: Client;
let today: string, cust: string, A: string, B: string, C: string, D: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const id = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const tbDiff = async () => Number((await sql<{ d: string }[]>`select (coalesce(sum(debit_cents), 0) - coalesce(sum(credit_cents), 0))::text as d from journal_lines where company_id = ${s.a}`)[0]!.d);
const xl = async (c: Client, report: string, q: Record<string, string> = {}) => {
  const qs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await app.inject({ method: "GET", url: `/api/export/${report}.xlsx${qs ? `?${qs}` : ""}`, headers: { cookie: c.cookie! } });
  const rows = r.statusCode === 200 ? readWorkbook(r.rawPayload)[0]!.rows : [];
  return { status: r.statusCode, rows, n: Number(r.headers["x-rows"]), filters: rows[3]?.[0] ?? "" };
};
const num = (v: string | undefined) => Number(v ?? 0);
const invoice = async (lines: { description: string; kind: "service" | "product"; unit_price: number }[], paid = 0) => {
  const r = await admin.req("POST", "/api/invoices", { customer_id: cust, lines: lines.map((l) => ({ ...l, qty: 1, unit: "" })) });
  expect(r.json, JSON.stringify(r.json)).toHaveProperty("id");
  expect((await admin.req("POST", `/api/invoices/${r.json.id}/issue`, {})).status).toBe(200);
  if (paid) expect((await admin.req("POST", `/api/invoices/${r.json.id}/payments`, { amount: paid, currency: "usd", method: "cash_usd" })).status).toBe(200);
  return r.json.id as string;
};

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); gm = await loginAs(app, "gm01");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  const o = await acc(cfo, "/opening", { date: today, cash_usd: 1000000, payables: [{ supplier: "Lim Nguon", amount: 150000, account_id: await id("20001") }] });
  expect(o.status, JSON.stringify(o.json)).toBe(200);
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី សុខ", phones: ["012 333 444"], zone: "inside" })).json.id;
  // the client's invoice: a $70 service + the $500 AC unit typed as a service by mistake — nothing paid
  A = await invoice([{ description: "ថ្លៃសេវាដំឡើង", kind: "service", unit_price: 7000 }, { description: "ម៉ាស៊ីនត្រជាក់ Panasonic 1.5HP", kind: "service", unit_price: 50000 }]);
  B = await invoice([{ description: "លាងម៉ាស៊ីន", kind: "service", unit_price: 5000 }], 2000); // paid in part
  C = await invoice([{ description: "ពិនិត្យ", kind: "service", unit_price: 3000 }], 3000); // paid in full
  D = await invoice([{ description: "ខុស", kind: "service", unit_price: 1000 }]);
  expect((await ceo.req("POST", `/api/invoices/${D}/void`, { reason: "បង្កើតខុស" })).json).toMatchObject({ status: "void" });
  // suppliers: Lim Nguon = the opening debt only (nothing paid) · Lim Ngoun = a credit receipt paid in part · Wire shop = a credit purchase paid in full
  expect((await inv(admin, "/in", { name: "Panasonic 1.5 HP", account_id: await id("13110"), qty: 2, total: 96000, pay: "credit", supplier: "Lim Ngoun", payable_account_id: await id("20002") })).status).toBe(200);
  expect((await inv(admin, "/supplier-pay", { supplier: "Lim Ngoun", amount: 50000, currency: "usd", method: "aba", date: today, account_id: await id("20002") })).status).toBe(200);
  expect((await acc(cfo, "/transactions", { date: today, type: "purchase", amount: 5000, pay: "credit", account_code: "50004", supplier: "Wire shop", debt_account_id: await id("20003") })).status).toBe(200);
  expect((await acc(cfo, "/transactions", { date: today, type: "supplier_payment", amount: 5000, pay: "acleda", supplier: "Wire shop", debt_account_id: await id("20003") })).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-184 an issued invoice's line switched between service and goods", () => {
  it("the client's case: $70 + $500 both on 40005 → the $500 line made goods → 40005 = $70, 40004 = $500; the total, the receivable and the books balance stay; audited", async () => {
    expect([await bal("40005"), await bal("40004")]).toEqual([-(7000 + 50000 + 5000 + 3000), 0]); // every line of A, B, C posted as a service (D voided)
    const before = (await admin.req("GET", `/api/invoices/${A}`)).json, ar = await bal("12002");
    const line = before.lines[1];
    expect(line).toMatchObject({ kind: "service", line_total: 50000 });
    expect((await gm.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "product" })).status).toBe(403); // accounting.post only
    const r = await cfo.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "product" });
    expect(r.json).toEqual({ changed: true, moved: 50000 });
    expect([await bal("40005"), await bal("40004")]).toEqual([-(7000 + 5000 + 3000), -50000]);
    expect(await bal("12002")).toBe(ar);
    expect(await tbDiff()).toBe(0);
    const after = (await admin.req("GET", `/api/invoices/${A}`)).json;
    expect(after.lines[1].kind).toBe("product");
    expect([after.total, after.balance, after.payment_status]).toEqual([before.total, before.balance, "unpaid"]);
    const je = (await sql<{ date: string; lines: number }[]>`select e.entry_date::text as date, count(l.*)::int as lines from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.company_id = ${s.a} and e.source = 'invoice' and e.source_id = ${A} group by e.id order by e.created_at desc limit 1`)[0]!;
    expect(je).toEqual({ date: today, lines: 2 });
    expect((await sql`select 1 from audit_log where company_id = ${s.a} and action = 'invoice.line_kind' and row_id = ${A}`).length).toBe(1);
    expect((await admin.req("GET", `/api/invoices/${A}`)).json.can.line_kind).toBe(true);
  });

  it("the same kind again changes nothing; back and forth moves the revenue back; a void invoice is refused; a line of another invoice is not found", async () => {
    const line = (await admin.req("GET", `/api/invoices/${A}`)).json.lines[1];
    expect((await cfo.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "product" })).json).toEqual({ changed: false, moved: 0 });
    expect((await cfo.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "service" })).json).toEqual({ changed: true, moved: 50000 });
    expect(await bal("40004")).toBe(0);
    expect((await cfo.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "product" })).json.moved).toBe(50000);
    expect([await bal("40005"), await bal("40004")]).toEqual([-15000, -50000]);
    const dl = (await admin.req("GET", `/api/invoices/${D}`)).json.lines[0];
    expect((await cfo.req("POST", `/api/invoices/${D}/lines/${dl.id}/kind`, { kind: "product" })).json.error).toBe("INVOICE_VOID");
    expect((await cfo.req("POST", `/api/invoices/${B}/lines/${line.id}/kind`, { kind: "product" })).status).toBe(404);
    expect((await cfo.req("POST", `/api/invoices/${A}/lines/${line.id}/kind`, { kind: "goods" })).status).toBe(400);
    expect(await tbDiff()).toBe(0);
  });
});

describe("D-183 the debt-state filter", () => {
  it("one rule: the debt accounts are the customers' receivable and the supplier payables (not deposits, tips or wages)", async () => {
    const accs = (await acc(cfo, "/accounts")).json as { code: string; type: string; mapped: string[] }[];
    const debt = (code: string) => isDebtAccount(accs.find((a) => a.code === code)!);
    expect([debt("12002"), debt("20001"), debt("20002"), debt("20003")]).toEqual([true, true, true, true]);
    expect([debt("11001"), debt("40005"), debt("21001")]).toEqual([false, false, false]);
  });

  it("the account report on 12002: ជំពាក់សុទ្ធ = invoice A only · ជំពាក់ខ្លះ = B's issue + payment (balance $30) · ទូទាត់ហើយ = C (net 0) · ទាំងអស់ = every line incl. the void one", async () => {
    const ar = await id("12002");
    const all = await xl(cfo, "account-report", { from: today, to: today, account: ar });
    expect(all.n).toBe(7); // A · B ×2 · C ×2 · D issue + its reversal
    const unpaid = await xl(cfo, "account-report", { from: today, to: today, account: ar, paystatus: "unpaid" });
    expect(unpaid.n).toBe(1); expect(unpaid.filters).toContain("ស្ថានភាពបំណុល: ជំពាក់សុទ្ធ");
    expect(unpaid.rows.some((r) => r[2] === "Opening Balance")).toBe(false);
    expect(num(unpaid.rows.find((r) => r[2] === "Balance")![6])).toBe(570);
    const partial = await xl(cfo, "account-report", { from: today, to: today, account: ar, paystatus: "partial" });
    expect(partial.n).toBe(2); expect(num(partial.rows.find((r) => r[2] === "Balance")![6])).toBe(30);
    const paid = await xl(cfo, "account-report", { from: today, to: today, account: ar, paystatus: "paid" });
    expect(paid.n).toBe(2); expect(num(paid.rows.find((r) => r[2] === "Balance")![6])).toBe(0);
    expect((await xl(cfo, "account-report", { from: today, to: today, account: ar, paystatus: "late" })).status).toBe(400);
  });

  it("the account report on a supplier payable: the supplier's state on that account (Lim Ngoun on 20002 = paid in part)", async () => {
    const ap = await id("20002");
    const partial = await xl(cfo, "account-report", { from: today, to: today, account: ap, paystatus: "partial" });
    expect(partial.n).toBe(2); expect(num(partial.rows.find((r) => r[2] === "Balance")![6])).toBe(-460);
    expect((await xl(cfo, "account-report", { from: today, to: today, account: ap, paystatus: "paid" })).n).toBe(0);
    expect((await xl(cfo, "account-report", { from: today, to: today, account: await id("20001"), paystatus: "unpaid" })).n).toBe(1); // Lim Nguon's opening debt
    expect((await xl(cfo, "account-report", { from: today, to: today, account: await id("20003"), paystatus: "paid" })).n).toBe(2); // Wire shop: bought + paid
  });

  it("the invoices, receivables and payables downloads: the state as their last column and as a filter", async () => {
    const st = (rows: string[][], number: string) => rows.find((r) => r[0] === number || r[2] === number)?.at(-1);
    const nums = Object.fromEntries(await Promise.all([A, B, C].map(async (x) => [x, (await admin.req("GET", `/api/invoices/${x}`)).json.number as string])));
    const invAll = await xl(ceo, "invoices");
    expect(invAll.n).toBe(4);
    expect([st(invAll.rows, nums[A]!), st(invAll.rows, nums[B]!), st(invAll.rows, nums[C]!)]).toEqual(["ជំពាក់សុទ្ធ", "ជំពាក់ខ្លះ", "ទូទាត់ហើយ"]);
    for (const [k, n] of [["unpaid", 1], ["partial", 1], ["paid", 1]] as const) expect((await xl(ceo, "invoices", { paystatus: k })).n).toBe(n); // the void one has no state
    expect((await xl(ceo, "receivables", { asof: today })).n).toBe(2); // what is still owed: A + B
    const arPaid = await xl(ceo, "receivables", { asof: today, paystatus: "paid" });
    expect(arPaid.n).toBe(1); expect(st(arPaid.rows, nums[C]!)).toBe("ទូទាត់ហើយ");
    expect((await xl(ceo, "receivables", { asof: today, paystatus: "partial" })).n).toBe(1);
    const sup = (rows: string[][], name: string) => rows.find((r) => r[0] === name)?.at(-1);
    const pAll = await xl(admin, "payables");
    expect([sup(pAll.rows, "Lim Nguon"), sup(pAll.rows, "Lim Ngoun"), sup(pAll.rows, "Wire shop")]).toEqual(["ជំពាក់សុទ្ធ", "ជំពាក់ខ្លះ", "ទូទាត់ហើយ"]);
    expect((await xl(admin, "payables", { paystatus: "partial" })).rows.some((r) => r[0] === "Lim Ngoun")).toBe(true);
    expect((await xl(admin, "payables", { paystatus: "partial" })).n).toBe(1);
    const pl = (await inv(admin, "/payables")).json as { supplier: string; pay_status: string }[];
    expect(pl.find((p) => p.supplier === "Wire shop")!.pay_status).toBe("paid");
  });

  it("the debts list by state: nothing paid → A $570 · in part → B $30 · in full → C (paid $30, owing 0) · all → $600 owed on two invoices", async () => {
    const one = async (q: string) => ((await ceo.req("GET", `/api/invoices/debts${q}`)).json as { customer_id: string; total: number; paid: number; invoices: number }[]).find((r) => r.customer_id === cust);
    expect(await one("")).toMatchObject({ total: 60000, invoices: 2 });
    expect(await one("?paystatus=unpaid")).toMatchObject({ total: 57000, invoices: 1, paid: 0 });
    expect(await one("?paystatus=partial")).toMatchObject({ total: 3000, invoices: 1, paid: 2000 });
    expect(await one("?paystatus=paid")).toMatchObject({ total: 0, invoices: 1, paid: 3000 });
    expect((await ceo.req("GET", "/api/invoices/debts?paystatus=x")).status).toBe(400);
  });
});
