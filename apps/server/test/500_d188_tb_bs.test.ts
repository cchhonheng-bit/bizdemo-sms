// D-188 (client 29-10): the trial balance's «ខែនេះ» column shows a balance-sheet account's balance at the month's end (not its movement),
// an income / expense account's movement; the profit already inside those balances (this year up to last month) is a computed line on
// 30002 so the column balances. The balance sheet shows this year's result in two lines: 30002 = to the end of last month, «ប្រចាំខែ» = this month.
// The client's own example: last month income $1,000 − expense $700 = $300; this month $500 − $400 = $100.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { readWorkbook } from "../src/lib/xlsx.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, cfo: Client;
let today: string, month: string, prevMonth: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const xl = async (report: string, q: string) => {
  const r = await app.inject({ method: "GET", url: `/api/export/${report}.xlsx?${q}`, headers: { cookie: cfo.cookie! } });
  return readWorkbook(r.rawPayload)[0]!.rows;
};

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); cfo = await loginAs(app, "cfo");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(cfo, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  month = today.slice(0, 7);
  const p = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 2, 1));
  prevMonth = p.toISOString().slice(0, 7);
  // both months in one fiscal year (it starts last month), the books start on its first day with nothing
  expect((await acc(cfo, "/fiscal-year", { start_month: p.getUTCMonth() + 1 })).status).toBe(200);
  expect((await acc(cfo, "/opening", { date: `${prevMonth}-01` })).status).toBe(200);
  const tx = (date: string, type: string, amount: number) => acc(cfo, "/transactions", { date, type, amount, pay: "cash_usd", ...(type === "expense" ? { account_code: "50010" } : {}) });
  for (const [d, t, a] of [[`${prevMonth}-15`, "other_income", 100000], [`${prevMonth}-15`, "expense", 70000], [today, "other_income", 50000], [today, "expense", 40000]] as const)
    expect((await tx(d, t, a)).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-188 the trial balance and the balance sheet as the client keeps them", () => {
  it("«ខែនេះ»: cash = its balance $400 (not +$100); income / expense = this month; a computed 30002 line of $300 (last month's profit) balances it", async () => {
    const tb = (await acc(cfo, `/trial-balance?month=${month}`)).json;
    const by = (code: string, computed = false) => tb.rows.find((r: any) => r.code === code && !!r.computed === computed);
    expect(by("11001").period).toEqual({ debit: 40000, credit: 0 });
    expect(by("11001").ytd).toEqual(by("11001").period); // a balance-sheet account: «ខែនេះ» = «ដើមឆ្នាំដល់ខែនេះ»
    expect(by("11001").ytd_prev).toEqual({ debit: 30000, credit: 0 });
    expect(by("40006").period).toEqual({ debit: 0, credit: 50000 });
    expect(by("40006").ytd).toEqual({ debit: 0, credit: 150000 }); // income adds up: last month + this month
    expect(by("50010").period).toEqual({ debit: 40000, credit: 0 });
    expect(by("30002", true)).toMatchObject({ period: { debit: 0, credit: 30000 }, ytd: { debit: 0, credit: 0 } });
    expect(tb.totals.period).toEqual({ debit: 80000, credit: 80000 });
    expect(tb.balanced).toBe(true);
    const last = (await acc(cfo, `/trial-balance?month=${prevMonth}`)).json; // the year's first month: no earlier profit
    expect(last.rows.some((r: any) => r.computed)).toBe(false); expect(last.balanced).toBe(true);
    const x = await xl("trial-balance", `month=${month}`);
    expect(x.some((r) => r[0] === "30002" && String(r[1]).includes("(ដើមឆ្នាំដល់ចុងខែមុន)"))).toBe(true);
  });

  it("the balance sheet: 30002 = $300 (to the end of last month) + «ប្រចាំខែ» $100; last month's column: $0 + $300; assets = liabilities + equity", async () => {
    const bs = (await acc(cfo, `/balance-sheet?to=${today}`)).json;
    expect([bs.year_earnings, bs.month_earnings, bs.current_earnings]).toEqual([30000, 10000, 40000]);
    expect([bs.previous.year_earnings, bs.previous.month_earnings]).toEqual([0, 30000]);
    expect(bs.assets_total).toBe(bs.liabilities_total + bs.equity_total + bs.current_earnings + bs.prior_earnings);
    const x = await xl("balance-sheet", `asof=${today}`);
    expect(Number(x.find((r) => r[0] === "30002")![2])).toBe(300);
    expect(Number(x.find((r) => r[1] === "ចំណេញ/ខាត(-) ប្រចាំខែ")![2])).toBe(100);
  });
});
