// CEO feedback 04-10 on the L4 videos (D-126): opening balances are a draft (changeable, logged) until «បញ្ជាក់សមតុល្យដើម»; the income
// statement shows the previous month and the variance; an invoice may carry an earlier date inside an unlocked period (a reason when
// more than 3 days back), never a future one — revenue and the journal entry take that date.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, PW, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance; let s: Seed; let ceo: Client; let cfo: Client; let admin: Client;
let today: string, prevFirst: string, lockDay: string, cust: string;
const acc = (c: Client, path: string, body?: unknown, method?: string) => c.req(method ?? (body === undefined ? "GET" : "POST"), `/api/accounting${path}`, body);
const day = async (expr: string) => (await sql.unsafe<{ d: string }[]>(`select (${expr})::date::text as d`))[0]!.d;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "accounting,inventory";
  const hash = await hashPassword(PW);
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false)`;
  ceo = await loginAs(app, "ceo"); cfo = await loginAs(app, "cfo"); admin = await loginAs(app, "admin");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  cust = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន ថ្ងៃមុន", phones: ["012636363"], zone: "inside" })).json.id;
  const pp = "(now() at time zone 'Asia/Phnom_Penh')::date";
  today = await day(pp); prevFirst = await day(`date_trunc('month', ${pp}) - interval '1 month'`); lockDay = await day(`date_trunc('month', ${pp}) - interval '1 month' - interval '1 day'`);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

const issue = async (date?: string, reason?: string) => {
  const id = (await admin.req("POST", "/api/invoices", { customer_id: cust, lines: [{ description: "ជួសជុល", kind: "service", qty: 1, unit: "unit", unit_price: 10000 }] })).json.id as string;
  return { id, r: await admin.req("POST", `/api/invoices/${id}/issue`, { ...(date ? { date } : {}), ...(reason ? { reason } : {}) }) };
};

describe("opening balances: a draft until «បញ្ជាក់សមតុល្យដើម»", () => {
  it("CFO / CEO save and change the draft (each change logged before → after); confirm posts and locks; no draft after that", async () => {
    expect((await acc(cfo, "/opening/draft", { date: prevFirst, cash_usd: 100000 }, "PUT")).status).toBe(200);
    expect((await acc(cfo, "/lock")).json.opening_draft).toMatchObject({ date: prevFirst, cash_usd: 100000 });
    expect((await acc(ceo, "/opening/draft", { date: prevFirst, cash_usd: 120000, banks: { aba: 50000 } }, "PUT")).status).toBe(200);
    expect((await acc(admin, "/opening/draft", { date: prevFirst, cash_usd: 1 }, "PUT")).status).toBe(403);
    const log = await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = 'acct.opening_draft' order by id`;
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ old_data: { cash_usd: 100000 }, new_data: { cash_usd: 120000, banks: { aba: 50000 } } });
    expect((await sql<{ n: number }[]>`select count(*)::int as n from journal_entries`)[0]!.n).toBe(0); // a draft posts nothing
    const r = await acc(cfo, "/opening", { date: prevFirst, cash_usd: 120000, banks: { aba: 50000 } });
    expect(r.status).toBe(200);
    const info = (await acc(cfo, "/lock")).json;
    expect(info).toMatchObject({ books_start: prevFirst, lock_date: lockDay, opening_draft: null });
    expect((await acc(cfo, "/opening/draft", { date: prevFirst, cash_usd: 1 }, "PUT")).json.error).toBe("OPENING_DONE");
    expect((await acc(cfo, "/opening", { date: prevFirst, cash_usd: 1 })).json.error).toBe("OPENING_DONE");
  });
});

describe("income statement: previous month + variance", () => {
  it("every line and total also for the same period one month earlier; a full month compares with the full month before", async () => {
    await acc(cfo, "/transactions", { date: prevFirst, type: "other_income", account_code: "4090", amount: 10000, pay: "aba" });
    await acc(cfo, "/transactions", { date: today, type: "other_income", account_code: "4090", amount: 25000, pay: "aba" });
    const thisFirst = await day("date_trunc('month', (now() at time zone 'Asia/Phnom_Penh')::date)");
    const is = (await acc(cfo, `/income-statement?from=${thisFirst}&to=${today}`)).json;
    expect(is.income.find((r: any) => r.code === "4090")).toMatchObject({ amount: 25000, previous: 10000, variance: 15000 });
    expect(is.previous).toMatchObject({ from: prevFirst, income_total: 10000, net: 10000 });
    expect(is.previous.to.slice(0, 7)).toBe(prevFirst.slice(0, 7)); // the same days of the previous month
    const prevLast = await day("date_trunc('month', (now() at time zone 'Asia/Phnom_Penh')::date) - interval '1 day'");
    const full = (await acc(cfo, `/income-statement?from=${prevFirst}&to=${prevLast}`)).json;
    expect(full.income.find((r: any) => r.code === "4090")).toMatchObject({ amount: 10000, previous: 0, variance: 10000 });
    expect(full.previous.to).toBe(lockDay); // the last day of the month before (a month end stays a month end)
  });
});

describe("invoice date: earlier days inside an unlocked period", () => {
  it("2 days back without a reason; more than 3 days needs one; never in the future nor in a locked period; revenue and the entry take the date", async () => {
    const d2 = await day("(now() at time zone 'Asia/Phnom_Penh')::date - 2"), d5 = await day("(now() at time zone 'Asia/Phnom_Penh')::date - 5");
    const tomorrow = await day("(now() at time zone 'Asia/Phnom_Penh')::date + 1");
    const a = await issue(d2);
    expect(a.r.status).toBe(200);
    expect((await sql<{ d: string }[]>`select ((issued_at at time zone 'Asia/Phnom_Penh')::date)::text as d from invoices where id = ${a.id}`)[0]!.d).toBe(d2);
    expect((await sql<{ d: string }[]>`select entry_date::text as d from journal_entries where source = 'invoice' and source_id = ${a.id}`)[0]!.d).toBe(d2);
    expect((await issue(d5)).r.json.error).toBe("REASON_REQUIRED");
    const b = await issue(d5, "ភ្លេចចេញវិក្កយបត្រ");
    expect(b.r.status).toBe(200);
    expect((await sql<{ n: any }[]>`select new_data as n from audit_log where action = 'invoice.issue' and row_id = ${b.id}`)[0]!.n).toMatchObject({ issued_on: d5, back_days: 5, reason: "ភ្លេចចេញវិក្កយបត្រ" });
    expect((await issue(tomorrow)).r.json.error).toBe("BAD_DATE");
    expect((await issue(lockDay, "ថ្ងៃបិទហើយ")).r.json.error).toBe("PERIOD_LOCKED");
    const c = await issue(); // today, as before
    expect(c.r.status).toBe(200);
    expect((await sql<{ n: any }[]>`select new_data as n from audit_log where action = 'invoice.issue' and row_id = ${c.id}`)[0]!.n.back_days).toBeUndefined();
  });
});
