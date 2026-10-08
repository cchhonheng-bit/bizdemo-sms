// D-135 (CEO 08-10): One Team's test logins — on again, a new password at the first sign-in, and the first password stops at go-live.
// After the deadline a sign-in with the never-changed password is refused (PASSWORD_EXPIRED — told only after the right password)
// until the CEO sets a new one; any new password (the CEO's reset, the server's reset, the person's own) clears the deadline. Set with
// shop-setup as HangKH Support, audited; the CEO account takes the password rules too, the platform account never.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { client, loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed; let support: string;
const signIn = async (identifier: string, password = PW): Promise<{ c: Client; status: number; json: any }> => {
  resetRateLimits(); const c = client(app); const r = await c.req("POST", "/api/auth/login", { identifier, password }); return { c, ...r };
};
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const deadline = async (u: string) => (await sql<{ t: Date | null }[]>`select temp_password_expires_at as t from users where company_id = ${s.a} and username = ${u}`)[0]!.t;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  support = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, is_platform)
    values (${s.a}, 'support', 'HangKH Support', 'admin', ${await hashPassword(PW)}, true) returning id`)[0]!.id;
  await sql`update users set is_active = false where company_id = ${s.a} and username in ('gm01', 'dara')`; // as D-132 left them
});
afterAll(async () => { await app.close(); });

describe("D-135 test logins", () => {
  it("shop-setup: on again + a new password at sign-in + the first password's deadline — preview first, audited as HangKH Support", async () => {
    const plan = { users: [
      { username: "gm01", active: true, must_change: true as const, temp_expires: inDays(3) },
      { username: "dara", active: true, must_change: true as const, temp_expires: inDays(3) },
      { username: "kim", must_change: true as const, temp_expires: inDays(3) },
      { username: "ceo", must_change: true as const, temp_expires: inDays(3) },
    ] };
    const dry = (await shopSetup("oneteam", plan, false)).join("\n");
    expect(dry).toContain("user gm01 (GM A): active no → yes · new password at sign-in no → yes · first password ends — → ");
    expect(dry).toContain("user ceo (CEO A): new password at sign-in no → yes · first password ends — → ");
    expect((await sql`select count(*)::int as n from users where company_id = ${s.a} and is_active and username in ('gm01', 'dara')`)[0]!.n).toBe(0); // the preview writes nothing
    await shopSetup("oneteam", plan, true);
    expect(await sql`select username, is_active, must_change_password, temp_password_expires_at is not null as deadline from users
      where company_id = ${s.a} and username in ('ceo', 'dara', 'gm01', 'kim') order by username`).toEqual(["ceo", "dara", "gm01", "kim"].map((username) =>
      ({ username, is_active: true, must_change_password: true, deadline: true })));
    const acts = await sql<{ user_id: string | null }[]>`select user_id from audit_log where company_id = ${s.a} and action = 'user.update' order by id`;
    expect(acts.length).toBe(6); // two turned on + four password rules
    expect(acts.every((a) => a.user_id === support)).toBe(true);
    // turning a CEO account off / on stays the CEO's (as on the Users page); the platform account takes nothing
    await expect(shopSetup("oneteam", { users: [{ username: "ceo", active: true }] }, true)).rejects.toThrow("a CEO account only by a CEO");
    await expect(shopSetup("oneteam", { users: [{ username: "support", must_change: true }] }, true)).rejects.toThrow("never changed here");
  });

  it("before the deadline: the first password signs in — and must be changed before anything else", async () => {
    const r = await signIn("dara");
    expect(r.status).toBe(200); expect(r.json.must_change_password).toBe(true);
    expect((await r.c.req("GET", "/api/bookings")).json.error).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("after the deadline: the never-changed password is refused (PASSWORD_EXPIRED, audited); a wrong one tells nothing more", async () => {
    await sql`update users set temp_password_expires_at = now() - interval '1 minute' where company_id = ${s.a} and username in ('ceo', 'dara', 'gm01', 'kim')`;
    const r = await signIn("dara");
    expect(r.status).toBe(403); expect(r.json.error).toBe("PASSWORD_EXPIRED");
    const w = await signIn("dara", "Wrong-pass-2026");
    expect(w.status).toBe(401); expect(w.json.error).toBe("INVALID_CREDENTIALS");
    expect((await sql`select count(*)::int as n from audit_log where action = 'auth.password_expired' and row_id = ${s.users.dara!}`)[0]!.n).toBe(1);
  });

  it("the CEO sets a new one in «អ្នកប្រើ» → it works (the deadline went with the old password), still a new password at sign-in", async () => {
    // the CEO account is past its deadline too: HangKH resets it on the server — any new password clears the deadline
    await sql`update users set password_hash = ${await hashPassword(PW)} where company_id = ${s.a} and username = 'ceo'`;
    expect(await deadline("ceo")).toBeNull();
    await sql`update users set must_change_password = false where company_id = ${s.a} and username = 'ceo'`;
    const ceo = await loginAs(app, "ceo");
    const t = await ceo.req("POST", `/api/users/${s.users.dara!}/reset-password`, {});
    expect(t.status).toBe(200);
    expect(await deadline("dara")).toBeNull();
    const r = await signIn("dara", t.json.temp_password);
    expect(r.status).toBe(200); expect(r.json.must_change_password).toBe(true);
  });

  it("a person who sets their own password is free of the deadline", async () => {
    await sql`update users set temp_password_expires_at = now() + interval '1 day' where company_id = ${s.a} and username = 'gm01'`;
    const r = await signIn("gm01");
    expect(r.status).toBe(200);
    expect((await r.c.req("POST", "/api/me/password", { new_password: "Gm01-own-pass-2026" })).status).toBe(200);
    expect(await deadline("gm01")).toBeNull();
    expect((await sql`select must_change_password as m from users where company_id = ${s.a} and username = 'gm01'`)[0]!.m).toBe(false);
  });
});
