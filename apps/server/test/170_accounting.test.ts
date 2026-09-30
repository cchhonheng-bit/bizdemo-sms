// STEP 4 Part C (D-88): double-entry accounting (flag "accounting") — chart of accounts, opening balances (the books start there),
// journal (balance, immutability, reversal, period lock), automatic postings, other transactions, payroll, reports, isolation — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, cfo: Client, kim: Client, ceoB: Client;
let cust: string, prod: string, prod2: string, today: string, yesterday: string, start: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const code = async (c: string, who?: Client) => ((await acc(who ?? cfo, "/accounts")).json as any[]).find((a) => a.code === c)!;
/** balance of an account (debit − credit, cents) up to today */
const bal = async (c: string) => ((await acc(cfo, `/trial-balance?to=${today}`)).json.rows as any[]).find((r) => r.code === c)?.balance ?? 0;
const tbOk = async () => { const tb = (await acc(cfo, `/trial-balance?to=${today}`)).json; expect(tb.total_debit).toBe(tb.total_credit); expect(tb.balanced).toBe(true); return tb; };
const entries = async () => (await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`)[0]!.n;
const invoice = async (lines: { kind: "service" | "product"; qty: number; unit_price: number; catalog_item_id?: string }[]) =>
  (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: lines.map((l) => ({ description: "x", unit: "unit", ...l })) })).json.id as string;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "accounting,inventory";
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  cust = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន គណនេយ្យ", phones: ["012626262"], zone: "inside" })).json.id;
  prod = (await ceo.req("POST", "/api/catalog", { name_km: "ខ្សែភ្លើង", kind: "product", category: "mep", unit: "m", sell_price: 200 })).json.id;
  prod2 = (await ceo.req("POST", "/api/catalog", { name_km: "បំពង់", kind: "product", category: "mep", unit: "pcs", sell_price: 300 })).json.id;
  const d = (await sql<{ t: string; y: string; s: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t, ((now() at time zone 'Asia/Phnom_Penh')::date - 1)::text as y,
    ((now() at time zone 'Asia/Phnom_Penh')::date - 3)::text as s`)[0]!;
  today = d.t; yesterday = d.y; start = d.s;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("C1 chart of accounts", () => {
  it("Cambodian SME template; permitted staff add / edit; unused non-system account can be deleted; GM / technician have no access", async () => {
    const list = (await acc(cfo, "/accounts")).json as any[];
    for (const c of ["1010", "1011", "1020", "1021", "1100", "1200", "2010", "2020", "2100", "3010", "3020", "3900", "4010", "4020", "4090", "4900", "5010", "5020", "6010", "6020", "6030", "6950"])
      expect(list.map((a) => a.code)).toContain(c);
    expect((await acc(admin, "/accounts", { code: "6150", name_km: "ថ្លៃសម្អាត", name_en: "Cleaning", type: "expense" })).status).toBe(200);
    expect((await acc(admin, "/accounts", { code: "6150", name_km: "x", type: "expense" })).json.error).toBe("CODE_EXISTS");
    expect((await acc(admin, "/accounts", { code: "7abc", name_km: "x", type: "expense" })).status).toBe(400);
    const c6150 = await code("6150");
    expect((await acc(admin, "/accounts", { id: c6150.id, code: "6150", name_km: "ថ្លៃសម្អាតការិយាល័យ", type: "expense" })).status).toBe(200);
    expect((await code("6150")).name_km).toBe("ថ្លៃសម្អាតការិយាល័យ");
    const cash = await code("1010");
    expect((await acc(admin, "/accounts", { id: cash.id, code: "1010", name_km: "x", type: "asset", is_active: false })).json.error).toBe("SYSTEM_ACCOUNT");
    expect((await admin.req("DELETE", `/api/accounting/accounts/${cash.id}`)).json.error).toBe("SYSTEM_ACCOUNT");
    expect((await admin.req("DELETE", `/api/accounting/accounts/${c6150.id}`)).status).toBe(200);
    expect((await acc(gm, "/accounts")).status).toBe(403);
    expect((await acc(kim, "/accounts")).status).toBe(403);
    expect((await kim.req("POST", "/api/accounting/accounts", { code: "6160", name_km: "x", type: "expense" })).status).toBe(403);
  });

  it("before the opening balances nothing posts: journal → OPENING_REQUIRED; invoices / stock stay out of the books", async () => {
    const [a, b] = [(await code("6030")).id, (await code("1010")).id];
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 100 }, { account_id: b, credit: 100 }] })).json.error).toBe("OPENING_REQUIRED");
    // before go-live: an issued invoice with a part payment, stock of another product
    const i = await invoice([{ kind: "service", qty: 1, unit_price: 5000 }]);
    await admin.req("POST", `/api/invoices/${i}/issue`);
    await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 1000, currency: "usd", method: "cash_usd" });
    const wh = ((await admin.req("GET", "/api/inventory/locations")).json as any[]).find((l) => l.kind === "warehouse").id;
    await admin.req("POST", `/api/inventory/items/${prod2}/track`, { track: true });
    await admin.req("POST", "/api/inventory/opening", { item_id: prod2, location_id: wh, qty: 10, unit_cost: 150 });
    expect(await entries()).toBe(0);
  });
});

describe("opening balances (go-live)", () => {
  it("CFO only; cash, banks, payables as entered + open invoices, stock and deposits from the app + old debts as opening invoices; balanced by opening equity; locks before", async () => {
    const body = { date: start, cash_usd: 20000, cash_khr: 400000, banks: { aba: 150000, acleda: 50000 },
      receivables: [{ customer_id: cust, amount: 12000, note: "វិក្កយបត្រក្រដាស" }], payables: [{ supplier: "ហាងស៊ីម៉ង់ត៍", amount: 8000 }] };
    expect((await acc(admin, "/opening", body)).status).toBe(403);
    expect((await acc(cfo, "/opening", { ...body, date: "2099-01-01" })).json.error).toBe("BAD_DATE");
    const r = await acc(cfo, "/opening", body);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ open_invoices: 1, opening_invoices: ["OB-0001"] });
    expect(r.json.opening_equity).toBe(20000 + 10000 + 150000 + 50000 + 12000 + 4000 + 1500 - 8000);
    expect(await bal("1010")).toBe(20000); expect(await bal("1011")).toBe(10000); expect(await bal("1020")).toBe(150000); expect(await bal("1021")).toBe(50000);
    expect(await bal("1100")).toBe(16000); expect(await bal("1200")).toBe(1500); expect(await bal("2010")).toBe(-8000); expect(await bal("3900")).toBe(-r.json.opening_equity);
    const debt = ((await admin.req("GET", "/api/invoices/debts")).json as any[]).find((d) => d.customer_id === cust);
    expect(debt.total).toBe(16000); // the old paper debt is collectable like any invoice
    const dash = (await ceo.req("GET", "/api/reports/dashboard")).json;
    expect(dash.today.revenue).toBe(5000); // … but it is not revenue
    expect((await acc(cfo, "/opening", body)).json.error).toBe("OPENING_DONE");
    const lock = (await acc(cfo, "/lock")).json;
    expect(lock).toMatchObject({ books_start: start });
    expect(lock.lock_date < start).toBe(true);
    await tbOk();
  });
});

describe("C2 journal: balance, immutability, reversal, period lock", () => {
  it("an entry must balance with ≥ 2 one-sided lines in integer cents; the KHR rate is stored; posted lines cannot be changed or deleted", async () => {
    const [a, b] = [(await code("6030")).id, (await code("1010")).id];
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 100 }, { account_id: b, credit: 99 }] })).json.error).toBe("NOT_BALANCED");
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 100 }] })).status).toBe(400);
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 1.5 }, { account_id: b, credit: 1.5 }] })).status).toBe(400);
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: a, debit: 100, credit: 100 }, { account_id: b, credit: 0 }] })).status).toBe(400);
    expect((await acc(admin, "/journal", { date: "2099-01-01", memo: "x", lines: [{ account_id: a, debit: 1 }, { account_id: b, credit: 1 }] })).json.error).toBe("BAD_DATE");
    const r = await acc(admin, "/journal", { date: today, memo: "សាំង", lines: [{ account_id: a, debit: 2500, memo: "សាំងឡាន 01" }, { account_id: b, credit: 2500 }] });
    expect(r.status).toBe(200);
    const e = (await acc(cfo, `/journal/${r.json.id}`)).json;
    expect(e).toMatchObject({ status: "posted", fx_rate_khr: 4000, source: "manual", reversible: true, number: expect.stringMatching(/^JE-\d{4}-\d{4}$/) });
    expect(e.lines.map((l: any) => [l.code, l.debit, l.credit])).toEqual([["6030", 2500, 0], ["1010", 0, 2500]]);
    await expect(sql`update journal_lines set debit_cents = 1 where entry_id = ${r.json.id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from journal_lines where entry_id = ${r.json.id}`).rejects.toThrow(/immutable/);
    await expect(sql`delete from journal_entries where id = ${r.json.id}`).rejects.toThrow(/immutable/);
    // the database refuses an unbalanced entry even when the app is bypassed
    await expect(sql.begin(async (t) => {
      const id = (await t<{ id: string }[]>`insert into journal_entries (company_id, number, entry_date, memo, source, fx_rate_khr) values (${s.a}, 'JE-X-1', ${today}::date, 'x', 'manual', 4000) returning id`)[0]!.id;
      await t`insert into journal_lines (entry_id, company_id, account_id, debit_cents) values (${id}, ${s.a}, ${a}, 5)`;
    })).rejects.toThrow(/NOT_BALANCED/);
    await tbOk();
  });

  it("a posted entry is corrected by a reversal (reason), never edited; twice is refused; automatic entries are corrected at their source", async () => {
    const [a, b] = [(await code("6030")).id, (await code("1010")).id];
    const before = await bal("6030");
    const id = (await acc(admin, "/journal", { date: today, memo: "វាយខុស", lines: [{ account_id: a, debit: 900 }, { account_id: b, credit: 900 }] })).json.id;
    expect(await bal("6030")).toBe(before + 900);
    expect((await acc(admin, `/journal/${id}/reverse`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    const rev = await acc(admin, `/journal/${id}/reverse`, { reason: "ចំនួនខុស" });
    expect(rev.status).toBe(200);
    expect(await bal("6030")).toBe(before);
    expect((await acc(admin, `/journal/${id}/reverse`, { reason: "ម្ដងទៀត" })).json.error).toBe("ALREADY_REVERSED");
    expect((await acc(admin, `/journal/${rev.json.id}/reverse`, { reason: "ម្ដងទៀត" })).json.error).toBe("NOT_REVERSIBLE");
    expect((await acc(cfo, `/journal/${id}`)).json).toMatchObject({ status: "reversed", reversible: false, reversed_by: { number: rev.json.number } });
    const opening = ((await acc(cfo, `/journal?from=${start}&to=${today}&source=opening`)).json as any[])[0];
    expect((await acc(admin, `/journal/${opening.id}/reverse`, { reason: "ចង់កែ" })).json.error).toBe("AUTO_ENTRY");
    await tbOk();
  });

  it("CFO locks the books up to a date: nothing on or before it (manual or automatic); a reversal is dated today; re-opening needs a reason", async () => {
    const [a, b] = [(await code("6030")).id, (await code("1010")).id];
    const early = (await acc(admin, "/journal", { date: yesterday, memo: "ម្សិលមិញ", lines: [{ account_id: a, debit: 300 }, { account_id: b, credit: 300 }] })).json.id;
    expect((await acc(admin, "/lock", { lock_date: yesterday })).status).toBe(403);
    expect((await acc(cfo, "/lock", { lock_date: today })).json.error).toBe("BAD_DATE");
    expect((await acc(cfo, "/lock", { lock_date: yesterday })).status).toBe(200);
    expect((await acc(admin, "/journal", { date: yesterday, memo: "late", lines: [{ account_id: a, debit: 1 }, { account_id: b, credit: 1 }] })).json.error).toBe("PERIOD_LOCKED");
    expect((await acc(admin, "/journal", { date: today, memo: "ok", lines: [{ account_id: a, debit: 1 }, { account_id: b, credit: 1 }] })).status).toBe(200);
    const rev = await acc(admin, `/journal/${early}/reverse`, { reason: "ខុសថ្ងៃ" });
    expect(rev.status).toBe(200);
    expect((await acc(cfo, `/journal/${rev.json.id}`)).json.date).toBe(today);
    const i = await invoice([{ kind: "service", qty: 1, unit_price: 1000 }]);
    await admin.req("POST", `/api/invoices/${i}/issue`);
    expect((await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 100, currency: "usd", method: "cash_usd", paid_on: yesterday })).json.error).toBe("PERIOD_LOCKED");
    expect((await admin.req("GET", `/api/invoices/${i}`)).json.paid).toBe(0); // the whole payment was refused, not only its posting
    expect((await acc(cfo, "/lock", { lock_date: start })).json.error).toBe("REASON_REQUIRED");
    expect((await acc(cfo, "/lock")).json.lock_date).toBe(yesterday);
    const audit = await sql`select 1 from audit_log where action = 'acct.lock' and company_id = ${s.a}`;
    expect(audit.length).toBe(1);
  });
});

describe("C3 automatic postings from the app", () => {
  it("invoice issue: Dr receivable / Cr service + product revenue, discount as contra-revenue; payment: Dr cash-bank / Cr receivable at its own rate; void reverses", async () => {
    const [ar, svc, sales, disc, cashUsd, aba] = await Promise.all(["1100", "4010", "4020", "4900", "1010", "1020"].map(bal));
    const id = await invoice([{ kind: "service", qty: 1, unit_price: 10000 }, { kind: "product", qty: 2, unit_price: 2500 }]);
    await ceo.req("POST", `/api/invoices/${id}/discount`, { amount: 1000 });
    await admin.req("POST", `/api/invoices/${id}/issue`);
    expect(await bal("1100")).toBe(ar + 14000);
    expect(await bal("4010")).toBe(svc - 10000);
    expect(await bal("4020")).toBe(sales - 5000);
    expect(await bal("4900")).toBe(disc + 1000);
    await admin.req("POST", `/api/invoices/${id}/payments`, { amount: 4000, currency: "usd", method: "cash_usd" });
    await admin.req("POST", `/api/invoices/${id}/payments`, { amount: 40000, currency: "khr", method: "aba" }); // $10.00 at 4000
    expect(await bal("1010")).toBe(cashUsd + 4000);
    expect(await bal("1020")).toBe(aba + 1000);
    expect(await bal("1100")).toBe(ar + 14000 - 5000);
    const p = (await admin.req("GET", `/api/invoices/${id}`)).json.payments[0].id;
    await ceo.req("POST", `/api/payments/${p}/void`, { reason: "វាយខុស" });
    expect(await bal("1010")).toBe(cashUsd);
    expect(await bal("1100")).toBe(ar + 14000 - 1000);
    // a voided invoice (no payments) reverses its revenue
    const v = await invoice([{ kind: "service", qty: 1, unit_price: 700 }]);
    await admin.req("POST", `/api/invoices/${v}/issue`);
    const svc2 = await bal("4010");
    await ceo.req("POST", `/api/invoices/${v}/void`, { reason: "វាយខុសអតិថិជន" });
    expect(await bal("4010")).toBe(svc2 + 700);
    await tbOk();
  });

  it("rate snapshots: every entry keeps the rate of its record; a new rate never changes old entries", async () => {
    const before = ((await acc(cfo, `/journal?from=${start}&to=${today}&source=payment`)).json as any[]).map((e) => e.id);
    await ceo.req("POST", "/api/settings/fx", { rate: 4200 });
    const i = await invoice([{ kind: "service", qty: 1, unit_price: 4200 }]);
    await admin.req("POST", `/api/invoices/${i}/issue`);
    await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 42000, currency: "khr", method: "cash_khr" }); // $10.00 at 4200
    const pays = (await acc(cfo, `/journal?from=${start}&to=${today}&source=payment`)).json as any[];
    const fresh = pays.find((e) => !before.includes(e.id));
    expect((await acc(cfo, `/journal/${fresh.id}`)).json).toMatchObject({ fx_rate_khr: 4200 });
    for (const id of before) expect((await acc(cfo, `/journal/${id}`)).json.fx_rate_khr).toBe(4000);
    await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  });

  it("stock in on credit: Dr inventory / Cr payable; loss adjustment at average cost; job use: Dr cost of sales / Cr inventory; inventory account = stock value", async () => {
    const wh = ((await admin.req("GET", "/api/inventory/locations")).json as any[]).find((l) => l.kind === "warehouse").id;
    await admin.req("POST", `/api/inventory/items/${prod}/track`, { track: true });
    const [inv0, ap0, adj0, cogs0] = await Promise.all(["1200", "2010", "5020", "5010"].map(bal));
    await admin.req("POST", "/api/inventory/in", { item_id: prod, location_id: wh, qty: 10, unit_cost: 150, pay: "credit", supplier: "ហាងអគ្គិសនី" });
    expect(await bal("1200")).toBe(inv0 + 1500);
    expect(await bal("2010")).toBe(ap0 - 1500);
    await admin.req("POST", "/api/inventory/adjust", { item_id: prod, location_id: wh, qty: -2, reason: "ខូច" });
    expect(await bal("1200")).toBe(inv0 + 1200);
    expect(await bal("5020")).toBe(adj0 + 300);
    // a job uses 3 m (Admin confirms)
    const b = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ភ្លើង", zone: "inside", scheduled_at: when() })).json.id;
    await sql`insert into booking_materials (booking_id, catalog_item_id, qty) values (${b}, ${prod}, 3)`;
    await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] });
    for (const st of ["on_site", "work_done"]) await sql`update bookings set status = ${st}::booking_status where id = ${b}`;
    expect((await admin.req("POST", `/api/inventory/jobs/${b}/confirm`, { location_id: wh })).status).toBe(200);
    expect(await bal("5010")).toBe(cogs0 + 450);
    const items = (await admin.req("GET", "/api/inventory/items")).json as any[];
    expect(await bal("1200")).toBe(items.reduce((x, i) => x + i.value, 0)); // books = stock value
    await tbOk();
  });

  it("deposit: Dr cash / Cr customer deposits; applied at issue: Dr deposits / Cr receivable; cash close over / short (re-count replaces it)", async () => {
    const b = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "B", category: "construction", service_text: "ជញ្ជាំង", zone: "inside", scheduled_at: when() })).json.id;
    const q = (await gm.req("POST", "/api/quotes", { booking_id: b, lines: [{ description: "ជញ្ជាំង", kind: "service", qty: 1, unit: "job", unit_price: 30000 }] })).json.id;
    await gm.req("POST", `/api/quotes/${q}/accept`);
    const [dep0, cash0] = await Promise.all(["2020", "1010"].map(bal));
    await admin.req("POST", `/api/bookings/${b}/deposits`, { amount: 10000, currency: "usd", method: "cash_usd" });
    expect(await bal("2020")).toBe(dep0 - 10000);
    expect(await bal("1010")).toBe(cash0 + 10000);
    await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${b}`;
    const i = (await admin.req("POST", "/api/invoices", { booking_id: b, lines: [{ description: "ជញ្ជាំង", kind: "service", qty: 1, unit: "job", unit_price: 30000 }] })).json.id;
    await admin.req("POST", `/api/invoices/${i}/issue`);
    expect(await bal("2020")).toBe(dep0);          // the deposit moved to the invoice
    expect(await bal("1010")).toBe(cash0 + 10000); // no second cash
    const cs0 = await bal("6950"), c0 = await bal("1010");
    const cc = (await admin.req("GET", `/api/reports/cash-close?from=${today}&to=${today}`)).json[0];
    expect(cc.expected_usd).toBeGreaterThanOrEqual(10000); // the cash deposit is in today's expected cash
    await admin.req("POST", "/api/reports/cash-close", { day: today, counted_usd: cc.expected_usd - 200, counted_khr: cc.expected_khr });
    expect(await bal("6950")).toBe(cs0 + 200);     // $2 short → expense
    await admin.req("POST", "/api/reports/cash-close", { day: today, counted_usd: cc.expected_usd - 500, counted_khr: cc.expected_khr });
    expect(await bal("6950")).toBe(cs0 + 500);     // re-count replaces, never adds
    expect(await bal("1010")).toBe(c0 - 500);
    await tbOk();
  });
});

describe("C4 other transactions", () => {
  it("expense (USD / riel, receipt photo), purchase on credit + supplier payment, other income, owner in / out, cash → bank; each balanced and audited", async () => {
    const t = (v: Record<string, unknown>, who = admin) => who.req("POST", "/api/accounting/transactions", { date: today, ...v });
    const [fuel, cash, cashKhr, bank, cap, draw, oth, ap, equip] = await Promise.all(["6030", "1010", "1011", "1020", "3010", "3020", "4090", "2010", "1500"].map(bal));
    const png = Buffer.concat([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), Buffer.alloc(40, 1)]).toString("base64");
    const e1 = await t({ type: "expense", account_code: "6030", amount: 1500, pay: "cash_usd", memo: "សាំង", attachment: png });
    expect(e1.status).toBe(200);
    const withPhoto = (await acc(cfo, `/journal/${e1.json.id}`)).json;
    expect(withPhoto.attachment_id).toBeTruthy();
    expect((await app.inject({ method: "GET", url: `/api/accounting/files/${withPhoto.attachment_id}`, headers: { cookie: cfo.cookie! } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/api/files/${withPhoto.attachment_id}`, headers: { cookie: gm.cookie! } })).statusCode).toBe(404); // receipts: accounting only
    expect((await t({ type: "expense", account_code: "6030", amount: 50000, currency: "khr", pay: "cash_khr", memo: "សាំង" })).status).toBe(200); // 50,000៛ = $12.50
    expect((await t({ type: "purchase", account_code: "1500", amount: 20000, pay: "credit", supplier: "ហាងឧបករណ៍" })).status).toBe(200);
    expect((await t({ type: "supplier_payment", amount: 5000, pay: "aba", supplier: "ហាងឧបករណ៍" })).status).toBe(200);
    expect((await t({ type: "other_income", amount: 700, pay: "aba", memo: "លក់ក្រដាសចាស់" })).status).toBe(200);
    expect((await t({ type: "owner_contribution", amount: 50000, pay: "aba", memo: "ដាក់ដើមទុន" })).status).toBe(200);
    expect((await t({ type: "owner_withdrawal", amount: 2000, pay: "cash_usd", memo: "ដកប្រើផ្ទាល់ខ្លួន" })).status).toBe(200);
    expect((await t({ type: "transfer", amount: 3000, from: "cash_usd", to: "aba", memo: "ដាក់ធនាគារ" })).status).toBe(200);
    expect((await t({ type: "expense", account_code: "4010", amount: 1, pay: "cash_usd" })).json.error).toBe("WRONG_ACCOUNT_TYPE");
    expect((await t({ type: "other_income", amount: 1, pay: "credit" })).json.error).toBe("BAD_METHOD");
    expect((await t({ type: "transfer", amount: 1, from: "aba", to: "aba" })).json.error).toBe("SAME_ACCOUNT");
    expect((await t({ type: "expense", account_code: "6030", amount: 1, pay: "cash_usd" }, gm)).status).toBe(403);
    expect(await bal("6030")).toBe(fuel + 1500 + 1250);
    expect(await bal("1010")).toBe(cash - 1500 - 2000 - 3000);
    expect(await bal("1011")).toBe(cashKhr - 1250);
    expect(await bal("1020")).toBe(bank - 5000 + 700 + 50000 + 3000);
    expect(await bal("1500")).toBe(equip + 20000);
    expect(await bal("2010")).toBe(ap - 20000 + 5000);
    expect(await bal("3010")).toBe(cap - 50000);
    expect(await bal("3020")).toBe(draw + 2000);
    expect(await bal("4090")).toBe(oth - 700);
    expect((await sql`select 1 from audit_log where action = 'acct.transaction' and company_id = ${s.a}`).length).toBe(8);
    await tbOk();
  });
});

describe("C6 payroll with adjustments (CEO approval)", () => {
  it("base salaries → run → bonus / deduction lines with reason → CEO approves (not Admin / CFO) → posts; paying clears the payable; locked after approval", async () => {
    expect((await acc(admin, `/payroll/salary/${s.users.kim}`, { base_salary: 30000 })).status).toBe(200);
    expect((await acc(admin, `/payroll/salary/${s.users.dara}`, { base_salary: 25000 })).status).toBe(200);
    const period = today.slice(0, 7);
    const run = (await acc(admin, "/payroll", { period })).json;
    expect(run.lines.map((l: any) => l.base).sort()).toEqual([25000, 30000]);
    expect((await acc(admin, "/payroll", { period })).json.error).toBe("PAYROLL_EXISTS");
    expect((await acc(admin, `/payroll/${run.id}/adjust`, { user_id: s.users.kim, kind: "bonus", amount: 5000, reason: "" })).json.error).toBe("REASON_REQUIRED");
    await acc(admin, `/payroll/${run.id}/adjust`, { user_id: s.users.kim, kind: "bonus", amount: 5000, reason: "ការងារល្អ" });
    await acc(admin, `/payroll/${run.id}/adjust`, { user_id: s.users.dara, kind: "deduction", amount: 2000, reason: "អវត្តមាន ២ ថ្ងៃ" });
    const wrong = (await acc(admin, `/payroll/${run.id}/adjust`, { user_id: s.users.dara, kind: "bonus", amount: 999, reason: "វាយខុស" })).json.id;
    expect((await acc(admin, `/payroll/${run.id}/adjust/${wrong}/remove`, {})).status).toBe(200);
    const r = (await acc(cfo, `/payroll/${run.id}`)).json;
    expect(r).toMatchObject({ status: "draft", gross: 60000, deductions: 2000, net: 58000 });
    expect((await acc(admin, `/payroll/${run.id}/approve`, {})).status).toBe(403);
    expect((await acc(cfo, `/payroll/${run.id}/approve`, {})).status).toBe(403);
    const [sal, bon, pay, bank] = await Promise.all(["6010", "6020", "2100", "1020"].map(bal));
    expect((await acc(ceo, `/payroll/${run.id}/approve`, {})).status).toBe(200);
    expect(await bal("6010")).toBe(sal + 55000 - 2000);
    expect(await bal("6020")).toBe(bon + 5000);
    expect(await bal("2100")).toBe(pay - 58000);
    expect((await acc(admin, `/payroll/${run.id}/adjust`, { user_id: s.users.kim, kind: "bonus", amount: 1, reason: "late" })).json.error).toBe("PAYROLL_LOCKED");
    expect((await acc(admin, `/payroll/${run.id}/pay`, { pay: "aba" })).status).toBe(200);
    expect(await bal("2100")).toBe(pay);
    expect(await bal("1020")).toBe(bank - 58000);
    expect((await acc(ceo, `/payroll/${run.id}/void`, { reason: "ចង់កែ" })).json.error).toBe("PAYROLL_PAID");
    expect((await acc(kim, `/payroll/${run.id}`)).status).toBe(403);
    expect((await acc(gm, "/payroll")).status).toBe(403);
    const acts = (await sql<{ action: string }[]>`select action from audit_log where action like 'payroll.%' and company_id = ${s.a}`).map((a) => a.action);
    for (const a of ["payroll.salary", "payroll.create", "payroll.adjust", "payroll.adjust_remove", "payroll.approve", "payroll.pay"]) expect(acts).toContain(a);
    await tbOk();
  });
});

describe("C5 reports + isolation", () => {
  it("trial balance always balances; P&L = income − expenses; balance sheet: assets = liabilities + equity + profit; ledger running balance; KHR; CSV", async () => {
    const tb = await tbOk();
    expect(tb.rows.length).toBeGreaterThan(10);
    const pl = (await acc(cfo, `/pl?from=${start}&to=${today}`)).json;
    expect(pl.net).toBe(pl.income_total - pl.expense_total);
    expect(pl.income.find((r: any) => r.code === "4010").amount).toBeGreaterThan(0);
    const bs = (await acc(cfo, `/balance-sheet?to=${today}`)).json;
    expect(bs.assets_total).toBe(bs.liabilities_total + bs.equity_total + bs.current_earnings);
    expect(bs.current_earnings).toBe(pl.net); // nothing before the go-live date
    expect(bs.fx_rate_khr).toBe(4000); expect(bs.assets_total_khr).toBe(Math.round(bs.assets_total / 100 * 4000 / 100) * 100);
    const cash = await code("1010");
    const gl = (await acc(cfo, `/ledger?account=${cash.id}&from=${start}&to=${today}`)).json;
    expect(gl.opening).toBe(0);
    expect(gl.rows.at(-1).balance).toBe(gl.closing);
    expect(gl.closing).toBe(await bal("1010"));
    for (const k of ["trial-balance", "pl", "balance-sheet", "journal"]) {
      const csv = await app.inject({ method: "GET", url: `/api/accounting/${k}.csv?from=${start}&to=${today}`, headers: { cookie: cfo.cookie! } });
      expect(csv.statusCode).toBe(200);
      expect(csv.headers["content-type"]).toContain("text/csv"); expect(csv.body.charCodeAt(0)).toBe(0xfeff);
    }
    expect((await acc(gm, `/pl?from=${start}&to=${today}`)).status).toBe(403);
    expect((await acc(kim, `/balance-sheet?to=${today}`)).status).toBe(403);
  });

  it("tenant isolation: another company's accounts and entries do not exist here, and theirs stay empty", async () => {
    const theirs = await code("6030", ceoB);
    const mine = await code("1010");
    expect(theirs.id).not.toBe((await code("6030")).id);
    expect((await acc(admin, "/journal", { date: today, memo: "x", lines: [{ account_id: theirs.id, debit: 1 }, { account_id: mine.id, credit: 1 }] })).status).toBe(404);
    const anyEntry = ((await acc(cfo, `/journal?from=${start}&to=${today}`)).json as any[])[0];
    expect((await acc(ceoB, `/journal/${anyEntry.id}`)).status).toBe(404);
    expect(((await acc(ceoB, `/trial-balance?to=${today}`)).json.rows as any[]).length).toBe(0);
    expect((await acc(ceoB, `/ledger?account=${mine.id}&from=${start}&to=${today}`)).status).toBe(404);
  });

  it("the module is off → routes do not exist and nothing is posted", async () => {
    config.shop.features = "inventory";
    expect((await acc(cfo, "/accounts")).status).toBe(404);
    const n0 = await entries();
    const i = await invoice([{ kind: "service", qty: 1, unit_price: 500 }]);
    await admin.req("POST", `/api/invoices/${i}/issue`);
    expect(await entries()).toBe(n0);
    config.shop.features = "accounting,inventory";
  });
});
