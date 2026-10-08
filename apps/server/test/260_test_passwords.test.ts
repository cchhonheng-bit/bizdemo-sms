// D-136 (CEO 08-10): One Team's test phase — HangKH gives the test logins one simple shared password (operator only, the strength
// rules waived, audited) and makes a CFO test account on it. It works with no new password asked until its end; then the account
// must set its own before anything else — never locked out (not the D-135 block). The app's own paths keep the strength rules.
// Every password field has an eye button, hidden at first. This file uses a weak value of its own — the real one is never written.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { buildHubApp } from "../src/hub/app.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { client, makeApp, PW, resetDb, seed, type Seed } from "./helpers.js";

const WEAK = "246810"; // stands in for the test password
const TEST = ["ceo", "gm01", "admin", "kim", "dara"];
let app: FastifyInstance; let s: Seed; let support: string;
const signIn = async (identifier: string, password = WEAK) => {
  resetRateLimits(); const c = client(app); const r = await c.req("POST", "/api/auth/login", { identifier, password }); return { c, ...r };
};
const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();
const row = async (u: string) => (await sql<{ role: string; is_active: boolean; must_change_password: boolean; temp_password_expires_at: Date | null; on_test: boolean }[]>`
  select role::text as role, is_active, must_change_password, temp_password_expires_at, coalesce(test_password_hash = password_hash, false) as on_test
  from users where company_id = ${s.a} and username = ${u}`)[0]!;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  support = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, is_platform)
    values (${s.a}, 'support', 'HangKH Support', 'admin', ${await hashPassword(PW)}, true) returning id`)[0]!.id;
  // as D-135 left them on the live shop: a new password at the first sign-in, the first password ending at go-live
  await sql`update users set must_change_password = true, temp_password_expires_at = now() + interval '5 days' where company_id = ${s.a} and username in ${sql(TEST)}`;
});
afterAll(async () => { await app.close(); });

describe("D-136 test passwords", () => {
  it("shop-setup: the test password on the five test logins + a new CFO test account — never printed, audited as HangKH Support", async () => {
    const end = inDays(5);
    const plan = { users: [...TEST.map((username) => ({ username, test_password: WEAK, temp_expires: end })),
      { username: "cfo", create: { full_name: "CFO", role: "cfo" as const }, test_password: WEAK, temp_expires: end }] };
    const dry = (await shopSetup("oneteam", plan, false)).join("\n");
    expect(dry).not.toContain(WEAK);
    expect(dry).toContain(`user kim (Kim): test password until ${new Date(end).toISOString()} (strength rules waived; then a new password before anything else)`);
    expect(dry).toContain("user cfo (CFO): new account · role cfo · test password until ");
    expect((await sql`select count(*)::int as n from users where company_id = ${s.a} and username = 'cfo'`)[0]!.n).toBe(0); // the preview writes nothing
    expect((await row("kim")).on_test).toBe(false);
    const done = (await shopSetup("oneteam", plan, true)).join("\n");
    expect(done).not.toContain(WEAK); expect(done).toContain("applied ✓");
    for (const u of [...TEST, "cfo"]) expect(await row(u)).toMatchObject({ is_active: true, must_change_password: false, on_test: true });
    expect((await row("cfo")).role).toBe("cfo");
    expect((await row("kim")).temp_password_expires_at?.toISOString()).toBe(new Date(end).toISOString());
    const acts = await sql<{ action: string; user_id: string; new_data: unknown }[]>`select action, user_id, new_data from audit_log
      where company_id = ${s.a} and action in ('password.test_set', 'user.create') order by id`;
    expect(acts.filter((a) => a.action === "password.test_set").length).toBe(6);
    expect(acts.filter((a) => a.action === "user.create").length).toBe(1);
    expect(acts.every((a) => a.user_id === support)).toBe(true);
    expect(JSON.stringify(acts)).not.toContain(WEAK);
  });

  it("refused: no end, an end gone by, with must_change, a CEO or an existing account to make, a new one without it, the platform account", async () => {
    const soon = inDays(1);
    await expect(shopSetup("oneteam", { users: [{ username: "kim", test_password: WEAK }] }, false)).rejects.toThrow("needs temp_expires");
    await expect(shopSetup("oneteam", { users: [{ username: "kim", test_password: WEAK, temp_expires: inDays(-1) }] }, false)).rejects.toThrow("must be in the future");
    await expect(shopSetup("oneteam", { users: [{ username: "kim", test_password: WEAK, temp_expires: soon, must_change: true }] }, false)).rejects.toThrow("exclude each other");
    await expect(shopSetup("oneteam", { users: [{ username: "boss2", create: { full_name: "Boss", role: "ceo" }, test_password: WEAK, temp_expires: soon }] }, false)).rejects.toThrow("a CEO account only by a CEO");
    await expect(shopSetup("oneteam", { users: [{ username: "kim", create: { full_name: "Kim", role: "tech" }, test_password: WEAK, temp_expires: soon }] }, false)).rejects.toThrow("exists already");
    await expect(shopSetup("oneteam", { users: [{ username: "xtra", create: { full_name: "X", role: "tech" } }] }, false)).rejects.toThrow("needs a test_password");
    await expect(shopSetup("oneteam", { users: [{ username: "support", test_password: WEAK, temp_expires: soon }] }, false)).rejects.toThrow("never changed here");
    await expect(shopSetup("oneteam", { users: [{ username: "kim", test_password: "12345", temp_expires: soon }] }, false)).rejects.toThrow(); // 6 characters, even here
  });

  it("during the test phase: it signs in with no new password asked; the app's own paths keep the strength rules", async () => {
    for (const u of [...TEST, "cfo"]) {
      const r = await signIn(u);
      expect(r.status).toBe(200); expect(r.json.must_change_password).toBe(false);
    }
    const cfo = (await signIn("cfo")).c;
    expect((await cfo.req("GET", "/api/me")).json).toMatchObject({ username: "cfo", role: "cfo", must_change_password: false });
    const ceo = (await signIn("ceo")).c;
    expect((await ceo.req("POST", "/api/users", { username: "neo", full_name: "Neo", role: "tech", password: WEAK })).status).toBe(400);
    expect((await ceo.req("POST", `/api/users/${s.users.dara!}/reset-password`, { password: WEAK })).json.error).toBe("PASSWORD_TOO_SHORT");
    const kim = (await signIn("kim")).c;
    expect((await kim.req("POST", "/api/me/password", { current_password: WEAK, new_password: WEAK })).json.error).toBe("PASSWORD_TOO_SHORT");
    expect((await row("dara")).on_test).toBe(true); // nothing above changed a password
  });

  it("after the end: an open session must set a new password before anything else; a new sign-in still works and asks for it too", async () => {
    const open = (await signIn("gm01")).c;
    expect((await open.req("GET", "/api/bookings")).status).toBe(200);
    await sql`update users set temp_password_expires_at = now() - interval '1 minute' where company_id = ${s.a} and username in ${sql([...TEST, "cfo"])}`;
    const r1 = await open.req("GET", "/api/bookings");
    expect(r1.status).toBe(403); expect(r1.json.error).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await open.req("GET", "/api/me")).json.must_change_password).toBe(true);
    const r = await signIn("dara");
    expect(r.status).toBe(200); expect(r.json.must_change_password).toBe(true);
    expect((await r.c.req("GET", "/api/bookings")).json.error).toBe("PASSWORD_CHANGE_REQUIRED");
    const again = await signIn("dara"); // still in — never refused like a D-135 first password
    expect(again.status).toBe(200); expect(again.json.must_change_password).toBe(true);
    expect((await sql`select count(*)::int as n from audit_log where action = 'auth.test_password_ended' and row_id = ${s.users.dara!}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from audit_log where action = 'auth.test_password_ended' and row_id = ${s.users.gm01!}`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from audit_log where action = 'auth.password_expired'`)[0]!.n).toBe(0);
  });

  it("the person's own new password ends the test password for good (mark + end cleared)", async () => {
    const r = await signIn("dara");
    expect((await r.c.req("POST", "/api/me/password", { new_password: "Dara-own-2026" })).status).toBe(200);
    expect(await row("dara")).toMatchObject({ must_change_password: false, on_test: false, temp_password_expires_at: null });
    expect((await signIn("dara")).status).toBe(401);
    const own = await signIn("dara", "Dara-own-2026");
    expect(own.status).toBe(200); expect(own.json.must_change_password).toBe(false);
    expect((await own.c.req("GET", "/api/bookings")).status).toBe(200);
  });

  it("«go-live» before the 13th: shop-setup moves the end to now — the next click asks for a new password", async () => {
    await shopSetup("oneteam", { users: [{ username: "kim", test_password: WEAK, temp_expires: inDays(1) }] }, true);
    const kim = await signIn("kim");
    expect(kim.status).toBe(200); expect(kim.json.must_change_password).toBe(false);
    const plan = (await shopSetup("oneteam", { users: [{ username: "kim", temp_expires: new Date().toISOString() }] }, true)).join("\n");
    expect(plan).toContain("user kim (Kim): first password ends ");
    expect((await kim.c.req("GET", "/api/bookings")).json.error).toBe("PASSWORD_CHANGE_REQUIRED");
    expect((await kim.c.req("GET", "/api/me")).json.must_change_password).toBe(true);
  });
});

describe("D-136 eye buttons", () => {
  it("the website's password fields: hidden at first, the eye says «show» in the page's language; site.js toggles", async () => {
    config.shop.features = "website"; setHubTransport(async () => ({ status: 200, json: { ok: true } })); resetBotCache();
    try {
      const km = (await app.inject({ method: "GET", url: "/my/login" })).body;
      expect(km).toContain('<input class="in" id="pw" type="password"');
      expect(km).toContain('data-eye="pw" aria-label="បង្ហាញពាក្យសម្ងាត់" data-show="បង្ហាញពាក្យសម្ងាត់" data-hide="លាក់ពាក្យសម្ងាត់"');
      const en = (await app.inject({ method: "GET", url: "/my/login?lang=en" })).body;
      expect(en).toContain('data-eye="pw" aria-label="Show password" data-show="Show password" data-hide="Hide password"');
      expect(en).not.toContain("បង្ហាញពាក្យសម្ងាត់"); // one language per page (D-89)
      const js = (await app.inject({ method: "GET", url: "/pub/site.js" })).body;
      expect(js).toContain('$$("[data-eye]")'); expect(js).toContain('input.type = show ? "text" : "password"');
    } finally { config.shop.features = ""; setHubTransport(null); resetBotCache(); }
  });

  it("the hub's platform page: the password and the bot token fields have it too (script from the hub itself, CSP 'self')", async () => {
    const hub = buildHubApp({ logger: false }); await hub.ready();
    try {
      const login = (await hub.inject({ method: "GET", url: "/platform/login" })).body;
      expect(login).toContain('<input name="password" type="password"');
      expect(login).toContain('aria-label="Show password" data-show="Show password" data-hide="Hide password"');
      expect(login).toContain('<script src="/platform/eye.js" defer></script>');
      const js = await hub.inject({ method: "GET", url: "/platform/eye.js" });
      expect(js.statusCode).toBe(200); expect(js.headers["content-type"]).toContain("javascript"); expect(js.body).toContain('i.type=s?"text":"password"');
      expect((await hub.inject({ method: "GET", url: "/" })).body).not.toContain("eye.js"); // only a page with a password field loads it
    } finally { await hub.close(); }
  });
});
