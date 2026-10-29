// D-189 (client 29-10, «1st By Booking.xlsx»): stock withdrawn for each job vs what was invoiced, per booking — the sample job reproduced
// (−480 · −29.50 · +30 · +510 · +45 · −15 = 60.50), withdrawals before invoice lines, bookings in order, a job without an invoice listed,
// the booking / technician / «only mismatches» filters, the 10-vs-2 flag (yellow + note), the three ways out (return to stock · an extra
// invoice · lost / broken), the invoice pre-filled with the stock taken, technicians refused, the file = the screen.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, PW, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";
import { roleIds } from "../src/services/accounting.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, cfo: Client, gm: Client, kim: Client;
let today: string, to: string, cust: string, ac: string, copper: string;
const bk: Record<string, { id: string; number: string }> = {};
const inv = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/inventory${path}`, body);
const id = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const qs = (q: Record<string, string>) => Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
const xl = async (c: Client, q: Record<string, string> = {}) => {
  const r = await app.inject({ method: "GET", url: `/api/export/by-booking.xlsx?${qs({ from: today, to, ...q })}`, headers: { cookie: c.cookie! } });
  return { status: r.statusCode, n: Number(r.headers["x-rows"]), rows: r.statusCode === 200 ? readWorkbook(r.rawPayload)[0]!.rows : [] };
};
const screen = async (q: Record<string, string> = {}) => (await cfo.req("GET", `/api/export/by-booking.json?${qs({ from: today, to, ...q })}`)).json;
const of = (rows: string[][], number: string) => rows.filter((r) => r[8] === number && r[1]); // a booking's lines (account column set)
const num = (v: string | undefined) => Number(v ?? NaN);

async function booking(name: string) {
  const b = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: name, zone: "outside", ...span(new Date(Date.now() + 3600e3).toISOString()) })).json;
  expect(b, JSON.stringify(b)).toHaveProperty("id");
  return { id: b.id as string, number: (await sql<{ n: string }[]>`select number as n from bookings where id = ${b.id}`)[0]!.n };
}
const out = (item: string, qty: number, b: string) => inv(admin, "/out", { item_id: item, qty, technician_id: s.users.kim, booking_id: b });
async function invoice(b: string, lines: { description: string; kind: "service" | "product"; qty: number; unit_price: number; catalog_item_id?: string }[], discount = 0) {
  await sql`update bookings set status = 'reviewed' where id = ${b}`;
  const r = await admin.req("POST", "/api/invoices", { booking_id: b, lines: lines.map((l) => ({ unit: "", ...l })) });
  expect(r.json, JSON.stringify(r.json)).toHaveProperty("id");
  if (discount) expect((await gm.req("POST", `/api/invoices/${r.json.id}/discount`, { amount: discount })).status).toBe(200);
  expect((await admin.req("POST", `/api/invoices/${r.json.id}/issue`, {})).status).toBe(200);
  return r.json.id as string;
}

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await cfo.req("GET", "/api/accounting/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  to = new Date(Date.parse(`${today}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10); // a booking an hour ahead may fall on tomorrow
  expect((await cfo.req("POST", "/api/accounting/opening", { date: today, cash_usd: 1000000 })).status).toBe(200);
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ក្រៅបុរី វិចិត្រ", phones: ["012 777 888"], zone: "outside" })).json.id;
  ac = (await inv(admin, "/in", { name: "ម៉ាស៊ីនត្រជាក់ជាប់ជញ្ជាំង Panasonic 1.5 HP", account_id: await id("13110"), unit: "គ្រឿង", qty: 2, total: 96000, pay: "cash_usd" })).json.item_id;
  copper = (await inv(admin, "/in", { name: "ហ្គេនទុយោស្ពាន់ (6*13)", account_id: await id("13400"), unit: "ម៉ែត្រ", qty: 30, total: 29500, pay: "cash_usd" })).json.item_id; // $9.8333 a metre
  // 1 = the client's sample · 2 = 10 m taken, 2 m billed · 3 = taken, no invoice yet · 4 = 5 m taken, 3 m billed (for the extra invoice)
  for (const k of ["one", "two", "three", "four"]) bk[k] = await booking(`QA ${k}`);
  expect((await out(ac, 1, bk.one!.id)).status).toBe(200);
  expect((await out(copper, 3, bk.one!.id)).status).toBe(200);
  await invoice(bk.one!.id, [{ description: "ដំឡើងម៉ាស៊ីនត្រជាក់ Panasonic 1.5HP", kind: "service", qty: 1, unit_price: 3000 },
    { description: "ម៉ាស៊ីនត្រជាក់ Panasonic 1.5HP", kind: "product", qty: 1, unit_price: 51000, catalog_item_id: ac },
    { description: "ទុយោស្ពាន់ 6 x13", kind: "product", qty: 3, unit_price: 1500, catalog_item_id: copper }], 1500);
  expect((await out(copper, 10, bk.two!.id)).status).toBe(200);
  await invoice(bk.two!.id, [{ description: "ទុយោស្ពាន់", kind: "product", qty: 2, unit_price: 1500, catalog_item_id: copper }]);
  expect((await out(copper, 4, bk.three!.id)).status).toBe(200);
  expect((await out(copper, 5, bk.four!.id)).status).toBe(200);
  await invoice(bk.four!.id, [{ description: "ទុយោស្ពាន់", kind: "product", qty: 3, unit_price: 1500, catalog_item_id: copper }]);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-189 «By Booking»", () => {
  it("the client's sample job: withdrawals first (− qty, − cost on the stock account), then the invoice lines (+ on the income account) and the discount (−); subtotal $60.50", async () => {
    const R = await roleIds(sql, s.a), code = async (k: keyof typeof R) => (await sql<{ c: string }[]>`select code as c from accounts where id = ${R[k]}`)[0]!.c;
    const { rows } = await xl(cfo);
    const lines = of(rows, bk.one!.number);
    expect(lines.map((r) => num(r[6]))).toEqual([-480, -29.5, 30, 510, 45, -15]);
    expect(lines.map((r) => r[1])).toEqual(["13110", "13400", await code("rev_service"), await code("rev_sales"), await code("rev_sales"), await code("discount")]);
    expect([num(lines[0]![3]), num(lines[0]![5]), num(lines[1]![3]), num(lines[1]![5])]).toEqual([-1, -480, -3, -9.83]);
    expect([lines[0]![7] ?? "", lines[2]![7]]).toEqual(["", expect.stringMatching(/^INV-/)]);
    expect(lines[0]![9]).toBe("Kim");
    const sub = rows.find((r) => String(r[2] ?? "").startsWith(`សរុប ${bk.one!.number}`))!;
    expect([num(sub[3]), num(sub[6])]).toEqual([0, 60.5]);
    expect(String(sub[2])).not.toContain("⚠"); // nothing missing on the sample job
  });

  it("bookings in order; a job without an invoice is listed; the grand total; 10 m taken vs 2 m billed is flagged yellow with its note", async () => {
    const { rows } = await xl(cfo);
    const order = [...new Set(rows.filter((r) => /^BK-/.test(r[8] ?? "") && r[1]).map((r) => r[8]))];
    expect(order).toEqual([bk.one!.number, bk.two!.number, bk.three!.number, bk.four!.number]);
    const three = of(rows, bk.three!.number);
    expect(three.length).toBe(1); expect(three[0]![7] ?? "").toBe("");
    const total = rows.find((r) => r[0] === "សរុប")!, subs = rows.filter((r) => String(r[2] ?? "").startsWith("សរុប BK-"));
    expect(subs.length).toBe(4);
    expect(num(total[6])).toBeCloseTo(subs.reduce((a, r) => a + num(r[6]), 0), 2);
    const sub2 = rows.find((r) => String(r[2] ?? "").startsWith(`សរុប ${bk.two!.number}`))!;
    expect(String(sub2[2])).toMatch(/ដក 10 ម៉ែត្រ · វិក្កយបត្រ 2 ម៉ែត្រ/);
    const j = await screen(), sheet = j.sheets[0].rows as any[][];
    const flaggedRow = sheet.find((r) => (r[8]?.v ?? r[8]) === bk.two!.number && (r[1]?.v ?? r[1]) === "13400" && (r[3]?.v ?? r[3]) === -10);
    expect(flaggedRow?.[3]?.s).toBe("hlQty"); // yellow on screen and in the file (same cells)
    const sampleRow = sheet.find((r) => (r[8]?.v ?? r[8]) === bk.one!.number && (r[1]?.v ?? r[1]) === "13400");
    expect(sampleRow?.[3]?.s).toBe("qty");
  });

  it("filters: one booking · several · all · a technician · only the mismatches (10 vs 2, no invoice, 5 vs 3)", async () => {
    expect([...new Set(of((await xl(cfo, { bk: bk.two!.id })).rows, bk.two!.number).map((r) => r[8]))]).toEqual([bk.two!.number]);
    const several = (await xl(cfo, { bk: `${bk.one!.id},${bk.three!.id}` })).rows;
    expect([...new Set(several.filter((r) => /^BK-/.test(r[8] ?? "") && r[1]).map((r) => r[8]))]).toEqual([bk.one!.number, bk.three!.number]);
    expect((await xl(cfo, { technician: s.users.dara! })).n).toBe(0);
    const mm = (await xl(cfo, { mismatch: "1" })).rows;
    expect([...new Set(mm.filter((r) => /^BK-/.test(r[8] ?? "") && r[1]).map((r) => r[8]))]).toEqual([bk.two!.number, bk.three!.number, bk.four!.number]);
    const opts = (await cfo.req("GET", `/api/export/by-booking/options?from=${today}&to=${to}`)).json;
    expect(opts.map((o: any) => o.name)).toEqual([bk.one!.number, bk.two!.number, bk.three!.number, bk.four!.number]);
  });

  it("settling: 8 m back to stock clears job 2 (never more than held); lost / broken clears job 3; an extra invoice for 2 m clears job 4", async () => {
    const held = (await inv(admin, `/withdrawn?booking=${bk.two!.id}`)).json as any[];
    expect(held).toEqual([expect.objectContaining({ item_id: copper, technician_id: s.users.kim, withdrawn: 10, left: 10 })]);
    expect((await inv(admin, "/return", { item_id: copper, qty: 11, technician_id: s.users.kim, booking_id: bk.two!.id })).json.error).toBe("RETURN_TOO_MUCH");
    const r = await inv(admin, "/return", { item_id: copper, qty: 8, technician_id: s.users.kim, booking_id: bk.two!.id });
    expect(r.json).toMatchObject({ left: 2 });
    const back = (await sql<{ v: string }[]>`select value_cents::text as v from stock_moves where id = ${r.json.id}`)[0]!;
    const took = (await sql<{ v: string }[]>`select (-value_cents)::text as v from stock_moves where kind = 'out' and ref_id = ${bk.two!.id}`)[0]!;
    expect(Number(back.v)).toBe(Math.round((Number(took.v) / 10) * 8)); // at the job's own cost
    const ar = await id("13400"), mm1 = (await cfo.req("GET", `/api/export/by-booking/mismatches?from=${today}&to=${to}`)).json as any[];
    expect(mm1.map((m) => m.number)).toEqual([bk.three!.number, bk.four!.number]);
    expect((await inv(admin, "/variance", { booking_id: bk.three!.id, account_id: ar, qty: 4, reason: "ខូចពេលដំឡើង" })).status).toBe(200);
    const pre = (await admin.req("GET", `/api/invoices/prefill?booking=${bk.four!.id}&extra=1`)).json;
    expect(pre.lines).toEqual([expect.objectContaining({ catalog_item_id: copper, qty: 2 })]);
    const x = await admin.req("POST", "/api/invoices", { booking_id: bk.four!.id, extra: true, lines: pre.lines.map((l: any) => ({ ...l, unit_price: 1500 })) });
    expect(x.json, JSON.stringify(x.json)).toHaveProperty("id");
    expect((await admin.req("POST", `/api/invoices/${x.json.id}/issue`, {})).status).toBe(200);
    expect((await cfo.req("GET", `/api/export/by-booking/mismatches?from=${today}&to=${to}`)).json).toEqual([]);
    expect((await xl(cfo, { mismatch: "1" })).n).toBe(0);
    expect((await admin.req("GET", `/api/invoices/prefill?booking=${bk.three!.id}&extra=1`)).json.error).toBe("NOT_INVOICED");
  });

  it("an invoice made from a job brings the stock taken for it as linked goods lines; a technician is refused; the file = the screen", async () => {
    const b = await booking("QA five");
    expect((await out(copper, 2, b.id)).status).toBe(200);
    await sql`update bookings set status = 'reviewed' where id = ${b.id}`;
    const pre = (await admin.req("GET", `/api/invoices/prefill?booking=${b.id}`)).json;
    expect(pre.lines).toEqual(expect.arrayContaining([expect.objectContaining({ catalog_item_id: copper, kind: "product", qty: 2 })]));
    expect((await xl(kim)).status).toBe(403);
    expect((await kim.req("GET", `/api/export/by-booking/options?from=${today}&to=${to}`)).status).toBe(403);
    expect((await xl(gm)).status).toBe(403); // cost.read only
    const file = await xl(cfo), j = await screen();
    expect(j.rows).toBe(file.n);
  });
});
