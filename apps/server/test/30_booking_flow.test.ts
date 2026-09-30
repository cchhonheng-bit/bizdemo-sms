import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { consumeLinkCode, flushOutbox } from "../src/services/telegram.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, dara: Client;
let cust: string, vehicle: string;
/** local Phnom Penh time, `d` days from today (tests never go stale) */
function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * 3600_000);
  return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm)).toISOString();
}
const T9 = at(2, 9), T10 = at(2, 10);
const ddmmyyyy = (iso: string) => { const d = new Date(new Date(iso).getTime() + 7 * 3600_000); return `${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${d.getUTCFullYear()}`; };

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក សុខា", phones: ["012345678"], address: "ផ្ទះ 12 ផ្លូវ 3", zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  vehicle = (await ceo.req("GET", "/api/settings/vehicles")).json[0].id;
  await ceo.req("PATCH", "/api/settings/company", { telegram_group_chat_id: "-100123" });
  // kim linked to Telegram (chat 900002)
  const code = (await kim.req("POST", "/api/telegram/link-code")).json.code;
  expect(await consumeLinkCode(code, 900002, 900002)).toMatchObject({ ok: true, reply: expect.stringContaining("Kim") });
});
afterAll(async () => { await app.close(); });

describe("booking flow M2 (create → assign → Telegram → technician)", () => {
  let bk1: string, bk2: string;

  it("create: numbering, defaults from customer, validation, type B → survey + GM notification", async () => {
    const r = await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់ 2 គ្រឿង", scheduled_at: T9, zone: "inside", vehicle_id: vehicle, notes: "យកជណ្ដើរ" });
    expect(r.status).toBe(200); expect(r.json.number).toBe("BK-0001"); expect(r.json.status).toBe("new");
    bk1 = r.json.id;
    const b = (await ceo.req("GET", `/api/bookings/${bk1}`)).json;
    expect(b.address).toBe("ផ្ទះ 12 ផ្លូវ 3"); expect(b.lat).toBe(11.55); expect(b.customer_name).toBe("លោក សុខា"); expect(b.customer_phones).toEqual(["012345678"]); expect(b.vehicle_code).toBe("01");
    expect((await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "", zone: "inside" })).json.error).toBe("REQUIRED");
    expect((await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", scheduled_at: at(4, 9), vehicle_id: "00000000-0000-0000-0000-000000000099" })).json.error).toBe("VEHICLE_NOT_FOUND");
    const r2 = await admin.req("POST", "/api/bookings", { customer_id: cust, type: "B", category: "construction", service_text: "សាងសង់របង 20m", zone: "outside", scheduled_at: at(3, 9) });
    expect(r2.json.number).toBe("BK-0002"); expect(r2.json.status).toBe("survey");
    bk2 = r2.json.id;
    const notif = (await gm.req("GET", "/api/notifications")).json;
    expect(notif[0].kind).toBe("booking.survey"); expect(notif[0].link).toBe(`/bookings/${bk2}`);
    expect((await gm.req("GET", "/api/notifications/unread-count")).json.count).toBe(1);
    expect((await ceo.req("GET", "/api/notifications")).json.length).toBe(0);
  });

  it("assign: validation (lead, schedule, team members, vehicle), type B admin blocked, happy path → outbox + notifications", async () => {
    expect((await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: "not-a-uuid", assistants: [], scheduled_at: T9 })).status).toBe(400);
    expect((await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: "", assistants: [], scheduled_at: T9 })).json.error).toBe("TEAM_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.kim, assistants: [], scheduled_at: at(9, 9) })).json.error).toBe("USE_RESCHEDULE"); // D2
    expect((await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.ceo, assistants: [], scheduled_at: T9 })).json.error).toBe("TECH_NOT_FOUND");
    expect((await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.kim, assistants: [s.users.kim], scheduled_at: T9 })).json.error).toBe("LEAD_IN_ASSISTANTS");
    expect((await admin.req("POST", `/api/bookings/${bk2}/assign`, { lead: s.users.kim, assistants: [], scheduled_at: T9 })).json.error).toBe("BOOKING_LOCKED"); // survey
    const r = await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.kim, assistants: [s.users.dara], vehicle_id: vehicle, scheduled_at: T9 });
    expect(r.status).toBe(200); expect(r.json.status).toBe("assigned"); expect(r.json.conflicts).toEqual([]);
    const b = (await ceo.req("GET", `/api/bookings/${bk1}`)).json;
    expect(b.status).toBe("assigned"); expect(b.technicians.map((t: any) => `${t.role}:${t.full_name}`)).toEqual(["lead:Kim", "assistant:Dara"]);
    const log = (await ceo.req("GET", `/api/bookings/${bk1}/log`)).json;
    expect(log.map((l: any) => l.to_status)).toEqual(["new", "assigned"]);
    // outbox: group + kim (linked); dara only in-app
    const out = await sql<{ chat_id: string; text: string; reply_markup: any }[]>`select chat_id, text, reply_markup from telegram_outbox order by id`;
    expect(out.map((o) => o.chat_id).sort()).toEqual(["-100123", "900002"]);
    expect(out[0]!.text.startsWith(`✅ បញ្ជាក់ការងារ (BK-0001)
📅 ${ddmmyyyy(T9)} · 09:00–11:00
👤 អតិថិជន: លោក សុខា · 📞 012345678`)).toBe(true);
    expect(out[0]!.text).toContain("1. Kim (មេជាង)  2. Dara"); expect(out[0]!.text).toContain("🚐 01");
    expect(out[0]!.reply_markup.inline_keyboard[0][0].url).toContain("destination=11.55,104.93");
    expect((await kim.req("GET", "/api/notifications")).json[0].kind).toBe("booking.assigned");
    expect((await dara.req("GET", "/api/notifications")).json[0].link).toBe(`/tech/job/${bk1}`);
  });

  it("outbox delivery: sent / retry / permanent failure (blocked chat) / max attempts", async () => {
    const send = vi.fn(async (chat: string | number) => (String(chat) === "-100123" ? { ok: true as const } : { ok: false as const, error: "403 Forbidden: bot was blocked", permanent: true }));
    const r = await flushOutbox(20, send as never);
    expect(r).toEqual({ taken: 2, sent: 1, failed: 1, retry: 0 });
    const rows = await sql<{ chat_id: string; status: string; attempts: number }[]>`select chat_id, status, attempts from telegram_outbox order by id`;
    expect(rows.find((x) => x.chat_id === "-100123")!.status).toBe("sent");
    expect(rows.find((x) => x.chat_id === "900002")).toMatchObject({ status: "failed", attempts: 1 });
    // transient error keeps pending until 5 attempts
    await sql`insert into telegram_outbox (company_id, chat_id, text, dedupe_key) values (${s.a}, ${1}, ${"retry me"}, ${"test:retry"})`;
    const flaky = vi.fn(async () => ({ ok: false as const, error: "timeout", permanent: false }));
    for (let i = 0; i < 4; i++) expect((await flushOutbox(20, flaky as never)).retry).toBe(1);
    expect((await flushOutbox(20, flaky as never)).failed).toBe(1);
    expect((await sql`select status from telegram_outbox where dedupe_key = 'test:retry'`)[0]!.status).toBe("failed");
  });

  it("technician visibility: kim/dara see BK-0001 only (+ its customer via booking), status log limited, cannot edit", async () => {
    expect((await kim.req("GET", "/api/bookings")).json.map((b: any) => b.number)).toEqual(["BK-0001"]);
    expect((await dara.req("GET", `/api/bookings/${bk1}`)).json.customer_phones).toEqual(["012345678"]);
    expect((await kim.req("GET", `/api/bookings/${bk2}`)).status).toBe(404);
    expect((await kim.req("GET", `/api/bookings/${bk2}/log`)).status).toBe(404);
    expect((await kim.req("PATCH", `/api/bookings/${bk1}`, { notes: "x" })).status).toBe(403);
    expect((await kim.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.kim, assistants: [], scheduled_at: T9 })).status).toBe(403);
  });

  it("re-assign at 10:00 is BLOCKED by the overlap (R2, was a ±2h warning); availability lists busy technicians; GM may assign type B after quote… (survey stays locked)", async () => {
    const av = (await admin.req("GET", `/api/bookings/availability?at=${encodeURIComponent(T10)}`)).json.people;
    expect(av.find((p: any) => p.full_name === "Kim").busy[0].number).toBe("BK-0001");
    expect(av.find((p: any) => p.full_name === "GM A").busy).toEqual([]);
    const bk3 = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "camera", service_text: "ដំឡើងកាមេរ៉ា", zone: "inside", scheduled_at: T10 })).json.id;
    const r = await gm.req("POST", `/api/bookings/${bk3}/assign`, { lead: s.users.kim, assistants: [], scheduled_at: T10 });
    expect(r.status).toBe(409); expect(r.json.error).toBe("TECH_UNAVAILABLE");
    expect(r.json.details.conflicts).toEqual([expect.objectContaining({ user_id: s.users.kim, number: "BK-0001" })]);
    expect((await gm.req("POST", `/api/bookings/${bk3}/assign`, { lead: s.users.gm01, assistants: [], scheduled_at: T10 })).status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${bk2}/assign`, { lead: s.users.kim, assistants: [], scheduled_at: T10 })).json.error).toBe("BOOKING_LOCKED");
    // re-assign replaces the team and queues a new message (new dedupe key)
    const before = (await sql`select count(*)::int as n from telegram_outbox`)[0]!.n;
    await admin.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.dara, assistants: [], scheduled_at: T9 });
    expect((await ceo.req("GET", `/api/bookings/${bk1}`)).json.technicians).toEqual([expect.objectContaining({ role: "lead", full_name: "Dara" })]);
    expect((await sql`select count(*)::int as n from telegram_outbox`)[0]!.n).toBeGreaterThan(before);
  });

  it("edit lock + status guard: patch works while assigned; en_route locks edits; illegal transition rejected by the trigger", async () => {
    expect((await ceo.req("PATCH", `/api/bookings/${bk1}`, { notes: "ចំណាំថ្មី", vehicle_id: "" })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${bk1}`)).json.notes).toBe("ចំណាំថ្មី");
    await sql`update bookings set status = 'en_route' where id = ${bk1}`;
    expect((await ceo.req("PATCH", `/api/bookings/${bk1}`, { notes: "x" })).json.error).toBe("BOOKING_LOCKED");
    await expect(sql`update bookings set status = 'closed' where id = ${bk1}`).rejects.toThrow(/INVALID_TRANSITION/);
    const log = (await ceo.req("GET", `/api/bookings/${bk1}/log`)).json;
    expect(log.at(-1).to_status).toBe("en_route");
  });

  it("board filters: status list + date range; catalog/customers audit rows exist", async () => {
    expect((await ceo.req("GET", "/api/bookings?status=survey")).json.map((b: any) => b.number)).toEqual(["BK-0002"]);
    expect((await ceo.req("GET", `/api/bookings?from=${encodeURIComponent(at(2, 0))}&to=${encodeURIComponent(at(3, 0))}`)).json.length).toBe(2);
    const audit = (await ceo.req("GET", "/api/settings/audit?limit=500")).json.map((a: any) => a.action);
    for (const a of ["customer.create", "booking.create", "booking.assign", "booking.update", "telegram.link", "settings.update"]) expect(audit).toContain(a);
  });

  it("telegram codes (v2.1): plain 8-char staff code (T3), replaced + single use, relink moves the account (F-M2-03), group code needs settings.manage", async () => {
    const r1 = (await dara.req("POST", "/api/telegram/link-code")).json;
    expect(r1.code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/);
    expect(r1.link).toBeNull(); // no hub in this suite → no bot known → no link (the UI says so)
    const c2 = (await dara.req("POST", "/api/telegram/link-code")).json.code; // replaces c1
    expect((await consumeLinkCode(r1.code, 900006, 900006)).ok).toBe(false);
    expect(await consumeLinkCode(c2, 900002, 900002)).toMatchObject({ ok: true }); // same Telegram account as kim → moves
    expect((await sql`select telegram_user_id from users where id = ${s.users.kim!}`)[0]!.telegram_user_id).toBeNull();
    expect((await consumeLinkCode(c2, 900002, 900002)).ok).toBe(false); // single use
    // expiry: 10 minutes
    const c3 = (await dara.req("POST", "/api/telegram/link-code")).json.code;
    await sql`update telegram_link_codes set expires_at = now() - interval '1 second' where code = ${c3}`;
    expect((await consumeLinkCode(c3, 900002, 900002)).ok).toBe(false);
    // group code: settings.manage only, 24 h
    expect((await gm.req("POST", "/api/telegram/group-code")).status).toBe(403);
    expect((await dara.req("POST", "/api/telegram/group-code")).status).toBe(403);
    const g = (await ceo.req("POST", "/api/telegram/group-code")).json;
    expect(g.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(g.command).toBe(`/register ${g.code}`);
    const hours = (new Date(g.expires_at).getTime() - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9); expect(hours).toBeLessThanOrEqual(24.01); // DB clock vs JS clock: sub-second skew
    // the shop has no webhook any more (the hub receives Telegram)
    expect((await app.inject({ method: "POST", url: "/api/telegram/webhook", payload: {} })).statusCode).toBe(404);
  });
});
