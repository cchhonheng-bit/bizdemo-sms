// Flow 7b: technician performance (FR-1104), Excel/CSV export (FR-1105), daily cash close (FR-1107) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, cfo: Client, kim: Client;
let cust: string;
let slot = 0;
const when = () => new Date(Date.now() + (2 + 3 * slot++) * 3600_000).toISOString();
const today = async () => (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;

/** kim's job with a start → finish of `minutes` today; optional revision round and late alert */
async function job(minutes: number, o: { revision?: boolean; late?: boolean } = {}): Promise<string> {
  const id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", scheduled_at: when() })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const path = ["on_site", "working", "work_done", "pending_review", ...(o.revision ? ["revision", "pending_review"] : []), "reviewed"];
  for (const st of path) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
  const start = new Date(Date.now() - (minutes + 30) * 60_000), finish = new Date(start.getTime() + minutes * 60_000);
  await sql`insert into booking_checkpoints (booking_id, company_id, step, at, by_user) values (${id}, ${s.a}, 'start', ${start}, ${s.users.kim!}), (${id}, ${s.a}, 'finish', ${finish}, ${s.users.kim!})`;
  if (o.late) await sql`update bookings set late_alerted_at = now() where id = ${id}`;
  return id;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim");
  await ceo.req("POST", "/api/settings/fx", { rate: 4100 });
  cust = (await ceo.req("POST", "/api/customers", { name: "=HYPERLINK(\"http://x\")", phones: ["012606060"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
});
afterAll(async () => { await app.close(); });

describe("technician performance (FR-1104)", () => {
  it("jobs finished, work minutes, revision rounds and late arrivals per technician", async () => {
    await job(90); await job(60, { revision: true, late: true });
    const d = await today();
    const r = (await gm.req("GET", `/api/reports/summary?from=${d}&to=${d}`)).json;
    const k = r.techs.find((t: any) => t.user_id === s.users.kim);
    expect(k).toMatchObject({ full_name: "Kim", jobs: 2, work_min: 150, revisions: 1, late: 1 });
    expect(r.techs.find((t: any) => t.user_id === s.users.dara)).toMatchObject({ jobs: 0, work_min: 0 });
  });
});

describe("export to Excel (CSV, FR-1105)", () => {
  let invNo: string;
  beforeAll(async () => {
    const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "x", kind: "service", qty: 1, unit: "job", unit_price: 12345 }] })).json.id;
    await admin.req("POST", `/api/invoices/${id}/issue`);
    await admin.req("POST", `/api/invoices/${id}/payments`, { amount: 3000, currency: "usd", method: "cash_usd" });
    await admin.req("POST", `/api/invoices/${id}/payments`, { amount: 41000, currency: "khr", method: "cash_khr" });
    invNo = (await admin.req("GET", `/api/invoices/${id}`)).json.number;
  });
  const get = (c: Client, kind: string, d: string) => app.inject({ method: "GET", url: `/api/reports/export?kind=${kind}&from=${d}&to=${d}`, headers: { cookie: c.cookie! } });

  it("invoices / payments / jobs / attendance as CSV with BOM (Khmer opens in Excel); formula cells neutralised", async () => {
    const d = await today();
    const r = await get(ceo, "invoices", d);
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-type"]).toContain("text/csv");
    expect(String(r.headers["content-disposition"])).toContain(`invoices_${d}_${d}.csv`);
    expect(r.body.charCodeAt(0)).toBe(0xfeff);
    const lines = r.body.slice(1).trim().split("\r\n");
    expect(lines[0]).toContain("number");
    const row = lines.find((l) => l.includes(invNo))!;
    expect(row).toContain("123.45");
    expect(row).toContain(`"'=HYPERLINK(""http://x"")"`); // CSV injection guard
    const p = await get(ceo, "payments", d);
    expect(p.body.split("\r\n").filter((l) => l.includes(invNo))).toHaveLength(2);
    expect((await get(gm, "jobs", d)).statusCode).toBe(200);
    expect((await get(gm, "attendance", d)).statusCode).toBe(200);
  });

  it("money exports need report.finance; technicians nothing; bad kind / range refused", async () => {
    const d = await today();
    expect((await get(gm, "invoices", d)).statusCode).toBe(403);
    expect((await get(gm, "payments", d)).statusCode).toBe(403);
    expect((await get(kim, "jobs", d)).statusCode).toBe(403);
    expect((await get(ceo, "bogus", d)).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: `/api/reports/export?kind=jobs&from=2025-01-01&to=${d}`, headers: { cookie: ceo.cookie! } })).statusCode).toBe(400);
  });
});

describe("daily cash close (FR-1107)", () => {
  it("expected cash from the day's cash payments; Admin enters the count → difference; CFO verifies → locked", async () => {
    const d = await today();
    const e = (await admin.req("GET", `/api/reports/cash-close?from=${d}&to=${d}`)).json;
    expect(e[0]).toMatchObject({ day: d, expected_usd: 3000, expected_khr: 41000, counted_usd: null, closed: false });
    const r = await admin.req("POST", "/api/reports/cash-close", { day: d, counted_usd: 2900, counted_khr: 41000, note: "ខ្វះ $1" });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ diff_usd: -100, diff_khr: 0 });
    expect((await admin.req("POST", "/api/reports/cash-close", { day: d, counted_usd: 3000, counted_khr: 41000 })).json).toMatchObject({ diff_usd: 0 }); // re-count before CFO check
    expect((await cfo.req("POST", `/api/reports/cash-close/${d}/verify`, {})).status).toBe(200);
    const v = (await cfo.req("GET", `/api/reports/cash-close?from=${d}&to=${d}`)).json[0];
    expect(v).toMatchObject({ counted_usd: 3000, diff_usd: 0, closed: true, verified_by_name: "CFO A", closed_by_name: "Admin A" });
    expect((await admin.req("POST", "/api/reports/cash-close", { day: d, counted_usd: 1, counted_khr: 0 })).json.error).toBe("CASH_VERIFIED");
  });

  it("guards: no future day; GM / technicians cannot close; only report.verify verifies; not before a close", async () => {
    expect((await admin.req("POST", "/api/reports/cash-close", { day: "2099-01-01", counted_usd: 0, counted_khr: 0 })).json.error).toBe("BAD_DATE");
    expect((await gm.req("POST", "/api/reports/cash-close", { day: await today(), counted_usd: 0, counted_khr: 0 })).status).toBe(403);
    expect((await kim.req("GET", `/api/reports/cash-close?from=2026-09-01&to=2026-09-02`)).status).toBe(403);
    expect((await admin.req("POST", "/api/reports/cash-close/2026-09-01/verify", {})).status).toBe(403);
    expect((await cfo.req("POST", "/api/reports/cash-close/2026-09-01/verify", {})).json.error).toBe("NOT_CLOSED");
    expect((await admin.req("POST", "/api/reports/cash-close", { day: await today(), counted_usd: -5, counted_khr: 0 })).status).toBe(400);
  });
});
