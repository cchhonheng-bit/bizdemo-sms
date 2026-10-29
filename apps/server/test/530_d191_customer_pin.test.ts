// D-191 (owner 29-10): the customer account = phone + a 4-digit PIN chosen right after a booking — no password by Telegram any more.
// Book → the sent page offers the account (no personal data in it) → PIN twice → this device stays signed in (180 days) and opens
// «ការកក់របស់ខ្ញុំ» → the timeline follows the staff's changes · a new device: phone + PIN · 5 wrong → 15 minutes (per phone and
// per visitor) · reset by a code (bot into the linked chat, or read out by the shop) · a known number sees its history only once
// verified · IDOR · skip · change PIN / sign out everywhere · cancel only new / assigned · rating · Origin check · book again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CUSTOMER_MENU, CUSTOMER_MENU_OLD } from "@sms/shared";
import { client, loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { seedWebCatalog } from "../src/services/catalog.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { formToken } from "../src/services/site.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, kim: Client;
const KEY = "key-oneteam-0123456789abcdef";
const hubCalls: { path: string; body: any }[] = [];
const told = (sub: number) => hubCalls.filter((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === sub).map((c) => String(c.body.text));
let SVC = "";
const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const pub = (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const internal = (path: string, body: unknown) => app.inject({ method: "POST", url: `/internal/${path}`, headers: { "x-hub-key": KEY, "content-type": "application/json" }, payload: JSON.stringify(body) });
const at = async (day: number, time: string) => ((await pub("GET", `/api/public/slots?items=${SVC}:1`)).json().days[day].slots as { time: string; at: string }[]).find((x) => x.time === time)!.at;
async function book(phone: string, name: string, day: number, time: string, address = "ផ្ទះ 9 ផ្លូវ 271") {
  const r = await pub("POST", "/api/public/bookings", { items: `${SVC}:1`, at: await at(day, time), address, lat: 11.55, lng: 104.92, name, phone, consent: true, ts: formToken(Date.now() - 60_000) });
  expect(r.statusCode, r.body).toBe(200);
  const ref = r.json().ref as string;
  return { ref, id: (await sql<{ id: string }[]>`select id from bookings where web_ref = ${ref}`)[0]!.id };
}
const account = (c: Client, ref: string, over: Record<string, unknown> = {}) => c.req("POST", "/api/public/account", { ref, name: "សុខ ថ្មី", phone: "012 345 111", pin: "4827", pin2: "4827", ...over });
const login = (phone: string, pin: string, ip = "10.0.0.1") => pub("POST", "/api/public/login", { phone, pin }, { "x-forwarded-for": ip });
async function device(phone: string, pin: string): Promise<Client> { const c = client(app); expect((await c.req("POST", "/api/public/login", { phone, pin })).status).toBe(200); return c; }
const requestOf = async (bookingId: string) => (await sql<{ id: string }[]>`select id from service_requests where booking_id = ${bookingId} and kind = 'booking'`)[0]!.id;
const confirm = async (bookingId: string) => expect((await admin.req("POST", `/api/requests/${await requestOf(bookingId)}/confirm`, { lead: s.users.kim!, assistants: [] })).status).toBe(200);
const custOf = async (phone: string) => (await sql<{ id: string; password_hash: string | null; pin_history_from: Date | null; name: string }[]>`select id, password_hash, pin_history_from, name from customers where ${phone} = any(phones)`)[0]!;

let A: Client, bkA = "", refA = "", bkK = "", staffK = "";

beforeAll(async () => {
  await resetDb(); s = await seed();
  config.publicUrl = "https://oneteam.test"; config.shop.hubKey = KEY; config.shop.hubUrl = "http://hub"; config.shop.features = "website,subscribe,reminders";
  setHubTransport(async (_method, path, body) => {
    hubCalls.push({ path, body });
    if (path === "/internal/bot") return { status: 200, json: { username: "Oneteam_app_bot" } };
    return { status: 200, json: { ok: true } };
  });
  resetBotCache();
  app = await makeApp();
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim");
  await sql`update users set is_active = false where username = 'newbie'`;
  await seedWebCatalog(s.a, { prices: true });
  SVC = (await sql<{ id: string }[]>`select id from catalog_items where company_id = ${s.a} and code = 'AC-CLEAN'`)[0]!.id;
  expect((await ceo.req("PATCH", "/api/settings/company", { work_days: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(200);
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-191 the customer account with a PIN", () => {
  it("book → the sent page offers the account without personal data → PIN twice → this device is signed in for 180 days, «/» opens its bookings, the timeline follows the staff", async () => {
    ({ ref: refA, id: bkA } = await book("012 345 111", "Sok Fresh", 2, "08:00"));
    const html = (await page(`/book/done/${refA}`)).body;
    for (const x of ['id="acct"', 'id="a-name"', 'id="a-phone"', 'id="a-pin"', 'id="a-pin2"', 'id="a-skip"', "បង្កើតគណនី ដើម្បីតាមដានការកក់", 'id="tl"', "បានទទួល"]) expect(html).toContain(x);
    expect(html).not.toContain("Sok Fresh"); expect(html).not.toContain("012345111"); expect(html).not.toContain("345 111");
    A = client(app);
    expect((await account(A, refA, { pin2: "4828" })).json.error).toBe("PIN_MISMATCH");
    expect((await account(A, refA, { pin: "1234", pin2: "1234" })).json.error).toBe("WEAK_PIN");
    expect((await account(A, refA, { pin: "5111", pin2: "5111" })).json.error).toBe("WEAK_PIN"); // the last 4 digits of the phone
    expect((await account(A, refA, { pin: "12a4", pin2: "12a4" })).json.error).toBe("PIN_FORMAT");
    expect((await account(A, refA, { name: " " })).json.error).toBe("NAME_REQUIRED");
    expect(A.cookie).toBeNull();
    const ok = await account(A, refA, { pin: "៤៨២៧", pin2: "៤៨២៧" }); // a Khmer keyboard
    expect(ok.json).toEqual({ ok: true, next: `/my/b/${bkA}` }); expect(A.cookie).toMatch(/^otc=/);
    const c = await custOf("+85512345111");
    expect(c.password_hash).toMatch(/^\$argon2id\$/); expect(c.pin_history_from).toBeNull(); expect(c.name).toBe("សុខ ថ្មី");
    const days = (await sql<{ d: number }[]>`select extract(day from expires_at - now())::int as d from customer_sessions where customer_id = ${c.id}`)[0]!.d;
    expect(days).toBeGreaterThanOrEqual(179);
    expect((await account(client(app), refA)).json.error).toBe("ACCOUNT_EXISTS");
    // the same device: «/» → its bookings; the sent page → the booking's own page
    const home = await page("/", { cookie: A.cookie! });
    expect(home.statusCode).toBe(302); expect(home.headers.location).toBe("/my/bookings");
    expect((await page(`/?items=${SVC}:1`, { cookie: A.cookie! })).headers.location).toBe(`/s/ac?items=${SVC}:1`); // a link with lines still books (D-192: on its category page)
    const done = await page(`/book/done/${refA}`, { cookie: A.cookie! });
    expect(done.headers.location).toBe(`/my/b/${bkA}`);
    const mine = (await page(`/my/b/${bkA}`, { cookie: A.cookie! })).body;
    for (const x of ["ជាងរបស់អ្នក", "រង់ចាំបញ្ជាក់", 'id="tl"', "data-cancel", "កក់ម្ដងទៀត"]) expect(mine).toContain(x);
    expect((await A.req("GET", `/api/my/bookings/${bkA}`)).json.track.steps[1]).toMatchObject({ key: "assigned", done: false });
    await confirm(bkA);
    const after = (await A.req("GET", `/api/my/bookings/${bkA}`)).json;
    expect(after.state).toBe("confirmed"); expect(after.track.steps[1]).toMatchObject({ key: "assigned", done: true }); expect(after.technician).toBe("Kim");
    expect(after.html).toContain("បានចាត់ជាង");
    expect((await A.req("GET", "/api/my")).json.upcoming.map((x: any) => x.id)).toEqual([bkA]);
    expect((await sql`select 1 from audit_log where action = 'customer.account_created'`).length).toBe(1);
  });

  it("a new device: phone + PIN; every 5th wrong PIN locks the phone 15 minutes (even the right PIN); the same per visitor", async () => {
    for (let i = 1; i <= 4; i++) expect((await login("012 345 111", "0000", `10.1.0.${i}`)).json().error).toBe("INVALID_CREDENTIALS");
    const fifth = await login("012 345 111", "0000", "10.1.0.5");
    expect([fifth.statusCode, fifth.json().error, fifth.json().details]).toEqual([423, "LOCKED", { minutes: 15 }]);
    expect((await login("012 345 111", "4827", "10.1.0.6")).statusCode).toBe(423);
    expect((await sql`select new_data from audit_log where action = 'customer.login_locked' order by id desc limit 1`)[0]!.new_data).toMatchObject({ failed: 5, minutes: 15 });
    await sql`update customer_login_guards set locked_until = now() - interval '1 second'`;
    expect((await login("012 345 111", "4827", "10.1.0.6")).statusCode).toBe(200);
    expect((await sql`select new_data from audit_log where action = 'customer.login' order by id desc limit 1`)[0]!.new_data).toEqual({ via: "pin" });
    // one visitor trying many numbers
    for (let i = 1; i <= 4; i++) expect((await login(`012 600 00${i}`, "0000", "10.9.9.9")).statusCode).toBe(401);
    expect((await login("012 600 005", "0000", "10.9.9.9")).statusCode).toBe(423);
    expect((await login("012 345 111", "4827", "10.9.9.9")).statusCode).toBe(423);
    expect((await login("012 345 111", "4827", "10.9.9.8")).statusCode).toBe(200);
  });

  it("forgot PIN: a code into the linked Telegram chat (the same answer for every number) or one the shop reads out; every old session ends; a code dies after 5 tries; never logged", async () => {
    await sql`update customers set tg_subscriber_id = 501 where '+85512345111' = any(phones)`;
    hubCalls.length = 0;
    expect((await pub("POST", "/api/public/pin-code", { phone: "099 888 777" })).json()).toEqual({ ok: true }); // unknown: same answer, nothing sent
    expect(hubCalls.filter((c) => c.path === "/internal/notify-subscriber")).toEqual([]);
    expect((await pub("POST", "/api/public/pin-code", { phone: "012 345 111" })).json()).toEqual({ ok: true });
    const code = /^🔑 លេខកូដប្ដូរលេខសម្ងាត់៖ (\d{6})\nប្រើក្នុង ១០ នាទី · កុំប្រាប់អ្នកណា$/.exec(told(501)[0]!)![1]!;
    expect(hubCalls.at(-1)!.body.buttons).toEqual([[{ text: "🔑 ប្ដូរលេខសម្ងាត់", url: "https://oneteam.test/my/reset" }]]);
    const reset = (over: Record<string, unknown>) => pub("POST", "/api/public/pin-reset", { phone: "012 345 111", code, pin: "2580", pin2: "2580", ...over }, { "x-forwarded-for": "10.2.0.1" });
    expect((await reset({ code: "000000" })).json().error).toBe("CODE_INVALID");
    expect((await reset({ pin: "1111", pin2: "1111" })).json().error).toBe("WEAK_PIN");
    const r = await reset({});
    expect(r.statusCode).toBe(200); expect(String(r.headers["set-cookie"])).toMatch(/otc=.+Max-Age=15552000/);
    expect((await A.req("GET", "/api/my")).status).toBe(401); // the old device is signed out
    expect((await login("012 345 111", "4827")).statusCode).toBe(401);
    A = await device("012 345 111", "2580");
    expect((await reset({})).json().error).toBe("CODE_INVALID"); // used
    const logged = await sql`select 1 from audit_log where new_data::text like ${"%" + code + "%"}`;
    expect(logged.length).toBe(0);
    expect((await sql`select new_data from audit_log where action = 'customer.pin_reset' order by id desc limit 1`)[0]!.new_data).toEqual({ via: "bot" });
    // the bot's button (and the old keyboards' label) sends a code too — into that chat only
    for (const text of [CUSTOMER_MENU.password, CUSTOMER_MENU_OLD.password]) {
      resetRateLimits();
      const m = (await internal("tg-text", { chat_id: 950001, tg_user: 950001, text, subscriber_id: 501 })).json();
      expect(m.text).toMatch(/^🔑 លេខកូដប្ដូរលេខសម្ងាត់៖ \d{6}\n/);
    }
    // the shop: Admin / GM (customer.manage) get a code to read out — technicians never
    const cust = (await custOf("+85512345111")).id;
    expect((await kim.req("POST", `/api/customers/${cust}/pin-code`)).status).toBe(403);
    const sc = (await admin.req("POST", `/api/customers/${cust}/pin-code`)).json;
    expect(sc).toMatchObject({ code: expect.stringMatching(/^\d{6}$/), minutes: 30 });
    await sql`delete from customer_login_guards`; // count this code's tries from zero
    for (let i = 1; i <= 5; i++) await pub("POST", "/api/public/pin-reset", { phone: "012 345 111", code: "123123", pin: "3690", pin2: "3690" }, { "x-forwarded-for": `10.3.0.${i}` });
    await sql`update customer_login_guards set locked_until = null`;
    expect((await pub("POST", "/api/public/pin-reset", { phone: "012 345 111", code: sc.code, pin: "3690", pin2: "3690" }, { "x-forwarded-for": "10.3.0.9" })).json().error).toBe("CODE_INVALID"); // 5 tries: dead
    const sc2 = (await admin.req("POST", `/api/customers/${cust}/pin-code`)).json;
    expect((await pub("POST", "/api/public/pin-reset", { phone: "012 345 111", code: sc2.code, pin: "3690", pin2: "3690" }, { "x-forwarded-for": "10.3.0.10" })).statusCode).toBe(200);
    A = await device("012 345 111", "3690");
    expect((await sql`select new_data from audit_log where action = 'customer.pin_code' order by id desc limit 1`)[0]!.new_data).toEqual({ via: "staff" });
  });

  it("a known number: its account sees only the new booking until the number is verified (the staff confirm), then the whole history; the number cannot change here", async () => {
    const custK = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "អតិថិជន ចាស់", phones: ["012777000"], zone: "inside" })).json.id;
    const start = await at(4, "15:00");
    staffK = (await admin.req("POST", "/api/bookings", { customer_id: custK, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់", zone: "inside", ...span(start, 60) })).json.id;
    const k = await book("012 777 000", "មិនមែនម្ចាស់", 3, "09:00");
    bkK = k.id;
    const html = (await page(`/book/done/${k.ref}`)).body;
    expect(html).toContain('id="a-pin"'); expect(html).not.toContain('id="a-name"'); expect(html).not.toContain("អតិថិជន ចាស់");
    const K = client(app);
    expect((await account(K, k.ref, { phone: "012 999 999" })).json.error).toBe("PHONE_LOCKED");
    expect((await account(K, k.ref, { phone: "012 777 000", name: "ឈ្មោះថ្មី" })).status).toBe(200);
    const c = await custOf("+85512777000");
    expect(c.name).toBe("អតិថិជន ចាស់"); expect(c.pin_history_from).not.toBeNull(); // the record is not touched; history hidden
    const ids = async () => { const h = (await K.req("GET", "/api/my")).json; return [...h.upcoming, ...h.past].map((x: any) => x.id).sort(); };
    expect(await ids()).toEqual([bkK]);
    expect((await K.req("GET", `/api/my/bookings/${staffK}`)).status).toBe(404);
    await confirm(bkK);
    expect(await ids()).toEqual([bkK, staffK].sort());
  });

  it("IDOR: another customer's booking is «not found» everywhere (read, page, cancel, rate, move)", async () => {
    const K = await device("012 777 000", "4827");
    expect((await K.req("GET", `/api/my/bookings/${bkA}`)).status).toBe(404);
    expect((await page(`/my/b/${bkA}`, { cookie: K.cookie! })).statusCode).toBe(404);
    expect((await K.req("POST", `/api/my/bookings/${bkA}/cancel`, { reason: "សាកល្បង" })).status).toBe(404);
    expect((await K.req("POST", `/api/my/bookings/${bkA}/rating`, { stars: 1 })).status).toBe(404);
    expect((await K.req("GET", `/api/my/bookings/${bkA}/slots`)).status).toBe(404);
    expect((await A.req("GET", `/api/my/bookings/${bkK}`)).status).toBe(404);
    expect((await pub("GET", `/api/my/bookings/${bkA}`)).statusCode).toBe(401);
  });

  it("skip: the booking stands without an account and the page offers it again; after 7 days the page offers nothing", async () => {
    const g = await book("012 456 222", "Guest", 5, "13:00");
    const html = (await page(`/book/done/${g.ref}`)).body;
    expect(html).toContain('id="a-skip"'); expect(html).toMatch(/id="a-open" hidden/);
    expect((await sql`select status from bookings where id = ${g.id}`)[0]!.status).toBe("new");
    const track = (await pub("GET", `/api/public/track/${g.ref}`)).json();
    expect(track.state).toBe("pending"); expect(track.html).toContain("បានទទួល"); expect(JSON.stringify(track)).not.toContain("Guest");
    await sql`update bookings set created_at = now() - interval '8 days' where id = ${g.id}`;
    expect((await page(`/book/done/${g.ref}`)).body).not.toContain('id="acct"');
    expect((await account(client(app), g.ref, { phone: "012 456 222" })).status).toBe(404);
  });

  it("change PIN (the current one first) ends the other sessions; cancel only new / assigned; rating once done (staff see it); «sign out everywhere»", async () => {
    const other = await device("012 345 111", "3690");
    expect((await A.req("POST", "/api/my/pin", { current: "0000", next: "1470", next2: "1470" })).json.error).toBe("WRONG_PIN");
    expect((await A.req("POST", "/api/my/pin", { current: "3690", next: "1470", next2: "1407" })).json.error).toBe("PIN_MISMATCH");
    expect((await A.req("POST", "/api/my/pin", { current: "3690", next: "1470", next2: "1470" })).status).toBe(200);
    expect((await other.req("GET", "/api/my")).status).toBe(401); expect((await A.req("GET", "/api/my")).status).toBe(200);
    expect((await A.req("POST", `/api/my/bookings/${bkA}/rating`, { stars: 5 })).json.error).toBe("NOT_DONE");
    await sql`update bookings set status = 'en_route' where id = ${bkA}`;
    expect((await A.req("GET", "/api/my")).json.upcoming[0]).toMatchObject({ id: bkA, can_cancel: false });
    expect((await A.req("POST", `/api/my/bookings/${bkA}/cancel`, { reason: "មិនចាំបាច់" })).json.error).toBe("BOOKING_NOT_CANCELLABLE");
    for (const st of ["on_site", "working", "work_done"]) await sql`update bookings set status = ${st}::booking_status where id = ${bkA}`;
    const d = (await A.req("GET", `/api/my/bookings/${bkA}`)).json;
    expect(d.track.steps.filter((x: any) => x.done).map((x: any) => x.key)).toEqual(["received", "assigned", "on_the_way", "arrived", "working", "done"]);
    expect(d.can_rate).toBe(true);
    expect((await A.req("POST", `/api/my/bookings/${bkA}/rating`, { stars: 6 })).status).toBe(400);
    expect((await A.req("POST", `/api/my/bookings/${bkA}/rating`, { stars: 4, comment: "ល្អណាស់" })).json).toEqual({ ok: true });
    expect((await admin.req("GET", `/api/bookings/${bkA}`)).json.rating).toMatchObject({ stars: 4, comment: "ល្អណាស់" });
    expect((await page(`/my/b/${bkA}`, { cookie: A.cookie! })).body).toContain('data-stars="4"');
    expect((await A.req("POST", "/api/my/logout-all", {})).status).toBe(200);
    expect((await A.req("GET", "/api/my")).status).toBe(401);
    expect((await sql`select count(*)::int as n from customer_sessions where customer_id = ${(await custOf("+85512345111")).id}`)[0]!.n).toBe(0);
  });

  it("book again fills the place of the customer's own earlier booking only; a form from another site is refused; no message ever carries a password", async () => {
    const B = await device("012 345 111", "1470");
    expect((await page(`/book?items=${SVC}:1&from=${bkA}`, { cookie: B.cookie! })).body).toContain('data-addr="ផ្ទះ 9 ផ្លូវ 271"');
    const K = await device("012 777 000", "4827");
    expect((await page(`/book?items=${SVC}:1&from=${bkA}`, { cookie: K.cookie! })).body).not.toContain("data-addr=");
    expect((await pub("POST", "/api/public/login", { phone: "012 345 111", pin: "1470" }, { origin: "https://evil.example" })).statusCode).toBe(403);
    expect((await pub("POST", "/api/public/login", { phone: "012 345 111", pin: "1470" }, { origin: "https://oneteam.test" })).statusCode).toBe(200);
    expect(hubCalls.some((c) => /ពាក្យសម្ងាត់/.test(String(c.body?.text ?? "")))).toBe(false);
    expect((await sql`select 1 from telegram_outbox where text like '%ពាក្យសម្ងាត់%'`).length).toBe(0);
  });
});
