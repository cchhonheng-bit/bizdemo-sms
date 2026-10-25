// D-142 (CEO 13-10) as D-144 left it — tests first: item codes on the client's scheme (sub codes under 14000 … 18000, the account IS
// the item for 13001 …), stock in as a direct entry (warehouse only), stock out to a technician for a job, the technician's list
// without stock items + «ការងារ/សម្ភារៈបន្ថែម» without a price, a catalog item turned off disappears from the website, the invoice
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
let inside: string, outside: string, today: string, copper: string;
const H = 3_600_000;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string) => (await sql<{ id: string; sub_codes: boolean }[]>`select id, sub_codes from accounts where company_id = ${s.a} and code = ${code}`)[0]!;
const itemByCode = async (code: string) => (await sql<{ id: string; name_km: string; track_stock: boolean; is_stock: boolean; is_active: boolean; acc: string | null }[]>`
  select ci.id, ci.name_km, ci.track_stock, ci.is_stock, ci.is_active, a.code as acc from catalog_items ci left join accounts a on a.id = ci.inventory_account_id where ci.company_id = ${s.a} and ci.code = ${code}`)[0];
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const product = (name: string, extra: Record<string, unknown> = {}) => ceo.req("POST", "/api/catalog", { name_km: name, kind: "product", category: "mep", unit: "unit", sell_price: 100, ...extra });
const stockOf = async (itemId: string) => ((await inv(admin, "/items")).json as any[]).find((x) => x.item_id === itemId);
const jobFor = async (customer: string, text: string, h: number) => {
  const id = (await admin.req("POST", "/api/bookings", { customer_id: customer, type: "A", category: "mep", service_text: text, zone: "inside", ...span(new Date(Date.now() + h * H).toISOString()) })).json.id;
  expect((await admin.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  return id as string;
};

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
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("5 · item codes on the client's scheme (D-165: the account code + 2 digits)", () => {
  it("every stock account carries sub codes; the copper / insulation items of the sheet exist (1340001 …); the AC accounts are by brand and type", async () => {
    for (const code of ["13110", "13230", "13330", "13830", "13400", "13500", "14100", "14500", "18100"]) expect((await account(code)).sub_codes, code).toBe(true);
    expect(await itemByCode("1340001")).toMatchObject({ is_stock: true, acc: "13400" });
    expect(await itemByCode("1350010")).toMatchObject({ is_stock: true, acc: "13500" });
    expect(await itemByCode("13001")).toBeUndefined(); // no generic air-conditioner stock any more
  });

  it("sub codes: 13110 → 1311001, then 1311002; 13400 holds the sheet's 1340001–1340004 → 1340005; the code is editable inside the parent's range, unique; outside is refused", async () => {
    const a1 = await account("13110"), a4 = await account("13400");
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a1.id}`)).json).toEqual({ code: "1311001", sub_codes: true, taken: false });
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a4.id}`)).json).toEqual({ code: "1340005", sub_codes: true, taken: false });
    expect((await product("Panasonic 1.5 HP", { code: "1311001", inventory_account_id: a1.id })).status).toBe(200);
    expect(await itemByCode("1311001")).toMatchObject({ is_stock: true, acc: "13110" }); // D-144: never in the price list
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).some((i) => i.code === "1311001")).toBe(false);
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a1.id}`)).json.code).toBe("1311002");
    expect((await product("Panasonic 2 HP", { code: "1311004", inventory_account_id: a1.id })).status).toBe(200); // edited by hand, still under 13110
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a1.id}`)).json.code).toBe("1311005");
    expect((await product("x", { code: "1311004", inventory_account_id: a1.id })).json.error).toBe("CODE_TAKEN");
    expect((await product("x", { code: "1312001", inventory_account_id: a1.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT");
    expect((await product("x", { inventory_account_id: a1.id })).json.error).toBe("CODE_NOT_IN_ACCOUNT"); // no code at all
  });

  it("an account switched to «no sub codes» IS its one item (code = the account code); the flag is saved by the account form", async () => {
    const a = await account("14100");
    expect((await acc(cfo, "/accounts", { id: a.id, code: "14100", name_km: "ម៉ាស៊ីនបោកខោអាវ", type: "asset", sub_codes: false })).status).toBe(200);
    expect((await account("14100")).sub_codes).toBe(false);
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a.id}`)).json).toEqual({ code: "14100", sub_codes: false, taken: false });
    expect((await product("ម៉ាស៊ីនបោក", { code: "14100", inventory_account_id: a.id })).status).toBe(200);
    expect((await product("ម៉ាស៊ីនបោក ទី២", { code: "14100", inventory_account_id: a.id })).json.error).toBe("ONE_ITEM_PER_CODE");
    expect((await acc(cfo, "/accounts", { id: a.id, code: "14100", name_km: "ម៉ាស៊ីនបោកខោអាវ", type: "asset", sub_codes: true })).status).toBe(200);
  });
});

describe("4 · stock in as a direct entry, stock out to a technician (D-144: the warehouse only)", () => {
  it("a new name on 18000 → item 18001 made on the way; a service is never stock; the only location is the warehouse", async () => {
    const a18 = await account("14500");
    const r = await inv(admin, "/in", { name: "ស្កុតបិទ", account_id: a18.id, unit: "pcs", qty: 7.5, unit_cost: 40, pay: "cash_usd" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, total: 300, balance: 7.5 });
    expect(await itemByCode("1450001")).toMatchObject({ is_stock: true, track_stock: true, acc: "14500" });
    expect(await stockOf(r.json.item_id)).toMatchObject({ qty: 7.5, value: 300, account_code: "14500" });
    const svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុល", kind: "service", category: "mep", unit: "job", sell_price: 3000 })).json.id;
    expect((await inv(admin, "/in", { item_id: svc, qty: 1, unit_cost: 1, pay: "cash_usd" })).json.error).toBe("NOT_STOCK_ITEM");
    expect(((await inv(admin, "/locations")).json as any[]).map((l) => l.kind)).toEqual(["warehouse"]);
  });

  it("a job's copper leaves the warehouse when the Admin records the technician's collection (job BK); a sale by the place", async () => {
    const pipe = (await itemByCode("1340001"))!.id;
    expect((await inv(admin, "/in", { item_id: pipe, qty: 10, unit_cost: 200, pay: "cash_usd" })).status).toBe(200);
    const job = await jobFor(inside, "ដំឡើង", 40);
    const r = await inv(admin, "/out", { item_id: pipe, qty: 3, technician_id: s.users.kim, booking_id: job });
    expect(r.status).toBe(200);
    expect(r.json.balance).toBe(7);
    expect((await sql<{ qty: string; tech: string }[]>`select qty::text, technician_id as tech from stock_moves where ref_id = ${job} and kind = 'out'`)[0]).toMatchObject({ qty: "-3.000", tech: s.users.kim });
    expect((await inv(admin, "/out", { item_id: pipe, qty: 2, technician_id: s.users.kim, place: "ហាង (លក់ផ្ទាល់)" })).json.balance).toBe(5);
    expect(await stockOf(pipe)).toMatchObject({ qty: 5, value: 1000 });
    expect(await bal("50005")).toBe(1000); expect(await bal("13400")).toBe(1000); // copper's cost → technicians' materials (D-143)
  });
});

describe("3 · the technician's list has no stock item; «ការងារ/សម្ភារៈបន្ថែម» without a price", () => {
  it("the technician adds a price-list sale line and writes a free line (text, quantity, unit) — no price; the Admin prices it as goods → an invoice product line", async () => {
    copper = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", category: "mep", unit: "ម៉ែត្រ", sell_price: 1500, stock_link_account_id: (await account("13400")).id })).json.id;
    const job = await jobFor(inside, "ជួសជុល", 60);
    const start = Date.now() - 2 * H;
    await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * H)} where id = ${job}`;
    for (const step of ["depart", "arrive"]) expect((await kim.req("POST", `/api/bookings/${job}/checkpoint`, { step, no_gps: true })).status).toBe(200);
    const list = (await kim.req("GET", "/api/catalog")).json as any[];
    expect(list.some((i) => i.code === "1340001" || i.is_stock)).toBe(false);
    expect(list.some((i) => i.id === copper)).toBe(true);
    const ac = (await inv(admin, "/in", { name: "Panasonic 1 HP", account_id: (await account("13110")).id, qty: 1, total: 25000, pay: "aba" })).json.item_id;
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "service", item_id: ac, qty: 1 })).json.error).toBe("SERVICE_NOT_FOUND");
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "service", item_id: copper, qty: 4 })).status).toBe(200);
    const x = await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ" });
    expect(x.status).toBe(200);
    expect((await kim.req("GET", `/api/bookings/${job}/job`)).json.extras[1]).toMatchObject({ kind: "other", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ", unit_price: null, status: "pending" });
    expect((await kim.req("POST", `/api/bookings/${job}/extras`, { kind: "other", description: "x", qty: 1 })).json.error).toBe("DESCRIPTION_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x.json.id}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${x.json.id}/review`, { action: "confirm", unit_price: 150, kind: "product" })).status).toBe(200);
    const first = (await admin.req("GET", `/api/bookings/${job}/job`)).json.extras[0].id;
    expect((await admin.req("POST", `/api/bookings/${job}/extras/${first}/review`, { action: "confirm", unit_price: 1500 })).status).toBe(200); // D-152: the office types the price
    for (const st of ["work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    expect(p.lines.find((l: any) => l.description === "ខ្សែភ្លើង 2.5")).toMatchObject({ kind: "product", qty: 20, unit: "ម៉ែត្រ", unit_price: 150, catalog_item_id: null });
    expect(p.lines.find((l: any) => l.catalog_item_id === copper)).toMatchObject({ kind: "product", qty: 4, unit_price: 1500 });
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
  it("AC $450 (item 13001, cost $300, handed to the technician by the Admin) + service $50, paid $450 by ACLEDA → Dr 11002 450 · Dr 12002 50 · Cr 40001 450 · Cr 40002 50; the stock out: Dr 50001 300 / Cr 13001 300", async () => {
    const ac = (await inv(admin, "/in", { name: "Panasonic 1 HP", account_id: (await account("13110")).id, qty: 1, total: 25000, pay: "aba" })).json.item_id;
    expect((await inv(admin, "/in", { item_id: ac, qty: 2, unit_cost: 30000, pay: "credit", supplier: "ហាងម៉ាស៊ីនត្រជាក់" })).status).toBe(200);
    const before = Object.fromEntries(await Promise.all(["11002", "12002", "40001", "40002", "50001", "13001"].map(async (c) => [c, await bal(c)])));
    expect((await inv(admin, "/out", { item_id: ac, qty: 1, technician_id: s.users.kim, place: "ក្រៅបុរី ផ្ទះ 7" })).json.balance).toBe(1);
    const r = await admin.req("POST", "/api/invoices", { customer_id: outside, lines: [
      { description: "ម៉ាស៊ីនត្រជាក់ 1HP", kind: "product", qty: 1, unit: "គ្រឿង", unit_price: 45000 },
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

  it("«ការកត់ត្រាគណនេយ្យ» on the invoice: the issue and the payment, each line with code + name (the stock has its own record); GM and technician: 403", async () => {
    const j = await admin.req("GET", `/api/invoices/${invoiceId}/journal`);
    expect(j.status).toBe(200);
    expect(j.json.map((e: any) => e.source).sort()).toEqual(["invoice", "payment"]);
    const flat = j.json.flatMap((e: any) => e.lines.map((l: any) => [l.code, l.debit, l.credit]));
    expect(flat).toEqual(expect.arrayContaining([["12002", 50000, 0], ["40001", 0, 45000], ["40002", 0, 5000], ["11002", 45000, 0], ["12002", 0, 45000]]));
    expect(j.json.every((e: any) => e.lines.every((l: any) => typeof l.name_km === "string" && l.name_km.length > 0))).toBe(true);
    expect((await cfo.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(200);
    expect((await gm.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(403);
    expect((await kim.req("GET", `/api/invoices/${invoiceId}/journal`)).status).toBe(403);
  });

  it("trial balance / balance sheet: the stock accounts only (14000 as the sum of its items, 13001 as itself) — never an item code", async () => {
    const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r: any) => r.code === "13001").balance).toBe(30000); // 2 in − 1 out, at cost
    expect(tb.rows.find((r: any) => r.code === "14000").balance).toBe(1000); // 14001: 10 in @ $2, 3 for the job + 2 sold
    expect(tb.rows.some((r: any) => /^14[0-9]{3}$/.test(r.code) && r.code !== "14000")).toBe(false);
    expect(tb.rows.find((r: any) => r.code === "50005").balance).toBe(1000); // the copper that left
  });
});

describe("D-143 · the cost account follows the item's group", () => {
  it("job BK: AC 13001 + copper 14001 handed out → Dr 50001 (AC cost) + Dr 50005 (copper cost); the job's invoice with both lines moves nothing", async () => {
    const ac = (await itemByCode("13001"))!.id, pipe = (await itemByCode("1340001"))!.id;
    const b0 = Object.fromEntries(await Promise.all(["50001", "50005", "13001", "14000"].map(async (c) => [c, await bal(c)])));
    const job = await jobFor(outside, "ដំឡើងម៉ាស៊ីនត្រជាក់", 80);
    expect((await inv(admin, "/out", { item_id: ac, qty: 1, technician_id: s.users.kim, booking_id: job })).json.balance).toBe(0);
    expect((await inv(admin, "/out", { item_id: pipe, qty: 2, technician_id: s.users.kim, booking_id: job })).json.balance).toBe(3);
    const b1 = Object.fromEntries(await Promise.all(["50001", "50005", "13001", "14000"].map(async (c) => [c, await bal(c)])));
    expect({ "50001": b1["50001"]! - b0["50001"]!, "50005": b1["50005"]! - b0["50005"]!, "13001": b1["13001"]! - b0["13001"]!, "14000": b1["14000"]! - b0["14000"]! })
      .toEqual({ "50001": 30000, "50005": 400, "13001": -30000, "14000": -400 }); // AC at its $300 cost, 2 m of copper at $2
    const moves = (await sql`select count(*)::int as n from stock_moves where company_id = ${s.a}`)[0]!.n;
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    const r = await admin.req("POST", "/api/invoices", { booking_id: job, lines: [
      { description: "ម៉ាស៊ីនត្រជាក់ 1HP", kind: "product", qty: 1, unit: "គ្រឿង", unit_price: 45000 },
      { catalog_item_id: copper, description: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", qty: 2, unit: "ម៉ែត្រ", unit_price: 1500 }] });
    expect((await admin.req("POST", `/api/invoices/${r.json.id}/issue`, {})).status).toBe(200);
    expect((await sql`select count(*)::int as n from stock_moves where company_id = ${s.a}`)[0]!.n).toBe(moves); // the invoice moves nothing
    expect((await stockOf(ac)).qty).toBe(0); expect((await stockOf(pipe)).qty).toBe(3);
    const b2 = Object.fromEntries(await Promise.all(["50001", "50005"].map(async (c) => [c, await bal(c)])));
    expect(b2).toEqual({ "50001": b1["50001"], "50005": b1["50005"] });
    // «ផ្ទៀងផ្ទាត់សម្ភារៈ»: 2 m out, 2 m invoiced → nothing to look at
    const rec = (await inv(admin, `/reconcile?from=${today}&to=${today}`)).json;
    expect(rec.rows.find((x: any) => x.booking_id === job && x.group_code === "14000")).toMatchObject({ out_qty: 2, invoiced_qty: 2, difference: 0 });
  });
});

describe("7 · month-end stock check", () => {
  it("«តម្លៃស្តុកចុងខែ» by account (quantity + value) = the books' stock accounts; a difference shows up; GM sees the stock side only; an earlier day", async () => {
    const r = await inv(admin, `/month-end?to=${today}`);
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.json.accounts.map((a: any) => [a.code, a]));
    expect(by["13001"]).toMatchObject({ qty: 0, value: 0, balance: 0, difference: 0 }); // after D-143's job took the last AC
    expect(by["14000"]).toMatchObject({ qty: 3, value: 600, balance: 600, difference: 0 });
    expect(by["14000"].items.map((i: any) => i.code)).toContain("14001");
    expect(r.json.difference).toBe(0);
    expect(r.json.stock_total).toBe(r.json.books_total);
    // a hand entry on 13001 without stock behind it → the check shows the gap
    const [a13001, a11001] = [await account("13001"), await account("11001")];
    expect((await acc(cfo, "/journal", { date: today, memo: "QA កែដោយដៃ", lines: [{ account_id: a13001.id, debit: 1000 }, { account_id: a11001.id, credit: 1000 }] })).status).toBe(200);
    const r2 = (await inv(admin, `/month-end?to=${today}`)).json;
    expect(r2.accounts.find((a: any) => a.code === "13001")).toMatchObject({ value: 0, balance: 1000, difference: -1000 });
    expect(r2.difference).toBe(-1000);
    const g = (await inv(gm, `/month-end?to=${today}`)).json;
    expect(g.books_total).toBeNull(); expect(g.difference).toBeNull(); expect(g.stock_total).toBe(r2.stock_total);
    const yesterday = (await sql<{ d: string }[]>`select (${today}::date - 1)::text as d`)[0]!.d;
    const y = (await inv(admin, `/month-end?to=${yesterday}`)).json;
    expect(y.stock_total).toBe(0);
    expect((await inv(kim, `/month-end?to=${today}`)).status).toBe(403);
  });
});
