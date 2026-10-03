// Telegram bot menus per role (D-91): reply keyboards gated by the app's permissions, label dispatch, job steps with a location,
// pending actions (find customer, request service, send-back note), customer menu by linked subscriber, Mini App login.
// Shop side through the internal API (the hub only forwards); the hub side (keyboard markup, HMAC verify) is in 40_hub_telegram.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { setHubTransport } from "../src/services/hub-client.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client;
const KEY = "key-oneteam-0123456789abcdef";
const CHAT = { kim: 910001, dara: 910002, gm: 910003, admin: 910004, ceo: 910005, cfo: 910006, cust: 910007, nobody: 910099 };
const internal = (path: string, body: unknown) => app.inject({ method: "POST", url: `/internal/${path}`, headers: { "x-hub-key": KEY, "content-type": "application/json" }, payload: JSON.stringify(body) });
const start = async (chat: number, extra: Record<string, unknown> = {}) => (await internal("tg-start", { chat_id: chat, tg_user: chat, ...extra })).json();
const say = async (chat: number, text: string, extra: Record<string, unknown> = {}) => (await internal("tg-text", { chat_id: chat, tg_user: chat, text, ...extra })).json();
const labels = (m: any): string[] => (m.keyboard ?? []).flat().map((b: any) => b.text);
const inlineViews = (m: any): string[] => (m.buttons ?? []).flat().map((b: any) => b.view ?? b.web_app ?? b.url ?? "");
const hubCalls: { path: string; body: any }[] = [];
let cust: string, kimJob: string;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.publicUrl = "https://oneteam.test"; config.shop.hubKey = KEY; config.shop.hubUrl = "http://hub"; config.shop.features = "subscribe,reminders,inventory,accounting";
  setHubTransport(async (_method, path, body) => {
    hubCalls.push({ path, body });
    if (path === "/internal/tg-verify") return { status: 200, json: body && (body as any).init_data === "good" ? { ok: true, tg_user: CHAT.kim } : { ok: false, error: "BAD_SIGNATURE" } };
    if (path === "/internal/broadcasts") return { status: 200, json: [{ id: 1, kind: "promo", text: "បញ្ចុះតម្លៃ 10% ខែនេះ", created_at: new Date().toISOString() }] };
    return { status: 200, json: { ok: true } };
  });
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin");
  for (const [u, c] of [["kim", CHAT.kim], ["dara", CHAT.dara], ["gm01", CHAT.gm], ["admin", CHAT.admin], ["ceo", CHAT.ceo]] as const)
    await sql`update users set telegram_chat_id = ${c}, telegram_user_id = ${c} where id = ${s.users[u]!}`;
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, telegram_chat_id, telegram_user_id, tracks_attendance)
    values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', 'x', false, ${CHAT.cfo}, ${CHAT.cfo}, false)`;
  await ceo.req("PATCH", "/api/settings/company", { office_lat: 11.5564, office_lng: 104.9282, geofence_m: 100, company_info: { name_km: "One Team", phone: "012 345 678", address: "ផ្លូវ 271" } });
  cust = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន Bot", phones: ["012777888"], zone: "inside" })).json.id;
  await sql`update customers set tg_subscriber_id = 55 where id = ${cust}`;
  const at = new Date(); at.setUTCHours(3, 0, 0, 0); if (at.getTime() < Date.now()) at.setUTCDate(at.getUTCDate() + 1);
  kimJob = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "លាងម៉ាស៊ីនត្រជាក់", zone: "inside", scheduled_at: at.toISOString() })).json.id;
  expect((await gm.req("POST", `/api/bookings/${kimJob}/assign`, { lead: s.users.kim, assistants: [s.users.dara] })).status).toBe(200);
  // today 10:00 shop time (whatever the clock says when the suite runs) and a work group that is told about job steps
  await sql`update bookings set scheduled_at = x.t, ends_at = x.t + interval '2 hours' from (select (date_trunc('day', now() at time zone 'Asia/Phnom_Penh') + interval '10 hours') at time zone 'Asia/Phnom_Penh' as t) x where id = ${kimJob}`;
  await sql`update company_settings set telegram_group_chat_id = -100900 where company_id = ${s.a}`;
});
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("keyboards per role (permissions of the app)", () => {
  it("technician: today · steps · report · attendance · leave · tomorrow + Me / How to use — Khmer labels with icons, 2 per row, ≤ 8", async () => {
    const m = await start(CHAT.kim);
    expect(m.kind).toBe("staff");
    const l = labels(m);
    expect(l).toEqual(["📋 ការងារថ្ងៃនេះ", "🔧 ជំហានការងារ", "📝 របាយការណ៍ការងារ", "📍 វត្តមាន", "🗓 សុំច្បាប់ឈប់", "📅 ការងារថ្ងៃស្អែក", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    for (const row of m.keyboard) expect(row.length).toBeLessThanOrEqual(2);
    expect(JSON.stringify(labels(m))).not.toMatch(/[A-Za-z]{3,}/); // Khmer only for a Khmer-mode user (icons aside)
    expect(m.keyboard.flat().find((b: any) => b.text.includes("សុំច្បាប់")).web_app).toBe("https://oneteam.test/tg?to=%2Fleave");
    expect(inlineViews(m)).toEqual(expect.arrayContaining(["today", "next"])); // the quick inline buttons stay
  });
  it("lead technician adds Review jobs · Site survey · My team today; the English-mode user gets English labels", async () => {
    await sql`update users set is_lead = true, language = 'en' where id = ${s.users.kim!}`;
    const l = labels(await start(CHAT.kim));
    expect(l).toEqual(expect.arrayContaining(["🔎 Review jobs", "📐 Site survey", "👥 My team today", "👤 Me", "❓ How to use"]));
    expect(l.length).toBe(11);
    await sql`update users set language = 'km' where id = ${s.users.kim!}`;
  });
  it("admin / GM / CEO / CFO menus follow the brief; a button disappears when the role loses the permission", async () => {
    expect(labels(await start(CHAT.admin))).toEqual(["📝 ការងារថ្មី", "📋 ការងារថ្ងៃនេះ", "🧾 រង់ចាំវិក្កយបត្រ", "🔔 ដល់ពេលលាង", "🔍 រកអតិថិជន", "💵 ទទួលប្រាក់", "🌐 សំណើអតិថិជន", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    expect(labels(await start(CHAT.gm))).toEqual(["📝 ការងារថ្មី", "✅ រង់ចាំអនុម័ត", "📋 ការងារថ្ងៃនេះ", "📍 ជាងនៅណា", "📊 សង្ខេបថ្ងៃនេះ", "🌐 សំណើអតិថិជន", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    expect(labels(await start(CHAT.ceo))).toEqual(["📊 សង្ខេប", "✅ រង់ចាំអនុម័ត", "🚨 ដំណឹងសំខាន់", "👷 បុគ្គលិកថ្ងៃនេះ", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    expect(labels(await start(CHAT.cfo))).toEqual(["💵 សាច់ប្រាក់ថ្ងៃនេះ", "🔎 ត្រូវផ្ទៀងផ្ទាត់", "📒 ហិរញ្ញវត្ថុ", "📦 ស្តុកជិតអស់", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    await sql`update role_permissions set allowed = false where company_id = ${s.a} and role = 'admin' and permission_key = 'booking.create'`;
    expect(labels(await start(CHAT.admin))).not.toContain("📝 ការងារថ្មី");
    await sql`update role_permissions set allowed = true where company_id = ${s.a} and role = 'admin' and permission_key = 'booking.create'`;
    expect((await start(CHAT.nobody)).kind).toBe("none"); // unknown chat: the hub falls back to its own customer menu
  });
});

describe("technician actions", () => {
  it("job steps: Depart → Arrive needs a location (pending) → Start → Done; each step is a real checkpoint and the group is told", async () => {
    const m = await say(CHAT.kim, "🔧 ជំហានការងារ");
    const job = (m.buttons as any[][]).flat().find((b) => b.view === "job");
    expect(job).toBeTruthy(); expect(job.id).toBe(kimJob);
    const view = (view: string, id?: string, arg?: string) => internal("tg-menu", { chat_id: CHAT.kim, view, ...(id ? { id } : {}), ...(arg ? { arg } : {}) });
    const j = (await view("job", kimJob, "today")).json().menu;
    expect((j.buttons as any[][]).flat().some((b) => b.view === "step" && b.arg === "depart")).toBe(true); // only the next step is offered
    expect((await view("step", kimJob, "depart")).json().menu.text).toContain("🚐");
    expect((await sql`select step, no_gps from booking_checkpoints where booking_id = ${kimJob} order by at`).map((c) => c.step)).toEqual(["depart"]);
    const ask = (await view("step", kimJob, "arrive")).json().menu;
    expect(ask.ask_location).toBe(true);
    expect((await sql`select action from tg_pending where chat_id = ${CHAT.kim}`)[0]!.action).toMatchObject({ kind: "arrive", booking_id: kimJob });
    const loc = (await internal("tg-location", { chat_id: CHAT.kim, tg_user: CHAT.kim, lat: 11.55, lng: 104.93, accuracy: 8, sent_at: Math.floor(Date.now() / 1000) })).json();
    expect(loc.reply).toContain("📍");
    expect((await sql`select step, lat from booking_checkpoints where booking_id = ${kimJob} and step = 'arrive'`)[0]).toMatchObject({ lat: 11.55 });
    expect((await sql`select 1 from tg_pending where chat_id = ${CHAT.kim}`).length).toBe(0); // pending cleared
    await view("step", kimJob, "start"); await view("step", kimJob, "finish");
    expect((await sql`select status from bookings where id = ${kimJob}`)[0]!.status).toBe("work_done");
    expect((await view("step", kimJob, "finish")).json().menu.text).toMatch(/✅|រួច/); // pressing twice is harmless
    expect((await sql`select count(*)::int as n from telegram_outbox where text like '%' || (select number from bookings where id = ${kimJob}) || '%'`)[0]!.n).toBeGreaterThan(0);
  });
  it("another technician cannot step a job they are not on; location without a pending step = attendance", async () => {
    const other = (await admin.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", scheduled_at: new Date(Date.now() + 2 * 86400_000).toISOString() })).json.id;
    await gm.req("POST", `/api/bookings/${other}/assign`, { lead: s.users.dara, assistants: [] });
    expect((await internal("tg-menu", { chat_id: CHAT.kim, view: "step", id: other, arg: "depart" })).json().menu.text).toMatch(/❌/);
    const loc = (await internal("tg-location", { chat_id: CHAT.dara, tg_user: CHAT.dara, lat: 11.5564, lng: 104.9282, accuracy: 5, sent_at: Math.floor(Date.now() / 1000) })).json();
    expect(loc.reply).toContain("ចូលធ្វើការ");
  });
  it("job report and leave open the Mini App; tomorrow lists tomorrow only", async () => {
    const r = await say(CHAT.dara, "📝 របាយការណ៍ការងារ");
    expect((r.buttons as any[][]).flat().some((b) => String(b.web_app).startsWith("https://oneteam.test/tg?to=%2Ftech%2Fjob%2F"))).toBe(true);
    const t = await say(CHAT.dara, "📅 ការងារថ្ងៃស្អែក");
    expect(t.text).toMatch(/ស្អែក/);
  });
});

describe("lead technician, managers, CEO, CFO", () => {
  it("lead: review list → approve or send back with a note (pending); my team today", async () => {
    await sql`update bookings set status = 'pending_review' where id = ${kimJob}`;
    await sql`insert into booking_reports (booking_id, company_id, notes, status, submitted_by) values (${kimJob}, ${s.a}, 'done', 'submitted', ${s.users.dara!}) on conflict (booking_id) do update set status = 'submitted'`;
    const m = await say(CHAT.kim, "🔎 ពិនិត្យការងារ");
    const b = (m.buttons as any[][]).flat();
    expect(b.some((x) => x.view === "review" && x.arg === "ok" && x.id === kimJob)).toBe(true);
    const back = (await internal("tg-menu", { chat_id: CHAT.kim, view: "review", id: kimJob, arg: "back" })).json().menu;
    expect(back.text).toMatch(/មូលហេតុ|note/i);
    await say(CHAT.kim, "រូបក្រោយមិនច្បាស់");
    expect((await sql`select status, review_note from booking_reports where booking_id = ${kimJob}`)[0]).toMatchObject({ status: "revision", review_note: "រូបក្រោយមិនច្បាស់" });
    expect((await say(CHAT.kim, "👥 ក្រុមខ្ញុំថ្ងៃនេះ")).text).toContain("Dara");
    await sql`update users set is_lead = false where id = ${s.users.kim!}`;
    expect(labels(await start(CHAT.kim))).not.toContain("🔎 ពិនិត្យការងារ");
  });
  it("admin: waiting for invoice, due for cleaning, find customer (pending → search), requests; GM: approvals, where technicians, summary", async () => {
    await sql`update bookings set status = 'reviewed' where id = ${kimJob}`;
    expect((await say(CHAT.admin, "🧾 រង់ចាំវិក្កយបត្រ")).text).toContain("អតិថិជន Bot");
    expect((await say(CHAT.admin, "🔔 ដល់ពេលលាង")).text).toBeTruthy();
    const ask = await say(CHAT.admin, "🔍 រកអតិថិជន");
    expect(ask.text).toMatch(/ឈ្មោះ|លេខ/);
    const found = await say(CHAT.admin, "0127778");
    expect(found.text).toContain("អតិថិជន Bot"); expect(found.text).toContain("012777888");
    expect((await say(CHAT.gm, "✅ រង់ចាំអនុម័ត")).text).toMatch(/\d/);
    expect((await say(CHAT.gm, "📍 ជាងនៅណា")).text).toContain("Kim");
    const sum = await say(CHAT.gm, "📊 សង្ខេបថ្ងៃនេះ");
    expect(sum.text).toContain("ការងារ"); expect(sum.text).not.toMatch(/\$|៛/); // GM: no money (no report.finance)
  });
  it("CEO: summary today / week / month with money, alerts, staff today; CFO: cash today, to verify, finance Mini App, low stock", async () => {
    const m = await say(CHAT.ceo, "📊 សង្ខេប");
    expect(inlineViews(m)).toEqual(expect.arrayContaining(["sum_day", "sum_week", "sum_month"]));
    expect((await internal("tg-menu", { chat_id: CHAT.ceo, view: "sum_week" })).json().menu.text).toMatch(/\$/);
    expect((await say(CHAT.ceo, "👷 បុគ្គលិកថ្ងៃនេះ")).text).toContain("Dara");
    expect((await say(CHAT.ceo, "🚨 ដំណឹងសំខាន់")).text).toBeTruthy();
    expect((await say(CHAT.cfo, "💵 សាច់ប្រាក់ថ្ងៃនេះ")).text).toMatch(/\$/);
    expect((await say(CHAT.cfo, "🔎 ត្រូវផ្ទៀងផ្ទាត់")).text).toBeTruthy();
    expect((await say(CHAT.cfo, "📒 ហិរញ្ញវត្ថុ")).buttons.flat().some((b: any) => String(b.web_app).includes("%2Faccounting"))).toBe(true);
    expect((await say(CHAT.cfo, "📦 ស្តុកជិតអស់")).text).toBeTruthy();
  });
  it("Me: language toggle and unlink (with confirm); How to use", async () => {
    const me = await say(CHAT.dara, "👤 ខ្ញុំ");
    expect(inlineViews(me)).toEqual(expect.arrayContaining(["lang_en", "unlink"]));
    expect((await internal("tg-menu", { chat_id: CHAT.dara, view: "lang_en" })).json().menu.lang).toBe("en");
    expect((await sql`select language from users where id = ${s.users.dara!}`)[0]!.language).toBe("en");
    expect(labels(await start(CHAT.dara))).toContain("👤 Me");
    await internal("tg-menu", { chat_id: CHAT.dara, view: "lang_km" });
    expect((await say(CHAT.dara, "❓ របៀបប្រើ")).text.length).toBeGreaterThan(40);
    expect(inlineViews((await internal("tg-menu", { chat_id: CHAT.dara, view: "unlink" })).json().menu)).toContain("unlink_yes");
    const done = (await internal("tg-menu", { chat_id: CHAT.dara, view: "unlink_yes" })).json().menu;
    expect(done.remove_keyboard).toBe(true);
    expect((await sql`select telegram_user_id from users where id = ${s.users.dara!}`)[0]!.telegram_user_id).toBeNull();
    expect((await start(CHAT.dara)).kind).toBe("none");
    expect(hubCalls.some((c) => c.path === "/internal/chat-forget")).toBe(true);
  });
});

describe("customers (by the hub subscriber linked to a customer)", () => {
  it("menu, my bookings, warranty, contact shop, history, promotions; request service → pending → saved + Admin notified; «Me» hands back to the hub menu", async () => {
    const m = await start(CHAT.cust, { subscriber_id: 55 });
    expect(m.kind).toBe("customer");
    expect(labels(m)).toEqual(["📋 ការកក់របស់ខ្ញុំ", "🛡 ការធានា", "📞 ទាក់ទងហាង", "📜 ប្រវត្តិ", "🛠 ស្នើសេវាកម្ម", "🎁 ប្រូម៉ូសិន", "👤 ខ្ញុំ", "❓ របៀបប្រើ"]);
    expect((await say(CHAT.cust, "📋 ការកក់របស់ខ្ញុំ", { subscriber_id: 55 })).text).toMatch(/BK-\d{4}/);
    expect((await say(CHAT.cust, "📞 ទាក់ទងហាង", { subscriber_id: 55 })).text).toContain("012 345 678");
    expect((await say(CHAT.cust, "🎁 ប្រូម៉ូសិន", { subscriber_id: 55 })).text).toContain("បញ្ចុះតម្លៃ 10%");
    expect((await say(CHAT.cust, "🛠 ស្នើសេវាកម្ម", { subscriber_id: 55 })).text).toMatch(/សរសេរ|ប្រាប់/);
    const ok = await say(CHAT.cust, "ម៉ាស៊ីនត្រជាក់មិនត្រជាក់ សុំមកមើលថ្ងៃស្អែក", { subscriber_id: 55 });
    expect(ok.text).toMatch(/✅/);
    const req = (await sql`select source, customer_id, text, status from service_requests where company_id = ${s.a}`)[0]!;
    expect(req).toMatchObject({ source: "telegram", customer_id: cust, status: "new" });
    expect((await sql`select 1 from notifications where kind = 'service.request' and user_id = ${s.users.admin!}`).length).toBe(1);
    const list = await say(CHAT.admin, "🌐 សំណើអតិថិជន");
    expect(list.text).toContain("មិនត្រជាក់");
    const done = (await internal("tg-menu", { chat_id: CHAT.admin, view: "req", id: (await sql<{ id: string }[]>`select id from service_requests limit 1`)[0]!.id, arg: "done" })).json().menu;
    expect(done.text).toMatch(/✅/);
    expect((await sql`select status from service_requests`)[0]!.status).toBe("done");
    expect((await say(CHAT.cust, "👤 ខ្ញុំ", { subscriber_id: 55 })).kind).toBe("customer_menu");
    expect((await say(CHAT.cust, "📋 ការកក់របស់ខ្ញុំ", { subscriber_id: 99 })).kind).toBe("none"); // unknown subscriber → nothing
  });
});

describe("Mini App login (Telegram WebApp initData verified by the hub)", () => {
  it("good initData of a linked staff member → session cookie + me; bad / unknown → 401; a Mini App link is per role page", async () => {
    const ok = await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { init_data: "good" }, headers: { "x-forwarded-for": "10.9.9.9" } });
    expect(ok.statusCode).toBe(200); expect(ok.json().me.username).toBe("kim");
    expect(String(ok.headers["set-cookie"])).toContain("ots=");
    expect(hubCalls.some((c) => c.path === "/internal/tg-verify")).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/auth/telegram", payload: { init_data: "forged" } })).statusCode).toBe(401);
    expect((await sql`select 1 from audit_log where action = 'auth.login' and user_id = ${s.users.kim!} and new_data->>'via' = 'telegram'`).length).toBe(1);
  });
});
