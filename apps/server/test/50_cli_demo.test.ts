// Operator CLI on a real database: create-company → seed-demo (twice: idempotent) → demo user can log in and must change the password.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "../src/db.js";
import { client, makeApp, resetDb } from "./helpers.js";

const cli = (...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", join(__dirname, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, APP_MODE: "shop" }, encoding: "utf8", timeout: 60_000,
  });

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe("CLI seed-demo", () => {
  const accounts: Record<string, string> = {};
  it("creates the company, then demo users + 3 customers + 4 services + BK-0001/0002", async () => {
    cli("create-company", "One Team Engineering", "oneteam");
    const out = cli("seed-demo", "oneteam");
    for (const m of out.matchAll(/^DEMO_ACCOUNT (\S+) (\S+) (\S+)$/gm)) accounts[m[1]!] = m[3]!;
    expect(Object.keys(accounts).sort()).toEqual(["admin", "dara", "gm01", "kim"]);
    const roles = await sql`select username, role, must_change_password from users u join companies c on c.id = u.company_id where c.slug = 'oneteam' order by username`;
    expect(roles.map((r) => `${r.username}:${r.role}:${r.must_change_password}`)).toEqual(
      ["admin:admin:true", "ceo:ceo:true", "dara:tech:true", "gm01:gm:true", "kim:tech:true", "support:admin:true"]);
    expect((await sql`select count(*)::int n from customers`)[0]!.n).toBe(3);
    expect((await sql`select count(*)::int n from catalog_items where kind = 'service'`)[0]!.n).toBe(4);
    expect((await sql`select number from bookings order by number`).map((r) => r.number)).toEqual(["BK-0001", "BK-0002"]);
    expect((await sql`select last_no from booking_counters`)[0]!.last_no).toBe(2);
  });

  it("is idempotent — a second run adds nothing and shows no passwords", async () => {
    const out = cli("seed-demo", "oneteam");
    expect(out).not.toMatch(/DEMO_ACCOUNT/);
    expect(out).toMatch(/DEMO_EXISTS gm01/);
    expect((await sql`select count(*)::int n from customers`)[0]!.n).toBe(3);
    expect((await sql`select count(*)::int n from bookings`)[0]!.n).toBe(2);
  });

  it("a demo user logs in with the temp password and must change it", async () => {
    const r = await client(app).req("POST", "/api/auth/login", { identifier: "gm01", password: accounts.gm01, company: "oneteam" });
    expect(r.status).toBe(200);
    expect(r.json.must_change_password).toBe(true);
  });
});
