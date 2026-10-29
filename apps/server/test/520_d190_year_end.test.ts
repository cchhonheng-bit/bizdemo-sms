// D-190 (client 29-10): the year-end closing as they run it — tried first (nothing posted, also while the year runs), edited
// (lines added / changed, must balance) and posted exactly so, opened again (the closing reversed, history kept) and closed again.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { roleIds } from "../src/services/accounting.js";

let app: FastifyInstance; let s: Seed;
let cfo: Client, admin: Client;
let today: string, prevMonth: string, prevEnd: string, capBefore = 0;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const id = async (code: string) => (await sql<{ id: string }[]>`select id from accounts where company_id = ${s.a} and code = ${code}`)[0]!.id;
const bal = async (accountId: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(debit_cents - credit_cents), 0)::text as b from journal_lines where account_id = ${accountId}`)[0]!.b);
const entries = async () => Number((await sql<{ n: number }[]>`select count(*)::int as n from journal_entries where company_id = ${s.a}`)[0]!.n);

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  cfo = await loginAs(app, "cfo"); admin = await loginAs(app, "admin");
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  const m = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1));
  prevMonth = m.toISOString().slice(0, 7);
  prevEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, 0)).toISOString().slice(0, 10);
  // the fiscal year starts this month → last month ended a year (the books start in it): income $1,000 − expense $700 = $300
  expect((await acc(cfo, "/fiscal-year", { start_month: Number(today.slice(5, 7)) })).status).toBe(200);
  expect((await acc(cfo, "/opening", { date: `${prevMonth}-01`, cash_usd: 100000 })).status).toBe(200);
  for (const [type, amount] of [["other_income", 100000], ["expense", 70000]] as const)
    expect((await acc(cfo, "/transactions", { date: `${prevMonth}-15`, type, amount, pay: "cash_usd", ...(type === "expense" ? { account_code: "50010" } : {}) })).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-190 the year-end closing, tried, edited, reopened", () => {
  it("the test (preview): each result back to zero, $300 on retained earnings — nothing posted", async () => {
    const n0 = await entries();
    const p = (await acc(cfo, "/year-end/preview")).json;
    expect(p).toMatchObject({ year_end: prevEnd, ended: true, net_profit: 30000 });
    const R = await roleIds(sql, s.a);
    expect(p.lines.map((l: any) => [l.code, l.debit, l.credit])).toEqual([["40006", 100000, 0], ["50010", 0, 70000], [expect.any(String), 0, 30000]]);
    expect(p.lines.at(-1).account_id).toBe(R.retained);
    expect(await entries()).toBe(n0);
  });

  it("edited lines post exactly as edited (an extra line moves $50 to capital); an unbalanced edit is refused; the Admin cannot close", async () => {
    const R = await roleIds(sql, s.a), cap = await id("30001");
    const lines = [{ account_id: await id("40006"), debit: 100000 }, { account_id: await id("50010"), credit: 70000 }, { account_id: R.retained, credit: 25000 }, { account_id: cap, credit: 5000 }];
    expect((await acc(cfo, "/close-year", { year_end: prevEnd, lines: [...lines.slice(0, 3)] })).json.error).toBe("NOT_BALANCED");
    expect((await acc(admin, "/close-year", { year_end: prevEnd, lines })).status).toBe(403);
    const before = await Promise.all([R.retained, cap].map(bal)); capBefore = before[1]!;
    const r = await acc(cfo, "/close-year", { year_end: prevEnd, lines });
    expect(r.json, JSON.stringify(r.json)).toMatchObject({ year_end: prevEnd, net_profit: 30000 });
    expect(await Promise.all([R.retained, cap].map(bal))).toEqual([before[0]! - 25000, before[1]! - 5000]);
    expect(await bal(await id("40006"))).toBe(0);
    expect((await acc(cfo, "/lock")).json.books_closed_through).toBe(prevEnd);
    const a = (await sql<{ n: any }[]>`select new_data as n from audit_log where action = 'acct.close_year' order by id desc limit 1`)[0]!.n;
    expect(a).toMatchObject({ edited: true });
  });

  it("reopen: the closing reversed (history kept), the year open again; close again with the app's lines → $300 on retained", async () => {
    const R = await roleIds(sql, s.a), cap = await id("30001");
    expect((await acc(admin, "/reopen-year", {})).status).toBe(403);
    const r = await acc(cfo, "/reopen-year", {});
    expect(r.json).toMatchObject({ reopened: prevEnd, closed_through: null });
    expect(r.json.reversed).toHaveLength(1);
    expect(await bal(cap)).toBe(capBefore); // the edited 0 is gone again
    expect(await bal(await id("40006"))).toBe(-100000);
    expect((await acc(cfo, "/lock")).json.books_closed_through).toBeNull();
    expect((await acc(cfo, "/close-year", { year_end: prevEnd })).status).toBe(200); // the plan, no edit
    expect(await bal(R.retained)).toBe(-30000);
    expect((await acc(cfo, "/reopen-year", {})).status).toBe(200);
    expect((await acc(cfo, "/reopen-year", {})).json.error).toBe("NOTHING_CLOSED");
  });

  it("while a year runs the test still works (to today), and it cannot be closed yet", async () => {
    await acc(cfo, "/close-year", { year_end: prevEnd });
    expect((await acc(cfo, "/transactions", { date: today, type: "other_income", amount: 5000, pay: "cash_usd" })).status).toBe(200);
    const p = (await acc(cfo, "/year-end/preview")).json;
    expect(p).toMatchObject({ ended: false, upto: today, net_profit: 5000 });
    expect((await acc(cfo, "/close-year", { year_end: p.year_end })).json.error).toBe("YEAR_NOT_ENDED");
  });
});
