// D-178 (owner 26-10): the accounts follow Accounting everywhere — one account map by id (Accounting → Setup, CEO / CFO), the stock
// accounts = the ones under the mapped stock headers, item code = account code + 2 digits and it follows the account, each stock
// movement keeps its own account, payables by the supplier's type, an account in use is never switched off or deleted.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client, gm: Client;
let today: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string) => (await sql<{ id: string; code: string; name_km: string; is_active: boolean }[]>`select id, code, name_km, is_active from accounts where company_id = ${s.a} and code = ${code}`)[0]!;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const item = async (id: string) => (await sql<{ code: string; acc: string }[]>`select ci.code, a.code as acc from catalog_items ci join accounts a on a.id = ci.inventory_account_id where ci.id = ${id}`)[0]!;
const setMap = (c: Client, key: string, account_id: string) => c.req("PUT", "/api/accounting/mapping", { key, account_id });

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); gm = await loginAs(app, "gm01");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  expect((await acc(cfo, "/opening", { date: today, cash_usd: 1000000 })).status).toBe(200); // the books run
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-178 one account map, by id", () => {
  it("the old role column is gone; the map holds every posting key + the two stock headers; CEO / CFO change it, the GM / Admin read only; the account type must fit", async () => {
    expect((await sql`select 1 from information_schema.columns where table_name = 'accounts' and column_name = 'role'`).length).toBe(0);
    const m = (await acc(cfo, "/mapping")).json;
    expect(m.can_edit).toBe(true);
    const by = Object.fromEntries((m.keys as any[]).map((k) => [k.key, k.account?.code]));
    expect(by).toMatchObject({ cash_usd: "11001", bank_acleda: "11002", bank_aba: "11003", ar: "12002", staff_advance: "12001", deposits: "20004", tips: "20005",
      rev_sales: "40001", rev_sales_inside: "40004", rev_service: "40002", rev_service_inside: "40005", cogs: "50001", materials: "50005",
      ap_ac: "20001", ap_washing: "20002", ap: "20003", current_profit: "30002", retained: "30003", stock_new: "13000", stock_second_hand: "18000", inventory: "14500" });
    expect((await acc(gm, "/mapping")).status).toBe(403); // no accounting.view
    expect((await setMap(admin, "discount", (await account("50011")).id)).status).toBe(403);
    expect((await setMap(cfo, "discount", (await account("11001")).id)).json.error).toBe("MAP_WRONG_ACCOUNT"); // an asset for a discount
    expect((await setMap(cfo, "stock_new", (await account("13110")).id)).json.error).toBe("MAP_WRONG_ACCOUNT"); // a header needs a group
    expect((await setMap(cfo, "nonsense", (await account("50011")).id)).status).toBe(404);
  });

  it("receive stock → the item's own stock account; stock out → cost of goods 50001; the consumables' stock (map «inventory») → 50005", async () => {
    const r = (await inv(admin, "/in", { name: "Daikin 1 HP", account_id: (await account("13210")).id, qty: 2, total: 60000, pay: "cash_usd" })).json;
    expect(await item(r.item_id)).toEqual({ code: "132101", acc: "13210" });
    expect(await bal("13210")).toBe(60000);
    expect((await inv(admin, "/out", { item_id: r.item_id, qty: 1, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect([await bal("13210"), await bal("50001")]).toEqual([30000, 30000]);
    const tape = (await inv(admin, "/in", { name: "ស្កុត", account_id: (await account("14500")).id, unit: "pcs", qty: 10, unit_cost: 50, pay: "cash_usd" })).json.item_id;
    expect((await inv(admin, "/out", { item_id: tape, qty: 4, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect(await bal("50005")).toBe(200);
  });

  it("the account's code / name change in Accounting → the item code, the stock card, the journal and the exports show the new code at once (ids kept)", async () => {
    const a = await account("13210"), it0 = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${s.a} and code = '132101'`)[0]!.id;
    const r = await acc(cfo, "/accounts", { id: a.id, code: "13250", name_km: "ម៉ាស៊ីនត្រជាក់ Daikin (ថ្មី)", type: "asset" }); // used + holds an item: a recode is allowed
    expect(r.status).toBe(200); expect(r.json.recoded_items).toBe(1);
    expect(await item(it0)).toEqual({ code: "132501", acc: "13250" });
    const stock = (await inv(admin, "/items")).json as any[];
    expect(stock.find((x) => x.item_id === it0)).toMatchObject({ code: "132501", account_code: "13250", account_name: "ម៉ាស៊ីនត្រជាក់ Daikin (ថ្មី)" });
    const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    expect(tb.rows.find((x: any) => x.code === "13250")?.balance).toBe(30000);
    expect(tb.rows.some((x: any) => x.code === "13210")).toBe(false);
    const gl = await acc(cfo, `/ledger?code=13250&from=${today}&to=${today}`);
    expect(gl.status).toBe(200); expect(JSON.stringify(gl.json)).not.toContain("13210");
    const x = await app.inject({ method: "GET", url: `/api/export/stock-moves.xlsx?from=${today}&to=${today}`, headers: { cookie: admin.cookie! } });
    expect(x.statusCode).toBe(200);
    const rows = readWorkbook(x.rawPayload)[0]!.rows.flat().join(" ");
    expect(rows).toContain("13250"); expect(rows).toContain("132501"); expect(rows).not.toContain("132101");
    expect((await acc(cfo, "/accounts", { id: a.id, code: "13250", name_km: "x", type: "expense" })).json.error).toBe("ACCOUNT_USED"); // the type stays
  });

  it("an item remapped to another stock account: new movements use the new account (new code), the old ones keep theirs", async () => {
    const it0 = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${s.a} and code = '132501'`)[0]!.id;
    const to = await account("13220");
    const r = await ceo.req("POST", "/api/catalog", { id: it0, name_km: "Daikin 1 HP", kind: "product", category: "mep", unit: "unit", sell_price: 100, inventory_account_id: to.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await item(it0)).toEqual({ code: "132201", acc: "13220" });
    expect((await inv(admin, "/in", { item_id: it0, qty: 1, total: 32000, pay: "cash_usd" })).status).toBe(200);
    expect([await bal("13250"), await bal("13220")]).toEqual([30000, 32000]); // the old receipt and stock out stay on 13250
    const moves = await sql<{ code: string }[]>`select a.code from stock_moves m join accounts a on a.id = m.account_id where m.item_id = ${it0} order by m.id`;
    expect(moves.map((m) => m.code)).toEqual(["13250", "13250", "13220"]);
  });

  it("a borey customer's invoice → 40004 sales / 40005 service; outside → 40001 / 40002", async () => {
    const mk = async (zone: string, phone: string) => (await admin.req("POST", "/api/customers", { province_code: "12", district_code: "1212", commune_code: "121201", name: `C ${zone}`, phones: [phone], zone })).json.id;
    const inside = await mk("inside", "012 400 400"), outside = await mk("outside", "012 400 401");
    const issue = async (customer_id: string) => {
      const r = await admin.req("POST", "/api/invoices", { customer_id, lines: [{ description: "service", kind: "service", qty: 1, unit_price: 2000 }, { description: "goods", kind: "product", qty: 1, unit_price: 3000 }] });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect((await admin.req("POST", `/api/invoices/${r.json.id}/issue`, {})).status).toBe(200);
    };
    const b0 = await Promise.all(["40001", "40002", "40004", "40005"].map(bal));
    await issue(inside); await issue(outside);
    const b1 = await Promise.all(["40001", "40002", "40004", "40005"].map(bal));
    expect(b1.map((x, i) => x - b0[i]!)).toEqual([-3000, -2000, -3000, -2000]);
  });

  it("payables by the supplier's type: air conditioners → 20001, washing machines → 20002, other → 20003; the type is remembered per supplier", async () => {
    const ac = (await account("13310")).id, wm = (await account("14100")).id;
    expect((await inv(admin, "/in", { name: "LG 1 HP", account_id: ac, qty: 1, total: 40000, pay: "credit", supplier: "AC Co", supplier_kind: "ac" })).status).toBe(200);
    expect((await inv(admin, "/in", { name: "LG 8 kg", account_id: wm, qty: 1, total: 25000, pay: "credit", supplier: "WM Co", supplier_kind: "washing" })).status).toBe(200);
    expect((await inv(admin, "/in", { name: "LG 1.5 HP", account_id: ac, qty: 1, total: 45000, pay: "credit", supplier: "ac co " })).status).toBe(200); // same supplier → AC again
    expect((await inv(admin, "/in", { name: "LG fridge", account_id: (await account("14200")).id, qty: 1, total: 10000, pay: "credit", supplier: "New shop" })).status).toBe(200);
    expect([await bal("20001"), await bal("20002"), await bal("20003")]).toEqual([-85000, -25000, -10000]);
    // a CFO remap of «other suppliers» to another liability: new receipts follow it
    const other = (await sql<{ id: string }[]>`insert into accounts (company_id, code, name_km, type, parent_code) values (${s.a}, '20006', 'ជំពាក់ផ្សេងទៀត', 'liability', '20000') returning id`)[0]!.id;
    expect((await setMap(cfo, "ap", other)).status).toBe(200);
    expect((await inv(admin, "/in", { name: "Wire", account_id: (await account("13700")).id, qty: 1, total: 700, pay: "credit", supplier: "Wire shop" })).status).toBe(200);
    expect([await bal("20003"), await bal("20006")]).toEqual([-10000, -700]);
  });

  it("switching off or deleting an account still mapped or linked to items is refused, with where it is used", async () => {
    const cash = await account("11001");
    const r = await acc(cfo, "/accounts", { id: cash.id, code: "11001", name_km: cash.name_km, type: "asset", is_active: false });
    expect(r.status).toBe(409); expect(r.json.error).toBe("ACCOUNT_IN_USE");
    expect(r.json.details.mappings).toEqual(expect.arrayContaining(["cash_usd"]));
    const wm = await account("14100");
    const w = await acc(cfo, "/accounts", { id: wm.id, code: "14100", name_km: wm.name_km, type: "asset", is_active: false });
    expect(w.json.error).toBe("ACCOUNT_IN_USE"); expect(w.json.details.items.join(" ")).toContain("LG 8 kg");
    expect((await admin.req("DELETE", `/api/accounting/accounts/${(await account("13600")).id}`)).status).toBe(200); // nothing points at it → may go
    const spare = (await sql<{ id: string }[]>`insert into accounts (company_id, code, name_km, type, parent_code) values (${s.a}, '50099', 'ល្បង', 'expense', '50000') returning id`)[0]!.id;
    expect((await setMap(cfo, "stock_adjust", spare)).status).toBe(200);
    expect((await admin.req("DELETE", `/api/accounting/accounts/${spare}`)).json.error).toBe("ACCOUNT_IN_USE");
    expect(await account("11001")).toMatchObject({ is_active: true });
    expect(await sql`select 1 from journal_lines where company_id = ${s.a} having coalesce(sum(debit_cents), 0) <> coalesce(sum(credit_cents), 0)`).toHaveLength(0); // still balanced
  });
});

describe("D-179 an item leaves the stock (stock card «លុបទំនិញនេះ»)", () => {
  it("never used → deleted; used → switched off, hidden from the stock lists, its history kept; refused while in stock; technicians never", async () => {
    const floor = (await account("13330")).id;
    const unused = (await ceo.req("POST", "/api/catalog", { name_km: "LG floor (sample)", kind: "product", category: "mep", unit: "unit", sell_price: 0, inventory_account_id: floor })).json.id;
    expect((await admin.req("DELETE", `/api/inventory/items/${unused}`)).json).toEqual({ removed: "deleted" });
    expect(await sql`select 1 from catalog_items where id = ${unused}`).toHaveLength(0);
    const used = (await inv(admin, "/in", { name: "LG floor 5 HP", account_id: floor, qty: 1, total: 90000, pay: "cash_usd" })).json.item_id;
    expect((await admin.req("DELETE", `/api/inventory/items/${used}`)).json.error).toBe("ITEM_HAS_STOCK");
    expect((await inv(admin, "/out", { item_id: used, qty: 1, technician_id: s.users.kim, place: "ហាង" })).status).toBe(200);
    expect((await (await loginAs(app, "kim")).req("DELETE", `/api/inventory/items/${used}`)).status).toBe(403);
    expect((await admin.req("DELETE", `/api/inventory/items/${used}`)).json).toEqual({ removed: "off" });
    expect(((await inv(admin, "/items")).json as any[]).some((x) => x.item_id === used)).toBe(false);
    expect((await inv(admin, `/card?item=${used}&from=${today}&to=${today}`)).json.rows).toHaveLength(2); // the receipt and the stock out stay
    expect(await sql`select 1 from journal_lines where company_id = ${s.a} having coalesce(sum(debit_cents), 0) <> coalesce(sum(credit_cents), 0)`).toHaveLength(0);
  });
});
