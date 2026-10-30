// Client 25-10 batch: D-165 the chart's stock codes by product and brand (sub codes = account + 2 digits) and the in-place update
// of a shop still on the 23-10 codes · D-166 opening balances on any other balance-sheet account · D-167 a purchase paid in part (the
// rest owed), the supplier's invoice number, paying a supplier later in $ / ៛, what is owed per supplier · D-168 the income statement
// in four columns with the gross profit.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql, tx } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { updateChartV2, V1_TO_V2 } from "../src/services/chart.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client;
let today: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string) => (await sql<{ id: string; sub_codes: boolean; is_active: boolean; name_km: string }[]>`select id, sub_codes, is_active, name_km from accounts where company_id = ${s.a} and code = ${code}`)[0]!;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200); // the chart
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-165 the chart of 25-10", () => {
  it("a shop still on the 23-10 codes is moved in place: accounts keep their ids and movements, items are re-coded, the generic 13001 is kept switched off", async () => {
    // put the shop back on the 23-10 codes (as One Team's live shop is): the reverse of the map, plus the old generic AC account with a movement
    for (const [code, acc] of [["134001", "13400"], ["135003", "13500"]] as const) expect((await ceo.req("POST", "/api/catalog", { name_km: `item ${code}`, kind: "product", category: "mep", unit: "m", sell_price: 100, code, inventory_account_id: (await account(acc)).id })).status).toBe(200);
    await tx(null, async (t) => {
      for (const [v1, v2] of [...V1_TO_V2].reverse()) await t`update accounts set code = ${v1} where company_id = ${s.a} and code = ${v2}`;
      await t`update catalog_items set code = '14001' where company_id = ${s.a} and code = '134001'`;
      await t`update catalog_items set code = '15003' where company_id = ${s.a} and code = '135003'`;
      await t`delete from accounts where company_id = ${s.a} and code in ('13110', '13120', '13130', '13210', '13220', '13230', '13310', '13320', '13330', '13810', '13820', '13830')`;
      await t`insert into accounts (company_id, code, name_km, name_en, type, is_group, parent_code, sub_codes) values (${s.a}, '13001', 'ម៉ាស៊ីនត្រជាក់', 'Air conditioners', 'asset', false, '13000', false)`;
    });
    const a13001 = await account("13001");
    const ac = (await sql<{ id: string }[]>`insert into catalog_items (company_id, code, name_km, kind, category, unit, is_stock, track_stock, inventory_account_id) values (${s.a}, '13001', 'ម៉ាស៊ីនត្រជាក់', 'product', 'mep', 'គ្រឿង', true, true, ${a13001.id}) returning id`)[0]!.id;
    expect((await inv(admin, "/in", { item_id: ac, qty: 1, total: 25000, pay: "aba" })).status).toBe(200); // a movement on the old account
    const copperId = (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = '14000'`)[0]!.id;
    const dry = await tx(null, (t) => updateChartV2(t, s.a, false));
    expect(dry.renamed.map((r) => `${r.from}>${r.to}`)).toEqual(expect.arrayContaining(["18000>14500", "13100>18000", "14000>13400", "13005>14400"]));
    expect(dry.added).toEqual(expect.arrayContaining(["13110", "13830"]));
    expect(dry.recoded).toEqual(expect.arrayContaining([{ from: "14001", to: "1340001" }, { from: "15003", to: "1350003" }]));
    expect(dry.kept).toEqual(["13001"]);
    expect((await account("14000")).id).toBe(copperId); // nothing written by a dry run
    await tx(null, (t) => updateChartV2(t, s.a, true));
    expect((await account("13400")).id).toBe(copperId); // the same row, a new code
    expect(await account("14000")).toBeUndefined(); // eslint-disable-line
    expect((await account("14500")).sub_codes).toBe(true); expect((await account("18000")).name_km).toContain("Second hand");
    expect((await sql<{ c: string }[]>`select code as c from catalog_items where id = ${ac}`)[0]!.c).toBe("13001");
    expect(await account("13001")).toMatchObject({ is_active: false }); expect((await account("13001")).name_km).toContain("មុន ២៥-១០");
    expect((await sql<{ n: number }[]>`select count(*)::int as n from catalog_items where company_id = ${s.a} and code in ('1340001', '1350003')`)[0]!.n).toBe(2);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from stock_moves where item_id = ${ac}`)[0]!.n).toBe(1); // the movement stays
    const again = await tx(null, (t) => updateChartV2(t, s.a, true));
    expect(again.already).toBe(true); // idempotent
  });

  it("the cost account: every stock account → 50001 (AC, copper …), only the technicians' consumables of 14500 → 50005 (D-175)", async () => {
    expect((await acc(cfo, "/opening", { date: today, cash_usd: 500000 })).status).toBe(200); // the books start → stock moves post
    const ac = (await inv(admin, "/in", { name: "Daikin 2 HP", account_id: (await account("13220")).id, qty: 1, total: 40000, pay: "cash_usd" })).json;
    expect(ac.item_id).toBeTruthy();
    expect((await sql<{ c: string }[]>`select code as c from catalog_items where id = ${ac.item_id}`)[0]!.c).toBe("132201"); // D-197: 6 digits
    expect((await inv(admin, "/out", { item_id: ac.item_id, qty: 1, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect(await bal("50001")).toBe(40000);
    const pipe = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${s.a} and code = '1340001'`)[0]!.id;
    expect((await inv(admin, "/in", { item_id: pipe, qty: 10, unit_cost: 200, pay: "cash_usd" })).status).toBe(200);
    expect((await inv(admin, "/out", { item_id: pipe, qty: 4, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect(await bal("50001")).toBe(40000 + 800); expect(await bal("50005")).toBe(0); expect(await bal("13400")).toBe(1200);
  });
});

describe("D-167 suppliers: paid in part, the invoice number, paying later, what is owed", () => {
  it("a purchase of $100 paid $30 by ABA → $70 owed to the supplier (an AC: 20001, D-175); the supplier's invoice number on the move and the card; a credit purchase owes everything", async () => {
    const aba0 = await bal("11003"); // the Daikin of the test above was paid by ABA too
    const r = await inv(admin, "/in", { name: "LG 1 HP", account_id: (await account("13310")).id, qty: 2, total: 10000, pay: "aba", paid: 3000, supplier: "ហាង A", supplier_invoice: "INV-A-77", supplier_kind: "ac" }); // D-178: an AC supplier
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ total: 10000, paid: 3000, owed: 7000 });
    expect(await bal("20001")).toBe(-7000); expect((await bal("11003")) - aba0).toBe(-3000); // Cr payable 70, Cr ABA 30, Dr stock 100
    expect((await inv(admin, "/in", { item_id: r.json.item_id, qty: 1, total: 5000, pay: "credit", supplier: "ហាង A", supplier_invoice: "INV-A-78" })).json).toMatchObject({ paid: 0, owed: 5000 });
    expect((await inv(admin, "/in", { item_id: r.json.item_id, qty: 1, total: 5000, pay: "aba", paid: 6000, supplier: "ហាង A" })).json.error).toBe("PAID_OVER_TOTAL");
    expect((await inv(admin, "/in", { item_id: r.json.item_id, qty: 1, total: 5000, pay: "aba", paid: 1000 })).json.error).toBe("SUPPLIER_REQUIRED");
    const card = (await inv(admin, `/card?item=${r.json.item_id}&from=${today}&to=${today}`)).json;
    expect(card.rows.find((x: any) => x.supplier_invoice === "INV-A-77")).toMatchObject({ paid: "3000" });
    const list = (await inv(admin, "/payables")).json as any[];
    expect(list.find((p) => p.supplier === "ហាង A")).toMatchObject({ owed: 12000, purchases: 2, invoices: expect.arrayContaining(["INV-A-77", "INV-A-78"]) });
  });

  it("paying the supplier: $50 by ACLEDA and 100,000 ៛ cash → owed goes down, posted Dr 20001 (what the supplier is owed for ACs) / Cr the method; a technician may not; the method must match the currency", async () => {
    expect((await inv(admin, "/supplier-pay", { supplier: "ហាង A", amount: 5000, currency: "usd", method: "acleda", date: today, note: "ផ្នែកទី ១" })).json).toMatchObject({ usd_cents: 5000, owed: 7000 });
    expect((await inv(admin, "/supplier-pay", { supplier: "ហាង A", amount: 100000, currency: "khr", method: "cash_khr", date: today })).json).toMatchObject({ usd_cents: 2500, owed: 4500 });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from supplier_payments where company_id = ${s.a}`)[0]!.n).toBe(2); // one row per payment
    expect(((await inv(admin, "/payables")).json as any[]).find((p) => p.supplier === "ហាង A")).toMatchObject({ owed: 4500, paid: 7500, purchases: 2 });
    expect((await inv(admin, "/supplier-pay", { supplier: "ហាង A", amount: 1000, currency: "khr", method: "cash_usd", date: today })).json.error).toBe("BAD_METHOD");
    expect(await bal("20001")).toBe(-4500); expect(await bal("20003")).toBe(0); expect(await bal("11002")).toBe(-5000); expect(await bal("11004")).toBe(-2500);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where company_id = ${s.a} and source = 'supplier_pay'`)[0]!.n).toBe(2);
    const kim = await loginAs(app, "kim");
    expect((await kim.req("POST", "/api/inventory/supplier-pay", { supplier: "ហាង A", amount: 100, currency: "usd", method: "aba", date: today })).status).toBe(403);
    expect(((await inv(admin, "/payables")).json as any[]).find((p) => p.supplier === "ហាង A")).toMatchObject({ owed: 4500, paid: 7500 });
  });
});

describe("D-168 the income statement in four columns", () => {
  it("current period · the whole month before · the fiscal year to the end of that month · the fiscal year to date; revenue − 50001 = gross profit; the CSV carries the four columns", async () => {
    const is = (await acc(cfo, `/income-statement?from=${today.slice(0, 8)}01&to=${today}`)).json;
    expect(is.columns.current).toEqual({ from: `${today.slice(0, 8)}01`, to: today });
    expect(is.columns.last.to < is.columns.current.from).toBe(true);
    expect(is.columns.ytd.from <= is.columns.current.from && is.columns.ytd.to === today).toBe(true);
    expect(is.cogs.find((r: any) => r.code === "50001")).toMatchObject({ amount: 40800, ytd: 40800 }); // D-175: the copper too
    expect(is.expense.find((r: any) => r.code === "50005")?.amount ?? 0).toBe(0);
    expect(is.totals.gross.amount).toBe(is.totals.income.amount - 40800);
    expect(is.totals.net.amount).toBe(is.totals.gross.amount - is.totals.expense.amount);
    expect(is.net).toBe(is.totals.net.amount); expect(is.expense_total).toBe(40800);
    expect(is.previous).toMatchObject({ from: is.columns.last.from, to: is.columns.last.to });
    const csv = await app.inject({ method: "GET", url: `/api/accounting/income-statement.csv?from=${today.slice(0, 8)}01&to=${today}`, headers: { cookie: cfo.cookie! } });
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain("GROSS PROFIT"); expect(csv.body.split("\n")[0]).toContain("year to date");
  });
});

describe("D-166 opening balances on any other balance-sheet account", () => {
  it("a second shop: capital 30001, customer deposits 20004 and staff advances 12001 enter with the balances; a P&L account or a group is refused", async () => {
    const ceoB = await loginAs(app, "ceo_b");
    const cfoB = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
      values (${s.b}, 'cfo_b', 'CFO B', 'cfo', '+85512000901', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
    expect(cfoB).toBeTruthy();
    const c = await loginAs(app, "cfo_b");
    expect((await acc(c, "/accounts")).status).toBe(200);
    expect((await c.req("PUT", "/api/accounting/opening/draft", { date: today, cash_usd: 100000, others: [{ code: "30001", amount: 80000 }, { code: "20004", amount: 5000 }, { code: "12001", amount: 2000 }] })).status).toBe(200);
    expect((await acc(c, "/opening", { date: today, cash_usd: 100000, others: [{ code: "40001", amount: 1 }] })).json.error).toBe("NOT_BS_ACCOUNT");
    expect((await acc(c, "/opening", { date: today, cash_usd: 100000, others: [{ code: "30000", amount: 1 }] })).json.error).toBe("NOT_BS_ACCOUNT");
    const r = await acc(c, "/opening", { date: today, cash_usd: 100000, others: [{ code: "30001", amount: 80000 }, { code: "20004", amount: 5000 }, { code: "12001", amount: 2000 }] });
    expect(r.status).toBe(200);
    const b = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id where a.company_id = ${s.b} and a.code = ${code}`)[0]!.b);
    expect(await b("11001")).toBe(100000); expect(await b("30001")).toBe(-80000); expect(await b("20004")).toBe(-5000); expect(await b("12001")).toBe(2000);
    expect(await b("30004")).toBe(-(100000 + 2000 - 80000 - 5000)); // opening equity balances the rest
    void ceoB;
  });
});
