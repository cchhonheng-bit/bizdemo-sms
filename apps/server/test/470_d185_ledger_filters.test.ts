// D-185 every account gets the filters its own lines support (client 28-10: «12001 បុគ្គលិកជំពាក់ should have the same as 12002»):
// staff advances name the person (Money «បុគ្គលិកខ្ចីប្រាក់ / បុគ្គលិកសងប្រាក់», a person on a manual journal line), the debt state per person
// on any balance-sheet account, and the account report's filters — who · movement · transaction type · zone · item · search — offered
// by the facets of the picked accounts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client, gm: Client;
let today: string, inside: string, outside: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const id = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const qs = (q: Record<string, string>) => Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const report = async (q: Record<string, string>) => {
  const r = await app.inject({ method: "GET", url: `/api/export/account-report.xlsx?${qs({ from: today, to: today, ...q })}`, headers: { cookie: cfo.cookie! } });
  const rows = r.statusCode === 200 ? readWorkbook(r.rawPayload)[0]!.rows : [];
  return { status: r.statusCode, n: Number(r.headers["x-rows"]), rows, balance: Number(rows.find((x) => x[2] === "Balance")?.[6] ?? NaN), filters: rows[3]?.[0] ?? "" };
};
const facets = async (c: Client, q: Record<string, string>) => {
  const r = await app.inject({ method: "GET", url: `/api/export/account-report/facets?${qs({ from: today, to: today, ...q })}`, headers: { cookie: c.cookie! } });
  return { status: r.statusCode, json: r.json() as any };
};
const tx = (body: Record<string, unknown>) => acc(cfo, "/transactions", { date: today, ...body });

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); gm = await loginAs(app, "gm01");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  expect((await acc(cfo, "/opening", { date: today, cash_usd: 1000000 })).status).toBe(200);
  // staff advances: Kim borrows $100 and pays $40 back (in part) · Dara borrows $50 + $10 by a journal line naming her (nothing paid) · the GM $20 and pays it all back
  expect((await tx({ type: "staff_advance", amount: 10000, pay: "cash_usd", user_id: s.users.kim })).status).toBe(200);
  expect((await tx({ type: "staff_repay", amount: 4000, pay: "cash_usd", user_id: s.users.kim })).status).toBe(200);
  expect((await tx({ type: "staff_advance", amount: 5000, pay: "aba", user_id: s.users.dara })).status).toBe(200);
  expect((await acc(cfo, "/journal", { date: today, memo: "បើកមុន", lines: [{ account_id: await id("12001"), debit: 1000, user_id: s.users.dara }, { account_id: await id("11001"), credit: 1000 }] })).status).toBe(200);
  expect((await tx({ type: "staff_advance", amount: 2000, pay: "cash_usd", user_id: s.users.gm01 })).status).toBe(200);
  expect((await tx({ type: "staff_repay", amount: 2000, pay: "cash_usd", user_id: s.users.gm01 })).status).toBe(200);
  // two customers, inside and outside a borey, one invoice each
  inside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី ស្រីនាង", phones: ["012 555 111"], zone: "inside" })).json.id;
  outside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្រៅបុរី វណ្ណា", phones: ["012 555 222"], zone: "outside" })).json.id;
  for (const [cust, price, paid] of [[inside, 7000, 7000], [outside, 3000, 1000]] as const) {
    const iv = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "សេវា", kind: "service", qty: 1, unit: "", unit_price: price }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${iv}/issue`, {})).status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${iv}/payments`, { amount: paid, currency: "usd", method: "cash_usd" })).status).toBe(200);
  }
  // a stock receipt from a supplier: the item and the supplier become choices on the stock account
  expect((await admin.req("POST", "/api/inventory/in", { name: "Daikin 1HP", account_id: await id("13110"), qty: 1, total: 40000, pay: "credit", supplier: "ហាង ខ" })).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-185 staff advances name the person", () => {
  it("Money «បុគ្គលិកខ្ចីប្រាក់ / បុគ្គលិកសងប្រាក់» post on the staff advances account (map) with the staff member; no staff member → refused", async () => {
    expect(await bal("12001")).toBe(10000 - 4000 + 5000 + 1000 + 2000 - 2000);
    const kim = await sql<{ d: string; c: string; memo: string }[]>`select l.debit_cents::text as d, l.credit_cents::text as c, l.memo from journal_lines l join accounts a on a.id = l.account_id
      where a.company_id = ${s.a} and a.code = '12001' and l.user_id = ${s.users.kim!} order by l.id`;
    expect(kim.map((r) => [Number(r.d), Number(r.c), r.memo])).toEqual([[10000, 0, "Kim"], [0, 4000, "Kim"]]);
    expect((await tx({ type: "staff_advance", amount: 100, pay: "cash_usd" })).json.error).toBe("STAFF_REQUIRED");
    expect((await tx({ type: "staff_advance", amount: 100, pay: "cash_usd", user_id: s.users.ceo_b })).json.error).toBe("STAFF_REQUIRED"); // another shop's
    expect((await acc(cfo, "/journal", { date: today, memo: "x", lines: [{ account_id: await id("12001"), debit: 100, user_id: s.users.ceo_b }, { account_id: await id("11001"), credit: 100 }] })).status).toBe(404);
  });
});

describe("D-185 every account gets the filters its own lines support", () => {
  it("facets: 12001 → the debt state + its staff; 12002 → customers + both zones; 13110 → the item + the supplier; cash → its transaction types; none picked → nothing; GM → 403", async () => {
    const f1 = (await facets(cfo, { account: await id("12001") })).json;
    expect(f1.debt).toBe(true);
    expect(f1.parties.map((p: any) => `${p.kind}:${p.name}`)).toEqual(["staff:Dara", "staff:GM A", "staff:Kim"]);
    expect(f1.sources).toEqual(["manual", "other"]);
    const f2 = (await facets(cfo, { account: await id("12002") })).json;
    expect(f2.parties.map((p: any) => p.kind)).toEqual(["customer", "customer"]); expect(f2.zones).toEqual(["inside", "outside"]); expect(f2.debt).toBe(true);
    const f3 = (await facets(cfo, { account: await id("13110") })).json;
    expect(f3.items.map((x: any) => x.name)).toEqual(["Daikin 1HP"]); expect(f3.parties.map((p: any) => `${p.kind}:${p.name}`)).toEqual(["supplier:ហាង ខ"]);
    const f4 = (await facets(cfo, { account: await id("11001") })).json;
    expect(f4.sources).toEqual(expect.arrayContaining(["opening", "other", "payment", "manual"]));
    expect((await facets(cfo, {})).json).toEqual({ debt: false, sources: [], zones: [], parties: [], items: [], bookers: [] });
    expect((await facets(gm, { account: await id("12001") })).status).toBe(403);
  });

  it("12001 by debt state, per staff member: ជំពាក់ខ្លះ = Kim ($60 left) · ជំពាក់សុទ្ធ = Dara ($60, nothing paid) · ទូទាត់ហើយ = the GM (0)", async () => {
    const a = await id("12001");
    const all = await report({ account: a });
    expect(all.n).toBe(6); expect(all.rows.some((r) => r[2] === "Opening Balance")).toBe(true);
    const partial = await report({ account: a, paystatus: "partial" });
    expect([partial.n, partial.balance]).toEqual([2, 60]); expect(partial.rows.some((r) => r[2] === "Opening Balance")).toBe(false);
    expect(partial.rows.filter((r) => r[1] === "12001" && r[10]).map((r) => r[10])).toEqual(["Kim", "Kim"]); // the staff member in the person column
    const unpaid = await report({ account: a, paystatus: "unpaid" });
    expect([unpaid.n, unpaid.balance]).toEqual([2, 60]);
    const paid = await report({ account: a, paystatus: "paid" });
    expect([paid.n, paid.balance]).toEqual([2, 0]);
  });

  it("who · movement · transaction type · search · zone · item narrow the lines; the file's header says which", async () => {
    const a = await id("12001");
    const kim = (await facets(cfo, { account: a })).json.parties.find((p: any) => p.name === "Kim").token as string;
    const who = await report({ account: a, party: kim });
    expect([who.n, who.balance]).toEqual([2, 60]); expect(who.filters).toContain("អ្នកពាក់ព័ន្ធ: Kim");
    const out = await report({ account: a, dir: "out" });
    expect([out.n, out.balance]).toEqual([2, -60]); expect(out.filters).toContain("ចលនា: ឥណទាន (ចេញ)");
    const manual = await report({ account: a, sources: "manual" });
    expect([manual.n, manual.balance]).toEqual([1, 10]); expect(manual.filters).toContain("ប្រភេទប្រតិបត្តិការ: ដោយដៃ");
    const search = await report({ account: a, q: "dara" });
    expect([search.n, search.balance]).toEqual([2, 60]);
    const both = await report({ account: a, party: kim, dir: "in" });
    expect([both.n, both.balance]).toEqual([1, 100]);
    const ar = await id("12002");
    const zone = await report({ account: ar, zone: "outside" });
    expect([zone.n, zone.balance]).toEqual([2, 20]); expect(zone.filters).toContain("តំបន់: ក្រៅបុរី");
    expect((await report({ account: ar, paystatus: "paid" })).balance).toBe(0); // the inside invoice, paid in full
    const st = await id("13110"), item = (await facets(cfo, { account: st })).json.items[0].id as string;
    expect((await report({ account: st, items: item })).n).toBe(1);
    const sup = (await facets(cfo, { account: await id("20003") })).json.parties.find((p: any) => p.kind === "supplier");
    expect(sup?.name).toBe("ហាង ខ"); // the receipt owes on «other suppliers»
    expect((await report({ account: await id("20003"), party: sup.token, paystatus: "unpaid" })).n).toBe(1);
    expect((await report({ account: a, party: "x.bad" })).status).toBe(400);
    expect((await report({ account: a, dir: "sideways" })).status).toBe(400);
  });
});
