// STEP 4 Part B (D-87): inventory (flag "inventory") — locations, opening, stock in/out, weighted-average cost, adjustments,
// transfers, stock card, job materials confirmed by Admin, direct sales, no negative stock, low-stock alert — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
let pipe: string, gas: string, svc: string, cust: string, wh: string, van: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const item = async (id: string) => ((await inv(admin, "/items")).json as any[]).find((x) => x.item_id === id);
const balance = async (id: string, loc: string) => (await item(id))?.by_location.find((l: any) => l.location_id === loc)?.qty ?? 0;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "inventory";
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  pipe = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោ PVC", kind: "product", category: "mep", unit: "m", sell_price: 250 })).json.id;
  gas = (await ceo.req("POST", "/api/catalog", { name_km: "ហ្គាស R32", kind: "product", category: "mep", unit: "kg", sell_price: 1500 })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុល", kind: "service", category: "mep", unit: "job", sell_price: 3000 })).json.id;
  cust = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន ស្តុក", phones: ["012616161"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("locations + tracking", () => {
  it("a warehouse and one location per vehicle exist by default; Admin adds more; GM views only; technicians never", async () => {
    const l = (await inv(admin, "/locations")).json as any[];
    expect(l.find((x) => x.kind === "warehouse")).toBeTruthy();
    expect(l.filter((x) => x.kind === "vehicle").map((x) => x.vehicle_code).sort()).toEqual(["01", "02"]);
    wh = l.find((x) => x.kind === "warehouse").id; van = l.find((x) => x.vehicle_code === "01").id;
    expect((await inv(admin, "/locations", { name: "ឃ្លាំង 2", kind: "warehouse" })).status).toBe(200);
    expect((await inv(gm, "/locations")).status).toBe(200);
    expect((await inv(gm, "/locations", { name: "x", kind: "warehouse" })).status).toBe(403);
    expect((await inv(kim, "/locations")).status).toBe(403);
    expect((await inv(admin, `/items/${pipe}/track`, { track: true, reorder_level: 5 })).status).toBe(200);
    expect((await inv(admin, `/items/${gas}/track`, { track: true })).status).toBe(200);
    expect((await inv(admin, `/items/${svc}/track`, { track: true })).json.error).toBe("NOT_A_PRODUCT");
  });

  it("the module is off → 404", async () => {
    config.shop.features = "";
    expect((await inv(admin, "/items")).status).toBe(404);
    config.shop.features = "inventory";
  });
});

describe("weighted-average cost (integer cents, exact to the last cent)", () => {
  it("opening + stock in at different costs → average; out uses the average; the last unit takes the remaining value", async () => {
    expect((await inv(admin, "/opening", { item_id: pipe, location_id: wh, qty: 10, unit_cost: 500 })).status).toBe(200);   // 10 × $5
    expect((await inv(admin, "/opening", { item_id: pipe, location_id: wh, qty: 1, unit_cost: 500 })).json.error).toBe("OPENING_EXISTS");
    expect((await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 10, unit_cost: 600, supplier: "ហាងដែក", pay: "cash_usd" })).status).toBe(200); // 10 × $6
    let i = await item(pipe);
    expect(i).toMatchObject({ qty: 20, value: 11000, avg_cost: 550 });
    expect((await inv(admin, "/adjust", { item_id: pipe, location_id: wh, qty: -5, reason: "ខូច" })).status).toBe(200);
    i = await item(pipe);
    expect(i).toMatchObject({ qty: 15, value: 8250 });
    expect((await inv(admin, "/adjust", { item_id: pipe, location_id: wh, qty: -15, reason: "ខូចទាំងអស់" })).status).toBe(200);
    expect(await item(pipe)).toMatchObject({ qty: 0, value: 0 });                       // nothing left → no value left
  });

  it("thirds: 3 units for 100 cents go out as 33 + 34 + 33 — the sum is exactly 100", async () => {
    await inv(admin, "/in", { item_id: gas, location_id: wh, qty: 3, total: 100, pay: "credit", supplier: "Supplier A" });
    const outs: number[] = [];
    for (let k = 0; k < 3; k++) { await inv(admin, "/adjust", { item_id: gas, location_id: wh, qty: -1, reason: "សាកល្បង" }); outs.push(Number((await sql`select value_cents from stock_moves where item_id = ${gas} order by id desc limit 1`)[0]!.value_cents)); }
    expect(outs.map((x) => -x)).toEqual([33, 34, 33]);
    expect(await item(gas)).toMatchObject({ qty: 0, value: 0 });
  });

  it("fractional quantities (2.5 m) and validation: qty > 0, reason for adjustments, cost ≥ 0, other company's item 404", async () => {
    await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 2.5, unit_cost: 400, pay: "aba" });
    expect(await item(pipe)).toMatchObject({ qty: 2.5, value: 1000 });
    expect((await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 0, unit_cost: 1, pay: "aba" })).status).toBe(400);
    expect((await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 1, unit_cost: -1, pay: "aba" })).status).toBe(400);
    expect((await inv(admin, "/adjust", { item_id: pipe, location_id: wh, qty: -1, reason: "" })).json.error).toBe("REASON_REQUIRED");
    const ceoB = await loginAs(app, "ceo_b");
    expect((await inv(ceoB, "/in", { item_id: pipe, location_id: wh, qty: 1, unit_cost: 1, pay: "aba" })).status).toBe(404);
  });
});

describe("no negative stock, transfers, low stock", () => {
  it("out or transfer beyond what the location holds is refused; transfer moves quantity, not value", async () => {
    await inv(admin, "/in", { item_id: pipe, location_id: wh, qty: 20, unit_cost: 400, pay: "cash_usd" }); // wh = 22.5
    expect((await inv(admin, "/transfer", { item_id: pipe, from: wh, to: van, qty: 50 })).json.error).toBe("INSUFFICIENT_STOCK");
    const before = await item(pipe);
    expect((await inv(admin, "/transfer", { item_id: pipe, from: wh, to: van, qty: 10 })).status).toBe(200);
    expect(await balance(pipe, van)).toBe(10); expect(await balance(pipe, wh)).toBe(12.5);
    expect(await item(pipe)).toMatchObject({ qty: before.qty, value: before.value });
    expect((await inv(admin, "/adjust", { item_id: pipe, location_id: van, qty: -11, reason: "ខូច" })).json.error).toBe("INSUFFICIENT_STOCK");
    expect((await inv(admin, "/transfer", { item_id: pipe, from: wh, to: wh, qty: 1 })).json.error).toBe("SAME_LOCATION");
  });

  it("below the reorder level → one alert to inventory managers (not repeated the same day)", async () => {
    const n = async () => (await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = ${s.users.admin!} and kind = 'stock.low'`)[0]!.n;
    await sql`update stock_items set low_alerted_on = null where item_id = ${pipe}`; // a new day (it already alerted today when it ran out)
    const before = await n();
    await inv(admin, "/adjust", { item_id: pipe, location_id: wh, qty: -10, reason: "សាកល្បង" }); // total 22.5 → 12.5
    await inv(admin, "/adjust", { item_id: pipe, location_id: van, qty: -8, reason: "សាកល្បង" });  // 12.5 → 4.5 < 5
    expect(await n()).toBe(before + 1);
    await inv(admin, "/adjust", { item_id: pipe, location_id: van, qty: -1, reason: "សាកល្បង" });  // still low: no second alert
    expect(await n()).toBe(before + 1);
    expect((await item(pipe)).low).toBe(true);
  });
});

describe("job materials (technician records, Admin confirms → stock out)", () => {
  let job: string;
  it("pending list → confirm from the job's vehicle → out at average cost; materials locked; twice refused; technicians cannot confirm", async () => {
    await inv(admin, "/in", { item_id: gas, location_id: van, qty: 10, unit_cost: 700, pay: "cash_usd" });
    job = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "បំពេញហ្គាស", zone: "inside", scheduled_at: when(), service_item_id: svc })).json.id;
    await gm.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [], vehicle_id: (await sql`select id from vehicles where code = '01' and company_id = ${s.a}`)[0]!.id });
    for (const st of ["on_site", "working"]) await sql`update bookings set status = ${st}::booking_status where id = ${job}`;
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: gas, qty: 2 }] })).status).toBe(200);
    await sql`update bookings set status = 'work_done' where id = ${job}`;
    const pending = (await inv(admin, "/jobs/pending")).json as any[];
    expect(pending.find((p) => p.booking_id === job)).toMatchObject({ suggested_location_id: van });
    expect((await inv(kim, `/jobs/${job}/confirm`, {})).status).toBe(403);
    expect((await inv(admin, `/jobs/${job}/confirm`, {})).status).toBe(200);
    expect(await balance(gas, van)).toBe(8);
    const out = (await sql`select value_cents from stock_moves where ref_id = ${job} and kind = 'out_job'`)[0]!;
    expect(Number(out.value_cents)).toBe(-1400);
    expect((await inv(admin, `/jobs/${job}/confirm`, {})).json.error).toBe("ALREADY_CONFIRMED");
    await sql`update bookings set status = 'pending_review' where id = ${job}`;
    await sql`update bookings set status = 'revision' where id = ${job}`;
    expect((await kim.req("PUT", `/api/bookings/${job}/materials`, { items: [{ catalog_item_id: gas, qty: 5 }] })).json.error).toBe("MATERIALS_CONFIRMED");
  });
});

describe("direct sale + stock card + immutable moves", () => {
  it("a direct-sale invoice takes stock at issue; its void puts it back", async () => {
    const before = await balance(gas, wh);
    await inv(admin, "/in", { item_id: gas, location_id: wh, qty: 5, unit_cost: 700, pay: "cash_usd" });
    const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ catalog_item_id: gas, description: "ហ្គាស", kind: "product", qty: 3, unit: "kg", unit_price: 1500 }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
    expect(await balance(gas, wh)).toBe(before + 2);
    const big = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ catalog_item_id: gas, description: "ហ្គាស", kind: "product", qty: 999, unit: "kg", unit_price: 1 }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${big}/issue`)).json.error).toBe("INSUFFICIENT_STOCK");
    expect((await ceo.req("POST", `/api/invoices/${id}/void`, { reason: "ចេញខុស" })).json.status).toBe("void");
    expect(await balance(gas, wh)).toBe(before + 5);
  });

  it("stock card: opening, ins, outs and ending quantity and value agree; GM can read it", async () => {
    const today = (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;
    const c = (await inv(gm, `/card?item=${gas}&from=${today}&to=${today}`)).json;
    expect(c.opening).toMatchObject({ qty: 0, value: 0 });
    const ins = c.rows.reduce((a: number, r: any) => a + (r.qty > 0 ? r.qty : 0), 0), outs = c.rows.reduce((a: number, r: any) => a + (r.qty < 0 ? -r.qty : 0), 0);
    expect(c.ending.qty).toBeCloseTo(ins - outs, 3);
    const last = c.rows.at(-1);
    expect(last).toMatchObject({ balance_qty: c.ending.qty, balance_value: c.ending.value });
    expect(c.ending).toMatchObject({ qty: (await item(gas)).qty, value: (await item(gas)).value });
  });

  it("stock moves cannot be changed or deleted (append-only)", async () => {
    await expect(sql`update stock_moves set qty = 1`).rejects.toThrow(/append-only/);
    await expect(sql`delete from stock_moves`).rejects.toThrow(/append-only/);
  });
});
