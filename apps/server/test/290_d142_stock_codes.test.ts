// D-142 (CEO 13-10) — tests first: item codes on the client's scheme (sub codes under 14000 … 18000, the account IS the item for
// 13001 …), stock locations = warehouse + vehicles, any product stocked in / moved, job materials from the job's vehicle, materials
// from every catalog item + «សម្ភារៈផ្សេងៗ» without a price, a catalog item turned off disappears from the website, the invoice
// keeps the job number only, the accounting view of an invoice (the $500 example), the month-end stock check against the books.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { seedWebCatalog } from "../src/services/catalog.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { websiteItems } from "../src/services/web-booking.js";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, gm: Client, kim: Client, cfo: Client;
let inside: string, outside: string, today: string, wh: string, van: string, vanLoc: string;
const H = 3_600_000;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string) => (await sql<{ id: string; sub_codes: boolean }[]>`select id, sub_codes from accounts where company_id = ${s.a} and code = ${code}`)[0]!;
const itemByCode = async (code: string) => (await sql<{ id: string; name_km: string; track_stock: boolean; is_active: boolean; acc: string | null }[]>`
  select ci.id, ci.name_km, ci.track_stock, ci.is_active, a.code as acc from catalog_items ci left join accounts a on a.id = ci.inventory_account_id where ci.company_id = ${s.a} and ci.code = ${code}`)[0];
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const product = (name: string, extra: Record<string, unknown> = {}) => ceo.req("POST", "/api/catalog", { name_km: name, kind: "product", category: "mep", unit: "unit", sell_price: 100, ...extra });
const stockOf = async (itemId: string) => ((await inv(admin, "/items")).json as any[]).find((x) => x.item_id === itemId);

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "accounting,inventory,website";
  const hash = await hashPassword(PW);
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance) values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000008', ${hash}, false, false)`;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); cfo = await loginAs(app, "cfo");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200); // the chart (D-141) and, with it, one stock item per no-sub account (D-142)
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  expect((await acc(cfo, "/opening", { date: today, cash_usd: 100000 })).status).toBe(200); // the books start: every stock move below is posted
  inside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី", phones: ["012 111 222"], zone: "inside" })).json.id;
  outside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្រៅបុរី", phones: ["012 111 333"], zone: "outside" })).json.id;
  const locs = (await inv(admin, "/locations")).json as { id: string; kind: string; vehicle_code: string | null }[];
  wh = locs.find((l) => l.kind === "warehouse")!.id;
  van = (await sql<{ id: string }[]>`select id from vehicles where company_id = ${s.a} and code = '01'`)[0]!.id;
  vanLoc = locs.find((l) => l.vehicle_code === "01")!.id;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("5 · item codes on the client's scheme", () => {
  it("no-sub accounts: 13001 … 13005 and 13101 … 13104 each ARE their stock item (code = account code, tracked); a second item there is refused", async () => {
    for (const code of ["13001", "13002", "13003", "13004", "13005", "13101", "13102", "13103", "13104"]) {
      const it = await itemByCode(code);
      expect(it, code).toMatchObject({ track_stock: true, is_active: true, acc: code });
      expect(it!.name_km).toBe((await sql<{ n: string }[]>`select name_km as n from accounts where company_id = ${s.a} and code = ${code}`)[0]!.n);
    }
    expect(await itemByCode("13006")).toBeUndefined(); // no such account (nameless in the client's file)
    const a = await account("13001");
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a.id}`)).json).toEqual({ code: "13001", sub_codes: false, taken: true });
    expect((await product("ម៉ាស៊ីនត្រជាក់ ទី២", { code: "13001", inventory_account_id: a.id })).json.error).toBe("ONE_ITEM_PER_CODE");
    expect((await product("x", { code: "13009", inventory_account_id: a.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT");
  });

  it("sub codes: 14000 → 14005 after the client's 14001–14004, 16000 → 16001; the code is editable inside the parent's range, unique; a code outside is refused", async () => {
    const a14 = await account("14000"), a16 = await account("16000");
    expect(a14.sub_codes && a16.sub_codes).toBe(true);
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a14.id}`)).json).toEqual({ code: "14005", sub_codes: true, taken: false });
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a16.id}`)).json).toEqual({ code: "16001", sub_codes: true, taken: false });
    expect((await product("ទុយោស្ពាន់ 19mm", { code: "14005", inventory_account_id: a14.id })).status).toBe(200);
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a14.id}`)).json.code).toBe("14006");
    expect((await product("ទុយោស្ពាន់ 22mm", { code: "14100", inventory_account_id: a14.id })).status).toBe(200); // edited by hand, still under 14
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a14.id}`)).json.code).toBe("14101");
    expect((await product("x", { code: "14100", inventory_account_id: a14.id })).json.error).toBe("CODE_TAKEN");
    expect((await product("x", { code: "15099", inventory_account_id: a14.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT");
    expect((await product("x", { inventory_account_id: a14.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT"); // no code at all
    expect((await product("ប្រអប់ខ្សែភ្លើង 2x4", { code: "16001", inventory_account_id: a16.id })).status).toBe(200);
  });

  it("later, per account: sub codes may be turned on (13002 → 13002001 …); the account form saves the flag", async () => {
    const a = await account("13002");
    const r = await acc(cfo, "/accounts", { id: a.id, code: "13002", name_km: "ម៉ាស៊ីនបោកខោអាវ", type: "asset", sub_codes: true });
    expect(r.status).toBe(200);
    expect((await account("13002")).sub_codes).toBe(true);
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a.id}`)).json).toEqual({ code: "13002001", sub_codes: true, taken: false });
    expect((await product("ម៉ាស៊ីនបោក 8kg", { code: "13002001", inventory_account_id: a.id })).status).toBe(200);
    expect(((await acc(cfo, "/accounts")).json as any[]).find((x) => x.code === "13002").sub_codes).toBe(true);
  });
});

describe("4 · locations: warehouse + vehicles; any product in / moved; the job's vehicle", () => {
  it("stock in turns an untracked product into a stock item; a transfer warehouse → vehicle of any quantity; a service is never stock", async () => {
    const tape = (await product("ស្កុតបិទ", { unit: "pcs" })).json.id;
    expect((await itemByCode("x"))).toBeUndefined();
    expect((await inv(admin, "/in", { item_id: tape, location_id: wh, qty: 7.5, unit_cost: 40, pay: "cash_usd" })).status).toBe(200);
    expect((await sql`select track_stock from catalog_items where id = ${tape}`)[0]).toMatchObject({ track_stock: true });
    expect((await inv(admin, "/transfer", { item_id: tape, from: wh, to: vanLoc, qty: 2.5 })).status).toBe(200);
    const st = await stockOf(tape);
    expect(st.by_location.find((l: any) => l.location_id === vanLoc).qty).toBe(2.5);
    expect(st.by_location.find((l: any) => l.location_id === wh).qty).toBe(5);
    expect(st.account_code).toBe("18000"); // no account of its own → the fallback
    const svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុល", kind: "service", category: "mep", unit: "job", sell_price: 3000 })).json.id;
    expect((await inv(admin, "/in", { item_id: svc, location_id: wh, qty: 1, unit_cost: 1, pay: "cash_usd" })).json.error).toBe("NOT_A_PRODUCT");
    const kinds = new Set(((await inv(admin, "/locations")).json as any[]).map((l) => l.kind));
    expect([...kinds].every((k) => k === "warehouse" || k === "vehicle")).toBe(true);
  });

  it("a job's materials leave the JOB'S VEHICLE when the Admin confirms (no location chosen)", async () => {
    const pipe = (await itemByCode("14001"))!.id;
    expect((await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 10, unit_cost: 200, pay: "cash_usd" })).status).toBe(200);
    expect((await inv(admin, "/transfer", { item_id: pipe, from: wh, to: vanLoc, qty: 5 })).status).toBe(200);
    const job = (await admin.req("POST", "/api/bookings", { customer_id: inside, type: "A", category: "mep", service_text: "ដំឡើង", zone: "inside", ...span(new Date(Date.now() + 40 * H).toISOString()) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [], vehicle_id: van })).status).toBe(200);
    await sql`insert into booking_materials (booking_id, catalog_item_id, qty) values (${job}, ${pipe}, 3)`;
    for (const st of ["on_site", "work_done"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    const pending = ((await inv(admin, "/jobs/pending")).json as any[]).find((j) => j.booking_id === job);
    expect(pending).toMatchObject({ suggested_location_id: vanLoc, vehicle_code: "01" });
    expect((await inv(admin, `/jobs/${job}/confirm`, {})).status).toBe(200);
    expect((await sql<{ loc: string; qty: string }[]>`select location_id as loc, qty::text from stock_moves where ref_id = ${job} and kind = 'out_job'`)[0]).toMatchObject({ loc: vanLoc, qty: "-3.000" });
    const st = await stockOf(pipe);
    expect(st.by_location.find((l: any) => l.location_id === vanLoc).qty).toBe(2);
    expect(st.by_location.find((l: any) => l.location_id === wh).qty).toBe(5);
  });
});

describe("3 · materials from every catalog item; «សម្ភារៈផ្សេងៗ» without a price", () => {
  it("the technician records a service and an appliance as materials; writes a free material (text, quantity, unit) — no price; the Admin prices it → an invoice product line", async () => {
    const job = (await admin.req("POST", "/api/bookings", { customer_id: inside, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + 60 * H).toISOString()) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const start = Date.now() - 2 * H;
    await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * H)} where id = ${job}`;
    for (const step of ["depart", "arrive"]) expect((await kim.req("POST", `/api/bookings/${job}/checkpoint`, { step, no_gps: true })).status).toBe(200);
    const svc = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${s.a} and kind = 'service' limit 1`)[0]!.id;
    const ac = (await itemByCode("13001"))!.id;
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: svc, qty: 1 }, { catalog_item_id: ac, qty: 1 }] })).status).toBe(200);
    const mats = (await kim.req("GET", `/api/bookings/${job}/job`)).json.materials;
    expect(mats.map((m: any) => [m.kind, m.code])).toEqual(expect.arrayContaining([["service", null], ["product", "13001"]]));
    const x = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "material", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ" });
    expect(x.status).toBe(200);
    expect((await kim.req("GET", `/api/bookings/${job}/job`)).json.extras[0]).toMatchObject({ kind: "material", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ", unit_price: null, status: "pending" });
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "material", description: "x", qty: 1 })).json.error).toBe("DESCRIPTION_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x.json.id}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x.json.id}/review`, { action: "confirm", unit_price: 150 })).status).toBe(200);
    for (const st of ["work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines.find((l: any) => l.description === "ខ្សែភ្លើង 2.5")).toMatchObject({ kind: "product", qty: 20, unit: "ម៉ែត្រ", unit_price: 150, catalog_item_id: null });
    expect(p.lines.find((l: any) => l.catalog_item_id === ac)).toMatchObject({ kind: "product", qty: 1 }); // the appliance recorded as a material is on the invoice too
    expect(p.booking_number).toMatch(/^BK-\d{4}$/); // 2: the invoice carries the job's number (the screens show it alone)
  });
});

describe("1 · «ចង់ទិញម៉ាស៊ីនត្រជាក់» turned off", () => {
  it("shop-setup by code: inactive → gone from the website's choices and not bookable; «ស្នើសុំតម្លៃ» stays; the staff list keeps it, off", async () => {
    expect(await seedWebCatalog(s.a, { prices: true })).toMatchObject({ added: 13 });
    await sql`insert into users (company_id, username, full_name, role, password_hash, is_platform) values (${s.a}, 'support', 'HangKH Support', 'admin', ${await hashPassword(PW)}, true)`;
    const buy = (await itemByCode("AC-BUY"))!;
    expect((await websiteItems(sql, s.a)).some((i) => i.code === "AC-BUY")).toBe(true);
    const plan = await shopSetup("oneteam", { catalog: [{ code: "AC-BUY", is_active: false }] }, false);
    expect(plan.some((l) => /AC-BUY: is_active true → false/.test(l))).toBe(true);
    expect((await itemByCode("AC-BUY"))!.is_active).toBe(true); // a dry run writes nothing
    await shopSetup("oneteam", { catalog: [{ code: "AC-BUY", is_active: false }] }, true);
    expect((await itemByCode("AC-BUY"))!.is_active).toBe(false);
    expect((await websiteItems(sql, s.a)).some((i) => i.code === "AC-BUY")).toBe(false);
    expect((await websiteItems(sql, s.a)).some((i) => i.code === "CN-QUOTE")).toBe(true);
    const r = await app.inject({ method: "GET", url: `/api/public/slots?items=${buy.id}:1` });
    expect([404, 400]).toContain(r.statusCode);
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).find((i) => i.code === "AC-BUY")).toMatchObject({ is_active: false });
    expect(((await kim.req("GET", "/api/catalog")).json as any[]).some((i) => i.code === "AC-BUY")).toBe(false); // technicians: active items only
    expect((await sql`select 1 from audit_log where action = 'catalog.active' and row_id = ${buy.id}`).length).toBe(1);
  });
});

describe("6 · the accounting view of an invoice — the $500 example", () => {
  let invoiceId: string;
  it("AC $450 (item 13001, cost $300) + service $50, paid $450 by ACLEDA → Dr 11002 450 · Dr 12002 50 · Cr 40001 450 · Cr 40002 50 · Dr 50001 300 / Cr 13001 300", async () => {
    const ac = (await itemByCode("13001"))!.id;
    expect((await inv(admin, "/in", { item_id: ac, location_id: wh, qty: 2, unit_cost: 30000, pay: "credit", supplier: "ហាងម៉ាស៊ីនត្រជាក់" })).status).toBe(200);
    const before = Object.fromEntries(await Promise.all(["11002", "12002", "40001", "40002", "50001", "13001"].map(async (c) => [c, await bal(c)])));
    const r = await admin.req("POST", "/api/invoices", { customer_id: outside, lines: [
      { catalog_item_id: ac, description: "ម៉ាស៊ីនត្រជាក់ 1HP", kind: "product", qty: 1, unit: "គ្រឿង", unit_price: 45000 },
      { description: "ដំឡើង", kind: "service", qty: 1, unit: "job", unit_price: 5000 }] });
    expect(r.status).toBe(200);
    invoiceId = r.json.id;
    expect((await admin.req("POST", `/api/invoices/${invoiceId}/issue`, {})).status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${invoiceId}/payments`, { amount: 45000, currency: "usd", method: "acleda" })).status).toBe(200);
    const after = Object.fromEntries(await Promise.all(["11002", "12002", "40001", "40002", "50001", "13001"].map(async (c) => [c, await bal(c)])));
    const delta = Object.fromEntries(Object.keys(after).map((c) => [c, after[c]! - before[c]!]));
    expect(delta).toEqual({ "11002": 45000, "12002": 5000, "40001": -45000, "40002": -5000, "50001": 30000, "13001": -30000 });
    expect((await stockOf(ac))).toMatchObject({ qty: 1, value: 30000 });
  });

  it("«ការកត់ត្រាគណនេយ្យ» on the invoice: the issue, the stock at cost and the payment, each line with code + name; GM and technician: 403", async () => {
    const j = await admin.req("GET", `/api/invoices/${invoiceId}/journal`);
    expect(j.status).toBe(200);
    expect(j.json.map((e: any) => e.source).sort()).toEqual(["invoice", "payment", "stock"]);
    const flat = j.json.flatMap((e: any) => e.lines.map((l: any) => [l.code, l.debit, l.credit]));
    expect(flat).toEqual(expect.arrayContaining([["12002", 50000, 0], ["40001", 0, 45000], ["40002", 0, 5000], ["50001", 30000, 0], ["13001", 0, 30000], ["11002", 45000, 0], ["12002", 0, 45000]]));
    expect(j.json.every((e: any) => e.lines.every((l: any) => typeof l.name_km === "string" && l.name_km.length > 0))).toBe(true);
    expect((await cfo.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(200);
    expect((await gm.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(403);
    expect((await kim.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(403);
  });

  it("trial balance / balance sheet: the stock accounts only (14000 as the sum of its items, 13001 as itself) — never an item code", async () => {
    const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: any) => r.code === "13001").balance).toBe(30000); // 2 in − 1 sold, at cost
    expect(tb.rows.find((r: any) => r.code === "14000").balance).toBe(1400); // 14001: 10 in @ $2, 3 used on the job
    expect(tb.rows.some((r: any) => /^14[0-9]{3}$/.test(r.code) && r.code !== "14000")).toBe(false);
    expect(tb.rows.find((r: any) => r.code === "50005").balance).toBe(600); // the job's materials
  });
});

describe("7 · month-end stock check", () => {
  it("«តម្លៃស្តុកចុងខែ» by account (quantity + value) = the books' stock accounts; a difference shows up; GM sees the stock side only; an earlier day", async () => {
    const r = await inv(admin, `/month-end?to=${today}`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.json.accounts.map((a: any) => [a.code, a]));
    expect(by["13001"]).toMatchObject({ qty: 1, value: 30000, balance: 30000, difference: 0 });
    expect(by["14000"]).toMatchObject({ qty: 7, value: 1400, balance: 1400, difference: 0 });
    expect(by["14000"].items.map((i: any) => i.code)).toContain("14001");
    expect(r.json.difference).toBe(0);
    expect(r.json.stock_total).toBe(r.json.books_total);
    // a hand entry on 13001 without stock behind it → the check shows the gap
    const [a13001, a11001] = [await account("13001"), await account("11001")];
    expect((await acc(cfo, "/journal", { date: today, memo: "QA កែដោយដៃ", lines: [{ account_id: a13001.id, debit: 1000 }, { account_id: a11001.id, credit: 1000 }] })).status).toBe(200);
    const r2 = (await inv(admin, `/month-end?to=${today}`)).json;
    expect(r2.accounts.find((a: any) => a.code === "13001")).toMatchObject({ value: 30000, balance: 31000, difference: -1000 });
    expect(r2.difference).toBe(-1000);
    const g = (await inv(gm, `/month-end?to=${today}`)).json;
    expect(g.books_total).toBeNull(); expect(g.difference).toBeNull(); expect(g.stock_total).toBe(r2.stock_total);
    const yesterday = (await sql<{ d: string }[]>`select (${today}::date - 1)::text as d`)[0]!.d;
    const y = (await inv(admin, `/month-end?to=${yesterday}`)).json;
    expect(y.stock_total).toBe(0);
    expect((await inv(kim, `/month-end?to=${today}`)).status).toBe(403);
  });
});
