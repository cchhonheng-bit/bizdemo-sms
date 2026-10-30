// D-180 the trial balance shows each account's net on one side (the client's own sample) · D-181 the debt account is chosen where a debt
// is recorded or cleared, and the debt list comes from the books · D-182 the CEO retires an account in use: keep the amounts (they move to
// another account) or remove them (a mistake reversed — history kept); everyone else is refused.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client;
let today: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const id = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const tbDiff = async () => Number((await sql<{ d: string }[]>`select (coalesce(sum(debit_cents), 0) - coalesce(sum(credit_cents), 0))::text as d from journal_lines where company_id = ${s.a}`)[0]!.d);

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  // the books start as One Team's did on 28-10: cash, and an AC supplier's opening debt on the account picked for it (D-181)
  const r = await acc(cfo, "/opening", { date: today, cash_usd: 1000000, payables: [{ supplier: "Lim Nguon", amount: 150000, account_id: await id("20001") }] });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-180 the trial balance shows each account's net on one side", () => {
  it("cash $10,000 in and $3,310 out this month → the month's pair shows $6,690 debit only; every pair balances; the COA «Trial Balance» sheet too", async () => {
    expect((await acc(cfo, "/transactions", { date: today, type: "expense", amount: 331000, pay: "cash_usd", account_code: "50011" })).status).toBe(200);
    const tb = (await acc(cfo, `/trial-balance?month=${today.slice(0, 7)}`)).json;
    expect(tb.rows.find((r: any) => r.code === "11001").period).toEqual({ debit: 669000, credit: 0 });
    expect(tb.balanced).toBe(true);
    const x = await app.inject({ method: "GET", url: `/api/export/coa.xlsx?from=${today.slice(0, 8)}01&to=${today}&asof=${today}`, headers: { cookie: cfo.cookie! } });
    expect(x.statusCode).toBe(200);
    const row = readWorkbook(x.rawPayload)[0]!.rows.find((r) => r[2] === "11001")!;
    expect([Number(row[4] ?? 0), Number(row[5] ?? 0)]).toEqual([6690, 0]);
  });
});

describe("D-181 the debt account is chosen where a debt is recorded or cleared", () => {
  it("opening debt on the account picked; a credit receipt on its pick, the same supplier's next one there too; a credit purchase in Money on its pick; a non-debt account refused", async () => {
    expect(await bal("20001")).toBe(-150000);
    const ac = await id("13110"), d2 = await id("20002");
    expect((await inv(admin, "/in", { name: "Panasonic 1.5 HP", account_id: ac, qty: 2, total: 96000, pay: "credit", supplier: "Lim Ngoun", payable_account_id: d2 })).status).toBe(200);
    expect(await bal("20002")).toBe(-96000);
    expect((await inv(admin, "/in", { name: "Panasonic 1 HP", account_id: ac, qty: 1, total: 46000, pay: "credit", supplier: "lim ngoun " })).status).toBe(200); // as last time
    expect(await bal("20002")).toBe(-142000);
    expect((await inv(admin, "/in", { name: "x", account_id: ac, qty: 1, total: 100, pay: "credit", supplier: "S", payable_account_id: await id("11001") })).json.error).toBe("NOT_DEBT_ACCOUNT");
    expect((await acc(cfo, "/transactions", { date: today, type: "purchase", amount: 5000, pay: "credit", account_code: "50004", supplier: "Wire shop", debt_account_id: await id("20003") })).status).toBe(200);
    expect(await bal("20003")).toBe(-5000);
    expect((await acc(cfo, "/transactions", { date: today, type: "purchase", amount: 5000, pay: "credit", account_code: "50004", supplier: "Wire shop", debt_account_id: await id("50004") })).json.error).toBe("NOT_DEBT_ACCOUNT");
  });

  it("paying clears the account picked («បង់» and Money); automatic = the supplier's open debts in account order; the debt list comes from the books, per account, spellings merged", async () => {
    const list0 = (await inv(admin, "/payables")).json as any[];
    expect(list0.find((p) => p.supplier.toLowerCase() === "lim ngoun")).toMatchObject({ owed: 142000, accounts: [expect.objectContaining({ code: "20002", owed: 142000 })] });
    expect(list0.find((p) => p.supplier === "Lim Nguon")).toMatchObject({ owed: 150000, opening: 150000, accounts: [expect.objectContaining({ code: "20001", owed: 150000 })] });
    expect((await inv(admin, "/supplier-pay", { supplier: "Lim Ngoun", amount: 50000, currency: "usd", method: "aba", date: today, account_id: await id("20002") })).json).toMatchObject({ owed: 92000 });
    expect(await bal("20002")).toBe(-92000);
    expect((await acc(cfo, "/transactions", { date: today, type: "supplier_payment", amount: 100000, pay: "acleda", supplier: "Lim Nguon", debt_account_id: await id("20001") })).status).toBe(200);
    expect(await bal("20001")).toBe(-50000);
    expect((await inv(admin, "/supplier-debts?supplier=lim%20nguon")).json).toEqual([expect.objectContaining({ code: "20001", owed: 50000 })]);
    expect((await inv(admin, "/supplier-pay", { supplier: "Lim Nguon", amount: 50000, currency: "usd", method: "cash_usd", date: today })).status).toBe(200); // automatic → 20001
    expect(await bal("20001")).toBe(0);
    const ln = ((await inv(admin, "/payables")).json as any[]).find((p) => p.supplier === "Lim Nguon");
    expect(ln).toMatchObject({ owed: 0, paid: 150000, accounts: [] });
    expect((await inv(admin, "/debt-accounts")).json.map((a: any) => a.code)).toEqual(expect.arrayContaining(["20001", "20002", "20003", "20004", "20005", "21001"]));
    expect(await tbDiff()).toBe(0);
  });
});

describe("D-182 the CEO retires an account in use", () => {
  const newStockAccount = async (code: string, name: string) => {
    const r = await acc(cfo, "/accounts", { code, name_km: name, type: "asset", sub_codes: true });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    return r.json.id as string;
  };

  it("keep the amounts: the balance moves to the account picked (one entry today), its item follows with a new code, the account is switched off; only the CEO", async () => {
    const a = await newStockAccount("13111", "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង Panasonic 1.0HP");
    const item = (await inv(admin, "/in", { name: "Panasonic 1.0HP", account_id: a, qty: 3, total: 150000, pay: "cash_usd", supplier: "Lim Nguon" })).json.item_id;
    expect((await sql<{ code: string }[]>`select code from catalog_items where id = ${item}`)[0]!.code).toBe("131111");
    // the old refusal stays for everybody, and the account form's «stop using» still answers ACCOUNT_IN_USE (the CEO's screen opens the confirm)
    expect((await acc(cfo, "/accounts", { id: a, code: "13111", name_km: "x", type: "asset", is_active: false })).json.error).toBe("ACCOUNT_IN_USE");
    const u = (await acc(ceo, `/accounts/${a}/usage`)).json;
    expect(u).toMatchObject({ code: "13111", balance: 150000, entries: { stock: 1 }, mappings: [], remove_blockers: [] });
    expect(u.items).toEqual([expect.objectContaining({ code: "131111", qty: 3, value: 150000 })]);
    const to = await id("13110"), before = await bal("13110");
    expect((await acc(cfo, `/accounts/${a}/retire`, { mode: "keep", target_id: to })).status).toBe(403);
    expect((await acc(ceo, `/accounts/${a}/retire`, { mode: "keep", target_id: await id("20001") })).json.error).toBe("BAD_TARGET_ACCOUNT"); // another type
    const r = await acc(ceo, `/accounts/${a}/retire`, { mode: "keep", target_id: to });
    expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json.result).toBe("off");
    expect([await bal("13111"), (await bal("13110")) - before]).toEqual([0, 150000]);
    expect((await sql<{ code: string; acc: string }[]>`select ci.code, a.code as acc from catalog_items ci join accounts a on a.id = ci.inventory_account_id where ci.id = ${item}`)[0]).toMatchObject({ acc: "13110" });
    expect((await sql<{ code: string }[]>`select code from catalog_items where id = ${item}`)[0]!.code).toMatch(/^1311\d{2}$/); // D-197: 13110 × 10 + n
    expect((await sql<{ a: boolean }[]>`select is_active as a from accounts where id = ${a}`)[0]!.a).toBe(false);
    expect(await sql`select 1 from journal_entries where company_id = ${s.a} and source = 'manual' and memo = '13111 → 13110'`).toHaveLength(1);
    expect(await tbDiff()).toBe(0);
  });

  it("remove the amounts (a mistake): the receipts are reversed — stock 0, the cash back, the debt gone, history kept; the account off; refused while mapped / in the opening; an unused account is deleted", async () => {
    const a = await newStockAccount("13112", "សាកល្បង");
    const it1 = (await inv(admin, "/in", { name: "Test AC", account_id: a, qty: 1, total: 30000, pay: "credit", supplier: "Oops", payable_account_id: await id("20003") })).json.item_id;
    expect((await inv(admin, "/in", { item_id: it1, qty: 1, total: 20000, pay: "cash_usd" })).status).toBe(200);
    const [cash0, ap0] = [await bal("11001"), await bal("20003")];
    const r = await acc(ceo, `/accounts/${a}/retire`, { mode: "remove" });
    expect(r.status, JSON.stringify(r.json)).toBe(200); expect(r.json).toMatchObject({ result: "off", reversed_moves: 2 });
    expect([await bal("13112"), (await bal("11001")) - cash0, (await bal("20003")) - ap0]).toEqual([0, 20000, 30000]);
    expect((await sql<{ q: string }[]>`select qty::text as q from stock_items where item_id = ${it1}`)[0]!.q).toBe("0.000");
    expect((await sql<{ n: number }[]>`select count(*)::int as n from stock_moves where item_id = ${it1}`)[0]!.n).toBe(4); // 2 + their mirrors
    expect((await sql<{ a: boolean }[]>`select is_active as a from catalog_items where id = ${it1}`)[0]!.a).toBe(false);
    const blocked = await acc(ceo, `/accounts/${await id("11001")}/retire`, { mode: "remove" });
    expect(blocked.json.error).toBe("ACCOUNT_REMOVE_BLOCKED");
    expect(blocked.json.details.blockers).toEqual(expect.arrayContaining(["map:cash_usd", "source:opening"]));
    const spare = await newStockAccount("13113", "ទទេ");
    expect((await acc(ceo, `/accounts/${spare}/retire`, { mode: "keep", target_id: await id("13110") })).json.result).toBe("deleted");
    expect(await sql`select 1 from accounts where id = ${spare}`).toHaveLength(0);
    expect(await tbDiff()).toBe(0);
  });
});
