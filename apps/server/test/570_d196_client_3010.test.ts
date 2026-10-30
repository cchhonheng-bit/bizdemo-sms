// D-196 (client 30-10): (2) the office's own booking / invoice numbers · (3) the jobs board filters reach the Excel file (stage, job
// type) · (4) an invoice laid out like the client's Excel — text rows inside the price of the line above (a lump-sum job, «ការងារម៉ៅ»)
// and section headings, no amount on them · (7) a substitute reviewer while the GM is away. (1) = the invoice inside the customer's
// timeline (560) · (5) = the service quick-add on the booking form (web, the catalog API it calls is unchanged) · (6) = an answer.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { invoiceToken } from "../src/services/invoice-pay.js";
import { ensureChart } from "../src/services/accounting.js";
import { itemCodes6Cli } from "../src/services/chart-replace.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, cfo: Client, ceoB: Client;
let cust = "";
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
let slot = 0;
const booking = async (type: "A" | "B" = "A") => (await ceo.req("POST", "/api/bookings", { customer_id: cust, type, category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + (5 + 3 * slot++) * 3600_000).toISOString()) })).json.id as string;
/** a job sent for review by kim (checkpoints, photos, signature) */
async function sent(): Promise<string> {
  const b = await booking();
  expect((await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - (3 + 4 * slot++) * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${b}`;
  for (const step of ["depart", "arrive", "start", "finish"]) expect((await kim.req("POST", `/api/bookings/${b}/checkpoint`, { step, no_gps: true })).status).toBe(200);
  for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${b}/photos`, { kind, data: JPEG })).status).toBe(200);
  expect((await kim.req("POST", `/api/bookings/${b}/report`, { notes: "រួចរាល់", signature: PNG })).status).toBe(200);
  return b;
}
const L = (description: string, unit_price: number, extra: Record<string, unknown> = {}) => ({ description, kind: "service", qty: 1, unit: "", unit_price, ...extra });

beforeAll(async () => {
  await resetDb(); s = await seed();
  config.publicUrl = "https://oneteam.test"; config.shop.features = "website";
  app = await makeApp();
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password) values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000008', ${await hashPassword(PW)}, false)`;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); cfo = await loginAs(app, "cfo");
  ceoB = await loginAs(app, "ceo_b", PW, "otherco");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "Sopal", phones: ["012 555 042"], zone: "inside" })).json.id;
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-196 the client's 30-10 requests", () => {
  it("(4) an invoice like their Excel: a lump-sum line + text rows (one price), a section heading, the materials line — $1,024.65; text / heading carry no amount", async () => {
    const lines = [L("រៀបចំប្រព័ន្ធភ្លើងខាងក្រោមផ្ទះថ្មី", 35000), L("ដោះប្ដូរអំពូលភ្លើងថ្មីជាន់ខាងលើ", 999, { row_type: "text", unit: "x", qty: 5 }), L("ជួសជុលម៉ាស៊ីនបោកខោអាវ", 0, { row_type: "text" }),
      L("សម្ភារៈត្រូវប្រើ", 0, { row_type: "heading" }), L("សម្ភារៈអគ្គិសនី និងសម្ភារៈទឹក", 67465, { kind: "product" })];
    const r = await admin.req("POST", "/api/invoices", { customer_id: cust, lines });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    const d = (await admin.req("GET", `/api/invoices/${r.json.id}`)).json;
    expect(d.lines.map((l: any) => l.row_type)).toEqual(["line", "text", "text", "heading", "line"]);
    expect(d.lines[1]).toMatchObject({ unit_price: 0, qty: 1, unit: "", catalog_item_id: null, line_total: 0 }); // the typed 999 × 5 is dropped
    expect(d.total).toBe(102465);
    expect((await admin.req("POST", `/api/invoices/${r.json.id}/issue`)).status).toBe(200);
    const page = (await app.inject({ method: "GET", url: `/i/${invoiceToken(r.json.id)}` })).body;
    expect(page).toContain('<li class="hd"><b>សម្ភារៈត្រូវប្រើ</b></li>'); expect(page).toContain('<li class="tx"><span>ដោះប្ដូរអំពូលភ្លើងថ្មីជាន់ខាងលើ</span></li>');
    expect(page).toContain("$1,024.65");
    // only line / text / heading
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [L("x", 100, { row_type: "box" })] })).status).toBe(400);
  });

  it("(2) the job's own number: unique, audited, the people who book only; the next automatic number skips one typed by hand", async () => {
    const a = await booking(), b = await booking();
    expect((await admin.req("POST", `/api/bookings/${a}/number`, { number: "010,017" })).json).toEqual({ number: "010,017" });
    expect((await ceo.req("GET", `/api/bookings/${a}`)).json.number).toBe("010,017");
    expect((await admin.req("POST", `/api/bookings/${b}/number`, { number: "010,017" })).json.error).toBe("NUMBER_TAKEN");
    expect((await admin.req("POST", `/api/bookings/${b}/number`, { number: "  " })).json.error).toBe("BAD_NUMBER");
    expect((await kim.req("POST", `/api/bookings/${b}/number`, { number: "K-1" })).status).toBe(403);
    expect((await ceoB.req("POST", `/api/bookings/${b}/number`, { number: "K-1" })).status).toBe(404);
    expect((await sql`select old_data, new_data from audit_log where action = 'booking.number' and row_id = ${a}`)[0]).toMatchObject({ new_data: { number: "010,017" } });
    const last = (await sql<{ n: number }[]>`select last_no as n from booking_counters where company_id = ${s.a}`)[0]!.n;
    const next = `BK-${String(last + 1).padStart(4, "0")}`;
    expect((await admin.req("POST", `/api/bookings/${b}/number`, { number: next })).status).toBe(200);
    const c = await booking();
    expect((await ceo.req("GET", `/api/bookings/${c}`)).json.number).toBe(`BK-${String(last + 2).padStart(4, "0")}`);
  });

  it("(2) the invoice's own number: a draft freely, an issued one with a reason (audited), never a void one; invoice.issue only; the counter skips it", async () => {
    const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [L("សេវា", 5000)] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${id}/number`, { number: "26-10-042" })).json).toEqual({ number: "26-10-042" });
    expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${id}/number`, { number: "26-10-043" })).json.error).toBe("REASON_REQUIRED");
    expect((await admin.req("POST", `/api/invoices/${id}/number`, { number: "26-10-043", reason: "លេខក្រដាសរបស់ហាង" })).status).toBe(200);
    expect((await sql`select new_data from audit_log where action = 'invoice.number' and row_id = ${id} order by id desc limit 1`)[0]!.new_data).toMatchObject({ number: "26-10-043", reason: "លេខក្រដាសរបស់ហាង" });
    const other = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [L("សេវា", 100)] })).json;
    expect((await admin.req("POST", `/api/invoices/${other.id}/number`, { number: "26-10-043" })).json.error).toBe("NUMBER_TAKEN");
    for (const c of [kim, cfo]) expect((await c.req("POST", `/api/invoices/${other.id}/number`, { number: "Z-1" })).status).toBe(403);
    expect((await ceo.req("POST", `/api/invoices/${other.id}/void`, { reason: "បង្កើតខុស" })).json.status).toBe("void");
    expect((await admin.req("POST", `/api/invoices/${other.id}/number`, { number: "Z-1" })).json.error).toBe("INVOICE_VOID");
    // the next automatic number is free even when someone typed it by hand
    const third = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [L("សេវា", 100)] })).json;
    const bump = (n: string, by: number) => n.replace(/(\d{4})$/, (m: string) => String(Number(m) + by).padStart(4, "0"));
    expect((await admin.req("POST", `/api/invoices/${third.id}/number`, { number: bump(third.number, 1) })).status).toBe(200);
    expect((await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [L("សេវា", 100)] })).json.number).toBe(bump(third.number, 2));
  });

  it("(3) the jobs board's stage and job type reach the Excel file", async () => {
    await booking("B");
    const x = await app.inject({ method: "GET", url: "/api/export/bookings.xlsx?jobtype=B", headers: { cookie: ceo.cookie! } });
    expect(x.statusCode).toBe(200); expect(x.headers["content-type"]).toContain("spreadsheetml");
    expect((await app.inject({ method: "GET", url: "/api/export/bookings.xlsx?jobtype=B&status=new,assigned", headers: { cookie: ceo.cookie! } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/export/bookings.xlsx?jobtype=C", headers: { cookie: ceo.cookie! } })).statusCode).toBe(400);
  });

  it("(7) the CEO names a substitute reviewer: the Admin then reviews and hears about reports; never a technician; a past day ends it", async () => {
    const one = await sent();
    expect((await admin.req("POST", `/api/bookings/${one}/review`, { decision: "approve" })).status).toBe(403);
    expect((await admin.req("PUT", "/api/settings/review-substitute", { user_id: s.users.admin, until: null })).status).toBe(403); // settings.manage
    expect((await ceo.req("PUT", "/api/settings/review-substitute", { user_id: s.users.kim, until: null })).json.error).toBe("NOT_A_REVIEWER");
    expect((await ceo.req("PUT", "/api/settings/review-substitute", { user_id: s.users.admin, until: "2020-01-01" })).json.error).toBe("BAD_DATE");
    const tomorrow = (await sql<{ d: string }[]>`select ((now() at time zone 'Asia/Phnom_Penh')::date + 1)::text as d`)[0]!.d;
    expect((await ceo.req("PUT", "/api/settings/review-substitute", { user_id: s.users.admin, until: tomorrow })).status).toBe(200);
    expect((await ceo.req("GET", "/api/settings/review-substitute")).json).toMatchObject({ user_id: s.users.admin, until: tomorrow, active: true });
    expect((await admin.req("POST", `/api/bookings/${one}/review`, { decision: "approve" })).status).toBe(200);
    const two = await sent(); // the Admin is told now, besides the GM
    expect((await sql`select 1 from notifications where user_id = ${s.users.admin!} and kind = 'job.review' and link = ${`/bookings/${two}`}`).length).toBe(1);
    expect((await sql`select 1 from notifications where user_id = ${s.users.gm01!} and kind = 'job.review' and link = ${`/bookings/${two}`}`).length).toBe(1);
    expect((await sql`select 1 from audit_log where action = 'settings.review_substitute'`).length).toBe(1);
    await sql`update company_settings set review_substitute_until = (now() at time zone 'Asia/Phnom_Penh')::date - 1 where company_id = ${s.a}`;
    expect((await admin.req("POST", `/api/bookings/${two}/review`, { decision: "approve" })).status).toBe(403);
    expect((await ceo.req("GET", "/api/settings/review-substitute")).json.active).toBe(false);
    expect((await gm.req("POST", `/api/bookings/${two}/review`, { decision: "approve" })).status).toBe(200); // the GM always can
  });
});

// D-197 (client 30-10): stock item sub codes have 6 digits — the account code × 10 + n: 13110 → 131101 … 131109, 131110 …; 13600's
// tenth item = 136010 (not 1360010). `item-codes-6` re-codes the D-165 codes a shop already holds, once, as HangKH Support.
describe("D-197 six-digit stock codes", () => {
  it("next code = account × 10 + n (old codes count); item-codes-6: dry run, apply in one go (audited), then nothing to do", async () => {
    await ensureChart(sql, s.a);
    const acc = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
    const a1 = await acc("13110"), a6 = await acc("13600");
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a1}`)).json.code).toBe("131101");
    // what a shop holds from D-165: 1311001, 1311002 and 1360001 … 1360010 (made here with the new rule, then set back to the old form)
    const old = [["1311001", a1], ["1311002", a1], ...Array.from({ length: 10 }, (_, k) => [`13600${String(k + 1).padStart(2, "0")}`, a6])] as [string, string][];
    for (const [code, account] of old) {
      const next = (await ceo.req("GET", `/api/catalog/next-code?account=${account}`)).json.code;
      const r = await ceo.req("POST", "/api/catalog", { name_km: `ទំនិញ ${code}`, kind: "product", category: "mep", unit: "គ្រឿង", sell_price: 100, code: next, inventory_account_id: account });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      await sql`update catalog_items set code = ${code} where id = ${r.json.id}`;
    }
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a1}`)).json.code).toBe("131103");
    expect((await ceo.req("GET", `/api/catalog/next-code?account=${a6}`)).json.code).toBe("136011"); // 10 → 136010, so the next is 136011 (6 digits)
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, code: "1311003", inventory_account_id: a1 })).json.error).toBe("CODE_NOT_IN_ACCOUNT"); // no new 7-digit code
    expect((await ceo.req("POST", "/api/catalog", { name_km: "x", kind: "product", category: "mep", unit: "m", sell_price: 1, code: "131201", inventory_account_id: a1 })).json.error).toBe("CODE_NOT_IN_ACCOUNT"); // n = 101: outside
    await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, is_platform) values (${s.a}, 'support', 'HangKH Support', 'ceo', '+85512000099', ${await hashPassword(PW)}, false, true)`;
    const dry = await itemCodes6Cli("oneteam", false);
    expect(dry.join("\n")).toContain("1311001 → 131101"); expect(dry.join("\n")).toContain("1360010 → 136010"); expect(dry.at(-1)).toBe("12 item(s) to re-code");
    expect((await sql`select 1 from catalog_items where company_id = ${s.a} and code = '1360010'`).length).toBe(1); // nothing written
    expect((await itemCodes6Cli("oneteam", true)).at(-1)).toBe("12 item(s) re-coded");
    const codes = (await sql<{ code: string }[]>`select code from catalog_items where company_id = ${s.a} and inventory_account_id in (${a1}, ${a6}) order by code`).map((r) => r.code);
    expect(codes).toEqual(["131101", "131102", "136001", "136002", "136003", "136004", "136005", "136006", "136007", "136008", "136009", "136010"]);
    expect((await sql`select 1 from audit_log where action = 'catalog.recode'`).length).toBe(12);
    expect((await itemCodes6Cli("oneteam", true)).at(-1)).toBe("nothing to do — every sub code has 6 digits");
  });
});
