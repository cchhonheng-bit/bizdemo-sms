// CEO feedback 04-10 on the L3 videos (D-125): the audit log in plain words (every action code labelled, filters by person / type,
// what each row is about), «last change» on Settings / Website / Users, the crew is technicians only, the HangKH support account
// is locked for the shop.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AUDIT_ACTION, AUDIT_ACTION_EXTRA, AUDIT_FIELD, AUDIT_GROUPS, AUDIT_VALUE } from "@sms/shared";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed; let ceo: Client; let gm: Client; let admin: Client; let kim: Client;
beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
});
afterAll(async () => { await app.close(); });

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const files = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : []; });
const tomorrow10 = () => { const d = new Date(Date.now() + 86_400_000); d.setUTCHours(3, 0, 0, 0); return d.toISOString(); }; // 10:00 Phnom Penh

describe("audit log in plain words", () => {
  it("every action code the server writes has a Khmer and an English label; the labels keep one language each", () => {
    const codes = new Set<string>();
    for (const f of files(SRC)) for (const m of readFileSync(f, "utf8").matchAll(/action: (?:[^,\n]*?\? )?"([a-z_]+\.[a-z_.]+)"(?: : "([a-z_]+\.[a-z_.]+)")?/g)) { codes.add(m[1]!); if (m[2]) codes.add(m[2]); }
    expect(codes.size).toBeGreaterThan(100);
    expect([...codes].filter((c) => !AUDIT_ACTION[c])).toEqual([]);
    const ALLOWED = /^(PDF|QR|Excel|Telegram|bot|ABA|ACLEDA|GPS|Google|Maps|HangKH|Facebook)$/;
    const texts = [...Object.values(AUDIT_ACTION), ...Object.values(AUDIT_FIELD), ...AUDIT_GROUPS, ...Object.values(AUDIT_ACTION_EXTRA), ...Object.values(AUDIT_VALUE).flatMap((x) => Object.values(x))];
    expect(texts.filter((t) => (t.km.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).some((w) => !ALLOWED.test(w)))).toEqual([]);
    expect(texts.filter((t) => /[ក-៙ៜ-៿]/.test(t.en))).toEqual([]);
  });

  it("rows say what they are about; filter by type and by person; the person list; CEO / CFO only", async () => {
    const cust = (await admin.req("POST", "/api/customers", { name: "ភ្ញៀវ សាកល្បង", phones: ["012777000"], address: "ផ្ទះ 1", zone: "inside" })).json.id;
    const b = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "លាងម៉ាស៊ីនត្រជាក់", zone: "inside", scheduled_at: tomorrow10() })).json;
    const item = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់ពិសេស", kind: "service", category: "mep", sell_price: 1800 })).json.id;
    const jobs = (await ceo.req("GET", "/api/reports/audit?type=jobs")).json as any[];
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs.every((r) => /^(booking|job|quote|service)\./.test(r.action))).toBe(true);
    expect(jobs.find((r) => r.action === "booking.create" && r.row_id === b.id)).toMatchObject({ subject: b.number, user_name: "Admin A" });
    const cat = (await ceo.req("GET", "/api/reports/audit?type=catalog")).json as any[];
    expect(cat.find((r) => r.row_id === item)).toMatchObject({ action: "catalog.upsert", subject: "លាងម៉ាស៊ីនត្រជាក់ពិសេស" });
    const mine = (await ceo.req("GET", `/api/reports/audit?user=${s.users.admin}`)).json as any[];
    expect(mine.length).toBeGreaterThan(0); expect(mine.every((r) => r.user_id === s.users.admin)).toBe(true);
    const people = (await ceo.req("GET", "/api/reports/audit/people")).json as any[];
    expect(people.map((p) => p.full_name)).toEqual(expect.arrayContaining(["Admin A", "CEO A"]));
    expect((await ceo.req("GET", "/api/reports/audit?type=nonsense")).status).toBe(400);
    for (const who of [gm, admin, kim]) expect((await who.req("GET", "/api/reports/audit/people")).status).toBe(403);
  });
});

describe("«last change» on Settings, Website and Users", () => {
  it("says who changed the page last and when; only the people who manage the page", async () => {
    expect((await ceo.req("POST", "/api/users", { username: "neary", full_name: "Neary", role: "admin", phone: "012000009" })).status).toBe(200);
    const u = (await ceo.req("GET", "/api/settings/last-change?scope=users")).json.last;
    expect(u.name).toBe("CEO A"); expect(Math.abs(new Date(u.at).getTime() - Date.now())).toBeLessThan(60_000);
    expect((await ceo.req("PUT", "/api/settings/test-phones", { phones: ["017888777"] })).status).toBe(200);
    expect((await ceo.req("GET", "/api/settings/last-change?scope=settings")).json.last.name).toBe("CEO A");
    expect((await ceo.req("GET", "/api/settings/last-change?scope=website")).status).toBe(200);
    expect((await admin.req("GET", "/api/settings/last-change?scope=settings")).status).toBe(403);
    expect((await admin.req("GET", "/api/settings/last-change?scope=users")).status).toBe(403);
    expect((await ceo.req("GET", "/api/settings/last-change?scope=other")).status).toBe(400);
  });
});

describe("crew = technicians only; the HangKH support account is the platform's", () => {
  it("the picker lists technicians only and the server refuses anybody else", async () => {
    const av = (await admin.req("GET", `/api/bookings/availability?from=${encodeURIComponent(tomorrow10())}&to=${encodeURIComponent(new Date(Date.parse(tomorrow10()) + 7_200_000).toISOString())}`)).json;
    expect(av.people.length).toBeGreaterThan(0);
    expect(av.people.every((p: any) => p.role === "tech")).toBe(true);
    const cust = (await admin.req("POST", "/api/customers", { name: "ភ្ញៀវ ជាង", phones: ["012777001"], address: "ផ្ទះ 2", zone: "inside" })).json.id;
    const b = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", scheduled_at: tomorrow10() })).json.id;
    for (const who of [s.users.gm01, s.users.admin, s.users.ceo]) expect((await admin.req("POST", `/api/bookings/${b}/assign`, { lead: who, assistants: [] })).json.error).toBe("TECH_NOT_FOUND");
    expect((await admin.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.dara, assistants: [] })).status).toBe(200);
  });

  it("listed last as «HangKH Support»; the shop can neither edit, reset nor turn it off", async () => {
    const sup = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, is_platform)
      values (${s.a}, 'support', 'HangKH Support', 'admin', 'x', true) returning id`)[0]!.id;
    const list = (await ceo.req("GET", "/api/users")).json as any[];
    expect(list.at(-1)).toMatchObject({ id: sup, full_name: "HangKH Support", is_platform: true });
    expect(list.filter((x) => x.id !== sup).every((x) => x.is_platform === false)).toBe(true);
    for (const body of [{ full_name: "x" }, { is_active: false }, { role: "tech" }]) {
      const r = await ceo.req("PATCH", `/api/users/${sup}`, body);
      expect(r.status).toBe(403); expect(r.json.error).toBe("PLATFORM_USER");
    }
    expect((await ceo.req("POST", `/api/users/${sup}/reset-password`, {})).json.error).toBe("PLATFORM_USER");
    expect((await sql`select full_name, is_active from users where id = ${sup}`)[0]).toMatchObject({ full_name: "HangKH Support", is_active: true });
  });
});
