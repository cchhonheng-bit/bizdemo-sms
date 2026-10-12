// D-137 (CEO 12-10): the customer address from the official gazetteer (NCDD, Ministry of Interior) — cascading province → khan →
// sangkat → village, required province + khan + sangkat for staff-made customers, website customers may stay incomplete; the
// borey list (CEO / GM / Admin, audited, never deleted); revenue by khan and by borey; the staff write the end of a job (the
// overlap check uses it); the vehicle is chosen with the crew; phones stored +855… and accepted in any form.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "../src/db.js";
import { geoChildren, geoUnit } from "../src/lib/gazetteer.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { client, loginAs, makeApp, PLACE, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, ceoB: Client;
/** ISO for local Phnom Penh time: `d` days from today at hh:mm */
function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * 3600_000);
  return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm)).toISOString();
}
const today = () => new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10);
const mkCustomer = async (c: Client, body: Record<string, unknown>) => c.req("POST", "/api/customers", { name: "x", phones: [], zone: "inside", ...body });
const customerRow = async (id: string) => (await admin.req("GET", "/api/customers")).json.find((c: { id: string }) => c.id === id);

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
});
afterAll(async () => { await app.close(); });

describe("D-137 gazetteer (official NCDD data)", () => {
  it("25 provinces; Phnom Penh = 14 khan, 105 sangkat, 953 phum; Chbar Ampov = 1212; every unit sits under its parent", () => {
    const provinces = geoChildren("");
    expect(provinces.map((p) => p.code)).toEqual(Array.from({ length: 25 }, (_, i) => String(i + 1).padStart(2, "0")));
    const khans = geoChildren("12"), sangkats = khans.flatMap((k) => geoChildren(k.code)), phums = sangkats.flatMap((g) => geoChildren(g.code));
    expect([khans.length, sangkats.length, phums.length]).toEqual([14, 105, 953]);
    expect(geoUnit("12")).toMatchObject({ km: "រាជធានីភ្នំពេញ", type: "c" });
    expect(geoUnit("1212")).toMatchObject({ km: "ច្បារអំពៅ", en: "Chbar Ampov", type: "h" });
    expect(phums.every((v) => v.code.length === 8 && v.code.startsWith("12"))).toBe(true);
  });

  it("the cascading pickers: the children of a code only, cached; technicians 403; a bad code 400", async () => {
    const r = await admin.req("GET", "/api/geo?parent=1212");
    expect(r.status).toBe(200);
    expect(r.json.units.length).toBe(geoChildren("1212").length);
    expect(r.json.units.every((u: { code: string }) => u.code.length === 6 && u.code.startsWith("1212"))).toBe(true);
    expect(r.json.source).toContain("NCDD");
    expect((await admin.req("GET", "/api/geo")).json.units.length).toBe(25);
    expect((await kim.req("GET", "/api/geo?parent=12")).status).toBe(403);
    expect((await admin.req("GET", "/api/geo?parent=12x")).status).toBe(400);
  });
});

describe("D-137 customer address", () => {
  it("staff-made: province + khan + sangkat required; each code under the one above; the one-line address is composed", async () => {
    expect((await mkCustomer(admin, { name: "គ្មានអាសយដ្ឋាន" })).json.error).toBe("ADDRESS_INCOMPLETE");
    expect((await mkCustomer(admin, { province_code: "12", district_code: "1212" })).json.error).toBe("ADDRESS_INCOMPLETE");
    expect((await mkCustomer(admin, { province_code: "12", district_code: "1212", commune_code: "010201" })).json.error).toBe("INVALID_PLACE");
    expect((await mkCustomer(admin, { ...PLACE, village_code: "12020101" })).json.error).toBe("INVALID_PLACE");
    const r = await mkCustomer(admin, { name: "សុខ ដារ៉ា", ...PLACE, village_code: "12120101", house_no: "12", street: "371", lat: 11.55, lng: 104.93 });
    expect(r.status).toBe(200);
    const c = await customerRow(r.json.id);
    expect(c).toMatchObject({ address: "ផ្ទះលេខ 12, ផ្លូវលេខ 371, ភូមិព្រែក, សង្កាត់ច្បារអំពៅទី ១, ខណ្ឌច្បារអំពៅ, រាជធានីភ្នំពេញ", address_complete: true,
      province_code: "12", district_code: "1212", commune_code: "121201", village_code: "12120101", house_no: "12", street: "371" });
  });

  it("borey list: CEO / GM / Admin add and edit (audited), same name refused, technicians cannot; a customer in a borey; turned off, never deleted", async () => {
    const r = await admin.req("POST", "/api/boreys", { name: "បុរីប៉េងហួត", province_code: "12", district_code: "1212", commune_code: "121201" });
    expect(r.status).toBe(200);
    const id = r.json.id as string;
    expect((await sql`select user_id from audit_log where action = 'borey.create' and row_id = ${id}`)[0]).toMatchObject({ user_id: s.users.admin });
    expect((await gm.req("POST", "/api/boreys", { name: " បុរីប៉េងហួត ", province_code: "12", district_code: "1212" })).json.error).toBe("BOREY_EXISTS");
    expect((await admin.req("POST", "/api/boreys", { name: "x", province_code: "12", district_code: "0102" })).json.error).toBe("INVALID_PLACE");
    expect((await kim.req("POST", "/api/boreys", { name: "y", province_code: "12", district_code: "1212" })).status).toBe(403);
    expect((await kim.req("GET", "/api/boreys")).status).toBe(403);
    expect((await gm.req("PATCH", `/api/boreys/${id}`, { name: "បុរីប៉េងហួត បឹងស្នោរ", province_code: "12", district_code: "1212", commune_code: "121201" })).status).toBe(200);
    expect((await sql`select 1 from audit_log where action = 'borey.update' and row_id = ${id}`).length).toBe(1);
    const list = (await admin.req("GET", "/api/boreys")).json;
    expect(list).toEqual([expect.objectContaining({ id, name: "បុរីប៉េងហួត បឹងស្នោរ", area_km: "សង្កាត់ច្បារអំពៅទី ១, ខណ្ឌច្បារអំពៅ, រាជធានីភ្នំពេញ", customers: 0 })]);
    // a customer in it: the borey is in the line; another company cannot use it
    const c = (await mkCustomer(admin, { name: "ចាន់ ថា", ...PLACE, borey_id: id, house_no: "B-12" })).json.id;
    expect((await customerRow(c))).toMatchObject({ borey_id: id, borey_name: "បុរីប៉េងហួត បឹងស្នោរ", address: "ផ្ទះលេខ B-12, បុរីប៉េងហួត បឹងស្នោរ, សង្កាត់ច្បារអំពៅទី ១, ខណ្ឌច្បារអំពៅ, រាជធានីភ្នំពេញ" });
    expect((await mkCustomer(ceoB, { ...PLACE, borey_id: id })).json.error).toBe("BOREY_NOT_FOUND");
    // turned off: hidden from the picker, its customers keep it, a new customer cannot take it
    expect((await admin.req("POST", `/api/boreys/${id}/active`, { active: false })).status).toBe(200);
    expect((await admin.req("GET", "/api/boreys")).json).toEqual([]);
    expect((await admin.req("GET", "/api/boreys?all=1")).json[0]).toMatchObject({ id, is_active: false, customers: 1 });
    expect((await mkCustomer(admin, { id: c, name: "ចាន់ ថា", ...PLACE, borey_id: id })).status).toBe(200);
    expect((await mkCustomer(admin, { ...PLACE, borey_id: id })).json.error).toBe("BOREY_NOT_FOUND");
    expect((await sql`select count(*)::int as n from boreys where id = ${id}`)[0]!.n).toBe(1);
    await admin.req("POST", `/api/boreys/${id}/active`, { active: true });
  });

  it("a website customer may stay incomplete (badge) and be saved as it is; the staff complete it", async () => {
    const id = (await sql<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, origin) values (${s.a}, 'អតិថិជនគេហទំព័រ', ${sql.array(["+85512777666"])}, 'ជិតវត្តច្បារអំពៅ', 'inside', 'website') returning id`)[0]!.id;
    expect(await customerRow(id)).toMatchObject({ address_complete: false, address: "ជិតវត្តច្បារអំពៅ", origin: "website" });
    expect((await mkCustomer(admin, { id, name: "អតិថិជនគេហទំព័រ", phones: ["012777666"] })).status).toBe(200);
    expect(await customerRow(id)).toMatchObject({ address_complete: false, address: "ជិតវត្តច្បារអំពៅ" });
    expect((await mkCustomer(admin, { id, name: "អតិថិជនគេហទំព័រ", phones: ["012777666"], ...PLACE })).status).toBe(200);
    expect(await customerRow(id)).toMatchObject({ address_complete: true, address: "សង្កាត់ច្បារអំពៅទី ១, ខណ្ឌច្បារអំពៅ, រាជធានីភ្នំពេញ" });
  });
});

describe("D-137 phones", () => {
  it("Khmer digits, spaces, +855 → stored +855…; a wrong length refused; the staff sign in with their phone in any form", async () => {
    const id = (await mkCustomer(admin, { name: "លេខខ្មែរ", phones: ["០៩៧ ១២៣ ៤៥៦៧", "+855 12 888 999"], ...PLACE })).json.id;
    expect((await customerRow(id)).phones).toEqual(["+855971234567", "+85512888999"]);
    const bad = await mkCustomer(admin, { name: "y", phones: ["01234567"], ...PLACE });
    expect(bad.status).toBe(400); expect(bad.json.error).toBe("INVALID_PHONE");
    expect((await ceo.req("PATCH", `/api/users/${s.users.kim!}`, { phone: "097 765 4321" })).status).toBe(200);
    expect((await sql`select phone from users where id = ${s.users.kim!}`)[0]!.phone).toBe("+855977654321");
    resetRateLimits();
    const c = client(app);
    expect((await c.req("POST", "/api/auth/login", { identifier: "០១២ ០០០ ០០១", password: PW })).status).toBe(200); // the CEO's phone, Khmer digits
  });
});

describe("D-137 bookings", () => {
  it("the staff write the end (END_REQUIRED); the overlap check uses the end they wrote; the vehicle is chosen with the crew", async () => {
    const cust = (await mkCustomer(admin, { name: "ការងារ", ...PLACE })).json.id;
    const mk = (start: string, end?: string) => admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", scheduled_at: start, ...(end ? { ends_at: end } : {}) });
    expect((await mk(at(20, 9))).json.error).toBe("END_REQUIRED");
    const b1 = (await mk(at(20, 9), at(20, 11, 30))).json.id;
    const b2 = (await mk(at(20, 11), at(20, 12))).json.id;
    const b3 = (await mk(at(20, 11, 30), at(20, 12, 30))).json.id;
    const van = (await sql<{ id: string }[]>`select id from vehicles where company_id = ${s.a} and code = '01'`)[0]!.id;
    expect((await admin.req("POST", `/api/bookings/${b1}/assign`, { lead: s.users.kim, assistants: [], vehicle_id: van })).status).toBe(200);
    expect((await sql`select vehicle_id from bookings where id = ${b1}`)[0]!.vehicle_id).toBe(van);
    expect((await admin.req("POST", `/api/bookings/${b2}/assign`, { lead: s.users.kim, assistants: [] })).json.error).toBe("TECH_UNAVAILABLE"); // 11:00 < 11:30
    expect((await admin.req("POST", `/api/bookings/${b3}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200); // starts when b1 ends
  });
});

describe("D-137 reports: revenue by khan and by borey", () => {
  it("issued invoices grouped by the customer's khan / district and borey; not set = null; money only for report.finance", async () => {
    const borey = (await admin.req("POST", "/api/boreys", { name: "បុរីចំណូល", province_code: "12", district_code: "1212" })).json.id;
    const a = (await mkCustomer(admin, { name: "ក", ...PLACE, borey_id: borey })).json.id;
    const b = (await mkCustomer(admin, { name: "ខ", province_code: "12", district_code: "1202", commune_code: "120201" })).json.id;
    const c = (await sql<{ id: string }[]>`insert into customers (company_id, name, phones, zone, origin) values (${s.a}, 'គ', '{}', 'inside', 'website') returning id`)[0]!.id;
    for (const [cust, cents] of [[a, 10000], [b, 5000], [c, 2000]] as const) {
      const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "សេវាកម្ម", kind: "service", qty: 1, unit: "unit", unit_price: cents }] })).json.id;
      expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
    }
    const r = (await ceo.req("GET", `/api/reports/summary?from=${today()}&to=${today()}`)).json;
    expect(r.by_khan).toEqual([
      { code: "1212", name_km: "ខណ្ឌច្បារអំពៅ", name_en: "Chbar Ampov Khan", total: 10000, invoices: 1 },
      { code: "1202", name_km: "ខណ្ឌដូនពេញ", name_en: "Doun Penh Khan", total: 5000, invoices: 1 },
      { code: null, name_km: null, name_en: null, total: 2000, invoices: 1 },
    ]);
    expect(r.by_borey).toEqual([{ id: borey, name: "បុរីចំណូល", total: 10000, invoices: 1 }, { id: null, name: null, total: 7000, invoices: 2 }]);
    expect((await admin.req("GET", `/api/reports/summary?from=${today()}&to=${today()}`)).json.by_khan).toBeUndefined();
  });
});
