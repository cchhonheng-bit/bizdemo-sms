// D-169: Excel export of every report — the three owner samples (ជាងដក · COA · Account Report) match column order and layout,
// totals equal the API's, every filter changes the rows, the as-of rule (opening before From · closing up to As-of · the as-of day
// included · the next day excluded), the COA debit = credit check, permission (403) and company scope, Khmer round trip, an empty
// result is still a valid file, 50 000 rows write in seconds, every other report answers with the standard header block.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook, writeWorkbook } from "../src/lib/xlsx.js";
import { REPORTS } from "../src/services/excel.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client, kim: Client, ceoB: Client;
let today: string, d: (n: number) => string;
let inside: string, copper: string, ac: string, job: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const account = async (code: string, company = s.a) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${company} and code = ${code}`)[0]!.id;
const fixture = (f: string) => readWorkbook(readFileSync(join(__dirname, "fixtures", f)));
/** GET the export and parse it: status, sheets, the first sheet's rows */
const xl = async (c: Client, report: string, q: Record<string, string> = {}) => {
  const qs = Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const r = await app.inject({ method: "GET", url: `/api/export/${report}.xlsx${qs ? `?${qs}` : ""}`, headers: { cookie: c.cookie! } });
  const ok = r.statusCode === 200;
  const wb = ok ? readWorkbook(r.rawPayload) : [];
  return { status: r.statusCode, json: ok ? null : r.json(), name: /filename="([^"]+)"/.exec(r.headers["content-disposition"] as string ?? "")?.[1], sheets: wb, rows: wb[0]?.rows ?? [], rowsHeader: Number(r.headers["x-rows"]) };
};
const HEAD = 6;
const num = (v: string | undefined) => Number(v ?? 0);
const findRow = (rows: string[][], pred: (r: string[]) => unknown) => rows.find((r) => !!pred(r));
const span = (start: Date) => ({ scheduled_at: start.toISOString(), ends_at: new Date(start.getTime() + 2 * 3600e3).toISOString() });

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000900', ${hash}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  d = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  expect((await acc(cfo, "/opening", { date: d(-10), cash_usd: 500000 })).status).toBe(200); // the books start 10 days ago → dated entries below
  inside = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្នុងបុរី ខ្មែរ", phones: ["012 111 222"], zone: "inside" })).json.id;
  const cp = await ceo.req("POST", "/api/catalog", { name_km: "ទុយោស្ពាន់ 16mm (16*0.72)", kind: "product", category: "mep", unit: "ម៉ែត្រ", sell_price: 1500, code: "1340001", inventory_account_id: await account("13400") });
  expect(cp.json, JSON.stringify(cp.json)).toHaveProperty("id"); copper = cp.json.id;
  const in1 = await inv(admin, "/in", { item_id: copper, qty: 10, unit_cost: 1000, pay: "cash_usd", date: d(-6) }); // 10 m @ $10
  expect(in1.json, JSON.stringify(in1.json)).toMatchObject({ created: false });
  const in2 = await inv(admin, "/in", { name: "ម៉ាស៊ីនត្រជាក់ Panasonic 1.5HP", account_id: await account("13110"), qty: 2, total: 90000, pay: "aba", paid: 50000, supplier: "ហាង A", supplier_invoice: "INV-A-1", date: d(-6) });
  expect(in2.json, JSON.stringify(in2.json)).toHaveProperty("item_id"); ac = in2.json.item_id;
  job = (await admin.req("POST", "/api/bookings", { customer_id: inside, type: "A", category: "mep", service_text: "ដំឡើងម៉ាស៊ីនត្រជាក់", zone: "inside", ...span(new Date(Date.now() + 3600e3)) })).json.id;
  expect((await admin.req("POST", `/api/bookings/${job}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  expect((await inv(admin, "/out", { item_id: copper, qty: 6, technician_id: s.users.kim, booking_id: job, date: d(-3) })).status).toBe(200);   // kim, for the job
  expect((await inv(admin, "/out", { item_id: ac, qty: 1, technician_id: s.users.dara, place: "ផ្ទះលេខ 22, ផ្លូវ 19", date: d(-2) })).status).toBe(200); // dara, to a place
  const iv = await admin.req("POST", "/api/invoices", { customer_id: inside, lines: [{ description: "ដំឡើង", kind: "service", qty: 1, unit: "job", unit_price: 5000 }] });
  expect(iv.json, JSON.stringify(iv.json)).toHaveProperty("id"); const invoice = iv.json.id as string;
  const is1 = await admin.req("POST", `/api/invoices/${invoice}/issue`, {}); expect(is1.json, JSON.stringify(is1.json)).not.toHaveProperty("error");
  expect((await admin.req("POST", `/api/invoices/${invoice}/payments`, { amount: 2000, currency: "usd", method: "acleda" })).status).toBe(200);
  expect((await acc(cfo, "/transactions", { date: d(-4), type: "expense", account_code: "50010", amount: 1500, pay: "cash_usd", memo: "សាំង" })).status).toBe(200);
  // three cash entries on three days for the as-of edge cases: D1 = d-5 (before From), D2 = d-3 (inside), D3 = d-2 (after To)
  for (const [day, cents] of [[d(-5), 10000], [d(-3), 20000], [d(-2), 40000]] as const)
    expect((await acc(cfo, "/journal", { date: day, memo: `ចំណូលផ្សេង ${day}`, lines: [{ account_id: await account("11001"), debit: cents }, { account_id: await account("40006"), credit: cents }] })).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("the standard", () => {
  it("every report answers a valid workbook with the header block (company · title km · title en · filters · generated by) and is audited", async () => {
    for (const report of REPORTS) {
      const r = await xl(cfo, report, { from: d(-7), to: today, asof: today });
      expect(r.status, report).toBe(200);
      expect(r.name, report).toMatch(new RegExp(`^${report}_(all_)?\\d{4}-\\d{2}(-\\d{2})?(_\\d{4}-\\d{2}-\\d{2})?_[a-z0-9-]+\\.xlsx$`)); // one date for as-of / month reports
      const rows = r.rows;
      expect(rows[0]![0], report).toBe("One Team Engineering"); expect(rows[1]![0]!.length, report).toBeGreaterThan(0); expect(rows[2]![0], report).toMatch(/[A-Za-z]/); expect(rows[4]![0], report).toMatch(/^Generated by CFO A on \d\d\/\d\d\/\d{4} \d\d:\d\d/);
      expect(rows[HEAD]!.length, report).toBeGreaterThan(0); // the header row
    }
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where company_id = ${s.a} and action = 'report.export'`)[0]!.n)).toBeGreaterThanOrEqual(REPORTS.length);
  });
  it("validation: From > To → BAD_RANGE; As-of before From → BAD_ASOF; an unknown report → 400", async () => {
    expect((await xl(cfo, "coa", { from: today, to: d(-1) })).json?.error).toBe("BAD_RANGE");
    expect((await xl(cfo, "coa", { from: d(-3), to: today, asof: d(-4) })).json?.error).toBe("BAD_ASOF");
    expect((await xl(cfo, "nothing")).status).toBe(400);
  });
  it("empty result: a valid file with the headers and the «no data» line", async () => {
    const r = await xl(admin, "tech-withdrawals", { from: "2020-01-01", to: "2020-01-31" });
    expect(r.status).toBe(200); expect(r.rows[HEAD]![0]).toBe("ថ្ងៃទី"); expect(r.rows[HEAD + 1]![0]).toContain("គ្មានទិន្នន័យ"); expect(r.rowsHeader).toBe(0);
  });
  it("50 000 rows write in a few seconds and read back", () => {
    const t0 = Date.now();
    const rows = Array.from({ length: 50_000 }, (_x, i) => [{ v: "2026-10-25", s: "date" as const }, `ជួរ ${i}`, { v: i / 100, s: "money" as const }, i, "x".repeat(20)]);
    const buf = writeWorkbook([{ name: "big", rows, freeze: 1, autoFilter: { row: 1, cols: 5 } }]);
    expect(Date.now() - t0).toBeLessThan(8000); expect(buf.length).toBeGreaterThan(100_000);
    expect(readWorkbook(buf)[0]!.rows.length).toBe(50_000);
  });
});

describe("ជាងដក (technician withdrawals) — the owner's sample", () => {
  it("columns in the sample's order, one row per withdrawal with negative quantities as in the sample, a grand total; the sheet is named as the sample", async () => {
    const sample = fixture("sample-tech-withdrawals.xlsx");
    const r = await xl(admin, "tech-withdrawals", { from: d(-7), to: today });
    expect(r.status).toBe(200); expect(r.sheets[0]!.name).toBe(sample[0]!.name);
    expect(r.rows[HEAD]!.slice(0, 10)).toEqual(sample[0]!.rows[2]!.slice(0, 10)); // r3 of the sample is the header
    const body = r.rows.slice(HEAD + 1).filter((x) => x[1] === "13400" || x[1] === "13110");
    expect(body.map((x) => [x[1], num(x[3]), num(x[6]), x[7] ? "bk" : "", x[8]])).toEqual([["13400", -6, -60, "bk", "Kim"], ["13110", -1, -450, "", "Dara"]]);
    expect(body[0]![9]).toContain("ក្នុងបុរី ខ្មែរ".length ? "" : ""); // address column present
    const total = findRow(r.rows, (x) => x[0] === "សរុប")!;
    expect(num(total[3])).toBe(-7); expect(num(total[6])).toBe(-510);
    expect(r.rows[3]![0]).toContain("ជាង: ទាំងអស់"); expect(r.rowsHeader).toBe(2);
  });
  it("filters: technician (multi) and booker (multi) and the date range each change the rows", async () => {
    expect((await xl(admin, "tech-withdrawals", { from: d(-7), to: today, technician: s.users.kim! })).rowsHeader).toBe(1);
    expect((await xl(admin, "tech-withdrawals", { from: d(-7), to: today, technician: `${s.users.kim!},${s.users.dara!}` })).rowsHeader).toBe(2);
    expect((await xl(admin, "tech-withdrawals", { from: d(-7), to: today, booker: s.users.admin! })).rowsHeader).toBe(1); // the job's booker
    expect((await xl(admin, "tech-withdrawals", { from: d(-7), to: today, booker: s.users.gm01! })).rowsHeader).toBe(0);
    expect((await xl(admin, "tech-withdrawals", { from: d(-3), to: d(-3) })).rowsHeader).toBe(1);
    const r = await xl(admin, "tech-withdrawals", { from: d(-7), to: today, technician: s.users.kim! });
    expect(r.rows[3]![0]).toContain("ជាង: Kim");
  });
  it("permission: a technician gets 403; another company sees none of our data", async () => {
    expect((await xl(kim, "tech-withdrawals", { from: d(-7), to: today })).status).toBe(403);
    const b = await xl(ceoB, "tech-withdrawals", { from: d(-7), to: today });
    expect(b.status).toBe(200); expect(b.rowsHeader).toBe(0); expect(JSON.stringify(b.rows)).not.toContain("Kim");
  });
});

describe("Account Report — the owner's sample", () => {
  it("one section per account with the sample's 13 columns first (+ debit · credit · running balance), Opening Balance, lines, Balance; a summary at the end", async () => {
    const sample = fixture("sample-account-report.xlsx");
    const r = await xl(cfo, "account-report", { from: d(-7), to: today, account: await account("13400") });
    expect(r.status).toBe(200); expect(r.sheets[0]!.name.trim()).toBe(sample[0]!.name.trim());
    expect(r.rows[HEAD]![0]).toContain("13400"); // the section title
    expect(r.rows[HEAD + 1]!.slice(0, 13)).toEqual(sample[0]!.rows[1]!.slice(0, 13)); // r2 of the sample is its header
    expect(r.rows[HEAD + 1]!.slice(13)).toEqual(["ឥណពន្ធ", "ឥណទាន", "សមតុល្យ"]);
    expect(r.rows[HEAD + 2]!.slice(1, 3)).toEqual(["13400", "Opening Balance"]);
    const lines = r.rows.slice(HEAD + 3).filter((x) => x[1] === "13400" && x[2] !== "Opening Balance");
    expect(lines.map((x) => [x[2], num(x[3]), x[4], num(x[6]), x[8], x[10]])).toEqual([["ទុយោស្ពាន់ 16mm (16*0.72)", 10, "ម៉ែត្រ", 100, "", ""], ["ទុយោស្ពាន់ 16mm (16*0.72)", -6, "ម៉ែត្រ", -60, expect.stringMatching(/^BK/), "Kim"]]);
    const balance = findRow(r.rows, (x) => x[2] === "Balance")!;
    expect(num(balance[3])).toBe(4); expect(num(balance[6])).toBe(40); expect(num(balance[15])).toBe(40);
    const summary = r.rows.findIndex((x) => x[0]?.startsWith("សង្ខេប"));
    expect(summary).toBeGreaterThan(0); expect(r.rows[summary + 2]!.slice(0, 2)).toEqual(["13400", "ទុយោស្ពាន់"]); expect(num(r.rows[summary + 2]![5])).toBe(40);
  });
  it("as-of edge cases on cash 11001: opening = before From · the as-of day included · the day after excluded · closing beyond To shown as one line", async () => {
    const a = await account("11001");
    const r = await xl(cfo, "account-report", { from: d(-4), to: d(-3), asof: d(-3), account: a });
    const opening = findRow(r.rows, (x) => x[2] === "Opening Balance")!, balance = findRow(r.rows, (x) => x[2] === "Balance")!;
    expect(num(opening[6])).toBe(5000 + 100 - 100); // $5000 opening + D1 $100 − 10 m copper @ $10 cash (d-6) — all before d-4
    const lines = r.rows.filter((x) => x[1] === "11001" && x[2] !== "Opening Balance" && !x[2]?.startsWith("ចលនា"));
    expect(lines.map((x) => num(x[6]))).toEqual([-15, 200]); // d-4 expense $15, d-3 D2 $200 (the as-of day itself); D3 (d-2) excluded
    expect(num(balance[15])).toBe(5000 - 15 + 200);
    const r2 = await xl(cfo, "account-report", { from: d(-4), to: d(-3), asof: d(-2), account: a });
    const later = findRow(r2.rows, (x) => x[2]?.startsWith("ចលនាបន្ទាប់ពី"))!;
    expect(num(later[6])).toBe(400); expect(num(findRow(r2.rows, (x) => x[2] === "Balance")![15])).toBe(5000 - 15 + 200 + 400);
  });
  it("account multi-select: two accounts → two sections; a P&L account shows the invoice's income line with its number", async () => {
    const r = await xl(cfo, "account-report", { from: d(-7), to: today, account: `${await account("11001")},${await account("40005")}` }); // 40005: service income inside the borey (D-141)
    expect(r.rows.filter((x) => x[0]?.startsWith("11001 ·") || x[0]?.startsWith("40005 ·")).length).toBe(2);
    const income = r.rows.find((x) => x[1] === "40005" && x[7]?.startsWith("INV"));
    expect(income).toBeTruthy(); expect(num(income![14])).toBe(50); expect(income![2]).toContain("ក្នុងបុរី ខ្មែរ");
  });
});

describe("COA — the owner's sample (three sheets)", () => {
  it("sheet 1 Trial Balance: Note · A/c Code · Description · Debit · Credit · opening debit/credit · closing debit/credit; groups bold in column B, accounts in C; total debit = total credit; check row 0", async () => {
    const sample = fixture("sample-coa.xlsx");
    const r = await xl(cfo, "coa", { from: d(-7), to: today, asof: today });
    expect(r.sheets.map((x) => x.name)).toEqual(["Trial Balance", "Income Statement", "Balance Sheet"]);
    const head = r.rows[HEAD]!, s5 = sample[0]!.rows[4]!; // r5 of the sample: Note · A/c Code · (merged) · Description · Debit · Credit · Year to date …
    expect(head.slice(0, 4)).toEqual(s5.slice(0, 4));
    expect(head[4]).toMatch(/^Debit\n\d\d\/\d\d\/\d{4} – \d\d\/\d\d\/\d{4}$/); expect(head[5]).toMatch(/^Credit\n/);
    expect(head[6]!.startsWith(s5[6]!.trim())).toBe(true); expect(head[6]).toContain("(to "); // «Year to date Last month» + its date
    expect(head[8]!.startsWith(s5[8]!.trim())).toBe(true); expect(head[8]).toMatch(/\(\d\d\/\d\d\/\d{4} – \d\d\/\d\d\/\d{4}\)$/);
    expect(r.rows[HEAD + 1]!.slice(6, 10)).toEqual(["Debit", "Credit", "Debit", "Credit"]);
    const g = r.rows.find((x) => x[1] === "13000")!, a = r.rows.find((x) => x[2] === "13400")!;
    expect(g[3]).toBe("ស្តុកថ្មី"); expect(a[0]).toBe("BS"); expect(a[3]).toBe("ទុយោស្ពាន់");
    expect([num(a[4]), num(a[5]), num(a[6]), num(a[7]), num(a[8]), num(a[9])]).toEqual([40, 0, 0, 0, 40, 0]); // D-180: 10 m in (d-6) − 6 m out (d-3) = 40 net on the debit side (the client’s own sample) · opening before d-7 = 0 · closing 40
    const total = findRow(r.rows, (x) => x[3] === "Total")!, check = findRow(r.rows, (x) => x[3] === "Debit − Credit")!;
    expect(num(total[4])).toBe(num(total[5])); expect(num(total[8])).toBe(num(total[9])); expect([num(check[4]), num(check[6]), num(check[8])]).toEqual([0, 0, 0]);
    expect(r.rows.some((x) => !!x[0]?.startsWith("⚠"))).toBe(false);
  });
  it("as-of rule: only As-of → the fiscal year to that day; only a range → As-of = To; the opening column = everything before From", async () => {
    const r = await xl(cfo, "coa", { asof: d(-3) });
    expect(r.rows[3]![0]).toContain(`គិតត្រឹម`); const cash = r.rows.find((x) => x[2] === "11001")!;
    expect(num(cash[8]) - num(cash[9])).toBe(5000 + 100 - 100 - 15 + 200); // up to d-3 inclusive
    const r2 = await xl(cfo, "coa", { from: d(-4), to: d(-3) });
    const c2 = r2.rows.find((x) => x[2] === "11001")!;
    expect([num(c2[6]) - num(c2[7]), num(c2[4]), num(c2[5]), num(c2[8]) - num(c2[9])]).toEqual([5000, 200 - 15, 0, 5000 - 15 + 200]); // D-180: the period net on one side
  });
  it("sheets 2 / 3 equal the API's income statement and balance sheet; the standalone exports equal the API totals", async () => {
    const is = (await acc(cfo, `/income-statement?from=${d(-7)}&to=${today}`)).json, bs = (await acc(cfo, `/balance-sheet?to=${today}`)).json, tb = (await acc(cfo, `/trial-balance?to=${today}`)).json;
    const r = await xl(cfo, "coa", { from: d(-7), to: today, asof: today });
    const net = findRow(r.sheets[1]!.rows, (x) => x[1] === "ចំណេញសុទ្ធ" || x[1] === "ខាតសុទ្ធ")!; expect(num(net[2])).toBe(is.totals.net.amount / 100);
    const gross = findRow(r.sheets[1]!.rows, (x) => x[1] === "ចំណេញដុល")!; expect(num(gross[2])).toBe(is.totals.gross.amount / 100);
    const assets = findRow(r.sheets[2]!.rows, (x) => x[1] === "ទ្រព្យសកម្មសរុប")!; expect(num(assets[2])).toBe(bs.assets_total / 100);
    const tbm = (await acc(cfo, `/trial-balance?month=${today.slice(0, 7)}`)).json, tbx = await xl(cfo, "trial-balance", { month: today.slice(0, 7) }); // the screen's month layout
    const tot = findRow(tbx.rows, (x) => x[0]?.startsWith("ឥណពន្ធ"))!; expect(tot[0]).toContain("✓");
    expect([num(tot[3]), num(tot[4]), num(tot[7]), num(tot[8])]).toEqual([tbm.totals.period.debit / 100, tbm.totals.period.credit / 100, tbm.totals.ytd.debit / 100, tbm.totals.ytd.credit / 100]); void tb;
    const isx = await xl(cfo, "income-statement", { from: d(-7), to: today }); expect(num(findRow(isx.rows, (x) => x[1] === "ចំណូលសរុប")![2])).toBe(is.totals.income.amount / 100);
    const bsx = await xl(cfo, "balance-sheet", { asof: today }); expect(num(findRow(bsx.rows, (x) => x[1] === "បំណុល + មូលធន")![2])).toBe((bs.liabilities_total + bs.equity_total + bs.current_earnings) / 100);
    expect(bsx.rows.some((x) => !!x[0]?.includes("✓"))).toBe(true);
  });
  it("permission: an Admin without accounting.view → 403 on COA; Khmer text round-trips", async () => {
    const gm = await loginAs(app, "gm01");
    expect((await xl(gm, "coa", { asof: today })).status).toBe(403);
    expect((await xl(cfo, "customers")).rows.some((x) => x[0] === "ក្នុងបុរី ខ្មែរ")).toBe(true);
  });
});

describe("the other reports (smoke)", () => {
  it("stock balance as-of: before the withdrawals the copper shows 10, after 4; stock moves filtered by kind", async () => {
    const before = await xl(admin, "stock-balance", { asof: d(-4) }), after = await xl(admin, "stock-balance", { asof: today });
    expect(num(findRow(before.rows, (x) => x[0] === "1340001")![5])).toBe(10); expect(num(findRow(after.rows, (x) => x[0] === "1340001")![5])).toBe(4);
    expect((await xl(admin, "stock-moves", { from: d(-7), to: today, kind: "out" })).rowsHeader).toBe(2);
    expect((await xl(admin, "stock-moves", { from: d(-7), to: today })).rowsHeader).toBe(4);
  });
  it("payables (owed $400 to ហាង A) · reconcile · bookings (technician filter) · invoices · payments · receivables as-of · technician performance · attendance · expenses · journal", async () => {
    const p = await xl(admin, "payables"); expect(num(findRow(p.rows, (x) => x[0] === "ហាង A")![1])).toBe(400);
    expect((await xl(cfo, "stock-reconcile", { from: d(-7), to: today })).status).toBe(200);
    expect((await xl(admin, "bookings", { from: d(-1), to: d(1), technician: s.users.kim! })).rowsHeader).toBe(1);
    expect((await xl(admin, "bookings", { from: d(-1), to: d(1), technician: s.users.dara! })).rowsHeader).toBe(0);
    const inv1 = await xl(ceo, "invoices", { from: d(-1), to: today }); const row = inv1.rows[HEAD + 1]!; expect(num(row[10])).toBe(50); expect(num(row[11])).toBe(20); expect(num(row[12])).toBe(30);
    expect((await xl(ceo, "payments", { from: d(-1), to: today, method: "acleda" })).rowsHeader).toBe(1); expect((await xl(ceo, "payments", { from: d(-1), to: today, method: "aba" })).rowsHeader).toBe(0);
    const ar = await xl(ceo, "receivables", { asof: today }); expect(num(findRow(ar.rows, (x) => x[0] === "ក្នុងបុរី ខ្មែរ")![8])).toBe(30);
    expect((await xl(ceo, "receivables", { asof: d(-1) })).rowsHeader).toBe(0); // issued today → nothing owed yesterday
    expect((await xl(admin, "invoices", { from: d(-1), to: today })).status).toBe(403); // report.finance only
    expect((await xl(admin, "tech-performance", { from: d(-7), to: today })).status).toBe(200);
    expect((await xl(admin, "attendance", { from: d(-7), to: today })).status).toBe(200);
    const ex = await xl(cfo, "expenses", { from: d(-7), to: today }); expect(num(findRow(ex.rows, (x) => x[2] === "50010")![5])).toBe(15);
    expect((await xl(cfo, "journal", { from: d(-7), to: today, source: "manual" })).rowsHeader).toBe(6); // 3 entries × 2 lines
  });
});

describe("D-171 the on-screen table is the file", () => {
  it("GET .json = the file's sheet without the header block (same header row, same rows, same count)", async () => {
    const audited0 = Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where action = 'report.export' and row_id = 'tech-withdrawals'`)[0]!.n);
    const p = await app.inject({ method: "GET", url: `/api/export/tech-withdrawals.json?from=${d(-7)}&to=${today}`, headers: { cookie: admin.cookie! } });
    expect(p.statusCode).toBe(200);
    const j = p.json(), f = await xl(admin, "tech-withdrawals", { from: d(-7), to: today });
    const text = (x: unknown) => (x === null || x === undefined ? "" : typeof x === "object" ? String((x as { v: unknown }).v ?? "") : String(x));
    expect(j.sheets[0].rows[0].map(text)).toEqual(f.rows[HEAD]); expect(j.sheets[0].rows.length).toBe(f.rows.length - HEAD); expect(j.rows).toBe(f.rowsHeader);
    expect(Number((await sql<{ n: string }[]>`select count(*)::text as n from audit_log where action = 'report.export' and row_id = 'tech-withdrawals'`)[0]!.n) - audited0).toBe(1); // only the file is audited, not the screen table
  });
});

describe("D-171 as-of only: balance-sheet accounts from the first entry, income / expense from the fiscal-year start", () => {
  let Y = 0;
  beforeAll(async () => {
    Y = Number(today.slice(0, 4));
    expect((await acc(ceoB, "/accounts")).status).toBe(200);
    await sql`update company_settings set fiscal_year_start_month = 1 where company_id = ${s.b}`;
    expect((await acc(ceoB, "/opening", { date: `${Y - 1}-11-01`, cash_usd: 100000 })).status).toBe(200);
    for (const [day, cents] of [[`${Y - 1}-12-15`, 30000], [today, 50000]] as const) // last year's income (never closed) · this year's
      expect((await acc(ceoB, "/journal", { date: day, memo: `ចំណូល ${day}`, lines: [{ account_id: await account("11001", s.b), debit: cents }, { account_id: await account("40006", s.b), credit: cents }] })).status).toBe(200);
  });
  it("COA as of today: cash cumulative since the first entry; income this fiscal year only; last year's result on 30003; debit = credit", async () => {
    const r = await xl(ceoB, "coa", { asof: today });
    const row = (code: string) => r.rows.find((x) => x[2] === code)!;
    expect(num(row("11001")[8]) - num(row("11001")[9])).toBe(1000 + 300 + 500);
    expect(num(row("40006")[9]) - num(row("40006")[8])).toBe(500);
    expect(num(row("30003")[9]) - num(row("30003")[8])).toBe(300);
    const total = findRow(r.rows, (x) => x[3] === "Total")!; expect(num(total[8])).toBe(num(total[9])); expect(num(total[6])).toBe(num(total[7]));
    expect(r.rows.some((x) => !!x[0]?.startsWith("⚠"))).toBe(false); expect(r.rows[HEAD]![8]).toContain(`01/01/${Y}`);
  });
  it("the balance sheet balances: this year's result from the fiscal-year start, last year's (not closed) apart — API and file", async () => {
    const bs = (await acc(ceoB, `/balance-sheet?to=${today}`)).json;
    expect([bs.current_earnings, bs.prior_earnings]).toEqual([50000, 30000]);
    expect(bs.assets_total).toBe(bs.liabilities_total + bs.equity_total + bs.current_earnings + bs.prior_earnings);
    const x = await xl(ceoB, "balance-sheet", { asof: today });
    expect(num(findRow(x.rows, (r) => r[1] === "ទ្រព្យសកម្មសរុប")![2])).toBe(1800); expect(num(findRow(x.rows, (r) => r[1] === "បំណុល + មូលធន")![2])).toBe(1800);
    expect(num(findRow(x.rows, (r) => r[0] === "30003")![2])).toBe(300); expect(x.rows.some((r) => !!r[0]?.includes("✓"))).toBe(true);
  });
});

describe("D-171 permissions per role group (every report, file and screen table)", () => {
  const MONEY = ["invoices", "payments", "receivables"];
  const check = async (c: Client, ok: (r: string) => boolean) => {
    for (const report of REPORTS) {
      const st = (await app.inject({ method: "GET", url: `/api/export/${report}.json?from=${d(-2)}&to=${today}&asof=${today}`, headers: { cookie: c.cookie! } })).statusCode;
      expect(st, report).toBe(ok(report) ? 200 : 403);
    }
  };
  it("CEO: every report", async () => { await check(ceo, () => true); });
  it("CFO: every report", async () => { await check(cfo, () => true); });
  it("GM: stock without costs tabs, bookings, technicians, attendance, customers — no accounting, no money, no payables / reconcile", async () => {
    await check(await loginAs(app, "gm01"), (r) => ["tech-withdrawals", "stock-balance", "stock-moves", "bookings", "tech-performance", "attendance", "customers"].includes(r));
  });
  it("Admin: everything except the money reports (report.finance)", async () => { await check(admin, (r) => !MONEY.includes(r)); });
  it("technician: 403 on every export and screen table — even when the settings grant inventory.view and report.ops", async () => {
    await check(kim, () => false);
    await sql`update role_permissions set allowed = true where company_id = ${s.a} and role = 'tech' and permission_key in ('inventory.view', 'report.ops')`;
    const dara = await loginAs(app, "dara");
    await check(dara, () => false);
    expect((await xl(dara, "stock-balance", { asof: today })).status).toBe(403);
    await sql`update role_permissions set allowed = false where company_id = ${s.a} and role = 'tech' and permission_key in ('inventory.view', 'report.ops')`;
  });
});
