// D-161 (owner 22-10, «multiple pay»): one save may carry several parts — cash $ + ABA, some ៛ some $ — in one transaction:
// one payments row per part, the overpay check on the sum, the ៛ rounding settle on the last part, nothing written on a refusal.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client;
let cust: string;

/** an issued direct invoice (one service line), $240 by default */
async function issued(total = 24000): Promise<string> {
  const inv = await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "សេវាកម្ម", kind: "service", qty: 1, unit: "", unit_price: total }] });
  expect(inv.status).toBe(200);
  expect((await admin.req("POST", `/api/invoices/${inv.json.id}/issue`)).status).toBe(200);
  return inv.json.id as string;
}
const pay = (id: string, body: Record<string, unknown>) => admin.req("POST", `/api/invoices/${id}/payments`, body);

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin");
  cust = (await admin.req("POST", "/api/customers", { ...PLACE, name: "អតិថិជន", phones: ["012 000 111"], zone: "inside" })).json.id;
  await sql`update company_settings set fx_rate_khr = 4000 where company_id = ${s.a}`;
});
afterAll(async () => { await app.close(); });

describe("D-161 split payment", () => {
  it("cash $45 + ABA $35 + 100,000 ៛ cash in one save → 3 rows, paid $105, partial; the single-part body still works", async () => {
    const id = await issued();
    const r = await pay(id, { parts: [{ amount: 4500, currency: "usd", method: "cash_usd" }, { amount: 3500, currency: "usd", method: "aba" }, { amount: 100_000, currency: "khr", method: "cash_khr" }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ paid: 10500, balance: 13500, payment_status: "partial" });
    expect(r.json.ids).toHaveLength(3);
    const rows = await sql<{ method: string; usd_cents: number; amount: string; currency: string }[]>`select method, usd_cents, amount::text, currency from payments where invoice_id = ${id} order by usd_cents desc`;
    expect(rows.map((x) => [x.method, x.usd_cents])).toEqual([["cash_usd", 4500], ["aba", 3500], ["cash_khr", 2500]]);
    expect((await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'payment.record' and new_data->>'part' is not null`)[0]!.n).toBe(3);
    expect((await pay(id, { amount: 1000, currency: "usd", method: "acleda" })).json).toMatchObject({ paid: 11500, balance: 12500 });
    expect((await ceo.req("GET", `/api/invoices/${id}`)).json.payments).toHaveLength(4);
  });

  it("the sum over the balance → OVERPAY and nothing written; a bad part (cash $ in ៛) → BAD_METHOD; a ៛ last part within the rounding settles the invoice exactly", async () => {
    const id = await issued(10000); // $100
    expect((await pay(id, { parts: [{ amount: 6000, currency: "usd", method: "cash_usd" }, { amount: 5000, currency: "usd", method: "aba" }] })).json.error).toBe("OVERPAY");
    expect((await pay(id, { parts: [{ amount: 1000, currency: "khr", method: "cash_usd" }] })).json.error).toBe("BAD_METHOD");
    expect((await sql<{ n: number }[]>`select count(*)::int as n from payments where invoice_id = ${id}`)[0]!.n).toBe(0);
    // $60 by ABA + 160,000 ៛ (= $40.00 at 4000) → paid in full, job closed
    const r = await pay(id, { parts: [{ amount: 6000, currency: "usd", method: "aba" }, { amount: 160_000, currency: "khr", method: "cash_khr" }] });
    expect(r.json).toMatchObject({ paid: 10000, balance: 0, payment_status: "paid" });
    expect((await pay(id, { parts: [] })).status).toBe(400);
  });
});
