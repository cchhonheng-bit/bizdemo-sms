// Test helpers: fresh schema per file, seeded companies/users, cookie-based client over app.inject().
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
import { migrate, sql, tx } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { seedPermissions } from "../src/services/permissions.js";

export const PW = "Passw0rd!x";

export async function resetDb(): Promise<void> {
  await sql.unsafe("drop schema public cascade; create schema public;");
  await migrate(sql, config.migrationsDir);
  await migrate(sql, config.hub.migrationsDir); // hub_ tables live side by side in tests (separate DB in production)
  resetRateLimits();
}

export type Seed = { a: string; b: string; users: Record<string, string> };

/** Company A (oneteam): ceo, gm01, admin, kim (tech), dara (tech) · Company B (otherco): ceo_b */
export async function seed(): Promise<Seed> {
  const users: Record<string, string> = {};
  const hash = await hashPassword(PW);
  const mk = async (name: string, slug: string) => {
    return tx(null, async (t) => {
      const id = (await t<{ id: string }[]>`insert into companies (name, slug) values (${name}, ${slug}) returning id`)[0]!.id;
      await t`insert into company_settings (company_id) values (${id})`;
      await seedPermissions(t, id);
      return id;
    });
  };
  const a = await mk("One Team Engineering", "oneteam");
  const b = await mk("Other Co", "otherco");
  const add = async (company: string, username: string, role: string, full: string, phone: string | null, mustChange = false) => {
    const r = await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password)
      values (${company}, ${username}, ${full}, ${role}::user_role, ${phone}, ${hash}, ${mustChange}) returning id`;
    users[username] = r[0]!.id;
  };
  await add(a, "ceo", "ceo", "CEO A", "012000001");
  await add(a, "gm01", "gm", "GM A", "012000003");
  await add(a, "admin", "admin", "Admin A", "012000005");
  await add(a, "kim", "tech", "Kim", "012000002");
  await add(a, "dara", "tech", "Dara", "012000006");
  await add(a, "newbie", "tech", "Newbie", "012000007", true);
  await add(b, "ceo_b", "ceo", "CEO B", "012000004");
  users.ceo_b_same = users.ceo_b!;
  await sql`insert into vehicles (company_id, code) values (${a}, '01'), (${a}, '02')`;
  return { a, b, users };
}

export type Client = { req: (method: string, url: string, body?: unknown) => Promise<{ status: number; json: any }>; cookie: string | null };

export function client(app: FastifyInstance): Client {
  const c: Client = { cookie: null, req: async (method, url, body) => {
    const r = await app.inject({ method: method as "GET", url, payload: body === undefined ? undefined : JSON.stringify(body), headers: { ...(c.cookie ? { cookie: c.cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), "x-forwarded-for": "10.0.0.1" } });
    const set = r.headers["set-cookie"] as string | string[] | undefined;
    if (set) {
      const s = Array.isArray(set) ? set[0]! : set;
      c.cookie = s.split(";")[0]!.endsWith("=") ? null : s.split(";")[0]!;
    }
    let json: any = null;
    try { json = r.json(); } catch { json = r.body; }
    return { status: r.statusCode, json };
  } };
  return c;
}

export async function loginAs(app: FastifyInstance, identifier: string, password = PW, company?: string): Promise<Client> {
  resetRateLimits(); // every test logs in from the same fake IP
  const c = client(app);
  const r = await c.req("POST", "/api/auth/login", { identifier, password, company });
  if (r.status !== 200) throw new Error(`login ${identifier} failed: ${r.status} ${JSON.stringify(r.json)}`);
  return c;
}

export async function makeApp(): Promise<FastifyInstance> {
  const app = buildApp({ logger: false });
  await app.ready();
  return app;
}
