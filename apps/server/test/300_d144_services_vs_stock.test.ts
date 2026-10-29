// D-144 (CEO + One Team 13-10) — tests first. The service / price list and the stock are SEPARATE: the technician picks price-list
// lines (+ quantity) or writes «ការងារ/សម្ភារៈបន្ថែម» — never a stock item; every line reaches the job page, the draft invoice and the
// customer's «ការងាររួចរាល់» message. Stock = the Admin's warehouse only: stock in as a direct entry (the item is made on its first entry,
// total auto, posting Dr stock / Cr cash · bank · payable), stock out with the technician and the job or the place (balance, posting
// at cost 13xxx → 50001, else 50005). An invoice never moves stock. «ផ្ទៀងផ្ទាត់សម្ភារៈ»: stock out vs invoiced per job and group.
// Books: an expense before the books start is saved, never refused; «ចាប់ផ្តើមសៀវភៅបញ្ជី» posts everything dated from the start day on,
// in date order, once.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql, tx } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { postBacklog } from "../src/services/accounting.js";
import { customerNotices } from "../src/services/customer-notify.js";
import { setHubTransport } from "../src/services/hub-client.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, span, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, gm: Client, kim: Client, cfo: Client;
let inside: string, outside: string, today: string, yesterday: string, d3: string;
let a14000: string, a13001: string, copper: string, svc: string, ac: string, pipe: string, job: string, job2: string;
const H = 3_600_000;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const hubCalls: { path: string; body: any }[] = [];
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const bal = async (code: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(l.debit_cents - l.credit_cents), 0)::text as b from journal_lines l join accounts a on a.id = l.account_id
  where a.company_id = ${s.a} and a.code = ${code}`)[0]!.b);
const entries = async () => (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where company_id = ${s.a}`)[0]!.n;
const moves = async () => (await sql<{ n: number }[]>`select count(*)::int as n from stock_moves where company_id = ${s.a}`)[0]!.n;
const stockOf = async (itemId: string) => ((await inv(admin, "/items")).json as any[]).find((x) => x.item_id === itemId);
const itemByCode = async (code: string) => (await sql<{ id: string; is_stock: boolean; code: string }[]>`select id, is_stock, code from catalog_items where company_id = ${s.a} and code = ${code}`)[0];
let slotN = 0;
/** a job for kim, moved into the past and checked in (on site) */
async function onSite(customer = inside): Promise<string> {
  const id = (await admin.req("POST", "/api/bookings", { customer_id: customer, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + 400 * H).toISOString(), 120) })).json.id;
  expect((await admin.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const startMs = Date.now() - (++slotN * 4 + 2) * H;
  await sql`update bookings set scheduled_at = ${new Date(startMs)}, ends_at = ${new Date(startMs + 120 * 60_000)} where id = ${id}`;
  for (const step of ["depart", "arrive"]) expect((await kim.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200);
  return id;
}
const reviewed = async (id: string) => { for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${id}`; };

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "accounting,inventory,website";
  setHubTransport(async (_m, path, body) => { hubCalls.push({ path, body }); return { status: 200, json: { ok: true } }; });
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000008', ${hash}, false, false) returning id`)[0]!.id;
  await sql`insert into users (company_id, username, full_name, role, password_hash, is_platform) values (${s.a}, 'support', 'HangKH Support', 'admin', ${hash}, true)`;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); cfo = await loginAs(app, "cfo");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200); // the chart (D-141) + one stock item per no-sub account (D-142); the books NOT started
  const d = (await sql<{ t: string; y: string; d3: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t, ((now() at time zone 'Asia/Phnom_Penh')::date - 1)::text as y,
    ((now() at time zone 'Asia/Phnom_Penh')::date - 3)::text as d3`)[0]!;
  today = d.t; yesterday = d.y; d3 = d.d3;
  a14000 = await account("13400"); a13001 = await account("13110");
  ac = (await ceo.req("POST", "/api/catalog", { name_km: "Panasonic 1 HP", kind: "product", category: "mep", unit: "គ្រឿង", sell_price: 45000, code: "1311001", inventory_account_id: a13001 })).json.id; // a stock item without stock (D-165: no account is its own item)
  inside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី", phones: ["012 111 222"], zone: "inside" })).json.id;
  outside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្រៅបុរី", phones: ["012 111 333"], zone: "outside" })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, duration_min: 60 })).json.id;
  expect((await ceo.req("PATCH", "/api/settings/company", { books_planned_start: yesterday })).status).toBe(200);
});
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("A · the price list and the stock are separate", () => {
  it("a package-priced sale line «ទុយោស្ពាន់ (ម៉ែត្រ)» $15/m linked to 14000; stock items never appear in anyone's price list; a price-list line is never stocked", async () => {
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, stock_link_account_id: await account("50001") })).json.error).toBe("NOT_STOCK_ACCOUNT");
    const r = await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", category: "mep", unit: "ម៉ែត្រ", sell_price: 1500, stock_link_account_id: a14000, show_on_website: false });
    expect(r.status).toBe(200); copper = r.json.id;
    for (const c of [ceo, admin, kim]) {
      const list = (await c.req("GET", "/api/catalog")).json as any[];
      expect(list.some((i) => i.id === copper)).toBe(true);
      expect(list.some((i) => i.id === ac || i.code === "1311001" || i.is_stock)).toBe(false); // the stock lives on the stock page
    }
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).find((i) => i.id === copper)).toMatchObject({ stock_link_account_id: a14000, is_stock: false });
    expect(((await inv(admin, "/items")).json as any[]).some((i) => i.item_id === ac)).toBe(true);
    expect((await inv(admin, "/in", { item_id: copper, qty: 1, unit_cost: 1, pay: "cash_usd" })).json.error).toBe("NOT_STOCK_ITEM");
    expect((await inv(admin, "/in", { item_id: svc, qty: 1, unit_cost: 1, pay: "cash_usd" })).json.error).toBe("NOT_STOCK_ITEM");
  });

  it("stock in = a direct entry: name · qty · unit · unit cost · stock account → the item is made with the next code (14001), the total is automatic; the same name again = the same item; a no-sub account is its item; the warehouse only", async () => {
    const r = await inv(admin, "/in", { name: "ទុយោស្ពាន់ 6mm", account_id: a14000, unit: "ម៉ែត្រ", qty: 10, unit_cost: 200, pay: "cash_usd", supplier: "ហាងដែក", date: today });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: true, total: 2000, balance: 10 });
    pipe = r.json.item_id;
    expect(await itemByCode("1340001")).toMatchObject({ id: pipe, is_stock: true });
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).some((i) => i.id === pipe)).toBe(false);
    expect(await stockOf(pipe)).toMatchObject({ code: "1340001", qty: 10, value: 2000, avg_cost: 200, account_code: "13400", unit: "ម៉ែត្រ" });
    const again = await inv(admin, "/in", { name: "ទុយោស្ពាន់ 6mm", account_id: a14000, qty: 5, unit_cost: 200, pay: "cash_usd" });
    expect(again.json).toMatchObject({ created: false, item_id: pipe, total: 1000, balance: 15 });
    expect((await inv(admin, "/in", { item_id: ac, qty: 2, unit_cost: 30000, pay: "credit", supplier: "ហាងម៉ាស៊ីនត្រជាក់", supplier_kind: "ac" })).json).toMatchObject({ created: false, total: 60000, balance: 2 });
    expect((await inv(admin, "/in", { item_id: ac, qty: 1, total: 25000, pay: "aba" })).json).toMatchObject({ item_id: ac, total: 25000, balance: 3 }); // the account alone names its one item; a total typed instead of a unit cost
    expect((await inv(admin, "/in", { item_id: ac, qty: 1, pay: "aba" })).json.error).toBe("COST_REQUIRED");
    expect((await inv(admin, "/in", { item_id: ac, qty: 1, unit_cost: 1 })).json.error).toBe("PAY_REQUIRED");
    expect((await inv(admin, "/in", { item_id: ac, qty: 1, unit_cost: 1, pay: "aba", date: "2099-01-01" })).json.error).toBe("BAD_DATE");
    expect((await inv(admin, "/in", { name: "x", qty: 1, unit_cost: 1, pay: "aba" })).json.error).toBe("NOT_STOCK_ACCOUNT"); // a stock account is needed for a new item
    expect((await inv(admin, "/in", { name: "x", account_id: await account("50001"), qty: 1, unit_cost: 1, pay: "aba" })).json.error).toBe("NOT_STOCK_ACCOUNT");
    const locs = (await inv(admin, "/locations")).json as any[];
    expect(locs.length).toBe(1); expect(locs[0].kind).toBe("warehouse");
    expect((await inv(gm, "/items")).status).toBe(200);
    expect((await inv(gm, "/in", { item_id: ac, qty: 1, unit_cost: 1, pay: "aba" })).status).toBe(403);
    expect((await inv(kim, "/items")).status).toBe(403);
    expect(await entries()).toBe(0); // the books have not started: nothing posted yet (it waits)
  });

  it("stock out: item · qty · technician · job (or the place) · date → the balance left; a technician is needed; a job or a place; never below zero", async () => {
    job = (await admin.req("POST", "/api/bookings", { customer_id: inside, type: "A", category: "mep", service_text: "ដំឡើងទុយោ", zone: "inside", ...span(new Date(Date.now() + 30 * H).toISOString()) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    const r = await inv(admin, "/out", { item_id: pipe, qty: 6, technician_id: s.users.kim, booking_id: job, date: today });
    expect(r.status).toBe(200);
    expect(r.json.balance).toBe(9);
    expect((await sql`select kind, technician_id, ref_type, ref_id, qty::float as qty from stock_moves where id = ${r.json.id}`)[0]).toMatchObject({ kind: "out", technician_id: s.users.kim, ref_type: "booking", ref_id: job, qty: -6 });
    expect((await inv(admin, "/out", { item_id: pipe, qty: 1, technician_id: s.users.kim })).json.error).toBe("PLACE_REQUIRED");
    expect((await inv(admin, "/out", { item_id: pipe, qty: 1, technician_id: s.users.ceo, place: "x" })).json.error).toBe("TECH_NOT_FOUND");
    expect((await inv(admin, "/out", { item_id: pipe, qty: 999, technician_id: s.users.kim, booking_id: job })).json.error).toBe("INSUFFICIENT_STOCK");
    expect((await inv(admin, "/out", { item_id: copper, qty: 1, technician_id: s.users.kim, booking_id: job })).json.error).toBe("NOT_STOCK_ITEM");
    expect((await inv(admin, "/out", { item_id: ac, qty: 1, technician_id: s.users.kim, place: "បុរីពិភពថ្មី ផ្ទះ 12" })).json).toMatchObject({ balance: 2 });
    expect((await inv(kim, "/out", { item_id: pipe, qty: 1, technician_id: s.users.kim, booking_id: job })).status).toBe(403);
    const card = (await inv(admin, `/card?item=${ac}&from=${today}&to=${today}`)).json;
    expect(card.rows.at(-1)).toMatchObject({ kind: "out", technician: "Kim", place: "បុរីពិភពថ្មី ផ្ទះ 12", balance_qty: 2 });
    expect((await sql`select 1 from audit_log where action = 'stock.out' and row_id = ${String(r.json.id)}`).length).toBe(1);
  });

  it("the invoice (price-list lines) never moves stock", async () => {
    await reviewed(job);
    const n = await moves(), before = await stockOf(pipe);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job}`)).json;
    // D-189: the stock taken for the job comes along as a linked goods line (pre-filled only — the invoice never moves stock)
    expect(p.lines).toEqual([expect.objectContaining({ kind: "service", description: "ដំឡើងទុយោ" }), expect.objectContaining({ catalog_item_id: pipe, kind: "product", qty: 6 })]);
    expect(p.extra_materials).toBeUndefined();
    const i = await admin.req("POST", "/api/invoices", { booking_id: job, lines: [{ catalog_item_id: copper, description: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", qty: 5, unit: "ម៉ែត្រ", unit_price: 1500 }] });
    expect(i.status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${i.json.id}/issue`, {})).status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${i.json.id}/payments`, { amount: 7500, currency: "usd", method: "cash_usd" })).status).toBe(200);
    expect(await moves()).toBe(n);
    expect(await stockOf(pipe)).toMatchObject({ qty: before.qty, value: before.value });
    expect(await entries()).toBe(0);
  });

  it("«ផ្ទៀងផ្ទាត់សម្ភារៈ»: per job and group, stock out vs invoiced through the linked lines — 6 m out, 5 m invoiced → 1 m; filter by technician; Admin / CEO / CFO only", async () => {
    const r = await inv(admin, `/reconcile?from=${today}&to=${today}`);
    expect(r.status).toBe(200);
    const row = r.json.rows.find((x: any) => x.booking_id === job && x.group_code === "13400");
    expect(row).toMatchObject({ out_qty: 6, invoiced_qty: 5, difference: 1, technician: "Kim", customer_name: "ក្នុងបុរី", group_name: expect.any(String) });
    expect(row.booking_number).toMatch(/^BK-/);
    expect(r.json.rows.find((x: any) => x.place === "បុរីពិភពថ្មី ផ្ទះ 12")).toMatchObject({ booking_id: null, group_code: "13110", out_qty: 1, invoiced_qty: 0, difference: 1 });
    expect(r.json.totals.find((t: any) => t.group_code === "13400")).toMatchObject({ out_qty: 6, invoiced_qty: 5, difference: 1 });
    expect((await inv(admin, `/reconcile?from=${today}&to=${today}&technician=${s.users.kim}`)).json.rows.length).toBe(r.json.rows.length);
    expect((await inv(admin, `/reconcile?from=${today}&to=${today}&technician=${s.users.dara}`)).json.rows.length).toBe(0);
    expect((await inv(cfo, `/reconcile?from=${today}&to=${today}`)).status).toBe(200);
    expect((await inv(ceo, `/reconcile?from=${today}&to=${today}`)).status).toBe(200);
    expect((await inv(gm, `/reconcile?from=${today}&to=${today}`)).status).toBe(403);
    expect((await inv(kim, `/reconcile?from=${today}&to=${today}`)).status).toBe(403);
  });
});

describe("B · every line the technician adds reaches the job, the draft invoice and the customer", () => {
  it("a price-list line (+ qty, list price hidden) and «ការងារ/សម្ភារៈបន្ថែម» (text · qty · unit · photo, no price); a stock item is refused; Admin / GM see who added what", async () => {
    job2 = await onSite();
    expect((await kim.req("POST", `/api/bookings/${job2}/extras`, { kind: "service", item_id: copper, qty: 6 })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${job2}/extras`, { kind: "service", item_id: ac, qty: 1 })).json.error).toBe("SERVICE_NOT_FOUND"); // stock is not on the technician's list
    expect((await kim.req("POST", `/api/bookings/${job2}/extras`, { kind: "other", description: "ខ្សែភ្លើង 2.5", qty: 20, unit: "ម៉ែត្រ", photo: PNG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${job2}/extras`, { kind: "material", description: "x", qty: 1 })).status).toBe(400);
    expect((await kim.req("PUT", `/api/bookings/${job2}/materials`, { items: [] })).status).toBe(404); // the materials picker is gone
    const mine = (await kim.req("GET", `/api/bookings/${job2}/job`)).json;
    expect(mine.materials).toBeUndefined();
    expect(mine.extras.map((x: any) => [x.description, x.qty, x.unit, x.unit_price, x.status])).toEqual([["ទុយោស្ពាន់ (ម៉ែត្រ)", 6, "ម៉ែត្រ", null, "pending"], ["ខ្សែភ្លើង 2.5", 20, "ម៉ែត្រ", null, "pending"]]);
    expect(mine.extras[1].photo_file).toBeTruthy();
    const office = (await admin.req("GET", `/api/bookings/${job2}/job`)).json.extras;
    expect(office.map((x: any) => [x.unit_price, x.added_by, x.added_by_name, x.item_kind])).toEqual([[null, s.users.kim, "Kim", "product"], [null, s.users.kim, "Kim", null]]); // D-152: no automatic price
    expect((await gm.req("GET", `/api/bookings/${job2}/job`)).json.extras.length).toBe(2);
  });

  it("the invoice waits and names the lines; Admin prices the free line as goods; both lines are on the draft invoice and in «ការងាររួចរាល់»; stock untouched; cancel asks nothing about materials", async () => {
    await reviewed(job2);
    const wait = await admin.req("GET", `/api/invoices/prefill?booking=${job2}`);
    expect(wait.json.error).toBe("EXTRAS_PENDING");
    expect(wait.json.details.lines).toEqual(["ទុយោស្ពាន់ (ម៉ែត្រ)", "ខ្សែភ្លើង 2.5"]);
    const [x1, x2] = (await admin.req("GET", `/api/bookings/${job2}/job`)).json.extras.map((x: any) => x.id);
    expect((await admin.req("POST", `/api/bookings/${job2}/extras/${x1}/review`, { action: "confirm" })).json.error).toBe("PRICE_REQUIRED"); // D-152: the office types the price
    expect((await admin.req("POST", `/api/bookings/${job2}/extras/${x1}/review`, { action: "confirm", unit_price: 1500 })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${job2}/extras/${x2}/review`, { action: "confirm", unit_price: 100, kind: "product" })).status).toBe(200);
    const p = (await admin.req("GET", `/api/invoices/prefill?booking=${job2}`)).json;
    expect(p.lines.slice(-2)).toEqual([
      expect.objectContaining({ catalog_item_id: copper, description: "ទុយោស្ពាន់ (ម៉ែត្រ)", kind: "product", qty: 6, unit: "ម៉ែត្រ", unit_price: 1500 }),
      expect.objectContaining({ catalog_item_id: null, description: "ខ្សែភ្លើង 2.5", kind: "product", qty: 20, unit: "ម៉ែត្រ", unit_price: 100 })]);
    const n = await moves();
    await sql`update customers set tg_subscriber_id = 8101 where id = ${inside}`;
    const i = await admin.req("POST", "/api/invoices", { booking_id: job2, lines: p.lines });
    expect(i.status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${i.json.id}/issue`, {})).status).toBe(200);
    expect(await moves()).toBe(n);
    await sql`update bookings set status = 'closed', closed_at = now() where id = ${job2}`;
    hubCalls.length = 0;
    await customerNotices();
    const texts = hubCalls.filter((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === 8101).map((c) => c.body.text as string);
    const done = texts.find((x) => x.includes("ខ្សែភ្លើង 2.5")); // the first job (BK-0001, 5 m) is told in the same sweep
    expect(done).toContain("✅ ការងាររួចរាល់");
    expect(done).toContain("• ទុយោស្ពាន់ (ម៉ែត្រ) ×6");
    expect(done).toContain("• ខ្សែភ្លើង 2.5 ×20");
    // a job on site is cancelled with a reason alone (D-140 E2's materials question is gone)
    const c = await onSite(outside);
    expect((await kim.req("POST", `/api/bookings/${c}/extras`, { kind: "service", item_id: copper, qty: 1 })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${c}/cancel`, { reason: "អតិថិជនបោះបង់" })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${c}/cancel`, { reason: "x", materials_used: true })).status).toBe(400); // the field is gone
  });
});

describe("C · the books start later than the work: nothing is refused, everything is posted once at the start", () => {
  it("before the start: an expense and a journal entry are saved («រក្សាទុករួច»), the CEO / CFO banner counts what waits, nothing is in the books", async () => {
    const info = (await acc(cfo, "/lock")).json;
    expect(info).toMatchObject({ books_start: null, planned_start: yesterday });
    expect(info.pending).toMatchObject({ transactions: 0, invoices: 2, payments: 1, stock: 6 }); // 4 ins + 2 outs
    const e = await acc(cfo, "/transactions", { date: today, type: "expense", account_code: "50010", amount: 2500, pay: "cash_usd", memo: "សាំង" });
    expect(e.status).toBe(200);
    expect(e.json).toMatchObject({ pending: true, number: null });
    expect((await acc(admin, "/transactions", { date: d3, type: "expense", account_code: "50010", amount: 700, pay: "cash_usd", memo: "មុនចាប់ផ្ដើម" })).json.pending).toBe(true);
    const [a, b] = [await account("50011"), await account("11001")];
    expect((await acc(cfo, "/journal", { date: today, memo: "ជួលការិយាល័យ", lines: [{ account_id: a, debit: 30000 }, { account_id: b, credit: 30000 }] })).json).toMatchObject({ pending: true });
    expect((await acc(cfo, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 1 }, { account_id: b, credit: 2 }] })).json.error).toBe("NOT_BALANCED"); // still checked
    expect((await acc(cfo, "/transactions", { date: "2099-01-01", type: "expense", account_code: "50010", amount: 1, pay: "cash_usd" })).json.error).toBe("BAD_DATE");
    const pending = (await acc(cfo, "/pending")).json as any[];
    expect(pending.map((p) => [p.kind, p.date, p.status])).toEqual([["other", d3, "pending"], ["other", today, "pending"], ["journal", today, "pending"]]);
    expect((await acc(cfo, "/lock")).json.pending).toMatchObject({ transactions: 3, total: 12 });
    expect(await entries()).toBe(0);
    expect((await sql`select count(*)::int as n from audit_log where action = 'acct.pending'`)[0]).toMatchObject({ n: 3 });
  });

  it("«ចាប់ផ្តើមសៀវភៅបញ្ជី» (01-10 for One Team): the opening + every invoice, payment, stock move and saved transaction from the start day on, in date order, once; older saved lines are marked «before the start»", async () => {
    const r = await acc(cfo, "/opening", { date: yesterday, cash_usd: 100000 });
    expect(r.status).toBe(200);
    expect(r.json.backlog).toMatchObject({ start: yesterday, posted: 11, invoices: 2, payments: 1, deposits: 0, stock: 6, transactions: 2, before_start: 1, failed: 0 });
    expect(r.json.open_invoices).toBe(0); // issued after the start day → posted as invoices, not as opening balances
    expect(((await acc(cfo, "/pending")).json as any[]).map((p) => p.status)).toEqual(["before_start"]);
    expect((await sql<{ st: string[] }[]>`select array_agg(status order by entry_date, created_at) as st from pending_postings where company_id = ${s.a}`)[0]!.st).toEqual(["before_start", "posted", "posted"]);
    expect(await entries()).toBe(12); // the opening + 11
    const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    expect(tb.balanced).toBe(true);
    expect(await bal("13400")).toBe(3000 - 1200);         // 15 m in at $2 − 6 m out at cost
    expect(await bal("13110")).toBe(85000 - 28333);       // 3 in ($600 + $250) − 1 out at the average
    expect(await bal("50001")).toBe(28333 + 1200);        // D-175: every stock but 14500 → 50001 (the AC and the copper)
    expect(await bal("50005")).toBe(0);
    expect(await bal("20001")).toBe(-60000);              // on credit — an AC: owed on 20001 (D-175)
    expect(await bal("11003")).toBe(-25000);              // paid by ABA
    expect(await bal("11001")).toBe(100000 - 3000 + 7500 - 2500 - 30000);
    expect(await bal("12002")).toBe(7500 + 11000 - 7500);
    expect(await bal("40004")).toBe(-(7500 + 11000));     // sales inside the borey (D-141)
    expect(await bal("50010")).toBe(2500); expect(await bal("50011")).toBe(30000);
    // once: a second run posts nothing (every source already has its entry)
    const user = { id: s.users.cfo!, companyId: s.a, role: "cfo", username: "cfo", fullName: "CFO A", mustChangePassword: false, language: "km", sessionId: "x" } as const;
    expect(await tx(null, (t) => postBacklog(t, user, yesterday))).toMatchObject({ posted: 0 });
    expect(await entries()).toBe(12);
    expect((await sql`select source, source_id from journal_entries where company_id = ${s.a} and source_id is not null group by 1, 2 having count(*) > 1`).length).toBe(0);
    expect((await acc(cfo, "/opening", { date: yesterday, cash_usd: 1 })).json.error).toBe("OPENING_DONE");
    expect((await acc(cfo, "/lock")).json).toMatchObject({ books_start: yesterday, pending: null });
  });

  it("after the start a transaction posts at once; the month-end stock equals the books' stock accounts", async () => {
    const e = await acc(cfo, "/transactions", { date: today, type: "expense", account_code: "50010", amount: 1000, pay: "cash_usd", memo: "សាំង" });
    expect(e.json.number).toMatch(/^JE-/);
    expect(await bal("50010")).toBe(3500);
    const m = (await inv(admin, `/month-end?to=${today}`)).json;
    expect(m.difference).toBe(0);
    expect(m.accounts.find((a: any) => a.code === "13400")).toMatchObject({ qty: 9, value: 1800, balance: 1800, difference: 0 });
    expect(m.accounts.find((a: any) => a.code === "13110")).toMatchObject({ qty: 2, value: 56667, balance: 56667, difference: 0 });
  });
});

describe("D · One Team's set-up by HangKH Support (shop-setup)", () => {
  it("a new price-list line by code with its stock link (never stock) and the planned books start (01-10-2026); dry run writes nothing", async () => {
    const input = { books_start: "2026-10-01", catalog: [{ code: "CU-M", name_km: "ទុយោស្ពាន់ (ម៉ែត្រ) B", kind: "product" as const, unit: "ម៉ែត្រ", sell_price: 1500, stock_link: "13400" }] };
    const plan = await shopSetup("oneteam", input, false);
    expect(plan.some((l) => /CU-M new: .* stock link 13400/.test(l))).toBe(true);
    expect(plan.some((l) => /books start \(planned\): 2026-10-01/.test(l))).toBe(true);
    expect(await itemByCode("CU-M")).toBeUndefined();
    await shopSetup("oneteam", input, true);
    const it = (await sql<{ is_stock: boolean; link: string | null; kind: string; show: boolean }[]>`select is_stock, stock_link_account_id as link, kind::text as kind, show_on_website as show from catalog_items where company_id = ${s.a} and code = 'CU-M'`)[0]!;
    expect(it).toMatchObject({ is_stock: false, link: a14000, kind: "product", show: false });
    expect((await sql<{ p: string }[]>`select books_planned_start::text as p from company_settings where company_id = ${s.a}`)[0]!.p).toBe("2026-10-01");
    expect(((await kim.req("GET", "/api/catalog")).json as any[]).some((i) => i.code === "CU-M")).toBe(true); // on the technician's list
  });
});
