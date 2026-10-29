// D-187 (owner 29-10): the salary is set on the user form (create + edit) and linked to the existing payroll — a history of changes,
// each from its own day; a month's run takes the salary in force on its last day and keeps it; approving posts salaries (map «salaries»)
// + the allowance with the benefits (map «bonus») / wages owed (map «payroll»); paying by each person's method clears it against the
// mapped bank. Only the CEO / CFO / GM / payroll see a salary; a technician never; the user list never carries one; every change audited.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { config } from "../src/config.js";
import { hashPassword } from "../src/lib/password.js";
import { roleIds } from "../src/services/accounting.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, gm: Client, kim: Client;
let today: string, month: string, nextMonth: string, lina: string;
const acc = (c: Client, path: string, body?: unknown) => c.req(body === undefined ? "GET" : "POST", `/api/accounting${path}`, body);
const mapped = async (key: string) => ((await roleIds(sql, s.a)) as Record<string, string>)[key]!;
const bal = async (accountId: string) => Number((await sql<{ b: string }[]>`select coalesce(sum(debit_cents - credit_cents), 0)::text as b from journal_lines where account_id = ${accountId}`)[0]!.b);

beforeAll(async () => {
  config.shop.features = "website,subscribe,reminders,inventory,accounting";
  await resetDb(); s = await seed(); app = await makeApp();
  s.users.cfo = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO', 'cfo', '+85512000900', ${await hashPassword(PW)}, false, false) returning id`)[0]!.id;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await acc(admin, "/accounts")).status).toBe(200);
  today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  month = today.slice(0, 7);
  nextMonth = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1)).toISOString().slice(0, 7);
  expect((await acc(admin, "/opening", { date: today, cash_usd: 1000000 })).status).toBe(200);
});
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("D-187 the salary on the user form, linked to payroll", () => {
  it("the CEO creates a user with a salary: kept with its history; never in the user list; a technician gets 403", async () => {
    const r = await ceo.req("POST", "/api/users", { username: "lina", full_name: "Lina", role: "tech", phone: "", email: "",
      salary: { base_salary: 30000, allowance: 5000, pay_method: "aba", start_date: `${month}-01`, note: "ចាប់ផ្ដើម" } });
    expect(r.status, JSON.stringify(r.json)).toBe(200); lina = r.json.id;
    const sal = (await ceo.req("GET", `/api/users/${lina}/salary`)).json;
    expect(sal).toMatchObject({ start_date: `${month}-01`, pay_method: "aba", current: { base_salary: 30000, allowance: 5000, effective_from: `${month}-01` } });
    expect(sal.history).toHaveLength(1);
    const list = (await ceo.req("GET", "/api/users")).json as Record<string, unknown>[];
    expect(JSON.stringify(list.find((u) => u.id === lina))).not.toMatch(/salary|base_cents|allowance/);
    expect((await kim.req("GET", `/api/users/${lina}/salary`)).status).toBe(403);
    expect((await kim.req("GET", "/api/users")).status).toBe(403);
    expect((await gm.req("GET", `/api/users/${lina}/salary`)).status).toBe(200); // the GM may see it
    expect((await acc(kim, "/payroll/salaries")).status).toBe(403);
  });

  it("a change applies from its own day only: this month's run keeps $300 + $50, next month's takes $400; the old run keeps its amount", async () => {
    const ch = await acc(admin, `/payroll/salary/${lina}`, { base_salary: 40000, effective_from: `${nextMonth}-01` });
    expect(ch.json).toMatchObject({ ok: true, effective_from: `${nextMonth}-01` });
    expect((await ceo.req("GET", `/api/users/${lina}/salary`)).json.current.base_salary).toBe(30000); // still in force today
    const now = (await acc(admin, "/payroll", { period: month })).json;
    expect(now.lines).toEqual([expect.objectContaining({ user_id: lina, base: 30000, allowance: 5000, pay_method: "aba", net: 35000 })]);
    expect([now.gross, now.net]).toEqual([35000, 35000]);
    const next = (await acc(admin, "/payroll", { period: nextMonth })).json;
    expect(next.lines).toEqual([expect.objectContaining({ user_id: lina, base: 40000, allowance: 5000, pay_method: "aba" })]);
    expect((await acc(admin, `/payroll/${now.id}`)).json.lines[0].base).toBe(30000);
    // the CEO edits on the user form too (PATCH with the salary part)
    expect((await ceo.req("PATCH", `/api/users/${lina}`, { salary: { base_salary: 42000, effective_from: `${nextMonth}-15` } })).status).toBe(200);
    expect((await ceo.req("GET", `/api/users/${lina}/salary`)).json.history.map((h: any) => h.base_salary)).toEqual([42000, 40000, 30000]);
    expect((await kim.req("PATCH", `/api/users/${lina}`, { salary: { base_salary: 1 } })).status).toBe(403);
    const audits = await sql<{ n: { effective_from: string } }[]>`select new_data as n from audit_log where action = 'payroll.salary' and row_id = ${lina} order by id`;
    expect(audits.map((a) => a.n.effective_from)).toEqual([`${month}-01`, `${nextMonth}-01`, `${nextMonth}-15`]);
  });

  it("approve posts salaries $300 + benefits $50 / wages owed $350 (the map); paying «each» clears it against the mapped ABA account", async () => {
    const run = ((await acc(admin, "/payroll")).json as any[]).find((r) => r.period === month);
    const [sal, ben, owed, aba] = (await Promise.all(["salaries", "bonus", "payroll", "bank_aba"].map(mapped))) as [string, string, string, string];
    const before = await Promise.all([sal, ben, owed, aba].map(bal));
    expect((await acc(ceo, `/payroll/${run.id}/approve`, {})).status).toBe(200);
    expect(await Promise.all([sal, ben, owed].map(bal))).toEqual([before[0]! + 30000, before[1]! + 5000, before[2]! - 35000]);
    expect((await acc(admin, `/payroll/${run.id}/pay`, { pay: "each" })).status).toBe(200);
    expect(await Promise.all([owed, aba].map(bal))).toEqual([before[2]!, before[3]! - 35000]);
    const diff = Number((await sql<{ d: string }[]>`select (coalesce(sum(debit_cents), 0) - coalesce(sum(credit_cents), 0))::text as d from journal_lines where company_id = ${s.a}`)[0]!.d);
    expect(diff).toBe(0);
  });
});
