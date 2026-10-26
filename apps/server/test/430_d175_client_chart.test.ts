// D-175 (client 26-10): One Team's chart exactly as the client listed it — names verbatim, the accounts the system had added switched off
// (never deleted; a balance moves with ONE dated reclass entry), every automatic posting on the client's accounts (KHR cash 11001, payroll
// 21001, opening / drawings 30001, discounts 50012, count / cash differences 50011, AC payables 20001, washing machines 20002, the rest
// 20003, every stock but 14500 → cost 50001), the old 13001 item → 13110, 14100–14500 under 13000, the COA export's headers rolled up.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql, tx } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";
import type { SessionUser } from "../src/services/auth.js";
import { roleIds, saveOpening } from "../src/services/accounting.js";
import { CLIENT_V3, clientChartV3 } from "../src/services/chart-replace.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client;
let today: string;
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const account = async (code: string, company = s.a) => (await sql<{ id: string; is_active: boolean; role: string | null; parent_code: string | null }[]>`
  select id, is_active, role, parent_code from accounts where company_id = ${company} and code = ${code}`)[0]!;
const bal = async (code: string, company = s.a) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b
  from journal_lines l join accounts a on a.id = l.account_id where a.company_id = ${company} and a.code = ${code}`)[0]!.b);
const tbDiff = async (company = s.a) => Number((await sql<{ d: string }[]>`select (coalesce(sum(debit_cents), 0) - coalesce(sum(credit_cents), 0))::text as d from journal_lines where company_id = ${company}`)[0]!.d);
const asUser = (id: string, companyId: string) => ({ id, companyId, role: "ceo", username: "support", fullName: "HangKH Support", mustChangePassword: false, language: "km", sessionId: "test" }) as SessionUser;

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

describe("D-175 the client's chart of 26-10", () => {
  let old = "";
  it("chart-v3 on a shop like the live one (books not started): a dry run writes nothing; names verbatim; the accounts off the list switched off, none deleted; postings re-pointed; the old 13001 item → 1311001; idempotent", async () => {
    // as live: the generic AC account 13001 (switched off on 25-10) with an item and two receipts, the client's own 50014, a zero-width space in 12000
    const a13001 = (await sql<{ id: string }[]>`insert into accounts (company_id, code, name_km, name_en, type, is_group, parent_code, sub_codes)
      values (${s.a}, '13001', 'ម៉ាស៊ីនត្រជាក់', 'Air conditioners', 'asset', false, '13000', false) returning id`)[0]!.id;
    old = (await sql<{ id: string }[]>`insert into catalog_items (company_id, code, name_km, kind, category, unit, is_stock, track_stock, inventory_account_id)
      values (${s.a}, '13001', 'ម៉ាស៊ីនត្រជាក់', 'product', 'mep', 'គ្រឿង', true, true, ${a13001}) returning id`)[0]!.id;
    expect((await inv(admin, "/in", { item_id: old, qty: 1, total: 50000, pay: "cash_usd" })).status).toBe(200);
    expect((await inv(admin, "/in", { item_id: old, qty: 1, total: 45000, pay: "cash_usd" })).status).toBe(200);
    await sql`update accounts set is_active = false, name_km = 'ម៉ាស៊ីនត្រជាក់ (មុន ២៥-១០)' where id = ${a13001}`;
    expect((await acc(cfo, "/accounts", { code: "50014", name_km: "បញ្ចុះតម្លៃ", type: "expense" })).status).toBe(200);
    await sql`update accounts set name_km = ${"គណនីត្រូវទទូលបាន​(គេជំពាក់យើង)"} where company_id = ${s.a} and code = '12000'`;
    const before = (await sql<{ n: number }[]>`select count(*)::int as n from accounts where company_id = ${s.a}`)[0]!.n;
    const u = asUser(s.users.ceo!, s.a);

    const dry = await tx(null, (t) => clientChartV3(t, u, false));
    expect(dry.created).toEqual([]);
    expect(dry.renamed.map((r) => r.code)).toEqual(["12000", "50012"]);
    expect(dry.off.map((o) => `${o.code}>${o.to}`)).toEqual(["11004>11001", "21002>21001", "30004>30001", "30005>30001", "40007>50012", "50013>50011", "50014>50012"]);
    expect(dry.items).toEqual([expect.objectContaining({ code: "13001", to_code: "1311001", from: "13001", account: "13110", qty: 2, value: 95000 })]);
    expect(dry.roles.map((r) => `${r.role}:${r.from}>${r.to}`)).toEqual(expect.arrayContaining(["discount:40007>50012", "stock_adjust:50012>50011", "payroll:21002>21001", "cash_khr:11004>null"]));
    expect(dry.reclass).toBeNull(); // no entry anywhere — nothing to move
    expect((await account("40007")).role).toBe("discount"); // a dry run writes nothing

    const plan = await tx(null, (t) => clientChartV3(t, u, true));
    expect(plan.reclass).toBeNull();
    const rows = await sql<{ code: string; name_km: string; is_active: boolean; is_group: boolean; added_by_system: boolean }[]>`
      select code, name_km, is_active, is_group, added_by_system from accounts where company_id = ${s.a} order by code`;
    expect(rows.length).toBe(before); // nothing deleted
    const active = rows.filter((r) => r.is_active);
    expect(active.map((r) => r.code)).toEqual(CLIENT_V3.map(([c]) => c).sort());
    for (const [code, km, group] of CLIENT_V3) expect(rows.find((r) => r.code === code), code).toMatchObject({ name_km: km, is_group: group, added_by_system: false });
    expect(Object.fromEntries(active.filter((r) => ["12000", "30002", "30003", "50011", "50012", "13830", "14400", "20002"].includes(r.code)).map((r) => [r.code, r.name_km]))).toEqual({
      "12000": "គណនីត្រូវទទូលបាន(គេជំពាក់យើង)", "30002": "ចំណេញ/ខាត(-) ក្នុងឆ្នាំ 2026", "30003": "ចំណេញ/ខាត(-) ខែមុន 2023 and 2024,2025", "50011": "ចំណាយផ្សេងៗ",
      "50012": "ចំណាយបញ្ចុះតម្លៃ", "13830": "ម៉ាស៊ីនត្រជាក់បញ្ឈរ Gree", "14400": "(ឆ្នាំងបាយ,កង្ហា,ម៉ាស៊ីនទឹកក្តៅទឹកត្រជាក់....)", "20002": "ជំពាក់ម៉ាស៊ីនបោកក់" }); // the client's list, verbatim
    expect(active.some((r) => r.name_km.includes("​"))).toBe(false);
    expect(active.filter((r) => r.is_group).map((r) => r.code)).toEqual(["10000", "11000", "12000", "13000", "18000", "20000", "21000", "30000", "40000", "50000"]);
    expect(rows.filter((r) => !r.is_active).map((r) => r.code)).toEqual(["11004", "13001", "21002", "30004", "30005", "40007", "50013", "50014"]);
    expect([(await account("14100")).parent_code, (await account("14500")).parent_code, (await account("18100")).parent_code]).toEqual(["13000", "13000", "18000"]);
    // every automatic posting
    const R = await roleIds(sql, s.a);
    const code = new Map((await sql<{ id: string; code: string }[]>`select id, code from accounts where company_id = ${s.a}`).map((a) => [a.id, a.code]));
    expect(Object.fromEntries(Object.entries(R).map(([r, id]) => [r, code.get(id)]))).toEqual({ cash_usd: "11001", cash_khr: "11001", bank_acleda: "11002", bank_aba: "11003",
      ar: "12002", staff_advance: "12001", inventory: "14500", ap_ac: "20001", ap_washing: "20002", ap: "20003", deposits: "20004", tips: "20005", payroll: "21001",
      capital: "30001", opening: "30001", drawings: "30001", current_profit: "30002", retained: "30003", rev_sales: "40001", rev_service: "40002", rev_sales_inside: "40004",
      rev_service_inside: "40005", rev_other: "40006", cogs: "50001", salaries: "50002", bonus: "50003", materials: "50005", stock_adjust: "50011", cash_diff: "50011", discount: "50012" });
    expect((await sql<{ code: string; acct: string; qty: string }[]>`select ci.code, a.code as acct, st.qty::text as qty from catalog_items ci join accounts a on a.id = ci.inventory_account_id
      join stock_items st on st.item_id = ci.id where ci.id = ${old}`)[0]).toMatchObject({ code: "1311001", acct: "13110", qty: "2.000" });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from stock_moves where item_id = ${old}`)[0]!.n).toBe(2); // the receipts stay
    expect((await tx(null, (t) => clientChartV3(t, u, true))).already).toBe(true); // idempotent
  });

  it("the books start on it (the live path): receipts and supplier payments saved before post on the right accounts — AC owed 20001 cleared by its 3 payments, washing machine 20002, copper 20003; copper → 50001, 14500 → 50005; trial balance 0; stock value = the stock accounts", async () => {
    const id = async (c: string) => (await account(c)).id;
    const ac = (await inv(admin, "/in", { name: "Gree 1.5 HP", account_id: await id("13820"), qty: 10, total: 100000, pay: "cash_usd", paid: 10000, supplier: "ABC", supplier_invoice: "ABC-1" })).json;
    expect(ac).toMatchObject({ total: 100000, paid: 10000, owed: 90000 });
    expect((await sql<{ c: string }[]>`select code as c from catalog_items where id = ${ac.item_id}`)[0]!.c).toBe("1382001");
    expect((await inv(admin, "/in", { name: "LG 8 kg", account_id: await id("14100"), qty: 1, total: 30000, pay: "credit", supplier: "WM Co" })).status).toBe(200);
    const pipe = (await inv(admin, "/in", { name: "ទុយោស្ពាន់ 10mm", account_id: await id("13400"), unit: "m", qty: 10, unit_cost: 200, pay: "credit", supplier: "Copper Co" })).json.item_id;
    const tape = (await inv(admin, "/in", { name: "ស្កុតបិទ", account_id: await id("14500"), unit: "pcs", qty: 10, unit_cost: 50, pay: "cash_usd" })).json.item_id;
    expect((await inv(admin, "/out", { item_id: pipe, qty: 4, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect((await inv(admin, "/out", { item_id: tape, qty: 2, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    // ABC paid as on live: 975,600 ៛ by ABA + $333 by ACLEDA + $323.10 cash = $900
    for (const p of [{ amount: 975600, currency: "khr", method: "aba" }, { amount: 33300, currency: "usd", method: "acleda" }, { amount: 32310, currency: "usd", method: "cash_usd" }])
      expect((await inv(admin, "/supplier-pay", { supplier: "ABC", date: today, ...p })).status).toBe(200);
    expect((await inv(admin, "/supplier-pay", { supplier: "WM Co", amount: 10000, currency: "usd", method: "aba", date: today })).status).toBe(200);
    expect(await tbDiff()).toBe(0); expect(await bal("13820")).toBe(0); // nothing posted before the start

    const r = await acc(cfo, "/opening", { date: today, cash_usd: 500000 });
    expect(r.status).toBe(200);
    expect(r.json.backlog).toMatchObject({ stock: 8, supplier_payments: 4, failed: 0 });
    expect(await bal("13110")).toBe(95000);   // the old 13001 receipts, now on 13110
    expect(await bal("13820")).toBe(100000);
    expect(await bal("20001")).toBe(0);       // −$900 owed for the ACs, cleared by the 3 payments
    expect(await bal("20002")).toBe(-20000);  // washing machine $300 − $100
    expect(await bal("20003")).toBe(-2000);   // copper on credit
    expect(await bal("13400")).toBe(1200); expect(await bal("50001")).toBe(800); // 4 m of copper → cost of goods
    expect(await bal("14500")).toBe(400); expect(await bal("50005")).toBe(100);  // 2 rolls of tape → technicians' consumables
    expect(await bal("11001")).toBe(500000 - 95000 - 10000 - 32310 - 500);
    expect(await bal("11002")).toBe(-33300); expect(await bal("11003")).toBe(-24390 - 10000);
    expect(await bal("30001")).toBe(-500000); expect(await bal("30004")).toBe(0); // the opening entry on the capital
    const pays = await sql<{ supplier: string; code: string }[]>`select l.supplier, a.code from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
      where e.company_id = ${s.a} and e.source = 'supplier_pay' and l.debit_cents > 0 order by e.number`;
    expect(pays.map((p) => `${p.supplier}:${p.code}`)).toEqual(["ABC:20001", "ABC:20001", "ABC:20001", "WM Co:20002"]);
    expect(await tbDiff()).toBe(0);
    expect((await acc(cfo, `/trial-balance?to=${today}`)).json.balanced).toBe(true);
    const stock = Number((await sql<{ v: string }[]>`select coalesce(sum(st.value_cents), 0)::text as v from stock_items st join catalog_items ci on ci.id = st.item_id where ci.company_id = ${s.a}`)[0]!.v);
    const books = Number((await sql<{ v: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as v from journal_lines l join accounts a on a.id = l.account_id
      where a.company_id = ${s.a} and a.code ~ '^1[348][0-9]{3}$'`)[0]!.v);
    expect(stock).toBe(95000 + 100000 + 30000 + 1200 + 400); expect(books).toBe(stock);
    // KHR cash now lands on 11001 (11004 is off)
    const c0 = await bal("11001");
    expect((await inv(admin, "/supplier-pay", { supplier: "WM Co", amount: 40000, currency: "khr", method: "cash_khr", date: today })).status).toBe(200);
    expect((await bal("11001")) - c0).toBe(-1000); expect(await bal("11004")).toBe(0); expect(await bal("20002")).toBe(-19000);
  });

  it("the COA export: the client's hierarchy, each header the roll-up of the accounts under it (every level), no account switched off, debit = credit", async () => {
    const res = await app.inject({ method: "GET", url: `/api/export/coa.xlsx?from=${today}&to=${today}&asof=${today}`, headers: { cookie: cfo.cookie! } });
    expect(res.statusCode).toBe(200);
    const rows = readWorkbook(res.rawPayload)[0]!.rows;
    const n = (v?: string) => Math.round(Number(v ?? 0) * 100);
    const head = (c: string) => rows.find((x) => x[1] === c)!, acct = (c: string) => rows.find((x) => x[2] === c);
    const close = (x: string[]) => n(x[8]) - n(x[9]);
    const under = (re: RegExp) => rows.filter((x) => re.test(x[2] ?? ""));
    expect(close(head("13000"))).toBe(95000 + 100000 + 30000 + 1200 + 400); // 13110 + 13820 + 13400 + 14100 + 14500 («ស្តុកថ្មី»)
    expect(n(head("13000")[4])).toBe(under(/^1[34][0-9]{3}$/).reduce((t, x) => t + n(x[4]), 0)); // the period's debit
    expect(close(head("10000"))).toBe(under(/^1[0-9]{4}$/).reduce((t, x) => t + close(x), 0));
    expect(close(head("20000"))).toBe(-(19000 + 2000)); // 20001 0 · 20002 · 20003 (21000 under it, empty)
    expect(head("11000")[3]).toBe("សាច់ប្រាក់"); expect(acct("50012")?.[3]).toBe("ចំណាយបញ្ចុះតម្លៃ");
    for (const off of ["11004", "13001", "21002", "30004", "30005", "40007", "50013", "50014"]) expect(acct(off), off).toBeUndefined();
    const total = rows.find((x) => x[3] === "Total")!;
    expect(n(total[4])).toBe(n(total[5])); expect(n(total[8])).toBe(n(total[9]));
  });

  it("D-177 the stock page's chart: the headers 13000 / 18000 and every active stock account under them (empty ones too), nothing switched off; technicians never", async () => {
    const r = await inv(admin, "/accounts");
    expect(r.status).toBe(200);
    const list = r.json as { code: string; is_group: boolean; parent_code: string | null }[];
    expect(list.filter((a) => a.is_group).map((a) => a.code)).toEqual(["13000", "18000"]);
    expect(list.filter((a) => !a.is_group).map((a) => a.code)).toEqual(CLIENT_V3.map(([c]) => c).filter((c) => /^1[3-8]/.test(c) && !["13000", "18000"].includes(c)).sort());
    expect(list.filter((a) => !a.is_group).every((a) => a.parent_code === (a.code.startsWith("18") ? "18000" : "13000"))).toBe(true);
    expect(list.some((a) => a.code === "13001")).toBe(false);
    expect((await (await loginAs(app, "kim")).req("GET", "/api/inventory/accounts")).status).toBe(403);
  });

  it("a balance on an account switched off moves with ONE reclass entry dated today; the old entries stay; the trial balance stays 0 (company B)", async () => {
    const ub = asUser(s.users.ceo_b!, s.b);
    await saveOpening(ub, null, { date: today, cash_usd: 10000, cash_khr: 400000 });
    const k = await bal("11004", s.b), o = await bal("30004", s.b);
    expect(k).toBeGreaterThan(0); expect(o).toBe(-(10000 + k));
    const lines0 = (await sql<{ n: number }[]>`select count(*)::int as n from journal_lines where company_id = ${s.b}`)[0]!.n;
    const plan = await tx(null, (t) => clientChartV3(t, ub, true));
    expect(plan.reclass).toMatch(/^JE-\d{4}-\d{4}$/);
    expect(plan.off.filter((x) => x.balance).map((x) => `${x.code}>${x.to}:${x.balance}`)).toEqual([`11004>11001:${k}`, `30004>30001:${o}`]);
    expect([await bal("11004", s.b), await bal("30004", s.b)]).toEqual([0, 0]);
    expect([await bal("11001", s.b), await bal("30001", s.b)]).toEqual([10000 + k, o]);
    expect((await sql<{ source: string; d: string }[]>`select source, entry_date::text as d from journal_entries where company_id = ${s.b} and number = ${plan.reclass}`)[0]).toEqual({ source: "manual", d: today });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from journal_lines where company_id = ${s.b}`)[0]!.n).toBe(lines0 + 4); // two accounts × two lines; nothing edited
    expect(await tbDiff(s.b)).toBe(0);
    expect((await account("11004", s.b)).is_active).toBe(false);
    expect(await bal("11001")).toBeGreaterThan(0); // company A untouched by B's change
  });
});
