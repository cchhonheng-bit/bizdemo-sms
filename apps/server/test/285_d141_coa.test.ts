// D-141 (CEO 12-10): One Team's own chart of accounts (COA.xlsx) — tests first: the chart (groups never posted to, the client's Khmer
// names, BS / P&L by the code, nameless rows skipped), the system accounts mapped to the client's codes, accounts the system adds
// flagged, revenue split by the borey (40004 / 40005 inside, 40001 / 40002 outside, 40006 other income), each stock item on its own
// stock account (materials used → 50005, goods sold → 50001), the trial balance still balances, the replace only on empty books.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql, tx } from "../src/db.js";
import { CHART, replaceChart, STOCK_ITEMS } from "../src/services/chart.js";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client;
let inside: string, outside: string, today: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const code = async (c: string, company = s.a) => (await sql<{ id: string; name_km: string; role: string | null; is_group: boolean; parent_code: string | null; added_by_system: boolean; type: string }[]>`
  select id, name_km, role, is_group, parent_code, added_by_system, type::text as type from accounts where company_id = ${company} and code = ${c}`)[0]!;
const bal = async (c: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${c}`)[0]!.b);
const invoice = async (customer: string, lines: { kind: "service" | "product"; qty: number; unit_price: number; catalog_item_id?: string }[]) => {
  const id = (await admin.req("POST", "/api/invoices", { customer_id: customer, lines: lines.map((l) => ({ description: "x", unit: "unit", ...l })) })).json.id as string;
  expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
  return id;
};

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "accounting,inventory";
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin");
  await sql`update users set role = 'cfo' where id = ${s.users.gm01!}`; // a CFO for the accounting screens (the GM user stands in)
  cfo = await loginAs(app, "gm01");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  inside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី", phones: ["012 111 222"], zone: "inside" })).json.id;
  outside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្រៅបុរី", phones: ["012 111 333"], zone: "outside" })).json.id;
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-141 the chart", () => {
  it("One Team's chart: 10 group headers, posting accounts, the client's Khmer names exactly, nameless rows skipped, BS / P&L by the code", async () => {
    const list = (await acc(cfo, "/accounts")).json as any[];
    expect(list.filter((a) => a.is_group).map((a) => a.code)).toEqual(["10000", "11000", "12000", "13000", "13100", "20000", "21000", "30000", "40000", "50000"]);
    expect(list.map((a) => a.code)).toEqual(CHART.map((r) => r[0]));
    for (const skipped of ["13006", "13007", "13008", "13105", "13106", "16001", "14001", "40003"]) expect(list.find((a) => a.code === skipped)).toBeUndefined();
    expect(list.find((a) => a.code === "11001").name_km).toBe("សាច់ប្រាក់នៅបេលា");
    expect(list.find((a) => a.code === "12000").name_km).toBe(CHART.find((r) => r[0] === "12000")![1]); // as in the file (a zero-width space inside)
    expect(list.find((a) => a.code === "12000").name_km).toContain("គេជំពាក់យើង");
    expect(list.find((a) => a.code === "40005").name_km).toBe("ចំណូលពីការសេវាកម្ម (ក្នុងបូរី)");
    expect(list.find((a) => a.code === "18000").name_km).toBe("សម្ភារះសម្រាប់ជាងប្រប្រាស់");
    for (const a of list) expect(a.statement).toBe(Number(a.code[0]) <= 3 ? "BS" : "PL");
    expect(Object.fromEntries(list.filter((a) => ["11001", "13101", "14000", "21001", "50005"].includes(a.code)).map((a) => [a.code, a.parent_code])))
      .toEqual({ "11001": "11000", "13101": "13100", "14000": "10000", "21001": "21000", "50005": "50000" });
  });

  it("system accounts on the client's codes; what the client's chart lacks is added with a free code and flagged «បន្ថែមដោយប្រព័ន្ធ»", async () => {
    const role = async (r: string) => (await sql<{ code: string }[]>`select code from accounts where company_id = ${s.a} and role = ${r}`)[0]?.code;
    const want: Record<string, string> = { cash_usd: "11001", bank_aba: "11003", bank_acleda: "11002", ar: "12002", staff_advance: "12001", inventory: "18000", deposits: "20004", tips: "20005",
      current_profit: "30002", retained: "30003", cogs: "50001", salaries: "50002", materials: "50005", rev_sales: "40001", rev_service: "40002", rev_sales_inside: "40004",
      rev_service_inside: "40005", rev_other: "40006", ap: "20003", capital: "30001",
      cash_khr: "11004", payroll: "21002", opening: "30004", drawings: "30005", discount: "40007", stock_adjust: "50012", cash_diff: "50013" };
    for (const [r, c] of Object.entries(want)) expect(await role(r), r).toBe(c);
    const added = (await sql<{ code: string }[]>`select code from accounts where company_id = ${s.a} and added_by_system order by code`).map((x) => x.code);
    expect(added).toEqual(["11004", "21002", "30004", "30005", "40007", "50012", "50013"]);
    expect((await code("11001")).added_by_system).toBe(false);
  });

  it("a group header takes no entry (manual journal, other transaction, the database itself); groups stay as they are", async () => {
    expect((await acc(cfo, "/opening", { date: today, cash_usd: 100000 })).status).toBe(200); // the books start
    const [grp, cash] = [await code("11000"), await code("11001")];
    expect((await acc(cfo, "/journal", { date: today, memo: "x", lines: [{ account_id: grp.id, debit: 100 }, { account_id: cash.id, credit: 100 }] })).json.error).toBe("ACCOUNT_IS_GROUP");
    expect((await acc(cfo, "/transactions", { date: today, type: "expense", account_code: "50000", amount: 100, pay: "cash_usd" })).json.error).toBe("ACCOUNT_IS_GROUP");
    await expect(sql`insert into journal_lines (entry_id, company_id, account_id, debit_cents, credit_cents) select id, company_id, ${grp.id}, 1, 0 from journal_entries where company_id = ${s.a} limit 1`)
      .rejects.toThrow(/ACCOUNT_IS_GROUP/);
    expect((await acc(cfo, "/accounts", { id: grp.id, code: "11900", name_km: "x", type: "asset" })).json.error).toBe("SYSTEM_ACCOUNT");
    expect((await admin.req("DELETE", `/api/accounting/accounts/${grp.id}`)).json.error).toBe("SYSTEM_ACCOUNT");
    const n = await acc(cfo, "/accounts", { code: "50014", name_km: "ចំណាយសាំង", name_en: "Fuel", type: "expense" });
    expect(n.status).toBe(200);
    expect((await code("50014")).parent_code).toBe("50000");
  });
});

describe("D-141 postings on the new codes", () => {
  it("revenue: a customer inside a borey → 40005 service / 40004 sales; outside → 40002 / 40001; other income → 40006", async () => {
    const before = await Promise.all(["40001", "40002", "40004", "40005", "40006", "12002"].map(bal));
    await invoice(inside, [{ kind: "service", qty: 1, unit_price: 10000 }, { kind: "product", qty: 2, unit_price: 2500 }]);
    await invoice(outside, [{ kind: "service", qty: 1, unit_price: 3000 }, { kind: "product", qty: 1, unit_price: 700 }]);
    expect((await acc(cfo, "/transactions", { date: today, type: "other_income", amount: 1200, pay: "aba" })).status).toBe(200);
    const after = await Promise.all(["40001", "40002", "40004", "40005", "40006", "12002"].map(bal));
    expect(after.map((x, i) => x - before[i]!)).toEqual([-700, -3000, -5000, -10000, -1200, 18700]);
  });

  it("each stock item on its own stock account: stock in → 14000; materials (14000–18000) cost 50005 on a job AND on a direct sale (D-143); no account → 18000", async () => {
    const pipeAcc = await code("14000");
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, inventory_account_id: (await code("50001")).id })).json.error).toBe("NOT_STOCK_ACCOUNT");
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, inventory_account_id: (await code("13000")).id })).json.error).toBe("NOT_STOCK_ACCOUNT");
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, inventory_account_id: pipeAcc.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT"); // D-142: 14001 …
    const pipe = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់ 10mm", kind: "product", category: "mep", unit: "m", sell_price: 500, code: "14001", inventory_account_id: pipeAcc.id })).json.id;
    const tape = (await ceo.req("POST", "/api/catalog", { name_km: "ស្កុតបិទ", kind: "product", category: "mep", unit: "pcs", sell_price: 100 })).json.id;
    for (const i of [pipe, tape]) expect((await admin.req("POST", `/api/inventory/items/${i}/track`, { track: true })).status).toBe(200);
    const wh = ((await admin.req("GET", "/api/inventory/locations")).json as any[]).find((l) => l.kind === "warehouse").id;
    const b0 = await Promise.all(["14000", "18000", "50005", "50001", "11001"].map(bal));
    expect((await admin.req("POST", "/api/inventory/in", { item_id: pipe, location_id: wh, qty: 20, unit_cost: 200, pay: "cash_usd" })).status).toBe(200);
    expect((await admin.req("POST", "/api/inventory/in", { item_id: tape, location_id: wh, qty: 10, unit_cost: 50, pay: "cash_usd" })).status).toBe(200);
    // a job uses 3 m of pipe (confirmed by the Admin)
    const job = (await admin.req("POST", "/api/bookings", { customer_id: inside, type: "A", category: "mep", service_text: "ដំឡើង", zone: "inside", ...span(new Date(Date.now() + 50 * 3600_000).toISOString()) })).json.id;
    await sql`insert into booking_materials (booking_id, catalog_item_id, qty) values (${job}, ${pipe}, 3)`;
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    for (const st of ["on_site", "work_done"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    expect((await admin.req("POST", `/api/inventory/jobs/${job}/confirm`, { location_id: wh })).status).toBe(200);
    // a direct sale of 2 m of pipe
    await invoice(outside, [{ kind: "product", qty: 2, unit_price: 500, catalog_item_id: pipe }]);
    const b1 = await Promise.all(["14000", "18000", "50005", "50001", "11001"].map(bal));
    expect(b1.map((x, i) => x - b0[i]!)).toEqual([4000 - 600 - 400, 500, 600 + 400, 0, -4500]); // D-143: copper pipe → 50005 wherever it leaves
  });

  it("the trial balance balances; group headers never appear in it; the balance sheet shows the year's profit on 30002", async () => {
    const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    expect(tb.balanced).toBe(true);
    expect(tb.total_debit).toBe(tb.total_credit);
    expect(tb.rows.some((r: any) => ["10000", "11000", "40000", "50000"].includes(r.code))).toBe(false);
    const bs = (await acc(cfo, `/balance-sheet?to=${today}`)).json;
    expect(bs.assets_total).toBe(bs.liabilities_total + bs.equity_total + bs.current_earnings);
    expect(bs.current_earnings_account).toMatchObject({ code: "30002", name_km: CHART.find((r) => r[0] === "30002")![1] });
  });
});

describe("D-141 chart-replace", () => {
  it("only on empty books: the old chart goes, this one comes, Sheet2's copper pipe / insulation sizes become stock items on 14000 / 15000", async () => {
    await expect(tx(null, (t) => replaceChart(t, s.a, false))).rejects.toThrow(/BOOKS_IN_USE/);
    // company B still has the old template (D-88) and no entry
    const old = [["1010", "សាច់ប្រាក់ក្នុងដៃ (ដុល្លារ)", "asset", "cash_usd"], ["4010", "ចំណូលសេវាកម្ម", "income", "rev_service"], ["6030", "សាំង", "expense", null]] as const;
    for (const [c, n, t, r] of old) await sql`insert into accounts (company_id, code, name_km, type, role) values (${s.b}, ${c}, ${n}, ${t}::account_type, ${r})`;
    const svcB = (await sql<{ id: string }[]>`insert into catalog_items (company_id, name_km, kind, category, unit, income_account_id) values (${s.b}, 'សេវា', 'service', 'mep', 'unit',
      (select id from accounts where company_id = ${s.b} and code = '4010')) returning id`)[0]!.id;
    const plan = await tx(null, (t) => replaceChart(t, s.b, false));
    expect(plan.remove.map((a) => a.code)).toEqual(["1010", "4010", "6030"]);
    expect(plan.added_by_system).toHaveLength(7);
    expect((await sql`select count(*)::int as n from accounts where company_id = ${s.b}`)[0]!.n).toBe(3); // a dry run writes nothing
    await tx(null, (t) => replaceChart(t, s.b, true));
    const codes = (await sql<{ code: string }[]>`select code from accounts where company_id = ${s.b} order by code`).map((x) => x.code);
    expect(codes).toEqual(CHART.map((r) => r[0]));
    expect((await sql`select income_account_id from catalog_items where id = ${svcB}`)[0]!.income_account_id).toBeNull();
    const items = await sql<{ code: string; name_km: string; track_stock: boolean; acc: string }[]>`select ci.code, ci.name_km, ci.track_stock, a.code as acc
      from catalog_items ci join accounts a on a.id = ci.inventory_account_id where ci.company_id = ${s.b} order by ci.code`;
    expect(items.filter((i) => /^1[45]/.test(i.code)).map((i) => [i.code, i.name_km, i.acc])).toEqual(STOCK_ITEMS.map(([c, n, a]) => [c, n, a]));
    expect(items.filter((i) => /^13/.test(i.code)).map((i) => i.code)).toEqual(["13001", "13002", "13003", "13004", "13005", "13101", "13102", "13103", "13104"]); // D-142: the account IS the item
    expect(items.every((i) => i.track_stock && i.acc === (i.code.startsWith("13") ? i.code : i.code.slice(0, 2) + "000"))).toBe(true);
    expect(items.find((i) => i.code === "14001")!.name_km).toBe("ទុយោស្ពាន់ 16mm (16*0.72)");
    await tx(null, (t) => replaceChart(t, s.b, true)); // again: idempotent (items linked, not doubled)
    expect((await sql`select count(*)::int as n from catalog_items where company_id = ${s.b} and code like '1%'`)[0]!.n).toBe(23);
  });
});
