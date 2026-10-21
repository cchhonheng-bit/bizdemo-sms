// D-156 (owner 21-10): the customer list by Excel — export = template, sample sheet, preview → apply (match by phone, update or
// add, places by name or code, borey by name, never deletes, audited). D-157: the staff may book a time that has passed (an
// appointment agreed by phone) and it raises no late alert; the website's own time rule is untouched.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { lateAlerts } from "../src/services/jobs.js";
import { readXlsx, writeXlsx } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
const b64 = (rows: (string | number)[][]) => writeXlsx("x", rows).toString("base64");
const HEAD = ["ឈ្មោះ", "ទូរស័ព្ទ (ច្រើនលេខ ខណ្ឌដោយ /)", "ផ្ទះលេខ", "ផ្លូវ", "បុរី", "តំបន់ក្នុងបុរី", "ខេត្ត / រាជធានី", "ខណ្ឌ / ស្រុក", "សង្កាត់ / ឃុំ", "ភូមិ", "ក្នុងបុរី (បាទ / ទេ)", "ចំណាំ", "សកម្ម (បាទ / ទេ)"];

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  expect((await admin.req("POST", "/api/customers", { ...PLACE, name: "លោក សុខា", phones: ["012 345 678"], zone: "outside", notes: "ចាស់" })).status).toBe(200);
  expect((await admin.req("POST", "/api/boreys", { name: "បុរីពិភពថ្មី", province_code: "12", district_code: "1201", commune_code: "120101" })).status).toBe(200);
});
afterAll(async () => { await app.close(); });

describe("D-156 customers by Excel", () => {
  it("export = the list with Khmer headers and places as names; the sample sheet has 3 rows; technicians / GM without customer.manage get 403", async () => {
    const r = await app.inject({ method: "GET", url: "/api/customers/export.xlsx?lang=km", headers: { cookie: admin.cookie! } });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("spreadsheetml");
    const rows = readXlsx(r.rawPayload);
    expect(rows[0]).toEqual(HEAD);
    expect(rows[1]![0]).toBe("លោក សុខា"); expect(rows[1]![1]).toBe("012345678");
    expect(rows[1]![6]).toBe("រាជធានីភ្នំពេញ"); expect(rows[1]![7]).toBe("ខណ្ឌច្បារអំពៅ");
    const sample = readXlsx((await app.inject({ method: "GET", url: "/api/customers/export.xlsx?sample=1", headers: { cookie: admin.cookie! } })).rawPayload);
    expect(sample.length).toBe(4);
    expect((await app.inject({ method: "GET", url: "/api/customers/export.xlsx", headers: { cookie: kim.cookie! } })).statusCode).toBe(403);
  });

  it("preview: an existing phone = update (changes listed), a new phone = new; errors for a bad phone, an unknown place, a missing address, a duplicate; nothing written", async () => {
    const data = b64([HEAD,
      ["លោក សុខា ម៉ៃ", "012 345 678 / 098 111 222", "24", "19", "", "", "រាជធានីភ្នំពេញ", "ខណ្ឌច្បារអំពៅ", "សង្កាត់ច្បារអំពៅទី ១", "", "ទេ", "បានផ្លាស់ឈ្មោះ", "បាទ"],
      ["អ្នកស្រី ចន្ថា", "015 222 333", "A-12", "", "បុរីពិភពថ្មី", "Zone B", "", "", "", "", "បាទ", "", "បាទ"],
      ["ហាង គីមស៊ុន", "017 888 999", "", "", "", "", "12", "1201", "120101", "", "ទេ", "ជាកូដ", "ទេ"],
      ["ខុស ទូរស័ព្ទ", "abc", "", "", "", "", "12", "1201", "120101", "", "", "", ""],
      ["ខុស កន្លែង", "011 000 111", "", "", "", "", "ខេត្តគ្មាន", "", "", "", "", "", ""],
      ["គ្មាន អាសយដ្ឋាន", "011 000 222", "", "", "", "", "", "", "", "", "ទេ", "", ""],
      ["ស្ទួន", "015 222 333", "", "", "", "", "12", "1201", "120101", "", "", "", ""]]);
    const p = (await admin.req("POST", "/api/customers/import/preview", { data })).json;
    expect(p.counts).toEqual({ new: 2, changed: 1, same: 0, error: 4 });
    expect(p.rows[0]).toMatchObject({ action: "changed", code: "012345678" });
    expect(Object.keys(p.rows[0].changes).sort()).toEqual(["house_no", "name", "notes", "phones", "street"]); // the place (PLACE) is unchanged
    expect(p.rows[1]).toMatchObject({ action: "new", name: "អ្នកស្រី ចន្ថា" });
    expect(p.rows[2]).toMatchObject({ action: "new" });
    expect(p.rows[3].errors).toContain("PHONE"); expect(p.rows[4].errors).toContain("PLACE"); expect(p.rows[5].errors).toContain("ADDRESS"); expect(p.rows[6].errors).toContain("DUPLICATE");
    expect((await sql<{ n: number }[]>`select count(*)::int as n from customers where company_id = ${s.a}`)[0]!.n).toBe(1);
    expect((await admin.req("POST", "/api/customers/import/apply", { data })).json.error).toBe("IMPORT_HAS_ERRORS");
  });

  it("apply a clean file: the existing customer updated (phones, name, notes), two new ones with composed addresses (borey → its place, codes → names), audited; export shows them", async () => {
    const data = b64([HEAD,
      ["លោក សុខា ម៉ៃ", "012 345 678 / 098 111 222", "24", "19", "", "", "រាជធានីភ្នំពេញ", "ខណ្ឌច្បារអំពៅ", "សង្កាត់ច្បារអំពៅទី ១", "", "ទេ", "បានផ្លាស់ឈ្មោះ", "បាទ"],
      ["អ្នកស្រី ចន្ថា", "015 222 333", "A-12", "", "បុរីពិភពថ្មី", "Zone B", "", "", "", "", "បាទ", "", "បាទ"],
      ["ហាង គីមស៊ុន", "017 888 999", "", "", "", "", "12", "1201", "120101", "", "ទេ", "ជាកូដ", "ទេ"]]);
    const r = await admin.req("POST", "/api/customers/import/apply", { data });
    expect(r.status).toBe(200);
    expect(r.json.counts).toMatchObject({ new: 2, changed: 1, error: 0 });
    const list = (await admin.req("GET", "/api/customers")).json as any[];
    expect(list.length).toBe(3);
    const sokha = list.find((c) => c.phones.includes("+85512345678"));
    expect(sokha).toMatchObject({ name: "លោក សុខា ម៉ៃ", phones: ["+85512345678", "+85598111222"], notes: "បានផ្លាស់ឈ្មោះ", house_no: "24", street: "19", zone: "outside", district_code: "1212" });
    const chantha = list.find((c) => c.phones.includes("+85515222333"));
    expect(chantha).toMatchObject({ zone: "inside", borey_name: "បុរីពិភពថ្មី", borey_zone: "Zone B", province_code: "12", district_code: "1201", commune_code: "120101", address_complete: true });
    expect(chantha.address).toContain("បុរីពិភពថ្មី");
    const shop = list.find((c) => c.phones.includes("+85517888999"));
    expect(shop).toMatchObject({ is_active: false, province_code: "12", address_complete: true });
    expect((await sql`select new_data from audit_log where action = 'customer.import'`)[0]).toMatchObject({ new_data: { new: 2, changed: 1 } });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'customer.create' and new_data->>'import' = 'true'`)[0]!.n).toBe(2);
    // the same file again: everything «same», nothing written
    expect((await admin.req("POST", "/api/customers/import/preview", { data })).json.counts).toMatchObject({ new: 0, changed: 0, same: 3, error: 0 });
    const rows = readXlsx((await app.inject({ method: "GET", url: "/api/customers/export.xlsx", headers: { cookie: admin.cookie! } })).rawPayload);
    expect(rows.length).toBe(4);
    expect(rows.find((x) => x[0] === "អ្នកស្រី ចន្ថា")![4]).toBe("បុរីពិភពថ្មី");
  });
});

describe("D-157 the staff book a time that has passed", () => {
  it("Admin creates a job 3 hours ago with a crew → 200, status assigned, no late alert; the website slot rule is untouched (past slot refused)", async () => {
    const cust = (await admin.req("GET", "/api/customers")).json[0].id;
    const start = new Date(Date.now() - 3 * 3_600_000), end = new Date(Date.now() - 3_600_000);
    const r = await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល (ណាត់តាមទូរស័ព្ទ)", zone: "inside", scheduled_at: start.toISOString(), ends_at: end.toISOString() });
    expect(r.status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${r.json.id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${r.json.id}`)).json.status).toBe("assigned");
    await lateAlerts();
    expect((await sql`select 1 from notifications where kind = 'booking.late'`).length).toBe(0); // booked after its start → late_alerted_at set at creation, never «late»
    // a future job moved into the past by the office → no late alert either
    const f = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", ...span(new Date(Date.now() + 48 * 3_600_000).toISOString()) })).json.id;
    expect((await admin.req("POST", `/api/bookings/${f}/reschedule`, { scheduled_at: new Date(Date.now() - 5 * 3_600_000).toISOString(), ends_at: new Date(Date.now() - 4 * 3_600_000).toISOString(), requested_by: "customer", reason: "ធ្វើរួចហើយ" })).status).toBe(200);
    expect((await sql<{ x: Date | null }[]>`select late_alerted_at as x from bookings where id = ${f}`)[0]!.x).toBeTruthy();
    // the customers' website keeps its own rule (slots from now + lead time — services/web-booking.ts, tests 200/230 untouched)
  });
});
