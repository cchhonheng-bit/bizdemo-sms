import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, ceoB: Client;
let custA: string;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  custA = (await ceo.req("POST", "/api/customers", { name: "លោក សុខា", phones: ["012345678"], address: "ផ្ទះ 12", zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  await ceoB.req("POST", "/api/customers", { name: "Customer B", phones: ["098000000"], zone: "outside" });
});
afterAll(async () => { await app.close(); });

describe("permissions in the API (rule 5)", () => {
  it("me() carries the permission list per role", async () => {
    expect((await ceo.req("GET", "/api/me")).json.permissions).toContain("user.manage");
    expect((await gm.req("GET", "/api/me")).json.permissions).not.toContain("user.manage");
    expect((await kim.req("GET", "/api/me")).json.permissions).toEqual(["job.checkpoint"]);
  });

  it("company isolation: B never sees A's customers, bookings, users, settings — even by id", async () => {
    expect((await ceoB.req("GET", "/api/customers")).json.map((c: any) => c.name)).toEqual(["Customer B"]);
    expect((await ceo.req("GET", "/api/customers")).json.map((c: any) => c.name)).toEqual(["លោក សុខា"]);
    const bk = (await ceo.req("POST", "/api/bookings", { customer_id: custA, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside" })).json;
    expect((await ceoB.req("GET", `/api/bookings/${bk.id}`)).status).toBe(404);
    expect((await ceoB.req("GET", "/api/bookings")).json).toEqual([]);
    expect((await ceoB.req("PATCH", `/api/bookings/${bk.id}`, { notes: "x" })).status).toBe(404);
    expect((await ceoB.req("POST", "/api/bookings", { customer_id: custA, type: "A", category: "mep", service_text: "steal", zone: "inside" })).json.error).toBe("CUSTOMER_NOT_FOUND");
    expect((await ceoB.req("PATCH", `/api/users/${s.users.kim}`, { full_name: "Hacked" })).status).toBe(404);
    expect((await ceoB.req("POST", `/api/customers`, { id: custA, name: "Renamed", phones: [], zone: "inside" })).status).toBe(404);
    expect((await ceoB.req("GET", "/api/users")).json.map((u: any) => u.username)).toEqual(["ceo_b"]);
  });

  it("technician: no customer list, no create/assign, only own bookings, catalog without prices, no settings", async () => {
    expect((await kim.req("GET", "/api/customers")).status).toBe(403);
    expect((await kim.req("POST", "/api/bookings", { customer_id: custA, type: "A", category: "mep", service_text: "x", zone: "inside" })).status).toBe(403);
    expect((await kim.req("GET", "/api/bookings")).json).toEqual([]);
    await ceo.req("POST", "/api/catalog", { name_km: "ជួសជុលម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", sell_price: 18000, cost_price: 9500 });
    const cat = (await kim.req("GET", "/api/catalog")).json;
    expect(cat.length).toBe(1); expect(cat[0].sell_price).toBeNull(); expect(cat[0].cost_price).toBeNull();
    expect((await kim.req("GET", "/api/settings/company")).status).toBe(403);
    expect((await kim.req("GET", "/api/users")).status).toBe(403);
    expect((await kim.req("GET", "/api/bookings/availability?at=2026-10-01T02:00:00Z")).status).toBe(403);
    expect((await kim.req("GET", "/api/settings/audit")).status).toBe(403);
  });

  it("cost.read: GM sees sell price only; CEO/Admin see cost; GM cannot set cost", async () => {
    const g = (await gm.req("GET", "/api/catalog")).json[0];
    expect(g.sell_price).toBe(18000); expect(g.cost_price).toBeNull();
    expect((await ceo.req("GET", "/api/catalog")).json[0].cost_price).toBe(9500);
    expect((await admin.req("GET", "/api/catalog")).json[0].cost_price).toBe(9500);
    expect((await gm.req("POST", "/api/catalog", { name_km: "X", kind: "service", category: "mep", sell_price: 1, cost_price: 1 })).json.error).toBe("FORBIDDEN_COST");
  });

  it("settings.manage: only CEO edits settings/vehicles/permissions; Admin may set FX only", async () => {
    expect((await gm.req("PATCH", "/api/settings/company", { fx_rate_khr: 4000 })).status).toBe(403);
    expect((await admin.req("PATCH", "/api/settings/company", { fx_rate_khr: 4000 })).status).toBe(403);
    expect((await admin.req("POST", "/api/settings/fx", { rate: 4050 })).status).toBe(200);
    expect((await gm.req("POST", "/api/settings/fx", { rate: 4050 })).status).toBe(403);
    expect(Number((await ceo.req("GET", "/api/settings/company")).json.fx_rate_khr)).toBe(4050);
    expect((await ceo.req("PATCH", "/api/settings/company", { telegram_group_chat_id: "-100123", work_start: "07:00" })).status).toBe(200);
    expect(String((await ceo.req("GET", "/api/settings/company")).json.telegram_group_chat_id)).toBe("-100123");
    expect((await gm.req("POST", "/api/settings/vehicles", { code: "09" })).status).toBe(403);
    expect((await ceo.req("POST", "/api/settings/vehicles", { code: "09", owner_user_id: s.users.kim })).status).toBe(200);
    expect((await ceo.req("POST", "/api/settings/vehicles", { code: "10", owner_user_id: s.users.ceo_b })).json.error).toBe("OWNER_NOT_IN_COMPANY");
  });

  it("fixed rules (S-14): tech can never get cost.read; last approver cannot be removed; audit.read gates the audit log", async () => {
    expect((await ceo.req("POST", "/api/settings/permissions", { role: "tech", key: "cost.read", allowed: true })).json.error).toBe("FIXED_RULE");
    // only CEO has void.approve by default besides GM → remove GM ok, then CEO cannot be removed
    expect((await ceo.req("POST", "/api/settings/permissions", { role: "gm", key: "void.approve", allowed: false })).status).toBe(200);
    expect((await ceo.req("POST", "/api/settings/permissions", { role: "ceo", key: "void.approve", allowed: false })).json.error).toBe("FIXED_RULE");
    expect((await ceo.req("POST", "/api/settings/permissions", { role: "gm", key: "void.approve", allowed: true })).status).toBe(200);
    const audit = (await ceo.req("GET", "/api/settings/audit")).json;
    expect(audit.some((a: any) => a.action === "permission.set")).toBe(true);
    expect((await gm.req("GET", "/api/settings/audit")).status).toBe(403);
    expect((await ceoB.req("GET", "/api/settings/audit")).json.some((a: any) => a.action === "permission.set")).toBe(false);
  });

  it("user.manage: CEO creates users (temp password), resets passwords, updates; GM cannot", async () => {
    const r = await ceo.req("POST", "/api/users", { username: "sok", full_name: "Sok", role: "tech", phone: "012000099" });
    expect(r.status).toBe(200); expect(r.json.temp_password).toMatch(/^[A-Za-z0-9]{10}$/);
    expect((await ceo.req("POST", "/api/users", { username: "sok", full_name: "Dup", role: "tech" })).json.error).toBe("USERNAME_TAKEN");
    expect((await ceo.req("POST", "/api/users", { username: "sok2", full_name: "Dup", role: "tech", phone: "012000099" })).json.error).toBe("PHONE_TAKEN");
    const first = await loginAs(app, "sok", r.json.temp_password);
    expect((await first.req("GET", "/api/me")).json.must_change_password).toBe(true);
    const reset = await ceo.req("POST", `/api/users/${r.json.id}/reset-password`, {});
    expect(reset.json.temp_password).toBeDefined();
    expect((await first.req("GET", "/api/me")).status).toBe(401); // reset ends sessions
    expect((await gm.req("POST", "/api/users", { username: "x1", full_name: "X", role: "tech" })).status).toBe(403);
    expect((await gm.req("GET", "/api/users/basic")).json.length).toBeGreaterThan(3);
  });
});
