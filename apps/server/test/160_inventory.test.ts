// STEP 4 Part B (D-87) as D-144 left it: inventory (flag "inventory") — the warehouse only, stock in as a direct entry (the item is
// made on its first entry), weighted-average cost, adjustments, stock out to a technician (job or place), stock card, no negative
// stock, low-stock alert, append-only moves; an invoice never moves stock; technicians never see stock items — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed, PLACE, span } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { ensureChart } from "../src/services/accounting.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let pipe: string, gas: string, svc: string, cust: string, wh: string, a18000: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const item = async (id: string) => ((await inv(admin, "/items")).json as any[]).find((x) => x.item_id === id);
const balance = async (id: string) => (await item(id))?.by_location.find((l: any) => l.location_id === wh)?.qty ?? 0;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "inventory";
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  await ensureChart(sql, s.a); // the stock accounts come with the chart (the item codes need it even without the accounting module — D-142)
  a18000 = (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = '18000'`)[0]!.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុល", kind: "service", category: "mep", unit: "job", sell_price: 3000 })).json.id;
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "អតិថិជន ស្តុក", phones: ["012616161"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("the warehouse", () => {
  it("one warehouse exists by default and is the only location; GM views; technicians never; a service is never stock", async () => {
    const l = (await inv(admin, "/locations")).json as any[];
    expect(l.length).toBe(1); expect(l[0].kind).toBe("warehouse");
    wh = l[0].id;
    expect((await inv(gm, "/locations")).status).toBe(200);
    expect((await inv(kim, "/locations")).status).toBe(403);
    expect((await inv(kim, "/items")).status).toBe(403);
    expect((await inv(admin, "/in", { item_id: svc, qty: 1, unit_cost: 1, pay: "cash_usd" })).json.error).toBe("NOT_STOCK_ITEM");
  });

  it("the module is off → 404", async () => {
    config.shop.features = "";
    expect((await inv(admin, "/items")).status).toBe(404);
    config.shop.features = "inventory";
  });
});

describe("weighted-average cost (integer cents, exact to the last cent)", () => {
  it("opening stock (no money) + stock in at different costs → average; out uses the average; the last unit takes the remaining value", async () => {
    const r = await inv(admin, "/in", { name: "ទុយោ PVC", account_id: a18000, unit: "m", qty: 10, unit_cost: 500, opening: true });   // 10 × $5
    expect(r.status).toBe(200); pipe = r.json.item_id;
    expect(r.json).toMatchObject({ created: true, total: 5000, balance: 10 });
    expect((await sql`select kind, pay from stock_moves where id = ${r.json.id}`)[0]).toMatchObject({ kind: "opening", pay: null });
    expect((await inv(admin, "/in", { item_id: pipe, qty: 1, unit_cost: 500, opening: true })).json.error).toBe("OPENING_EXISTS");
    expect((await inv(admin, "/in", { item_id: pipe, qty: 10, unit_cost: 600, supplier: "ហាងដែក", pay: "cash_usd" })).status).toBe(200); // 10 × $6
    let i = await item(pipe);
    expect(i).toMatchObject({ qty: 20, value: 11000, avg_cost: 550, code: "18001", account_code: "18000" });
    expect((await inv(admin, "/adjust", { item_id: pipe, qty: -5, reason: "ខូច" })).status).toBe(200);
    i = await item(pipe);
    expect(i).toMatchObject({ qty: 15, value: 8250 });
    expect((await inv(admin, "/adjust", { item_id: pipe, qty: -15, reason: "ខូចទាំងអស់" })).status).toBe(200);
    expect(await item(pipe)).toMatchObject({ qty: 0, value: 0 });                       // nothing left → no value left
  });

  it("thirds: 3 units for 100 cents go out as 33 + 34 + 33 — the sum is exactly 100", async () => {
    gas = (await inv(admin, "/in", { name: "ហ្គាស R32", account_id: a18000, unit: "kg", qty: 3, total: 100, pay: "credit", supplier: "Supplier A" })).json.item_id;
    const outs: number[] = [];
    for (let k = 0; k < 3; k++) { await inv(admin, "/adjust", { item_id: gas, qty: -1, reason: "សាកល្បង" }); outs.push(Number((await sql`select value_cents from stock_moves where item_id = ${gas} order by id desc limit 1`)[0]!.value_cents)); }
    expect(outs.map((x) => -x)).toEqual([33, 34, 33]);
    expect(await item(gas)).toMatchObject({ qty: 0, value: 0 });
  });

  it("fractional quantities (2.5 m) and validation: qty > 0, reason for adjustments, cost ≥ 0, other company's item 404", async () => {
    await inv(admin, "/in", { item_id: pipe, qty: 2.5, unit_cost: 400, pay: "aba" });
    expect(await item(pipe)).toMatchObject({ qty: 2.5, value: 1000 });
    expect((await inv(admin, "/in", { item_id: pipe, qty: 0, unit_cost: 1, pay: "aba" })).status).toBe(400);
    expect((await inv(admin, "/in", { item_id: pipe, qty: 1, unit_cost: -1, pay: "aba" })).status).toBe(400);
    expect((await inv(admin, "/adjust", { item_id: pipe, qty: -1, reason: "" })).json.error).toBe("REASON_REQUIRED");
    const ceoB = await loginAs(app, "ceo_b");
    expect((await inv(ceoB, "/in", { item_id: pipe, qty: 1, unit_cost: 1, pay: "aba" })).status).toBe(404);
  });
});

describe("stock out, no negative stock, low stock", () => {
  let job: string;
  it("the Admin records what a technician collects, for a job → the balance left, at average cost; beyond the balance is refused; technicians cannot", async () => {
    await inv(admin, "/in", { item_id: pipe, qty: 20, unit_cost: 400, pay: "cash_usd" }); // 22.5
    job = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "បំពេញហ្គាស", zone: "inside", ...span(when()), service_item_id: svc })).json.id;
    await gm.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] });
    expect((await inv(admin, "/out", { item_id: pipe, qty: 50, technician_id: s.users.kim, booking_id: job })).json.error).toBe("INSUFFICIENT_STOCK");
    const r = await inv(admin, "/out", { item_id: pipe, qty: 10, technician_id: s.users.kim, booking_id: job });
    expect(r.status).toBe(200);
    expect(r.json.balance).toBe(12.5);
    expect(Number((await sql`select value_cents from stock_moves where id = ${r.json.id}`)[0]!.value_cents)).toBe(-4000);
    expect((await inv(kim, "/out", { item_id: pipe, qty: 1, technician_id: s.users.kim, booking_id: job })).status).toBe(403);
    expect((await inv(gm, "/out", { item_id: pipe, qty: 1, technician_id: s.users.kim, booking_id: job })).status).toBe(403);
  });

  it("below the reorder level → one alert to inventory managers (not repeated the same day)", async () => {
    const n = async () => (await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${s.users.admin!} and kind = 'stock.low'`)[0]!.n;
    expect((await inv(admin, `/items/${pipe}/reorder`, { reorder_level: 5 })).status).toBe(200);
    await sql`update stock_items set low_alerted_on = null where item_id = ${pipe}`;
    const before = await n();
    await inv(admin, "/out", { item_id: pipe, qty: 8, technician_id: s.users.kim, place: "បុរី A ផ្ទះ 3" }); // 12.5 → 4.5 < 5
    expect(await n()).toBe(before + 1);
    await inv(admin, "/adjust", { item_id: pipe, qty: -1, reason: "សាកល្បង" });  // still low: no second alert
    expect(await n()).toBe(before + 1);
    expect((await item(pipe)).low).toBe(true);
  });
});

describe("the invoice, the technician's list, the stock card, immutable moves", () => {
  it("a direct-sale invoice never moves stock (stock out is the Admin's own record); technicians see no stock item", async () => {
    await inv(admin, "/in", { item_id: gas, qty: 5, unit_cost: 700, pay: "cash_usd" });
    const before = await balance(gas), n = (await sql<{ n: number }[]>`select count(*)::int as n from stock_moves`)[0]!.n;
    const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "ហ្គាស", kind: "product", qty: 3, unit: "kg", unit_price: 1500 }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
    expect(await balance(gas)).toBe(before);
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "ចេញខុស" })).json.status).toBe("void");
    expect((await sql<{ n: number }[]>`select count(*)::int as n from stock_moves`)[0]!.n).toBe(n);
    const list = (await kim.req("GET", "/api/catalog")).json as any[];
    expect(list.some((i) => i.id === pipe || i.id === gas)).toBe(false);
    expect(list.some((i) => i.id === svc)).toBe(true);
  });

  it("stock card: opening, ins, outs and ending quantity and value agree; the technician and the place on an out; GM can read it", async () => {
    const today = (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;
    const c = (await inv(gm, `/card?item=${pipe}&from=${today}&to=${today}`)).json;
    expect(c.opening).toMatchObject({ qty: 0, value: 0 });
    const ins = c.rows.reduce((a: number, r: any) => a + (r.qty > 0 ? r.qty : 0), 0), outs = c.rows.reduce((a: number, r: any) => a + (r.qty < 0 ? -r.qty : 0), 0);
    expect(c.ending.qty).toBeCloseTo(ins - outs, 3);
    const last = c.rows.at(-1);
    expect(last).toMatchObject({ balance_qty: c.ending.qty, balance_value: c.ending.value });
    expect(c.rows.find((r: any) => r.place === "បុរី A ផ្ទះ 3")).toMatchObject({ kind: "out", technician: "Kim", qty: -8 });
    expect(c.rows.find((r: any) => r.ref_type === "booking")).toMatchObject({ kind: "out", technician: "Kim", ref_label: expect.stringMatching(/^BK-/) });
    expect(c.ending).toMatchObject({ qty: (await item(pipe)).qty, value: (await item(pipe)).value });
  });

  it("stock moves cannot be changed or deleted (append-only)", async () => {
    await expect(sql`update stock_moves set qty = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from stock_moves`).rejects.toThrow(/append-only/);
  });
});
