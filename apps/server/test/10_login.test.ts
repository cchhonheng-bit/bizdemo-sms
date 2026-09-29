import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { client, loginAs, makeApp, PW, resetDb, seed, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";

let app: FastifyInstance; let s: Seed;
beforeAll(async () => { await resetDb(); s = await seed(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe("login (rule 6.2/6.3)", () => {
  it("username, phone and email all work; wrong password and unknown user give the same generic error", async () => {
    const c1 = await loginAs(app, "kim");
    expect((await c1.req("GET", "/api/me")).json.username).toBe("kim");
    const c2 = await loginAs(app, "012000002");
    expect((await c2.req("GET", "/api/me")).json.username).toBe("kim");
    const bad = await client(app).req("POST", "/api/auth/login", { identifier: "kim", password: "wrong-pass" });
    expect(bad.status).toBe(401); expect(bad.json.error).toBe("INVALID_CREDENTIALS");
    const unknown = await client(app).req("POST", "/api/auth/login", { identifier: "nobody", password: "wrong-pass" });
    expect(unknown.status).toBe(401); expect(unknown.json.error).toBe("INVALID_CREDENTIALS");
    expect(bad.json).toEqual(unknown.json);
  });

  it("same username in two companies: the password decides / company slug selects", async () => {
    await sql`update users set username = 'ceo' where id = ${s.users.ceo_b!}`; // both companies now have "ceo"
    const a = await loginAs(app, "ceo");
    expect((await a.req("GET", "/api/me")).json.company.slug).toBe("oneteam");
    const b = await loginAs(app, "ceo", PW, "otherco");
    expect((await b.req("GET", "/api/me")).json.company.slug).toBe("otherco");
  });

  it("rate limit: 6th attempt from one IP within a minute → 429", async () => {
    resetRateLimits();
    let last = 0;
    for (let i = 0; i < 6; i++) last = (await client(app).req("POST", "/api/auth/login", { identifier: "kim", password: "wrong-pass" })).status;
    expect(last).toBe(429);
    resetRateLimits();
  });

  it("inactive user cannot log in; deactivation ends existing sessions", async () => {
    const c = await loginAs(app, "dara");
    expect((await c.req("GET", "/api/me")).status).toBe(200);
    const ceo = await loginAs(app, "ceo");
    expect((await ceo.req("PATCH", `/api/users/${s.users.dara}`, { is_active: false })).status).toBe(200);
    expect((await c.req("GET", "/api/me")).status).toBe(401);
    const again = await client(app).req("POST", "/api/auth/login", { identifier: "dara", password: PW });
    expect(again.status).toBe(401);
    await ceo.req("PATCH", `/api/users/${s.users.dara}`, { is_active: true });
  });

  it("CEO cannot deactivate or re-role themselves", async () => {
    const ceo = await loginAs(app, "ceo");
    const r = await ceo.req("PATCH", `/api/users/${s.users.ceo}`, { is_active: false });
    expect(r.status).toBe(400); expect(r.json.error).toBe("CANNOT_CHANGE_SELF_ROLE");
  });

  it("must_change_password: only /api/me + password change allowed; then full access (F-M2-14 fixed)", async () => {
    const c = await loginAs(app, "newbie");
    expect((await c.req("GET", "/api/me")).json.must_change_password).toBe(true);
    expect((await c.req("GET", "/api/bookings")).status).toBe(403);
    expect((await c.req("POST", "/api/me/password", { new_password: "short" })).json.error).toBe("PASSWORD_TOO_SHORT");
    expect((await c.req("POST", "/api/me/password", { new_password: "password" })).json.error).toBe("PASSWORD_TOO_COMMON");
    expect((await c.req("POST", "/api/me/password", { new_password: "N3w-Strong-Pass" })).status).toBe(200);
    expect((await c.req("GET", "/api/me")).json.must_change_password).toBe(false);
    expect((await c.req("GET", "/api/bookings")).status).toBe(200);
    // password change requires the current password afterwards
    expect((await c.req("POST", "/api/me/password", { new_password: "Another-Pass-9" })).json.error).toBe("WRONG_PASSWORD");
    expect((await c.req("POST", "/api/me/password", { current_password: "N3w-Strong-Pass", new_password: "Another-Pass-9" })).status).toBe(200);
  });

  it("logout clears the session", async () => {
    const c = await loginAs(app, "kim");
    expect((await c.req("POST", "/api/auth/logout")).status).toBe(200);
    expect((await c.req("GET", "/api/me")).status).toBe(401);
  });

  it("audit: login and password events are written and cannot be deleted", async () => {
    const rows = await sql`select action from audit_log where action in ('auth.login','password.changed') limit 1`;
    expect(rows.length).toBe(1);
    await expect(sql`delete from audit_log`).rejects.toThrow(/append-only/);
  });
});
