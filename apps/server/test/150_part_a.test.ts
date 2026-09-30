// STEP 4 Part A (D-86): A1 done-but-not-invoiced · A3 exchange rate · deposits · payment void by reversal · A2 service reminders — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { setHubTransport } from "../src/services/hub-client.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, cfo: Client, kim: Client;
let cust: string, cust2: string, svc: string, clean: string, prod: string;
let slot = 0;
const when = (h = 2 + 3 * slot++) => new Date(Date.now() + h * 3600_000).toISOString();
const hubSent: { path: string; body: any }[] = [];

/** a job stepped to `status` (default reviewed) for `customer`, service `item`, optional materials */
async function job(o: { customer?: string; item?: string; status?: string; units?: string[]; materials?: boolean } = {}): Promise<string> {
  const id = (await ceo.req("POST", "/api/bookings", { customer_id: o.customer ?? cust, type: "A", category: "mep", service_text: "សេវាកម្ម", zone: "inside", scheduled_at: when(), service_item_id: o.item ?? svc, unit_ids: o.units })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const path = ["on_site", "work_done", "pending_review", "reviewed"];
  for (const st of path.slice(0, path.indexOf(o.status ?? "reviewed") + 1)) await sql`update bookings set status = ${st}::booking_status where id = ${id}`;
  if (o.materials) await sql`insert into booking_materials (booking_id, catalog_item_id, qty) values (${id}, ${prod}, 2)`;
  return id;
}
const invoiceFor = async (booking: string, cents: number) => {
  const id = (await admin.req("POST", "/api/invoices", { booking_id: booking, lines: [{ description: "x", kind: "service", qty: 1, unit: "job", unit_price: cents }] })).json.id;
  expect((await admin.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
  return id;
};
const inv = async (id: string) => (await ceo.req("GET", `/api/invoices/${id}`)).json;
const bstatus = async (id: string) => (await ceo.req("GET", `/api/bookings/${id}`)).json.status;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "subscribe,reminders";
  setHubTransport(async (_method, path, body) => {
    hubSent.push({ path, body });
    if (path === "/internal/notify-subscriber") return { status: 200, json: { ok: true } };
    if (path === "/internal/bot") return { status: 200, json: { username: "Oneteam_app_bot" } };
    return { status: 200, json: { ok: true } };
  });
  const hash = await hashPassword(PW);
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); cfo = await loginAs(app, "cfo"); kim = await loginAs(app, "kim");
  await ceo.req("POST", "/api/settings/fx", { rate: 4100 });
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក រំលឹក", phones: ["012707070"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  cust2 = (await ceo.req("POST", "/api/customers", { name: "អ្នកស្រី ពីរ", phones: ["012808080"], zone: "outside" })).json.id;
  svc = (await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុល", kind: "service", category: "mep", unit: "job", sell_price: 3000 })).json.id;
  clean = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "unit", sell_price: 1500, reminder_months: 3 })).json.id;
  prod = (await ceo.req("POST", "/api/catalog", { name_km: "ហ្គាស", kind: "product", category: "mep", unit: "kg", sell_price: 1000 })).json.id;
});
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("A1 done but not invoiced", () => {
  it("finished jobs without an invoice, with age and an estimate (service + materials at catalog price); gone once invoiced; CEO/CFO counter", async () => {
    const a = await job({ materials: true });             // $30 + 2 × $10 = $50
    const b = await job({ status: "pending_review" });   // finished, waiting for the GM — still counts
    await job({ status: "on_site" });                      // not finished
    const list = (await admin.req("GET", "/api/invoices/uninvoiced")).json as any[];
    expect(list.map((x) => x.booking_id)).toEqual(expect.arrayContaining([a, b]));
    expect(list).toHaveLength(2);
    expect(list.find((x) => x.booking_id === a)).toMatchObject({ estimate: 5000, age_days: 0, customer_name: "លោក រំលឹក" });
    const d = (await ceo.req("GET", "/api/reports/dashboard")).json;
    expect(d.uninvoiced).toMatchObject({ count: 2, estimate: 8000 });
    expect((await gm.req("GET", "/api/reports/dashboard")).json.uninvoiced).toBeUndefined(); // money: CEO/CFO only
    await invoiceFor(a, 5000);
    expect(((await admin.req("GET", "/api/invoices/uninvoiced")).json as any[]).map((x) => x.booking_id)).toEqual([b]);
    expect((await kim.req("GET", "/api/invoices/uninvoiced")).status).toBe(403);
  });
});

describe("A3 exchange rate", () => {
  it("CEO and CFO set it (audited, history), Admin/GM cannot; each transaction keeps its own rate; bounds", async () => {
    const i1 = await invoiceFor(await job(), 10000);
    expect((await inv(i1)).fx_rate_khr).toBe(4100);
    expect((await admin.req("POST", "/api/settings/fx", { rate: 4050 })).status).toBe(403);
    expect((await gm.req("POST", "/api/settings/fx", { rate: 4050 })).status).toBe(403);
    expect((await cfo.req("POST", "/api/settings/fx", { rate: 4150, note: "NBC 30-09" })).status).toBe(200);
    expect((await cfo.req("POST", "/api/settings/fx", { rate: 999 })).status).toBe(400);
    const h = (await cfo.req("GET", "/api/settings/fx")).json;
    expect(h.current).toBe(4150);
    expect(h.history[0]).toMatchObject({ rate: 4150, note: "NBC 30-09", set_by_name: "CFO A" });
    expect((await inv(i1)).fx_rate_khr).toBe(4100);                          // old record never changes
    const i2 = await invoiceFor(await job(), 10000);
    expect((await inv(i2)).fx_rate_khr).toBe(4150);                          // new one snapshots the new rate
    expect((await inv(i2)).total_khr).toBe(415000);
    const audit = (await ceo.req("GET", "/api/settings/audit?limit=100")).json;
    expect(audit.find((a: any) => a.action === "fx.set")).toMatchObject({ old_data: { fx_rate_khr: 4100 }, new_data: { fx_rate_khr: 4150 } });
    expect((await kim.req("GET", "/api/settings/fx")).status).toBe(403);
    await ceo.req("POST", "/api/settings/fx", { rate: 4100 });
  });
});

describe("deposit when the customer accepts a quote", () => {
  let booking: string, quote: string;
  beforeAll(async () => {
    booking = (await admin.req("POST", "/api/bookings", { customer_id: cust2, type: "B", category: "construction", service_text: "របង", zone: "outside", scheduled_at: when() })).json.id;
    quote = (await gm.req("POST", "/api/quotes", { booking_id: booking, lines: [{ description: "របង", kind: "service", qty: 1, unit: "job", unit_price: 50000 }] })).json.id;
  });

  it("only after acceptance; $ or ៛ with its own rate; Admin records, technicians cannot", async () => {
    const dep = (v: Record<string, unknown>, c = admin) => c.req("POST", `/api/bookings/${booking}/deposits`, v);
    expect((await dep({ amount: 10000, currency: "usd", method: "cash_usd" })).json.error).toBe("QUOTE_NOT_ACCEPTED");
    await gm.req("POST", `/api/quotes/${quote}/accept`);
    expect((await dep({ amount: 10000, currency: "usd", method: "cash_usd" }, kim)).status).toBe(403);
    expect((await dep({ amount: 10000, currency: "usd", method: "cash_usd" })).status).toBe(200);
    expect((await dep({ amount: 205000, currency: "khr", method: "aba" })).status).toBe(200); // = $50.00 at 4100
    const list = (await admin.req("GET", `/api/bookings/${booking}/deposits`)).json;
    expect(list.map((d: any) => [d.usd_cents, d.status])).toEqual([[10000, "active"], [5000, "active"]]);
  });

  it("issuing the job's invoice applies the deposits as payments (no new cash); balance and status follow", async () => {
    await gm.req("POST", `/api/bookings/${booking}/assign`, { lead: s.users.kim, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${booking}`;
    const id = await invoiceFor(booking, 50000);
    const d = await inv(id);
    expect(d).toMatchObject({ total: 50000, paid: 15000, balance: 35000, payment_status: "partial" });
    expect(d.payments.every((p: any) => p.from_deposit)).toBe(true);
    expect(await bstatus(booking)).toBe("partially_paid");
    expect((await admin.req("GET", `/api/bookings/${booking}/deposits`)).json.every((x: any) => x.status === "applied")).toBe(true);
  });

  it("a deposit larger than the invoice stops the issue (fix the lines or void the deposit); GM/CEO void a deposit with a reason", async () => {
    const b2 = (await admin.req("POST", "/api/bookings", { customer_id: cust2, type: "B", category: "construction", service_text: "ទ្វារ", zone: "outside", scheduled_at: when() })).json.id;
    const q2 = (await gm.req("POST", "/api/quotes", { booking_id: b2, lines: [{ description: "ទ្វារ", kind: "service", qty: 1, unit: "job", unit_price: 2000 }] })).json.id;
    await gm.req("POST", `/api/quotes/${q2}/accept`);
    const dep = (await admin.req("POST", `/api/bookings/${b2}/deposits`, { amount: 5000, currency: "usd", method: "cash_usd" })).json.id;
    await gm.req("POST", `/api/bookings/${b2}/assign`, { lead: s.users.dara, assistants: [] });
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${b2}`;
    const i = (await admin.req("POST", "/api/invoices", { booking_id: b2, lines: [{ description: "x", kind: "service", qty: 1, unit: "job", unit_price: 2000 }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${i}/issue`)).json.error).toBe("DEPOSIT_EXCEEDS_TOTAL");
    expect((await admin.req("POST", `/api/deposits/${dep}/void`, { reason: "សងវិញ" })).status).toBe(403);
    expect((await gm.req("POST", `/api/deposits/${dep}/void`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    expect((await gm.req("POST", `/api/deposits/${dep}/void`, { reason: "សងប្រាក់ភ្ញៀវវិញ" })).status).toBe(200);
    expect((await admin.req("POST", `/api/invoices/${i}/issue`)).status).toBe(200);
  });
});

describe("void a mistyped payment (reason + approval, by reversal)", () => {
  it("Admin asks → GM approves → a reversal row; balance and job status come back; original untouched but marked; then the invoice can be voided", async () => {
    const b = await job();
    const i = await invoiceFor(b, 20000);
    const p = (await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 20000, currency: "usd", method: "cash_usd" })).json.id;
    expect(await bstatus(b)).toBe("closed");
    expect((await admin.req("POST", `/api/payments/${p}/void`, { reason: "" })).json.error).toBe("REASON_REQUIRED");
    expect((await admin.req("POST", `/api/payments/${p}/void`, { reason: "វាយខុស ត្រូវ 2,000" })).json.status).toBe("pending");
    expect((await admin.req("POST", `/api/payments/${p}/void/approve`)).status).toBe(403);
    expect((await gm.req("POST", `/api/payments/${p}/void/approve`)).status).toBe(200);
    const d = await inv(i);
    expect(d).toMatchObject({ paid: 0, balance: 20000, payment_status: "unpaid" });
    const orig = d.payments.find((x: any) => x.id === p);
    expect(orig).toMatchObject({ amount: 20000, usd_cents: 20000, void_reason: "វាយខុស ត្រូវ 2,000" });
    expect(orig.voided_at).toBeTruthy();
    expect(d.payments.find((x: any) => x.reversal_of === p)).toMatchObject({ usd_cents: -20000 });
    expect(await bstatus(b)).toBe("invoiced");
    expect((await gm.req("POST", `/api/payments/${p}/void`, { reason: "ម្ដងទៀត" })).json.error).toBe("ALREADY_VOID");
    expect((await ceo.req("POST", `/api/invoices/${i}/void`, { reason: "ចេញខុស" })).json.status).toBe("void"); // no net payment left
  });

  it("GM asks → only the CEO approves (not self, not another GM); CEO voids directly; a partial job goes back to invoiced", async () => {
    const b = await job();
    const i = await invoiceFor(b, 20000);
    const p = (await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 5000, currency: "usd", method: "aba" })).json.id;
    expect(await bstatus(b)).toBe("partially_paid");
    await gm.req("POST", `/api/payments/${p}/void`, { reason: "ABA ខុសវិក្កយបត្រ" });
    expect((await gm.req("POST", `/api/payments/${p}/void/approve`)).json.error).toBe("OWN_REQUEST");
    expect((await ceo.req("POST", `/api/payments/${p}/void/approve`)).status).toBe(200);
    expect(await bstatus(b)).toBe("invoiced");
    const q = (await admin.req("POST", `/api/invoices/${i}/payments`, { amount: 3000, currency: "usd", method: "cash_usd" })).json.id;
    expect((await ceo.req("POST", `/api/payments/${q}/void`, { reason: "ចុចពីរដង" })).json.status).toBe("void");
    expect((await inv(i)).paid).toBe(0);
    // the day's cash close and reports see the net amount automatically
    const today = (await sql<{ d: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as d`)[0]!.d;
    const cash = (await ceo.req("GET", `/api/reports/cash-close?from=${today}&to=${today}`)).json[0];
    expect(cash.expected_usd % 1).toBe(0);
    const ver = (await cfo.req("GET", `/api/reports/verification?from=${today}&to=${today}`)).json as any[];
    expect(ver.some((v) => v.type === "payment" && v.amount === -3000)).toBe(true);
  });
});

describe("A2 service reminders (flag reminders)", () => {
  let unit1: string, unit2: string, done: string;
  beforeAll(async () => {
    unit1 = (await admin.req("POST", `/api/customers/${cust}/units`, { label: "បន្ទប់គេង", brand: "Daikin", model: "1.5HP" })).json.id;
    unit2 = (await admin.req("POST", `/api/customers/${cust}/units`, { label: "បន្ទប់ទទួលភ្ញៀវ" })).json.id;
    // cust: both units cleaned 3 months + 5 days ago → overdue per unit
    done = await job({ item: clean, status: "reviewed", units: [unit1, unit2] });
    await sql`update bookings set scheduled_at = now() - interval '3 months 5 days', ends_at = now() - interval '3 months 5 days' + interval '2 hours' where id = ${done}`;
    await sql`insert into booking_checkpoints (booking_id, company_id, step, at) values (${done}, ${s.a}, 'finish', now() - interval '3 months 5 days')`;
    // cust2: no units, cleaned 2 months 20 days ago → due within 14 days (customer level)
    const d2 = await job({ customer: cust2, item: clean, status: "reviewed" });
    await sql`update bookings set scheduled_at = now() - interval '2 months 20 days', ends_at = now() - interval '2 months 20 days' + interval '2 hours' where id = ${d2}`;
    await sql`insert into booking_checkpoints (booking_id, company_id, step, at) values (${d2}, ${s.a}, 'finish', now() - interval '2 months 20 days')`;
  });

  it("units per customer; a service's interval; due / overdue per unit when units exist, per customer otherwise; one-tap phone", async () => {
    expect((await admin.req("GET", `/api/customers/${cust}/units`)).json.map((u: any) => u.label)).toEqual(["បន្ទប់គេង", "បន្ទប់ទទួលភ្ញៀវ"]);
    const r = (await admin.req("GET", "/api/reminders?days=14")).json as any[];
    const mine = r.filter((x) => x.customer_id === cust);
    expect(mine.map((x) => x.unit_label).sort()).toEqual(["បន្ទប់គេង", "បន្ទប់ទទួលភ្ញៀវ"].sort());
    expect(mine.every((x) => x.status === "overdue" && x.days_overdue >= 4 && x.phones[0] === "012707070")).toBe(true);
    const c2 = r.find((x) => x.customer_id === cust2);
    expect(c2).toMatchObject({ unit_id: null, status: "due", service_name: "លាងម៉ាស៊ីនត្រជាក់" });
    expect((await kim.req("GET", "/api/reminders")).status).toBe(403);
  });

  it("contacted keeps it listed with the contact; snooze hides until the date; a future booking of the same service hides it", async () => {
    const r = (await admin.req("GET", "/api/reminders?days=14")).json as any[];
    const u1 = r.find((x) => x.unit_id === unit1), u2 = r.find((x) => x.unit_id === unit2);
    expect((await admin.req("POST", "/api/reminders/action", { customer_id: cust, unit_id: unit1, service_item_id: clean, due_on: u1.due_on, action: "contacted", note: "នឹងតេវិញ" })).status).toBe(200);
    const snoozeTo = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    await admin.req("POST", "/api/reminders/action", { customer_id: cust, unit_id: unit2, service_item_id: clean, due_on: u2.due_on, action: "snoozed", until: snoozeTo });
    const r2 = (await admin.req("GET", "/api/reminders?days=14")).json as any[];
    expect(r2.find((x) => x.unit_id === unit1)).toMatchObject({ last_action: "contacted", last_note: "នឹងតេវិញ" });
    expect(r2.find((x) => x.unit_id === unit2)).toBeUndefined();
    await ceo.req("POST", "/api/bookings", { customer_id: cust2, type: "A", category: "mep", service_text: "លាង", zone: "outside", scheduled_at: when(24), service_item_id: clean });
    expect(((await admin.req("GET", "/api/reminders?days=14")).json as any[]).find((x) => x.customer_id === cust2)).toBeUndefined();
  });

  it("Telegram: per-customer subscribe link; the hub reports the subscriber; reminders go once per due date, only to linked customers, daily limit", async () => {
    const l = (await admin.req("POST", `/api/customers/${cust}/tg-link`)).json;
    expect(l.link).toMatch(/^https:\/\/t\.me\/Oneteam_app_bot\?start=s_[A-HJ-NP-Z2-9]{8}$/);
    const code = l.link.split("s_")[1];
    const internal = (body: unknown) => app.inject({ method: "POST", url: "/internal/customer-subscribed", headers: { "x-hub-key": config.shop.hubKey, "content-type": "application/json" }, payload: JSON.stringify(body) });
    config.shop.hubKey = config.shop.hubKey || "test-hub-key-0123456789";
    expect((await internal({ code, subscriber_id: 77 })).json()).toMatchObject({ ok: true, customer: "លោក រំលឹក" });
    expect((await internal({ code, subscriber_id: 78 })).json()).toMatchObject({ ok: false, error: "CODE_USED" });
    hubSent.length = 0;
    const r = (await admin.req("GET", "/api/reminders?days=14")).json as any[];
    const u1 = r.find((x) => x.unit_id === unit1);
    expect(u1.telegram).toBe(true);
    const send = (items: any[]) => admin.req("POST", "/api/reminders/telegram", { items });
    const item = { customer_id: cust, unit_id: unit1, service_item_id: clean, due_on: u1.due_on };
    expect((await send([item])).json).toMatchObject({ sent: 1, skipped: 0 });
    expect(hubSent.filter((x) => x.path === "/internal/notify-subscriber")).toHaveLength(1);
    expect(hubSent[0]!.body).toMatchObject({ subscriber_id: 77 });
    expect(hubSent[0]!.body.text).toContain("លាងម៉ាស៊ីនត្រជាក់");
    expect((await send([item])).json).toMatchObject({ sent: 0, skipped: 1 });                  // once per due date
    const c2item = { customer_id: cust2, unit_id: null, service_item_id: clean, due_on: "2026-12-01" };
    expect((await send([c2item])).json).toMatchObject({ sent: 0, not_linked: 1 });
    await ceo.req("PATCH", "/api/settings/company", { reminder_daily_limit: 0 });
    const u1b = { ...item, due_on: "2027-01-01" };
    expect((await send([u1b])).json).toMatchObject({ sent: 0, limit: 1 });
  });

  it("the module is off → the routes do not exist", async () => {
    config.shop.features = "subscribe";
    expect((await admin.req("GET", "/api/reminders")).status).toBe(404);
    config.shop.features = "subscribe,reminders";
  });
});
