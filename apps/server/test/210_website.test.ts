// Customer website + bot — final combined brief (D-106…) and the CEO decisions. Tests first:
// routing + privacy back · catalog (who edits, Excel preview / apply / never delete, audit old → new) · home category tiles + item
// lines + quantity, unpriced items still bookable, quote-only items to the quote screen · slots (booking hours, lunch, last start,
// R1–R5) + hold + race · the one-tap link (website token, Mini App, signed in) · single-use token · confirm (job length) / decline
// · unanswered bookings (30 / 60 min, expired) · quote with photos (metadata stripped) · customer login (rules, every lock step,
// unlock paths, reset only from the bot into the linked chat, no enumeration, sessions end, /app closed) · customer home (own
// data, IDOR, notification settings) · the customer bot keyboard (each button), share-my-phone, location · messages ≤ 4 lines ·
// tracking messages (reminder the day before 17:00–20:00, on the way, done) · Settings → Website (hours, promotion gap) ·
// D-119 night rule (timers 08:00–20:00, «we confirm at 8 am», silent staff alert) · D-120 test phones (CEO only, hidden, 24 h).
// The Telegram side (hub: consent, contact, 🔕 menu, promotions) is in 40_hub_telegram; here the hub is a stub.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CUSTOMER_MENU, customerText, NIGHT_CONFIRM, SITE_CONSENT_VERSION, WEB_TIMER_HOURS } from "@sms/shared";
import { client, loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { clock } from "../src/lib/clock.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { readXlsx, writeXlsx } from "../src/lib/xlsx.js";
import { seedWebCatalog } from "../src/services/catalog.js";
import { customerNotices } from "../src/services/customer-notify.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { formToken } from "../src/services/site.js";
import { flushOutbox } from "../src/services/telegram.js";
import { cancelOldTests } from "../src/services/test-mode.js";
import { webBookingAlerts, webLimits } from "../src/services/web-booking.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, cfo: Client, admin: Client, gm: Client, kim: Client, ceoB: Client;
const ID: Record<string, string> = {}; // catalog ids by code
let custK: string, custB: string;
const KEY = "key-oneteam-0123456789abcdef";
const CHAT = { admin: 920004, gm: 920003 };
const SUB = { a: 71, b: 72, c: 73, mini: 81 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const hubCalls: { path: string; body: any }[] = [];
const toldBodies = (sub: number) => hubCalls.filter((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === sub).map((c) => c.body);
const told = (sub: number) => toldBodies(sub).map((b) => String(b.text));
const prefs = new Map<number, { service: boolean; promo: boolean }>();
let promos: { text: string; valid_until: string }[] = [];

const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const pub = (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const internal = (path: string, body: unknown) => app.inject({ method: "POST", url: `/internal/${path}`, headers: { "x-hub-key": KEY, "content-type": "application/json" }, payload: JSON.stringify(body) });
const oldToken = () => formToken(Date.now() - 60_000);
const code = async (r: Promise<{ statusCode: number; json: () => any }>) => { const x = await r; return [x.statusCode, x.json()?.error]; };

type Slot = { time: string; at: string; free: boolean };
type Day = { date: string; open: boolean; slots: Slot[] };
const ac = () => `${ID["AC-CLEAN"]}:1`;
const days = async (items = ac()): Promise<Day[]> => (await pub("GET", `/api/public/slots?items=${encodeURIComponent(items)}`)).json().days;
const slotOf = async (i: number, time: string, items = ac()) => (await days(items))[i]!.slots.find((x) => x.time === time)!;
const free = (d: Day, ...times: string[]) => times.map((t) => d.slots.find((x) => x.time === t)?.free ?? null);
const book = (at: string, over: Record<string, unknown> = {}) => pub("POST", "/api/public/bookings",
  { items: ac(), at, address: "ផ្ទះ 12 ផ្លូវ 271", name: "សុខ ដារ៉ា", phone: "12 345 678", note: "ជាន់ទី ២", consent: true, ts: oldToken(), ...over });
const quote = (over: Record<string, unknown> = {}) => pub("POST", "/api/public/quotes",
  { category: "construction", description: "ចង់ធ្វើពិដានបន្ទប់ទទួលភ្ញៀវ 4×5 ម៉ែត្រ", photos: [], name: "ចាន់ ថា", phone: "+855 11 222 333", location: "សង្កាត់ទួលគោក", consent: true, ts: oldToken(), ...over });
async function staffJob(at: string, crew: string[] = [], customer = custK): Promise<string> {
  const r = await admin.req("POST", "/api/bookings", { customer_id: customer, type: "A", category: "mep", service_text: "ជួសជុលម៉ាស៊ីនត្រជាក់", zone: "inside", scheduled_at: at });
  expect(r.status).toBe(200);
  if (crew.length) expect((await gm.req("POST", `/api/bookings/${r.json.id}/assign`, { lead: crew[0], assistants: crew.slice(1) })).status).toBe(200);
  return r.json.id;
}
const leave = async (who: Client, date: string) => {
  const id = (await who.req("POST", "/api/leave", { kind: "leave", date_from: date, date_to: date, part: "full", reason: "ទៅពេទ្យ" })).json.id;
  expect((await gm.req("POST", `/api/leave/${id}/approve`, {})).json.status).toBe("approved");
};
const bookingOf = async (ref: string) => (await sql<Record<string, any>[]>`select b.*, c.name as cname, c.phones, c.consent_at, c.consent_version, c.consent_source, c.origin as corigin, c.tg_subscriber_id::text as csub
  from bookings b join customers c on c.id = b.customer_id where b.web_ref = ${ref}`)[0]!;
const requestOf = async (bookingId: string, kind = "booking") => (await sql<Record<string, any>[]>`select * from service_requests where booking_id = ${bookingId} and kind = ${kind} order by created_at desc limit 1`)[0]!;
const linkToken = async (ref: string) => /start=(b-[A-Za-z0-9_-]{20})"/.exec((await page(`/book/done/${ref}`)).body)?.[1] ?? null;
/** the password a bot message carries («🔑 ពាក្យសម្ងាត់៖ 1234» or «🔑 ពាក្យសម្ងាត់ថ្មី៖ 1234») */
const pwIn = (text: unknown): string | null => /ពាក្យសម្ងាត់(?:ថ្មី)?៖ (\d{4})/.exec(String(text ?? ""))?.[1] ?? null;
let pwA = ""; // customer A's first password — set when A's chat is linked
const tryLogin = (phone: string, password: string) => pub("POST", "/api/public/login", { phone, password });
async function signIn(phone: string, password: string): Promise<Client> {
  const c = client(app);
  await c.req("POST", "/api/public/login", { phone, password });
  return c;
}
const counts = async () => (await sql`select (select count(*) from customers)::int as c, (select count(*) from bookings)::int as b, (select count(*) from service_requests)::int as r`)[0];
const lines4 = (t: string) => t.split("\n").length <= 4;

// photos that carry private metadata (camera position, comments) — the server must store them without it
const seg = (marker: number, body: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, body]); };
const SCAN = Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  seg(0xe1, Buffer.from("Exif\0\0GPS-SECRET-11.5564,104.9282", "latin1")), seg(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0XMP-SECRET", "latin1")),
  seg(0xed, Buffer.from("Photoshop 3.0\0IPTC-SECRET", "latin1")), seg(0xfe, Buffer.from("COMMENT-SECRET", "latin1")), seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), SCAN, Buffer.from([0xff, 0xd9])]).toString("base64");
const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, "latin1"), data, Buffer.alloc(4, 7)]); };
const png = Buffer.from(PNG, "base64");
const PNG_META = Buffer.concat([png.subarray(0, 33), chunk("tEXt", Buffer.from("Comment\0PNG-TEXT-SECRET", "latin1")), chunk("eXIf", Buffer.from("PNG-EXIF-SECRET", "latin1")), png.subarray(33)]).toString("base64");

beforeAll(async () => {
  await resetDb(); s = await seed();
  // a tiny "web build" so the routing of the staff app under /app can be checked
  const web = mkdtempSync(join(tmpdir(), "web-"));
  mkdirSync(join(web, "assets"));
  writeFileSync(join(web, "index.html"), "<!doctype html><title>SPA-INDEX</title>");
  writeFileSync(join(web, "assets", "app.js"), "console.log('app')");
  config.webDist = web;
  config.publicUrl = "https://oneteam.test"; config.shop.hubKey = KEY; config.shop.hubUrl = "http://hub"; config.shop.features = "website,subscribe,reminders";
  setHubTransport(async (method, path, body) => {
    hubCalls.push({ path, body });
    const b = (body ?? {}) as any;
    if (path === "/internal/bot") return { status: 200, json: { username: "Oneteam_app_bot" } };
    if (path === "/internal/tg-verify") {
      const who = ({ "mini-a": { tg_user: 501, subscriber_id: SUB.a, first_name: "Sok" }, "mini-b": { tg_user: 502, subscriber_id: SUB.b, first_name: "Bopha" },
        "mini-c": { tg_user: 503, subscriber_id: SUB.c, first_name: "Chan" }, "mini-none": { tg_user: 504, subscriber_id: null, first_name: "New" } } as Record<string, object>)[String(b.init_data)];
      return { status: 200, json: who ? { ok: true, ...who } : { ok: false, error: "BAD_SIGNATURE" } };
    }
    if (path === "/internal/web-subscribe") {
      const sub = ({ "mini-new": SUB.mini, "mini-a": SUB.a } as Record<string, number>)[String(b.init_data)];
      return { status: 200, json: sub ? { ok: true, subscriber_id: sub, tg_user: 600 + sub, first_name: "Mini" } : { ok: false, error: "BAD_SIGNATURE" } };
    }
    if (path.startsWith("/internal/subscriber-prefs")) {
      if (method === "GET") { const id = Number(new URLSearchParams(path.split("?")[1]).get("subscriber_id")); const p = prefs.get(id) ?? { service: true, promo: true }; return { status: 200, json: { ok: true, ...p } }; }
      const p = { service: !!b.service, promo: !!b.service && !!b.promo }; prefs.set(b.subscriber_id, p); return { status: 200, json: { ok: true, ...p } };
    }
    if (path === "/internal/promotions") return { status: 200, json: promos };
    if (path === "/internal/notify-subscriber" && b.subscriber_id === 99) return { status: 200, json: { ok: false, error: "NOT_SUBSCRIBED" } }; // stopped the bot
    return { status: 200, json: { ok: true } };
  });
  resetBotCache();
  app = await makeApp();
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password) values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${await hashPassword(PW)}, false)`;
  await sql`update users set is_active = false where username = 'newbie'`; // two technicians work: Kim and Dara
  await sql`update users set telegram_chat_id = ${CHAT.admin}, telegram_user_id = ${CHAT.admin} where id = ${s.users.admin!}`;
  await sql`update users set telegram_chat_id = ${CHAT.gm}, telegram_user_id = ${CHAT.gm} where id = ${s.users.gm01!}`;
  ceo = await loginAs(app, "ceo"); cfo = await loginAs(app, "cfo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  // the sample items WITH demo prices (test data only — the live shop gets none, CEO D-106) + items that must never show
  expect(await seedWebCatalog(s.a, { prices: true })).toEqual({ added: 13, updated: 0 });
  for (const r of await sql<{ id: string; code: string }[]>`select id, code from catalog_items where company_id = ${s.a}`) ID[r.code] = r.id;
  ID.NOPRICE = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់ធំ", kind: "service", category: "mep", unit: "គ្រឿង", sell_price: 3333, code: "AC-BIG", web_category: "ac" })).json.id; // no «from» price
  ID.PRODUCT = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោ PVC", kind: "product", category: "mep", unit: "m", sell_price: 250 })).json.id;
  ID.OFF = (await ceo.req("POST", "/api/catalog", { name_km: "សេវាចាស់", kind: "service", category: "mep", unit: "unit", sell_price: 100, web_category: "ac", from_price: 100 })).json.id;
  await ceo.req("POST", `/api/catalog/${ID.OFF}/active`, { active: false });
  ID.HIDDEN = (await ceo.req("POST", "/api/catalog", { name_km: "សេវាខាងក្នុង", kind: "service", category: "mep", unit: "unit", sell_price: 100, web_category: "ac", show_on_website: false })).json.id;
  await ceoB.req("POST", "/api/catalog", { name_km: "សេវារបស់ក្រុមហ៊ុន B", kind: "service", category: "mep", unit: "unit", sell_price: 100, web_category: "ac", from_price: 500 });
  custK = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន ចាស់", phones: ["012777888"], zone: "inside" })).json.id;
  custB = (await ceo.req("POST", "/api/customers", { name: "បុប្ផា", phones: ["012666555"], zone: "inside" })).json.id;
  await sql`update customers set tg_subscriber_id = ${SUB.b} where id = ${custB}`;
  expect((await ceo.req("PATCH", "/api/settings/company", { work_days: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(200); // every day is a working day in these tests
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("routing: the customer site at \"/\", the staff app under /app, public privacy / terms", () => {
  it("\"/\" always shows the customer site — also with a staff session; /site redirects to /; old app paths move under /app", async () => {
    const anon = await page("/");
    expect(anon.statusCode).toBe(200); expect(anon.body).toContain("ផ្ទះអ្នកត្រូវការជួសជុលអ្វី?"); expect(anon.body).toContain('<html lang="km">');
    const staff = await page("/", { cookie: ceo.cookie! });
    expect(staff.body).toContain("ផ្ទះអ្នកត្រូវការជួសជុលអ្វី?"); expect(staff.body).not.toContain("SPA-INDEX");
    for (const u of ["/site", "/site/thanks"]) { const r = await page(u); expect(r.statusCode).toBe(301); expect(r.headers.location).toBe("/"); }
    for (const [from, to] of [["/login", "/app/login"], ["/bookings/abc?x=1", "/app/bookings/abc?x=1"], ["/tg?to=%2Fleave", "/app/tg?to=%2Fleave"], ["/app", "/app/"]]) {
      const r = await page(from!); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(to);
    }
  });

  it("/privacy and /terms are public pages of the site: no login, back = the previous page (else \"/\"), one language per page — also for a signed-in customer", async () => {
    for (const u of ["/privacy", "/terms"]) {
      const r = await page(u);
      expect(r.statusCode).toBe(200); expect(r.body).toContain('data-page="legal"'); expect(r.body).toContain('data-legal-back'); expect(r.body).toMatch(/class="back" href="\/"/);
      expect(r.body).toContain("One Team Engineering"); expect(r.body).not.toContain("SPA-INDEX"); expect(r.body).not.toMatch(/Terms of Service|Privacy Policy/);
      const en = await page(`${u}?lang=en`);
      expect(en.body).toMatch(/Terms of Service|Privacy Policy/); expect(en.body.split("<footer")[0]).not.toMatch(/[ក-៿]{4}/);
    }
    await page("/?lang=km");
    expect((await page("/")).body).toContain('href="/privacy"');
    config.shop.features = "subscribe";
    expect((await page("/privacy")).headers.location).toBe("/app/privacy"); // without the module: the app's own page
    config.shop.features = "website,subscribe,reminders";
  });

  it("the staff app is served under /app/ only; the old root service worker retires itself; module off → \"/\" goes to the app", async () => {
    expect((await page("/app/")).body).toContain("SPA-INDEX");
    expect((await page("/app/bookings/5")).body).toContain("SPA-INDEX");
    expect((await page("/app/assets/missing.js")).statusCode).toBe(404);
    expect((await page("/nothing-here")).statusCode).toBe(404);
    expect((await page("/sw.js")).body).toContain("unregister");
    config.shop.features = "subscribe";
    const r = await page("/");
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/app/");
    for (const u of ["/book", "/quote", "/my", "/robots.txt", `/api/public/slots?items=${ac()}`]) expect((await page(u)).statusCode).toBe(404);
    config.shop.features = "website,subscribe,reminders";
  });
});

describe("catalog: CEO / CFO / Admin / GM edit; Excel template → preview → apply (by code, never delete); audit old → new", () => {
  it("who may edit: technicians never; the CFO now may (D-106); another company's item is not found; codes are unique", async () => {
    const body = { id: ID["AC-CLEAN"], name_km: "លាងម៉ាស៊ីនត្រជាក់", name_en: "AC cleaning", kind: "service", category: "mep", unit: "គ្រឿង", sell_price: 1500, code: "AC-CLEAN", web_category: "ac", from_price: 1500 };
    expect((await kim.req("POST", "/api/catalog", body)).status).toBe(403);
    expect((await kim.req("POST", `/api/catalog/${ID["AC-CLEAN"]}/active`, { active: false })).status).toBe(403);
    for (const who of [ceo, cfo, admin, gm]) expect((await who.req("POST", "/api/catalog", body)).status).toBe(200);
    expect((await ceoB.req("POST", "/api/catalog", body)).status).toBe(404);
    expect((await ceo.req("POST", "/api/catalog", { ...body, id: ID["AC-REPAIR"], name_km: "ជួសជុលម៉ាស៊ីនត្រជាក់" })).json).toMatchObject({ error: "CODE_TAKEN" });
    expect((await kim.req("GET", "/api/catalog/meta")).json.can_edit).toBe(false);
    expect((await cfo.req("GET", "/api/catalog/meta")).json.can_edit).toBe(true);
  });

  it("every change is in the audit log with old → new of exactly the changed fields; the list shows who changed it last", async () => {
    expect((await gm.req("POST", "/api/catalog", { id: ID["EL-CHECK"], name_km: "ពិនិត្យប្រព័ន្ធភ្លើង", name_en: "Electrical inspection", kind: "service", category: "mep", unit: "ផ្ទះ", sell_price: 2000, code: "EL-CHECK", web_category: "electric", from_price: 2500, duration_min: 90 })).status).toBe(200);
    const a = (await sql<{ old_data: any; new_data: any; user_id: string }[]>`select old_data, new_data, user_id from audit_log where action = 'catalog.upsert' and row_id = ${ID["EL-CHECK"]!} order by id desc limit 1`)[0]!;
    expect(a).toMatchObject({ user_id: s.users.gm01, old_data: { from_price: 2000, duration_min: 120 }, new_data: { from_price: 2500, duration_min: 90 } });
    expect(Object.keys(a.new_data).sort()).toEqual(["duration_min", "from_price"]);
    const meta = (await ceo.req("GET", "/api/catalog/meta")).json;
    expect(meta.last.name).toBe("GM A"); expect(new Date(meta.last.at).getTime()).toBeGreaterThan(Date.now() - 60_000);
    // an edited sample is no longer «sample» (the shop confirmed it)
    expect((await ceo.req("GET", "/api/catalog")).json.find((i: any) => i.id === ID["EL-CHECK"]).is_sample).toBe(false);
    expect((await ceo.req("GET", "/api/catalog")).json.find((i: any) => i.id === ID["WT-PIPE"]).is_sample).toBe(true);
  });

  it("Excel: the template is the services as they are now (real .xlsx); technicians cannot download it", async () => {
    expect((await page("/api/catalog/template.xlsx", { cookie: kim.cookie! })).statusCode).toBe(403);
    const r = await app.inject({ method: "GET", url: "/api/catalog/template.xlsx", headers: { cookie: ceo.cookie! } });
    expect(r.statusCode).toBe(200); expect(String(r.headers["content-type"])).toContain("spreadsheetml"); expect(String(r.headers["content-disposition"])).toContain(".xlsx");
    const rows = readXlsx(r.rawPayload);
    expect(rows[0]).toEqual(["កូដ", "ប្រភេទ", "ឈ្មោះ (ខ្មែរ)", "ឈ្មោះ (អង់គ្លេស)", "ឯកតា", "តម្លៃចាប់ពី ($)", "រយៈពេល (នាទី)", "បង្ហាញលើគេហទំព័រ", "ស្នើសុំតម្លៃប៉ុណ្ណោះ", "សកម្ម"]);
    const clean = rows.find((x) => x[0] === "AC-CLEAN")!;
    expect(clean).toEqual(["AC-CLEAN", "ម៉ាស៊ីនត្រជាក់", "លាងម៉ាស៊ីនត្រជាក់", "AC cleaning", "គ្រឿង", "15", "120", "បាទ", "ទេ", "បាទ"]);
    expect(rows.some((x) => x[2] === "ទុយោ PVC")).toBe(false); // services only
  });

  it("Excel import: preview shows new / changed / errors and writes nothing; apply is refused while errors remain; a fixed file is applied; rows not in the file stay; «active = no» switches off (never deleted); audited", async () => {
    const head = ["code", "category", "name_km", "name_en", "unit", "from_price", "duration_min", "show_on_website", "quote_only", "active"];
    const bad = writeXlsx("x", [head,
      ["AC-CLEAN", "ac", "លាងម៉ាស៊ីនត្រជាក់", "AC cleaning", "គ្រឿង", "16.50", "120", "yes", "no", "yes"], // changed price
      ["WT-HEATER", "ទឹក", "ដំឡើងម៉ាស៊ីនទឹកក្ដៅ", "Water heater", "គ្រឿង", "", "180", "បាទ", "ទេ", "បាទ"], // new, no price
      ["CC-REPAIR", "cctv", "ជួសជុលកាមេរ៉ា", "", "គ្រឿង", "15", "120", "yes", "no", "no"],         // switched off
      ["bad code!", "space", "", "", "", "-3", "5", "maybe", "", ""]]);                                 // every error
    const n0 = (await sql`select count(*)::int as n from catalog_items where company_id = ${s.a}`)[0]!.n;
    expect((await kim.req("POST", "/api/catalog/import/preview", { data: bad.toString("base64") })).status).toBe(403);
    const p = (await admin.req("POST", "/api/catalog/import/preview", { data: bad.toString("base64") })).json;
    expect(p.counts).toEqual({ new: 1, changed: 2, same: 0, error: 1 });
    expect(p.rows.find((r: any) => r.code === "AC-CLEAN").changes).toEqual({ from_price: [1500, 1650] });
    expect(p.rows.find((r: any) => r.row === 5).errors.sort()).toEqual(["CATEGORY", "CODE", "DURATION", "NAME", "PRICE", "YES_NO"].sort());
    expect((await sql`select count(*)::int as n from catalog_items where company_id = ${s.a}`)[0]!.n).toBe(n0); // the preview wrote nothing
    expect((await admin.req("POST", "/api/catalog/import/apply", { data: bad.toString("base64") })).json.error).toBe("IMPORT_HAS_ERRORS");
    const good = Buffer.from([head.join(","), "AC-CLEAN,ac,លាងម៉ាស៊ីនត្រជាក់,AC cleaning,គ្រឿង,16.50,120,yes,no,yes", "WT-HEATER,ទឹក,ដំឡើងម៉ាស៊ីនទឹកក្ដៅ,Water heater,គ្រឿង,,180,បាទ,ទេ,បាទ",
      "CC-REPAIR,cctv,ជួសជុលកាមេរ៉ា,,គ្រឿង,15,120,yes,no,no"].join("\n")); // CSV works too
    expect((await cfo.req("POST", "/api/catalog/import/apply", { data: good.toString("base64") })).json).toMatchObject({ ok: true, counts: { new: 1, changed: 2 } });
    const after = (await ceo.req("GET", "/api/catalog")).json as any[];
    expect(after.find((i) => i.code === "AC-CLEAN").from_price).toBe(1650);
    expect(after.find((i) => i.code === "WT-HEATER")).toMatchObject({ kind: "service", category: "mep", web_category: "water", from_price: null, duration_min: 180, show_on_website: true, is_active: true });
    expect(after.find((i) => i.code === "CC-REPAIR").is_active).toBe(false); // switched off, not deleted
    expect(after).toHaveLength(n0 + 1); // nothing deleted; items not in the file untouched
    expect(after.find((i) => i.code === "EL-CHECK").from_price).toBe(2500);
    const log = await sql<{ new_data: any; old_data: any; user_id: string }[]>`select new_data, old_data, user_id from audit_log where action = 'catalog.import' order by id`;
    const cfoId = (await sql<{ id: string }[]>`select id from users where username = 'cfo'`)[0]!.id;
    expect(log).toHaveLength(3); expect(log.every((l) => l.user_id === cfoId)).toBe(true);
    expect(log.find((l) => l.old_data?.from_price === 1500)!.new_data).toEqual({ from_price: 1650 });
    ID["WT-HEATER"] = after.find((i) => i.code === "WT-HEATER").id;
    // back to $15 for the rest of the suite; CC-REPAIR stays off
    await ceo.req("POST", "/api/catalog", { id: ID["AC-CLEAN"], name_km: "លាងម៉ាស៊ីនត្រជាក់", name_en: "AC cleaning", kind: "service", category: "mep", unit: "គ្រឿង", sell_price: 1500, code: "AC-CLEAN", web_category: "ac", from_price: 1500 });
  });

  it("the sample seed is idempotent; on the live shop it adds NO prices and matches existing items by name (no duplicates)", async () => {
    expect(await seedWebCatalog(s.a, { prices: true })).toEqual({ added: 0, updated: 0 });
    const b = s.b;
    await sql`insert into catalog_items (company_id, name_km, kind, category, unit, sell_price, code) values (${b}, 'ជួសជុលប្រព័ន្ធភ្លើង', 'service', 'mep', 'unit', 15000, 'S-001')`;
    expect(await seedWebCatalog(b, { prices: false })).toEqual({ added: 12, updated: 1 });
    const live = await sql<{ code: string; from_price: number | null; is_sample: boolean; name_km: string }[]>`select code, from_price, is_sample, name_km from catalog_items where company_id = ${b} and kind = 'service' and code is not null`;
    expect(live.every((i) => i.from_price === null)).toBe(true);
    expect(live.find((i) => i.code === "EL-REPAIR")).toMatchObject({ name_km: "ជួសជុលប្រព័ន្ធភ្លើង", is_sample: false }); // the shop's own item took the sample's place
  });
});

describe("home: category tiles → item dropdown + quantity (+ more lines); unpriced items still bookable (CEO); quote-only → quote screen", () => {
  it("tiles of the website categories, the item dropdown by category, the stepper and «add a service»; never the sell price, products, inactive, hidden or foreign items", async () => {
    const h = (await page("/")).body;
    for (const c of ["ម៉ាស៊ីនត្រជាក់", "ទឹក", "ភ្លើង", "កាមេរ៉ា CCTV", "សំណង់"]) expect(h).toContain(`<span class="tn">${c}</span>`);
    expect(h).toMatch(/data-cat="ac" aria-pressed="true"/);
    expect(h).toContain('<optgroup label="ម៉ាស៊ីនត្រជាក់">'); expect(h).toContain("លាងម៉ាស៊ីនត្រជាក់ · ចាប់ពី $15"); expect(h).toContain("ចង់ទិញម៉ាស៊ីនត្រជាក់ · ស្នើសុំតម្លៃ");
    expect(h).toContain('data-q="1"'); expect(h).toContain('data-maxq="20"'); expect(h).toContain("បន្ថែមសេវា");
    expect(h).toContain("តម្លៃប្រហែល ចាប់ពី $15"); expect(h).toContain(`href="/book?items=${ID["AC-CLEAN"]}:1"`);
    expect(h).toContain("លាងម៉ាស៊ីនត្រជាក់ធំ"); // no price → still offered
    for (const x of ["ទុយោ PVC", "សេវាចាស់", "សេវាខាងក្នុង", "ក្រុមហ៊ុន B", "ជួសជុលកាមេរ៉ា"]) expect(h).not.toContain(x); // CC-REPAIR was switched off by the import
    expect(h).not.toContain("$33.33"); expect(h).not.toContain("$2.50"); // never a sell price
  });

  it("an item without a «from» price is bookable and says «price confirmed on contact» (CEO); quote-only items go to the quote screen; older ?service= links still work", async () => {
    const h = (await page(`/?items=${ID.NOPRICE}:2`)).body;
    expect(h).toContain("តម្លៃបញ្ជាក់ពេលទាក់ទង"); expect(h).toContain(`href="/book?items=${ID.NOPRICE}:2"`);
    const b = await page(`/book?items=${ID.NOPRICE}:2`);
    expect(b.statusCode).toBe(200); expect(b.body).toContain("តម្លៃបញ្ជាក់ពេលទាក់ទង"); expect(b.body).toContain("លាងម៉ាស៊ីនត្រជាក់ធំ ×2");
    expect((await page(`/book?items=${ID["AC-BUY"]}:1`)).headers.location).toBe(`/quote?items=${ID["AC-BUY"]}:1`);
    expect((await page(`/?items=${ID["CN-QUOTE"]}:1`)).body).toContain(`href="/quote?items=${ID["CN-QUOTE"]}:1"`);
    expect((await page(`/book?service=${ID["AC-CLEAN"]}`)).headers.location).toBe(`/book?items=${ID["AC-CLEAN"]}:1`);
    for (const x of [ID.PRODUCT, ID.OFF, ID.HIDDEN]) expect((await page(`/book?items=${x}:1`)).headers.location).toBe("/");
    expect(await code(pub("GET", `/api/public/slots?items=${ID["AC-BUY"]}:1`))).toEqual([400, "QUOTE_ONLY"]);
    expect(await code(pub("GET", `/api/public/slots?items=${ID.HIDDEN}:1`))).toEqual([404, "SERVICE_NOT_BOOKABLE"]);
  });

  it("one language per page: Khmer by default, English with ?lang=en (remembered)", async () => {
    const km = (await page("/")).body;
    expect(km).toContain("កក់សេវា"); expect(km).toContain("ដំណើរការដោយ"); expect(km).not.toContain("Book a service"); expect(km).not.toContain("AC cleaning");
    const r = await page("/?lang=en");
    expect(String(r.headers["set-cookie"])).toContain("sl=en");
    expect(r.body).toContain("Book a service"); expect(r.body).toContain("AC cleaning · From $15"); expect(r.body).toContain("Air conditioner"); expect(r.body).toContain("Powered by");
    expect(r.body).not.toContain("កក់សេវា"); expect(r.body).not.toContain("ដំណើរការដោយ");
    await page("/?lang=km");
  });
});

describe("time slots: booking hours 08:00–17:00, lunch 12:00–13:00 blocked, last start = close − duration (CEO); only while a technician is free (R1–R5)", () => {
  it("7 days; a 2-hour job: 08 09 10 13 14 15; two lines (2 h + 2 h, one duration per line — not × quantity): 08 and 13; closed days have none; nothing in the past", async () => {
    const d = await days();
    expect(d).toHaveLength(7);
    expect(d[2]!.slots.map((x) => x.time)).toEqual(["08:00", "09:00", "10:00", "13:00", "14:00", "15:00"]);
    expect(d[2]!.slots.every((x) => x.free)).toBe(true);
    for (const x of d[0]!.slots) if (new Date(x.at).getTime() < Date.now() + 60 * 60_000) expect(x.free).toBe(false);
    const two = await days(`${ID["AC-CLEAN"]}:3,${ID["EL-REPAIR"]}:1`); // quantity 3 does not make it longer
    expect(two[2]!.slots.map((x) => x.time)).toEqual(["08:00", "13:00"]);
    await ceo.req("PATCH", "/api/settings/company", { holidays: [d[1]!.date] });
    expect((await days())[1]!.slots.every((x) => !x.free)).toBe(true);
    await ceo.req("PATCH", "/api/settings/company", { holidays: [] });
    expect((await page(`/book?items=${ac()}`)).body).toContain("ចាប់ពី $15 · ប្រហែល ២ ម៉ោង");
  });

  it("no overlap: a slot is offered while one technician is free for the whole job; jobs waiting for a technician take one each", async () => {
    const d = (await days())[2]!;
    const at = (t: string) => d.slots.find((x) => x.time === t)!.at;
    await staffJob(at("09:00"), [s.users.kim!]);            // Kim 09:00–11:00
    expect(free((await days())[2]!, "08:00", "09:00", "10:00", "13:00")).toEqual([true, true, true, true]);
    await staffJob(at("10:00"), [s.users.dara!]);           // Dara 10:00–12:00
    expect(free((await days())[2]!, "08:00", "09:00", "10:00", "13:00")).toEqual([true, false, false, true]);
    await staffJob(at("13:00"));                            // waits for a technician 13:00–15:00
    expect(free((await days())[2]!, "13:00", "14:00")).toEqual([true, true]);
    await staffJob(at("14:00"));                            // a second one 14:00–16:00
    expect(free((await days())[2]!, "13:00", "14:00", "15:00")).toEqual([false, false, true]);
  });

  it("leave / absence: a technician on approved leave is not counted", async () => {
    const d = (await days())[3]!;
    await leave(kim, d.date);
    await staffJob(d.slots.find((x) => x.time === "09:00")!.at, [s.users.dara!]);
    expect(free((await days())[3]!, "08:00", "09:00", "10:00", "13:00")).toEqual([false, false, false, true]);
  });
});

let ref1: string, bk1: string, n1: string, refA2: string, bkC: string;
describe("online booking: one tap = save + hold + consent + the bot link", () => {
  it("the button carries the consent; bad input is refused; nothing is saved", async () => {
    const dara = await loginAs(app, "dara");
    await leave(dara, (await days())[4]!.date); // day 4: only Kim works
    const at = (await slotOf(4, "13:00")).at;
    const n0 = await counts();
    expect(await code(book(at, { consent: false }))).toEqual([400, "CONSENT_REQUIRED"]);
    expect(await code(book(at, { phone: "12 34" }))).toEqual([400, "INVALID_PHONE"]);
    expect(await code(book(at, { name: " " }))).toEqual([400, "NAME_REQUIRED"]);
    expect(await code(book(at, { address: "" }))).toEqual([400, "ADDRESS_REQUIRED"]);
    expect(await code(book(at, { items: `${ID["AC-BUY"]}:1` }))).toEqual([400, "QUOTE_ONLY"]);
    expect(await code(book(at, { items: `${ID.PRODUCT}:1` }))).toEqual([404, "SERVICE_NOT_BOOKABLE"]);
    expect(await code(book(at, { ts: "1.aaaaaaaaaaaaaaaaaaaaaa" }))).toEqual([400, "FORM_EXPIRED"]);
    expect(await code(book(new Date(new Date(at).getTime() + 30 * 60_000).toISOString()))).toEqual([400, "SLOT_INVALID"]);
    expect(await code(book((await slotOf(4, "10:00")).at, { items: `${ID["AC-CLEAN"]}:1,${ID["EL-REPAIR"]}:1` }))).toEqual([400, "SLOT_INVALID"]); // 4 h from 10:00 would cross lunch
    expect((await book(at, { company_url: "http://spam.example" })).json()).toEqual({ ref: null });
    expect(await counts()).toEqual(n0);
  });

  it("two lines: saved «pending» with its lines, the sum of the line durations, the location with accuracy; consent kept (version, time, source); Admin + GM told with a map link; the answer carries the bot link", async () => {
    const s0 = await slotOf(4, "08:00", `${ID["AC-CLEAN"]}:2,${ID["EL-REPAIR"]}:1`);
    const r = await book(s0.at, { items: `${ID["AC-CLEAN"]}:2,${ID["EL-REPAIR"]}:1`, address: "", lat: 11.5564, lng: 104.9282, accuracy: 12.4 });
    expect(r.statusCode).toBe(200);
    const j = r.json() as { ref: string; number: string; linked: boolean; link: string };
    expect(j.number).toMatch(/^BK-\d{4}$/); expect(j.linked).toBe(false); expect(j.link).toMatch(/^https:\/\/t\.me\/Oneteam_app_bot\?start=b-[A-Za-z0-9_-]{20}$/);
    const b = await bookingOf(j.ref);
    ref1 = j.ref; bk1 = b.id; n1 = j.number;
    expect(b).toMatchObject({ status: "new", origin: "website", web_status: "pending", service_item_id: ID["AC-CLEAN"], service_text: "លាងម៉ាស៊ីនត្រជាក់ ×2 · ជួសជុលភ្លើង",
      lat: 11.5564, lng: 104.9282, loc_accuracy: 12, cname: "សុខ ដារ៉ា", phones: ["012345678"], corigin: "website", csub: null, consent_version: SITE_CONSENT_VERSION, consent_source: "web" });
    expect(b.web_lines.map((l: any) => [l.code, l.qty, l.minutes])).toEqual([["AC-CLEAN", 2, 120], ["EL-REPAIR", 1, 120]]);
    expect(new Date(b.ends_at).getTime() - new Date(b.scheduled_at).getTime()).toBe(240 * 60_000);
    const rq = await requestOf(b.id);
    expect(rq.meta.consent).toMatchObject({ version: SITE_CONSENT_VERSION, source: "web" }); expect(rq.meta.consent.at).toBeTruthy();
    expect((await sql`select new_data from audit_log where action = 'customer.consent' and row_id = ${b.customer_id}`)[0]!.new_data).toMatchObject({ version: SITE_CONSENT_VERSION, source: "web" });
    const note = (await sql<{ body: string }[]>`select body from notifications where kind = 'service.request' and user_id = ${s.users.admin!} order by id desc limit 1`)[0]!.body;
    expect(note).toContain("google.com/maps/search/?api=1&query=11.5564,104.9282"); expect(note).toContain("±12 m");
    expect((await sql`select 1 from telegram_outbox where chat_id = ${CHAT.gm} and text like ${"%" + j.number + "%"}`).length).toBe(1);
    // held: Kim is the only technician that day → 08:00–12:00 is gone
    expect(free((await days())[4]!, "08:00", "09:00", "10:00", "13:00")).toEqual([false, false, false, true]);
    expect(((await admin.req("GET", "/api/requests")).json as any[]).find((x) => x.booking_id === b.id)).toMatchObject({ web_status: "pending", lat: 11.5564, loc_accuracy: 12 });
  });

  it("race: two visitors send the last free slot at the same moment → exactly one booking", async () => {
    const at = (await slotOf(4, "13:00")).at;
    const [a, b] = await Promise.all([book(at, { phone: "011000001", name: "ភ្ញៀវ ក" }), book(at, { phone: "011000002", name: "ភ្ញៀវ ខ" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect((await sql`select count(*)::int as n from bookings where scheduled_at = ${at} and status <> 'cancelled'`)[0]!.n).toBe(1);
  });

  it("a known phone number books under the existing customer — that record is not touched", async () => {
    const r = await book((await slotOf(4, "15:00")).at, { phone: "012 777 888", name: "ឈ្មោះក្លែង" });
    expect(r.statusCode).toBe(200);
    const b = await bookingOf(r.json().ref);
    expect(b.customer_id).toBe(custK); expect(b.cname).toBe("អតិថិជន ចាស់"); expect(b.consent_at).toBeNull();
    expect((await requestOf(b.id)).name).toBe("ឈ្មោះក្លែង");
  });

  it("an item without a price books like any other (CEO); rate limit and the pending cap still hold", async () => {
    const r = await book((await slotOf(6, "08:00", `${ID.NOPRICE}:1`)).at, { items: `${ID.NOPRICE}:1`, phone: "011777000", name: "ភ្ញៀវ គ្មានតម្លៃ" });
    expect(r.statusCode).toBe(200);
    const d = (await days())[6]!;
    for (let i = 1; i < 5; i++) expect((await book(d.slots[i]!.at, { phone: `01155500${i}`, name: `ភ្ញៀវ ${i}` })).statusCode).toBe(200);
    expect(await code(book(d.slots[5]!.at, { phone: "011555006", name: "ភ្ញៀវ 6" }))).toEqual([429, "RATE_LIMITED"]);
    resetRateLimits();
    const waiting = (await sql`select count(*)::int as n from bookings where web_status = 'pending' and status <> 'cancelled'`)[0]!.n as number;
    webLimits.maxPending = waiting;
    expect(await code(book((await slotOf(5, "14:00")).at, { phone: "011888000", name: "ភ្ញៀវ ច្រើន" }))).toEqual([429, "TOO_MANY_PENDING"]);
    webLimits.maxPending = 30;
  });
});

describe("the Telegram link: website token (single use) · Mini App and signed in: linked at once", () => {
  it("the «sent» screen: number, status, lines, time — no personal data — and the bot link as a fallback button", async () => {
    const r = await page(`/book/done/${ref1}`);
    expect(r.body).toContain(`#${n1}`); expect(r.body).toContain("រង់ចាំបញ្ជាក់"); expect(r.body).toContain("លាងម៉ាស៊ីនត្រជាក់ ×2 · ជួសជុលភ្លើង"); expect(r.body).toContain("បើក Telegram");
    expect(r.body).toMatch(/href="https:\/\/t\.me\/Oneteam_app_bot\?start=b-[A-Za-z0-9_-]{20}"/); expect(r.body).toContain('data-state="pending"');
    expect(r.body).not.toContain("សុខ ដារ៉ា"); expect(r.body).not.toContain("012345678");
  });

  it("the token works once: «linked» + the first password in ONE message of at most 4 lines, the hint after it, the keyboard grid, the menu button; a second use is refused", async () => {
    const token = (await linkToken(ref1))!;
    const x = (await internal("customer-subscribed", { code: token, subscriber_id: SUB.a })).json();
    pwA = pwIn(x.text)!;
    expect(pwA).toMatch(/^\d{4}$/);
    expect(x.text).toBe(`✅ ភ្ជាប់រួចរាល់\nការកក់ #${n1} រង់ចាំបញ្ជាក់ (≤៣០ នាទី)\n🔑 ពាក្យសម្ងាត់៖ ${pwA}\nចូលដោយលេខទូរស័ព្ទ + ពាក្យសម្ងាត់នេះ`);
    expect(x.hint).toBe("កុំប្រើថ្ងៃកំណើត ឬលេខ៤ខ្ទង់ចុងទូរស័ព្ទ"); expect(x.menu_url).toBe("https://oneteam.test/");
    expect(x.keyboard).toEqual([[{ text: "📅 កក់សេវា", web_app: "https://oneteam.test/?book" }, { text: "📍 តាមដានការកក់", web_app: "https://oneteam.test/my" }],
      [{ text: "🎁 ប្រូម៉ូសិន" }, { text: "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី" }], [{ text: "🔕 ឈប់ទទួលដំណឹង" }]]);
    expect(Number((await bookingOf(ref1)).web_subscriber_id)).toBe(SUB.a); expect(Number((await bookingOf(ref1)).csub)).toBe(SUB.a);
    const again = (await internal("customer-subscribed", { code: token, subscriber_id: SUB.b })).json();
    expect(again).toMatchObject({ ok: false, error: "CODE_USED", text: customerText.linkUsed });
    expect((await internal("customer-subscribed", { code: "b-AAAAAAAAAAAAAAAAAAAA", subscriber_id: SUB.b })).json()).toMatchObject({ ok: false, error: "CODE_INVALID" });
    expect((await page(`/book/done/${ref1}`)).body).toContain("បានភ្ជាប់ Telegram");
  });

  it("inside Telegram (Mini App): the launch data links the booking at once — no link — and the bot sends «linked» + password with the grid", async () => {
    hubCalls.length = 0;
    const r = await book((await slotOf(5, "08:00")).at, { phone: "011999111", name: "ភ្ញៀវ Mini", init_data: "mini-new" });
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ linked: true, link: null });
    const b = await bookingOf(r.json().ref);
    expect(Number(b.web_subscriber_id)).toBe(SUB.mini); expect(b.consent_source).toBe("miniapp");
    expect(hubCalls.find((c) => c.path === "/internal/web-subscribe")!.body).toEqual({ init_data: "mini-new", source: "miniapp" });
    const m = toldBodies(SUB.mini)[0];
    expect(m.text).toMatch(new RegExp(`^✅ ភ្ជាប់រួចរាល់\\nការកក់ #${b.number} រង់ចាំបញ្ជាក់ \\(≤៣០ នាទី\\)\\n🔑 ពាក្យសម្ងាត់៖ \\d{4}\\nចូលដោយលេខទូរស័ព្ទ \\+ ពាក្យសម្ងាត់នេះ$`));
    expect(m.keyboard[2]).toEqual([{ text: "🔕 ឈប់ទទួលដំណឹង" }]); expect(m.hint).toBe(customerText.hint); expect(m.menu_url).toBe("https://oneteam.test/");
    expect(await code(book((await slotOf(5, "09:00")).at, { phone: "011999222", name: "ភ្ញៀវ ក្លែង", init_data: "forged" }))).toEqual([200, undefined]); // bad launch data: saved, the link stays the way
  });

  it("a signed-in customer: name and phone filled in, the booking linked at once, the bot says it arrived (no new password)", async () => {
    const A = await signIn("12 345 678", pwA);
    const html = (await page(`/book?items=${ac()}`, { cookie: A.cookie! })).body;
    expect(html).toContain('value="សុខ ដារ៉ា"'); expect(html).toContain('value="012345678"');
    hubCalls.length = 0;
    const r = await A.req("POST", "/api/public/bookings", { items: ac(), at: (await slotOf(5, "10:00")).at, address: "ផ្ទះ 12", name: "សុខ ដារ៉ា", phone: "012345678", consent: true, ts: oldToken() });
    expect(r.json).toMatchObject({ linked: true, link: null });
    refA2 = r.json.ref;
    expect(told(SUB.a)).toEqual([`✅ បានទទួលការកក់ #${r.json.number}\nរង់ចាំបញ្ជាក់ (≤៣០ នាទី)`]);
    expect(toldBodies(SUB.a)[0].buttons).toEqual([[{ text: "📍 តាមដានការកក់", web_app: "https://oneteam.test/my" }]]);
  });
});

describe("Admin / GM: confirm (the job length may change — CEO) or decline", () => {
  it("confirm: only staff who take bookings; a longer job only while a technician can take it; the customer gets the exact message with a button", async () => {
    const rq = await requestOf(bk1);
    expect((await kim.req("POST", `/api/requests/${rq.id}/confirm`, {})).status).toBe(403);
    expect((await ceoB.req("POST", `/api/requests/${rq.id}/confirm`, {})).status).toBe(404);
    expect((await admin.req("POST", `/api/requests/${rq.id}/confirm`, { minutes: 360 })).json.error).toBe("TECH_NOT_FREE"); // 08–14 meets the 13:00 job (Kim alone)
    hubCalls.length = 0;
    expect((await admin.req("POST", `/api/requests/${rq.id}/confirm`, { minutes: 300 })).status).toBe(200);
    const b = await bookingOf(ref1);
    expect(b).toMatchObject({ web_status: "confirmed", web_decided_by: s.users.admin });
    expect(new Date(b.ends_at).getTime() - new Date(b.scheduled_at).getTime()).toBe(300 * 60_000);
    expect((await sql`select old_data, new_data from audit_log where action = 'booking.web_duration' and row_id = ${bk1}`)[0]).toMatchObject({ old_data: { minutes: 240 }, new_data: { minutes: 300 } });
    expect(told(SUB.a)[0]).toMatch(new RegExp(`^✅ បានបញ្ជាក់ #${n1}\\n\\S+ \\d{1,2} \\S+ ម៉ោង 08:00$`));
    expect(toldBodies(SUB.a)[0].buttons[0][0]).toMatchObject({ text: "📍 តាមដានការកក់" });
    expect((await admin.req("POST", `/api/requests/${rq.id}/confirm`, {})).status).toBe(404); // once
  });

  it("decline needs a reason; the customer gets «❌ មិនអាចទទួល #… / មូលហេតុ៖ …» with «book another time»; the slot is free again", async () => {
    const s0 = await slotOf(5, "13:00");
    const ref = (await book(s0.at, { phone: "011333444", name: "វណ្ណា" })).json().ref as string;
    const b = await bookingOf(ref);
    await internal("customer-subscribed", { code: (await linkToken(ref))!, subscriber_id: 75 });
    expect((await gm.req("POST", `/api/requests/${(await requestOf(b.id)).id}/decline`, { reason: "" })).status).toBe(400);
    hubCalls.length = 0;
    expect((await gm.req("POST", `/api/requests/${(await requestOf(b.id)).id}/decline`, { reason: "ជាងមិនទំនេរថ្ងៃនោះ" })).status).toBe(200);
    expect(await bookingOf(ref)).toMatchObject({ status: "cancelled", web_status: "declined" });
    expect(told(75)).toEqual([`❌ មិនអាចទទួល #${b.number}\nមូលហេតុ៖ ជាងមិនទំនេរថ្ងៃនោះ`]);
    expect(toldBodies(75)[0].buttons).toEqual([[{ text: "កក់ម៉ោងផ្សេង", web_app: "https://oneteam.test/?book" }]]);
    expect((await slotOf(5, "13:00")).free).toBe(true);
  });

  it("in the bot: the request list with ✅ / ❌; confirm works there; decline asks for the reason first", async () => {
    const r1 = (await book((await slotOf(1, "13:00")).at, { phone: "011333555", name: "សុភា" })).json().ref as string;
    const q1 = await requestOf((await bookingOf(r1)).id);
    const list = (await internal("tg-menu", { chat_id: CHAT.admin, view: "req" })).json().menu;
    expect((list.buttons as any[][]).flat().some((b) => b.view === "req" && b.id === q1.id && b.arg === "confirm")).toBe(true);
    await internal("tg-menu", { chat_id: CHAT.admin, view: "req", id: q1.id, arg: "confirm" });
    expect((await bookingOf(r1)).web_status).toBe("confirmed");
  });
});

describe("nobody answers (CEO): 30 min → Admin + GM, 60 min → CEO, never declined; the time passes → «expired», hold released", () => {
  it("reminders once each, no message to the customer; after the appointment time the booking expires and the slot is free", async () => {
    const at = (await slotOf(3, "13:00")).at;
    const ref = (await book(at, { phone: "011121212", name: "ភ្ញៀវ រង់ចាំ" })).json().ref as string;
    const b = await bookingOf(ref);
    await internal("customer-subscribed", { code: (await linkToken(ref))!, subscriber_id: 76 });
    hubCalls.length = 0;
    await sql`update bookings set created_at = now() - interval '31 minutes' where id = ${b.id}`;
    expect(await webBookingAlerts()).toEqual({ reminded: 1, escalated: 0, expired: 0 });
    for (const u of [s.users.admin!, s.users.gm01!]) expect((await sql`select 1 from notifications where user_id = ${u} and title like ${"%" + b.number + "%៣០ នាទីហើយ%"}`).length).toBe(1);
    expect(await webBookingAlerts()).toEqual({ reminded: 0, escalated: 0, expired: 0 }); // once
    await sql`update bookings set created_at = now() - interval '61 minutes' where id = ${b.id}`;
    expect(await webBookingAlerts()).toEqual({ reminded: 0, escalated: 1, expired: 0 });
    expect((await sql`select 1 from notifications where user_id = ${s.users.ceo!} and title like ${"%" + b.number + "%"}`).length).toBe(1);
    expect((await bookingOf(ref)).web_status).toBe("pending"); // never declined by itself
    expect((await slotOf(3, "13:00")).free).toBe(false);       // still held
    await sql`update bookings set scheduled_at = now() - interval '5 minutes', ends_at = now() + interval '115 minutes' where id = ${b.id}`;
    expect((await webBookingAlerts()).expired).toBe(1);
    expect(await bookingOf(ref)).toMatchObject({ status: "cancelled", web_status: "expired" });
    expect(await requestOf(b.id)).toMatchObject({ status: "done", outcome: "expired" });
    expect((await sql`select 1 from notifications where user_id = ${s.users.gm01!} and title like ${"%" + b.number + "%ផុតពេល%"}`).length).toBe(1);
    expect(told(76)).toEqual([]); // no extra customer message
    expect((await page(`/book/done/${ref}`)).body).toContain("ផុតពេល");
    expect((await sql`select tg_subscriber_id from customers where id = ${b.customer_id}`)[0]!.tg_subscriber_id).toBeNull(); // nobody keeps an account on an unchecked number
  });
});

describe("quote request: the same tiles + items, photos (metadata stripped), the same one-tap link", () => {
  it("consent, description or an item, at most 5 real images; the request goes to the GM — photos without camera position or comments; the bot link for the new customer brings the password", async () => {
    expect(await code(quote({ consent: false }))).toEqual([400, "CONSENT_REQUIRED"]);
    expect(await code(quote({ description: " " }))).toEqual([400, "DESCRIPTION_REQUIRED"]);
    expect(await code(quote({ photos: [PNG, PNG, PNG, PNG, PNG, PNG] }))).toEqual([400, "TOO_MANY_PHOTOS"]);
    expect(await code(quote({ photos: [Buffer.from("<script>alert(1)</script>").toString("base64")] }))).toEqual([400, "BAD_IMAGE"]);
    const h = (await page(`/quote?items=${ID["AC-BUY"]}:1`)).body;
    expect(h).toContain("ផ្ញើ និងភ្ជាប់ Telegram"); expect(h).toContain("ពេលចុច «ផ្ញើ និងភ្ជាប់ Telegram» អ្នកយល់ព្រមលើ៖"); expect(h).toContain(`value="${ID["AC-BUY"]}" selected`);
    const r = await quote({ items: `${ID["AC-BUY"]}:2`, description: "", category: "ac", photos: [JPEG, PNG_META], lat: 11.5564, lng: 104.9282, accuracy: 30 });
    expect(r.statusCode).toBe(200); expect(r.json()).toMatchObject({ ok: true, linked: false }); expect(r.json().link).toMatch(/start=b-/);
    const rq = (await sql<Record<string, any>[]>`select * from service_requests where kind = 'quote' order by created_at desc limit 1`)[0]!;
    expect(rq.text).toContain("ចង់ទិញម៉ាស៊ីនត្រជាក់ ×2"); expect(rq.meta).toMatchObject({ category: "ac", lat: 11.5564, accuracy: 30, new_customer: true });
    const gmNote = await sql<{ body: string }[]>`select body from notifications where kind = 'service.request' and user_id = ${s.users.gm01!} and title like '%តម្លៃ%' order by id desc limit 1`;
    expect(gmNote[0]!.body).toContain("ម៉ាស៊ីនត្រជាក់"); expect(gmNote[0]!.body).toContain("google.com/maps");
    const files = await sql<{ id: string; path: string; mime: string }[]>`select id, path, mime from service_request_files where request_id = ${rq.id} order by created_at, id`;
    const jpg = readFileSync(join(config.uploadsDir, files.find((f) => f.mime === "image/jpeg")!.path));
    for (const secret of ["Exif", "GPS-SECRET", "XMP-SECRET", "IPTC-SECRET", "COMMENT-SECRET"]) expect(jpg.includes(secret)).toBe(false);
    expect(readFileSync(join(config.uploadsDir, files.find((f) => f.mime === "image/png")!.path)).includes("PNG-TEXT-SECRET")).toBe(false);
    expect((await page(`/pub/img/${files[0]!.id}`)).statusCode).toBe(404);
    const x = (await internal("customer-subscribed", { code: /start=(b-[A-Za-z0-9_-]{20})/.exec(r.json().link)![1], subscriber_id: 77 })).json();
    expect(x.text).toMatch(/^✅ ភ្ជាប់រួចរាល់\nសំណើតម្លៃរបស់អ្នកបានទទួលហើយ\n🔑 ពាក្យសម្ងាត់៖ \d{4}\nចូលដោយលេខទូរស័ព្ទ \+ ពាក្យសម្ងាត់នេះ$/);
    expect((await page(`/quote/done/${r.json().ref}`)).body).toContain("បានភ្ជាប់ Telegram");
  });
});

describe("customer login: phone + password from the bot; a new password only from the bot (CEO)", () => {
  const PHONE_B = "012666555";
  let pwB = "";
  const guard = async (phone: string) => (await sql<{ failed: number; locked_until: Date | null; permanent: boolean }[]>`select failed, locked_until, permanent from customer_login_guards where phone = ${phone}`)[0] ?? null;
  const wrong = async (phone: string, n: number) => {
    const out: unknown[][] = [];
    for (let i = 0; i < n; i++) { resetRateLimits(); const r = await tryLogin(phone, "9z9z"); out.push([r.statusCode, r.json().error, r.json().details?.minutes]); }
    return out;
  };
  const lockOver = (phone: string) => sql`update customer_login_guards set locked_until = now() - interval '1 second' where phone = ${phone}`;
  const newPwInBot = async () => {
    const m = (await internal("tg-text", { chat_id: 930002, tg_user: 930002, text: CUSTOMER_MENU.password, subscriber_id: SUB.b })).json();
    expect(m.text).toMatch(/^🔑 ពាក្យសម្ងាត់ថ្មី៖ \d{4}$/); expect(m.after).toBe(customerText.hint);
    return pwIn(m.text)!;
  };

  it("the sign-in screen: phone + password; «forgot password» opens the bot — no reset form, no reset address", async () => {
    const r = await page("/my");
    for (const x of ['id="phone"', 'id="pw"', 'type="password"', "ភ្លេចពាក្យសម្ងាត់?", 'id="forgot" href="https://t.me/Oneteam_app_bot"', "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី", "សូមភ្ជាប់ Telegram ជាមុនសិន"]) expect(r.body).toContain(x);
    expect((await pub("POST", "/api/public/password-reset", { phone: "12 666 555" })).statusCode).toBe(404);
    expect((await pub("GET", "/api/my")).statusCode).toBe(401);
  });

  it("only an argon2 hash is stored; nothing else carries the password", async () => {
    const c = (await sql<{ password_hash: string }[]>`select password_hash from customers where tg_subscriber_id = ${SUB.a}`)[0]!;
    expect(c.password_hash).toMatch(/^\$argon2id\$/); expect(c.password_hash).not.toContain(pwA);
    expect((await sql`select 1 from telegram_outbox where text like '%ពាក្យសម្ងាត់%'`).length).toBe(0);
    expect((await sql`select count(*)::int as n from audit_log where new_data::text like ${"%" + pwA + "%"} and action like 'customer.password%'`)[0]!.n).toBe(0);
  });

  it("login: right phone + password → session; a wrong password and an unknown number get the same answer", async () => {
    const bad = await tryLogin("12 345 678", "0000"), unknown = await tryLogin("099 111 222", "0000");
    expect([bad.statusCode, bad.json()]).toEqual([401, { error: "INVALID_CREDENTIALS" }]);
    expect([unknown.statusCode, unknown.json()]).toEqual([bad.statusCode, bad.json()]);
    const ok = await tryLogin("+855 12 345 678", pwA);
    expect(ok.statusCode).toBe(200); expect(String(ok.headers["set-cookie"])).toMatch(/^otc=[^;]+;.*HttpOnly/i);
    expect(await guard("012345678")).toBeNull();
  });

  it("locks per phone: 10 → 3 min, 15 → 5 min, 20 → 30 min, 30 → until a new password; while locked even the right password is refused", async () => {
    await sql`update users set telegram_chat_id = null where telegram_chat_id = 930002`;
    pwB = await newPwInBot(); // customer B was linked by the staff: the bot gives the first password
    expect((await tryLogin(PHONE_B, pwB)).statusCode).toBe(200);
    expect((await wrong(PHONE_B, 9)).every((x) => x[0] === 401)).toBe(true);
    expect((await wrong(PHONE_B, 1))[0]).toEqual([423, "LOCKED", 3]);
    expect((await tryLogin(PHONE_B, pwB)).statusCode).toBe(423);
    await lockOver(PHONE_B);
    expect((await wrong(PHONE_B, 4)).every((x) => x[0] === 401)).toBe(true);
    expect((await wrong(PHONE_B, 1))[0]).toEqual([423, "LOCKED", 5]);
    await lockOver(PHONE_B);
    await wrong(PHONE_B, 4);
    expect((await wrong(PHONE_B, 1))[0]).toEqual([423, "LOCKED", 30]);
    await lockOver(PHONE_B);
    await wrong(PHONE_B, 9);
    expect((await wrong(PHONE_B, 1))[0]).toEqual([423, "LOCKED_PERMANENT", undefined]);
    await lockOver(PHONE_B);
    expect((await tryLogin(PHONE_B, pwB)).json().error).toBe("LOCKED_PERMANENT");
    expect((await wrong("097 000 111", 10))[9]).toEqual([423, "LOCKED", 3]); // no enumeration: an unknown number climbs the same ladder
  });

  it("unlock paths: Admin / GM in the app (audited) or a new password from the bot — into the linked chat only; every session ends; 3 an hour", async () => {
    expect((await kim.req("POST", `/api/customers/${custB}/unlock-login`)).status).toBe(403);
    expect((await admin.req("POST", `/api/customers/${custB}/unlock-login`)).status).toBe(200);
    expect((await sql`select user_id from audit_log where action = 'customer.login_unlocked' and row_id = ${custB}`)[0]).toMatchObject({ user_id: s.users.admin });
    expect((await tryLogin(PHONE_B, pwB)).statusCode).toBe(200);
    const before = await signIn(PHONE_B, pwB);
    await sql`update customer_login_guards set failed = 30, permanent = true where phone = ${PHONE_B}`;
    hubCalls.length = 0;
    pwB = await newPwInBot();
    expect(hubCalls.filter((c) => c.path === "/internal/notify-subscriber")).toHaveLength(0); // the answer IS the chat message; nothing else is sent anywhere
    expect(await guard(PHONE_B)).toBeNull(); expect((await before.req("GET", "/api/my")).status).toBe(401);
    expect((await tryLogin(PHONE_B, pwB)).statusCode).toBe(200);
    expect((await sql`select new_data from audit_log where action = 'customer.password_reset' order by id desc limit 1`)[0]!.new_data).toEqual({ via: "bot" });
    await newPwInBot();
    const third = await newPwInBot();
    const fourth = (await internal("tg-text", { chat_id: 930002, tg_user: 930002, text: CUSTOMER_MENU.password, subscriber_id: SUB.b })).json();
    expect(fourth.text).toBe(customerText.tooManyResets);
    pwB = third;
  });

  it("change password: needs the current one, at least 4, nothing easy to guess (1212-style allowed); the other sessions end", async () => {
    resetRateLimits();
    const one = await signIn(PHONE_B, pwB), two = await signIn(PHONE_B, pwB);
    const change = (c: Client, current: string, next: string) => c.req("POST", "/api/my/password", { current, next });
    expect((await change(one, "0000", "2580")).json).toMatchObject({ error: "WRONG_PASSWORD" });
    expect((await change(one, pwB, "258")).json).toMatchObject({ error: "PASSWORD_TOO_SHORT" });
    for (const weak of ["1111", "1234", "4321", "6555"]) expect((await change(one, pwB, weak)).json).toMatchObject({ error: "WEAK_PASSWORD" });
    expect((await change(one, pwB, "1212")).status).toBe(200);
    expect((await one.req("GET", "/api/my")).status).toBe(200); expect((await two.req("GET", "/api/my")).status).toBe(401);
    pwB = "1212";
  });

  it("a customer session never opens the staff app; inside Telegram the launch data signs in (checked by the hub, up to 24 h)", async () => {
    const B = await signIn(PHONE_B, pwB);
    for (const u of ["/app/", "/app/requests"]) { const r = await page(u, { cookie: B.cookie! }); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/my"); }
    for (const u of ["/api/bookings", "/api/customers", "/api/requests"]) expect((await page(u, { cookie: B.cookie! })).statusCode).toBe(401);
    expect((await page("/privacy", { cookie: B.cookie! })).statusCode).toBe(200); // the privacy page is never closed
    hubCalls.length = 0;
    const mini = client(app);
    expect((await mini.req("POST", "/api/public/tg-login", { init_data: "mini-b" })).status).toBe(200);
    expect(hubCalls.find((c) => c.path === "/internal/tg-verify")!.body).toEqual({ init_data: "mini-b", max_age: 86400 });
    expect(await code(pub("POST", "/api/public/tg-login", { init_data: "forged" }))).toEqual([401, "INVALID_CREDENTIALS"]);
    expect(await code(pub("POST", "/api/public/tg-login", { init_data: "mini-none" }))).toEqual([409, "NOT_LINKED"]);
  });

  it("per visitor: after 50 failed logins in an hour the next one is refused", async () => {
    resetRateLimits();
    for (let i = 0; i < 50; i++) expect((await tryLogin(`0965550${String(i).padStart(2, "0")}`, "9z9z")).statusCode).toBe(401);
    expect(await code(tryLogin("096555099", "9z9z"))).toEqual([429, "RATE_LIMITED"]);
    resetRateLimits();
  });
});

describe("customer home: own data only, notification settings, book again", () => {
  let bkB: string, closedB: string, refC: string;
  let A: Client, B: Client;
  it("upcoming with status and technician; past jobs with the warranty end and «book again» with the same lines; settings with the notification switches", async () => {
    bkB = await staffJob((await slotOf(5, "15:00")).at, [s.users.dara!], custB);
    closedB = await staffJob((await slotOf(6, "15:00")).at, [s.users.dara!], custB);
    await sql`update bookings set service_item_id = ${ID["AC-CLEAN"]!} where id = ${closedB}`;
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${closedB}`;
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: closedB, lines: [{ description: "លាង", kind: "service", qty: 1, unit: "job", unit_price: 1500 }] })).json.id;
    await admin.req("POST", `/api/invoices/${inv}/issue`);
    await admin.req("POST", `/api/invoices/${inv}/payments`, { amount: 1500, currency: "usd", method: "cash_usd" });
    A = await signIn("12 345 678", pwA); B = await signIn("012666555", "1212");
    const a = (await A.req("GET", "/api/my")).json;
    expect(a.name).toBe("សុខ ដារ៉ា"); expect(a.upcoming.map((x: any) => x.id)).toContain(bk1);
    expect(a.upcoming.find((x: any) => x.id === bk1)).toMatchObject({ status: "confirmed", can_cancel: true, can_reschedule: true });
    const b = (await B.req("GET", "/api/my")).json;
    expect(b.upcoming.map((x: any) => x.id)).toEqual([bkB]); expect(b.past.map((x: any) => x.id)).toEqual([closedB]);
    expect(b.past[0].rebook).toBe(`/book?items=${ID["AC-CLEAN"]}:1`);
    expect(JSON.stringify(a)).not.toContain(bkB); expect(JSON.stringify(b)).not.toContain(bk1);
    const html = (await page("/my", { cookie: A.cookie! })).body;
    for (const x of ["សួស្តី", "ការកំណត់", "ដំណឹងអំពីការកក់របស់ខ្ញុំ", 'id="n-service" checked', 'id="n-promo" checked', "ប្ដូរពាក្យសម្ងាត់", "ចាកចេញ", "កក់សេវាថ្មី"]) expect(html).toContain(x);
  });

  it("notification switches: kept by the hub (consent log there), audited here; promotions off when service messages are off", async () => {
    hubCalls.length = 0;
    expect((await A.req("POST", "/api/my/prefs", { service: true, promo: false })).json).toEqual({ service: true, promo: false });
    expect(hubCalls.at(-1)).toMatchObject({ path: "/internal/subscriber-prefs", body: { subscriber_id: SUB.a, service: true, promo: false } });
    expect((await A.req("GET", "/api/my/prefs")).json).toEqual({ service: true, promo: false });
    expect((await A.req("POST", "/api/my/prefs", { service: false, promo: true })).json).toEqual({ service: false, promo: false });
    expect((await sql`select new_data from audit_log where action = 'customer.notify_prefs' order by id desc limit 1`)[0]!.new_data).toEqual({ service: false, promo: false });
    expect((await page("/my", { cookie: A.cookie! })).body).toMatch(/id="n-promo" disabled/);
    await A.req("POST", "/api/my/prefs", { service: true, promo: true });
    expect((await pub("POST", "/api/my/prefs", { service: false, promo: false })).statusCode).toBe(401);
  });

  it("IDOR: a customer cannot read, cancel or move another customer's booking", async () => {
    expect((await A.req("POST", `/api/my/bookings/${bkB}/cancel`, { reason: "សាកល្បង" })).status).toBe(404);
    expect((await A.req("POST", `/api/my/bookings/${bkB}/reschedule`, { at: (await slotOf(6, "08:00")).at })).status).toBe(404);
    expect((await A.req("GET", `/api/my/bookings/${bkB}/slots`)).status).toBe(404);
    expect((await B.req("POST", `/api/my/bookings/${bk1}/cancel`, { reason: "សាកល្បង" })).status).toBe(404);
  });

  it("a known phone number opens neither that customer's history nor an account until the staff confirm — then the password arrives", async () => {
    await staffJob((await slotOf(1, "08:00")).at, [], custK);
    refC = (await book((await slotOf(5, "14:00")).at, { phone: "012777888", name: "មិនមែនម្ចាស់" })).json().ref;
    bkC = (await bookingOf(refC)).id;
    const linked = (await internal("customer-subscribed", { code: (await linkToken(refC))!, subscriber_id: SUB.c })).json();
    expect(linked.text).toBe(`✅ ភ្ជាប់រួចរាល់\nការកក់ #${(await bookingOf(refC)).number} រង់ចាំបញ្ជាក់ (≤៣០ នាទី)`); // no password yet
    expect((await sql`select tg_subscriber_id from customers where id = ${custK}`)[0]!.tg_subscriber_id).toBeNull();
    const lite = (await internal("tg-text", { chat_id: 930003, tg_user: 930003, text: CUSTOMER_MENU.password, subscriber_id: SUB.c })).json();
    expect(lite.text).toBe(customerText.passwordLater);
    hubCalls.length = 0;
    expect((await admin.req("POST", `/api/requests/${(await requestOf(bkC)).id}/confirm`, {})).status).toBe(200);
    const pwC = told(SUB.c).map(pwIn).find(Boolean)!;
    expect(pwC).toMatch(/^\d{4}$/); expect(told(SUB.c).find((x) => pwIn(x))).toMatch(/^🔑 ពាក្យសម្ងាត់៖ \d{4}\nចូលដោយលេខទូរស័ព្ទ \+ ពាក្យសម្ងាត់នេះ$/);
    expect((await tryLogin("012 777 888", pwC)).statusCode).toBe(200);
  });

  it("reschedule is a REQUEST; the answer follows the message style", async () => {
    const a2 = await bookingOf(refA2);
    const target = await slotOf(1, "10:00");
    expect((await A.req("POST", `/api/my/bookings/${a2.id}/reschedule`, { at: target.at, reason: "ជាប់ធ្វើការ" })).status).toBe(200);
    const rq = await requestOf(a2.id, "reschedule");
    expect(rq.meta).toMatchObject({ requested_by: "customer", new_start: target.at });
    hubCalls.length = 0;
    expect((await admin.req("POST", `/api/requests/${rq.id}/approve`)).status).toBe(200);
    expect(told(SUB.a)[0]).toMatch(new RegExp(`^🔁 បានប្ដូរម៉ោង #${a2.number}\\n\\S+ \\d{1,2} \\S+ ម៉ោង 10:00$`));
  });

  it("cancel needs a reason; cancelled (never deleted); sign out ends the session", async () => {
    expect((await B.req("POST", `/api/my/bookings/${bkB}/cancel`, { reason: "ជួសជុលរួចហើយ" })).status).toBe(200);
    expect((await sql`select status from bookings where id = ${bkB}`)[0]!.status).toBe("cancelled");
    expect((await B.req("POST", "/api/my/logout")).status).toBe(200);
    expect((await B.req("GET", "/api/my")).status).toBe(401);
    expect((await A.req("GET", "/api/my")).status).toBe(200);
  });
});

describe("the customer bot: the keyboard grid — each button; share my phone; a location", () => {
  it("/start of a customer: hello + the grid (📅 / 📍 open the Mini App) + the menu button", async () => {
    const m = (await internal("tg-start", { chat_id: 930001, tg_user: 930001, subscriber_id: SUB.a })).json();
    expect(m).toMatchObject({ kind: "customer", text: "👋 សួស្តី សុខ ដារ៉ា\nសូមជ្រើសខាងក្រោម", menu_url: "https://oneteam.test/" });
    expect(m.keyboard.flat().map((b: any) => b.text)).toEqual(["📅 កក់សេវា", "📍 តាមដានការកក់", "🎁 ប្រូម៉ូសិន", "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី", "🔕 ឈប់ទទួលដំណឹង"]);
    expect((await internal("tg-start", { chat_id: 930009, tg_user: 930009, subscriber_id: null })).json()).toEqual({ kind: "none", menu_url: "https://oneteam.test/" });
  });

  it("🎁 the latest active promotion (or «none yet») with «📅 book»; 📅 / 📍 as plain text get their button; 🔕 goes to the hub's choices", async () => {
    const say = async (text: string, sub = SUB.a) => (await internal("tg-text", { chat_id: 930001, tg_user: 930001, text, subscriber_id: sub })).json();
    promos = [];
    expect(await say(CUSTOMER_MENU.promo)).toMatchObject({ kind: "customer", text: "🎁 មិនទាន់មានប្រូម៉ូសិនទេ", buttons: [[{ text: "📅 កក់សេវា", web_app: "https://oneteam.test/?book" }]] });
    promos = [{ text: "បញ្ចុះតម្លៃ 10% លាងម៉ាស៊ីនត្រជាក់", valid_until: "2099-01-01" }];
    expect((await say(CUSTOMER_MENU.promo)).text).toBe("🎁 បញ្ចុះតម្លៃ 10% លាងម៉ាស៊ីនត្រជាក់");
    expect((await say(CUSTOMER_MENU.book)).buttons).toEqual([[{ text: "📅 កក់សេវា", web_app: "https://oneteam.test/?book" }]]);
    expect((await say(CUSTOMER_MENU.track)).buttons).toEqual([[{ text: "📍 តាមដានការកក់", web_app: "https://oneteam.test/my" }]]);
    expect((await say(CUSTOMER_MENU.stop)).kind).toBe("customer_menu");
    expect((await say("សួស្តី")).keyboard).toHaveLength(3);
    expect((await say(CUSTOMER_MENU.promo, 98)).kind).toBe("none"); // an unknown chat gets nothing
  });

  it("share my phone (Telegram vouches for it): a new number makes the customer, a known number links its record; both get the first password; a foreign number is refused", async () => {
    const x = (await internal("tg-contact", { subscriber_id: 91, tg_user: 9101, phone: "+855 97 555 1111", first_name: "Vanna" })).json();
    expect(x.ok).toBe(true); expect(x.text).toMatch(/^✅ ភ្ជាប់រួចរាល់\n🔑 ពាក្យសម្ងាត់៖ \d{4}\nចូលដោយលេខទូរស័ព្ទ \+ ពាក្យសម្ងាត់នេះ$/); expect(x.hint).toBe(customerText.hint);
    expect((await sql`select name, phones, origin, consent_source, tg_subscriber_id::text as sub from customers where tg_subscriber_id = 91`)[0]).toMatchObject({ name: "Vanna", phones: ["0975551111"], origin: "telegram", consent_source: "bot", sub: "91" });
    const t = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន ហាង", phones: ["012454545"], zone: "inside" })).json.id;
    const y = (await internal("tg-contact", { subscriber_id: 92, tg_user: 9201, phone: "85512454545", first_name: "X" })).json();
    expect(pwIn(y.text)).toMatch(/^\d{4}$/);
    expect((await sql`select tg_subscriber_id::text as sub, name from customers where id = ${t}`)[0]).toMatchObject({ sub: "92", name: "អតិថិជន ហាង" });
    expect((await internal("tg-contact", { subscriber_id: 92, tg_user: 9201, phone: "85512454545" })).json().text).toBe(customerText.linkedKnown); // linked again: no new password
    expect((await internal("tg-contact", { subscriber_id: 93, tg_user: 9301, phone: "+1 202 555 0100" })).json()).toMatchObject({ ok: false, text: customerText.notKhPhone });
  });

  it("a customer who sends a location gets a short pointer to the booking button and the grid — nothing is recorded", async () => {
    const r = (await internal("tg-location", { chat_id: 930001, tg_user: 930001, lat: 11.55, lng: 104.92, accuracy: 10, sent_at: Math.floor(Date.now() / 1000), subscriber_id: SUB.a })).json();
    expect(r.reply).toBe(customerText.location); expect(r.keyboard).toHaveLength(3);
  });

  it("every customer message is Khmer, at most 4 lines, starts with its one emoji (the brief's exact texts)", () => {
    const all = [customerText.linked("BK-0001", "4827"), customerText.linkedQuote("4827"), customerText.linkedKnown, customerText.password("4827"), customerText.received("BK-0001"),
      customerText.confirmed("BK-0001", "ច័ន្ទ 6 តុលា", "09:00", "Kim"), customerText.declined("BK-0001", "ក្រៅតំបន់"), customerText.reminder("09:00", "លាងម៉ាស៊ីនត្រជាក់", "Kim"),
      customerText.onTheWay("Kim"), customerText.done("BK-0001", "5 វិច្ឆិកា 2026"), customerText.newPassword("4827"), customerText.unsubscribed("promo"), customerText.unsubscribed("all"),
      customerText.noPromo, customerText.askContact, customerText.linkUsed, customerText.passwordLater, customerText.rescheduled("BK-0001", "ច័ន្ទ 6 តុលា", "10:00")];
    for (const m of all) { expect(lines4(m)).toBe(true); expect(m).toMatch(/^\p{Extended_Pictographic}/u); expect(m).not.toMatch(/\b(booking|status|link|token|password|error)\b/i); }
    expect(customerText.confirmed("BK-0001", "ច័ន្ទ 6 តុលា", "09:00", "Kim")).toBe("✅ បានបញ្ជាក់ #BK-0001\nច័ន្ទ 6 តុលា ម៉ោង 09:00 · ជាង Kim");
    expect(customerText.reminder("09:00", "លាងម៉ាស៊ីនត្រជាក់", "Kim")).toBe("⏰ ស្អែក ម៉ោង 09:00\nលាងម៉ាស៊ីនត្រជាក់ · ជាង Kim");
    expect(customerText.onTheWay("Kim")).toBe("🚗 ជាង Kim កំពុងមក");
    expect(customerText.done("BK-0001", "5 វិច្ឆិកា 2026")).toBe("✅ ការងាររួចរាល់ #BK-0001\nធានាដល់ 5 វិច្ឆិកា 2026");
    expect(customerText.newPassword("4827")).toBe("🔑 ពាក្យសម្ងាត់ថ្មី៖ 4827");
    expect(customerText.unsubscribed("promo")).toBe("🔕 បានឈប់ តែប្រូម៉ូសិន\nបើកវិញបានគ្រប់ពេល");
  });
});

describe("tracking: reminder the day before (17:00–20:00 shop time), on the way, done — once each, with a button", () => {
  it("the reminder only in the evening window of the day before; on the way and done right away; a refused chat is marked", async () => {
    const tomorrow10 = (await sql<{ t: Date; at18: Date; at21: Date }[]>`select ((now() at time zone 'Asia/Phnom_Penh')::date + 1 + interval '10 hours') at time zone 'Asia/Phnom_Penh' as t,
      ((now() at time zone 'Asia/Phnom_Penh')::date + interval '18 hours') at time zone 'Asia/Phnom_Penh' as at18, ((now() at time zone 'Asia/Phnom_Penh')::date + interval '21 hours') at time zone 'Asia/Phnom_Penh' as at21`)[0]!;
    await sql`update bookings set created_at = now() - interval '3 days', scheduled_at = ${tomorrow10.t}, ends_at = ${tomorrow10.t}::timestamptz + interval '2 hours', status = 'assigned' where id = ${bk1}`;
    await sql`delete from customer_notices`;
    await sql`insert into customer_notices (booking_id, kind, ok) select id, 'done', true from bookings where status = 'closed'`; // old news stays old
    hubCalls.length = 0;
    expect(await customerNotices(tomorrow10.at21)).toBe(0); // 21:00: too late in the evening
    expect(await customerNotices(tomorrow10.at18)).toBeGreaterThanOrEqual(1);
    expect(told(SUB.a).at(-1)).toMatch(/^⏰ ស្អែក ម៉ោង 10:00\nលាងម៉ាស៊ីនត្រជាក់ ×2 · ជួសជុលភ្លើង$/);
    expect(toldBodies(SUB.a).at(-1).buttons[0][0].text).toBe("📍 តាមដានការកក់");
    const n = hubCalls.length;
    expect(await customerNotices(tomorrow10.at18)).toBe(0); expect(hubCalls.length).toBe(n); // once
    await sql`update bookings set status = 'en_route' where id = ${bk1}`;
    expect(await customerNotices()).toBeGreaterThanOrEqual(1);
    expect(told(SUB.a).at(-1)).toBe("🚗 ជាងកំពុងមក"); // no technician on it yet
    await sql`update bookings set web_subscriber_id = 99, created_at = now() - interval '3 days', scheduled_at = ${tomorrow10.t}, ends_at = ${tomorrow10.t}::timestamptz + interval '2 hours' where id = ${bkC}`;
    await customerNotices(tomorrow10.at18);
    expect((await sql`select ok from customer_notices where booking_id = ${bkC}`)[0]).toMatchObject({ ok: false });
  });
});

describe("Settings → Website: booking hours + promotion gap (CEO), indexing, photos", () => {
  it("the CEO sets the booking hours (slots follow) and the days between promotions (the hub gets them); others may not; nonsense is refused", async () => {
    expect((await admin.req("PUT", "/api/website", { hours: { open: "09:00", close: "18:00", lunch_start: "12:00", lunch_end: "13:00" } })).status).toBe(403);
    expect((await ceo.req("PUT", "/api/website", { hours: { open: "18:00", close: "09:00", lunch_start: "12:00", lunch_end: "13:00" } })).status).toBe(400);
    expect((await ceo.req("PUT", "/api/website", { hours: { open: "09:00", close: "18:00", lunch_start: "12:00", lunch_end: "13:00" }, promo_gap_days: 14 })).status).toBe(200);
    expect((await days())[2]!.slots.map((x) => x.time)).toEqual(["09:00", "10:00", "13:00", "14:00", "15:00", "16:00"]);
    hubCalls.length = 0;
    expect((await admin.req("POST", "/api/subscribe/broadcast/preview", { text: "ប្រូម៉ូសិនសាកល្បង" })).status).toBe(403); // CEO / GM only
    expect((await gm.req("POST", "/api/subscribe/broadcast/preview", { text: "ប្រូម៉ូសិនសាកល្បង" })).json.gap_days).toBe(14);
    expect(hubCalls.at(-1)).toMatchObject({ path: "/internal/broadcast/preview", body: { text: "ប្រូម៉ូសិនសាកល្បង", gap_days: 14 } });
    expect((await gm.req("POST", "/api/subscribe/broadcast", { text: "1\n2\n3\n4\n5" })).status).toBe(400); // at most 4 lines
    expect((await gm.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "ហាងបិទថ្ងៃច័ន្ទ" })).status).toBe(400); // no mass «service» messages
    expect((await ceo.req("PUT", "/api/website", { hours: { open: "08:00", close: "17:00", lunch_start: "12:00", lunch_end: "13:00" } })).status).toBe(200);
  });

  it("Google indexing stays off until the CEO switches it on; booking pages are never indexed; photos: only website photos are public", async () => {
    expect((await page("/")).body).toContain('content="noindex,nofollow"'); expect((await page("/robots.txt")).body).toContain("Disallow: /\n");
    expect((await ceo.req("PUT", "/api/website", { published: true, about_km: "យើងមានបទពិសោធន៍ 10 ឆ្នាំ" })).status).toBe(200);
    expect((await page("/")).body).not.toContain("noindex"); expect((await page("/")).body).toContain("យើងមានបទពិសោធន៍ 10 ឆ្នាំ");
    for (const u of [`/book?items=${ac()}`, "/quote", "/my"]) expect((await page(u)).body).toContain('content="noindex,nofollow"');
    await ceo.req("PUT", "/api/website", { published: false });
    const g = (await ceo.req("POST", "/api/website/photos", { slot: "gallery", data: PNG })).json.id;
    expect((await page(`/pub/img/${g}`)).statusCode).toBe(200);
    expect((await ceo.req("DELETE", `/api/website/photos/${g}`)).status).toBe(200);
    expect((await page(`/pub/img/${g}`)).statusCode).toBe(404);
    for (const f of ["site.css", "site.js"]) expect((await page(`/pub/${f}`)).statusCode).toBe(200);
  });
});

// ---------- D-119 / D-120 (CEO decisions 04-10) ----------
const ppDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh" }).format(d); // YYYY-MM-DD in shop time
const localAt = (date: string, hm: string) => new Date(`${date}T${hm}:00+07:00`);
const firstFree = async () => (await days()).slice(1).flatMap((d) => d.slots).find((x) => x.free)!;
/** wait until the outbox has delivered every row that mentions this text (another flush may be running) */
async function deliver(text: string) {
  for (let i = 0; i < 40; i++) {
    await flushOutbox(50);
    if ((await sql`select 1 from telegram_outbox where text like ${"%" + text + "%"} and status = 'pending'`).length === 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("D-119 night rule: made 20:00–08:00 → «we confirm at 8 am» and a silent staff alert; the timers run 08:00–20:00 only", () => {
  const today = ppDate(new Date());
  const NIGHT = localAt(today, "22:00"), DAY = localAt(today, "10:00");
  beforeEach(() => { clock.day = { ...WEB_TIMER_HOURS }; });
  afterEach(() => { clock.now = () => new Date(); clock.day = { from: 0, to: 24 }; });

  it("at night: the booking screen, screen 4 and the bot say «យើងនឹងបញ្ជាក់ ម៉ោង ៨ ព្រឹក»; Admin + GM get the alert without sound, asked for 8 am", async () => {
    clock.now = () => NIGHT;
    expect((await page(`/book?items=${ac()}`)).body).toContain(NIGHT_CONFIRM.km);
    const r = await book((await firstFree()).at, { phone: "011404040", name: "ភ្ញៀវ យប់" });
    expect(r.statusCode).toBe(200);
    const { ref, number } = r.json() as { ref: string; number: string };
    const done = (await page(`/book/done/${ref}`)).body;
    expect(done).toContain(NIGHT_CONFIRM.km); expect(done).not.toContain("នឹងបញ្ជាក់ក្នុងរយៈពេល");
    const rows = await sql<{ chat_id: string; text: string; silent: boolean }[]>`select chat_id::text as chat_id, text, silent from telegram_outbox where text like ${"%" + number + "%"} order by chat_id`;
    expect(rows.map((x) => [Number(x.chat_id), x.silent])).toEqual([[CHAT.gm, true], [CHAT.admin, true]]);
    for (const x of rows) { expect(x.text).toContain("សូមបញ្ជាក់ម៉ោង ៨ ព្រឹក"); expect(x.text).not.toContain("៣០ នាទី"); }
    hubCalls.length = 0;
    await deliver(number);
    const sends = hubCalls.filter((c) => c.path === "/internal/send" && String(c.body.text).includes(number));
    expect(sends.length).toBe(2); for (const c of sends) expect(c.body.silent).toBe(true);
    const x = (await internal("customer-subscribed", { code: (await linkToken(ref))!, subscriber_id: 78 })).json();
    expect(x.text.split("\n").slice(0, 2)).toEqual(["✅ ភ្ជាប់រួចរាល់", `ការកក់ #${number} · ${NIGHT_CONFIRM.km}`]);
    expect(lines4(x.text)).toBe(true);
  });

  it("in the day: «within 30 minutes» as before and an alert with sound", async () => {
    clock.now = () => DAY;
    expect((await page(`/book?items=${ac()}`)).body).not.toContain(NIGHT_CONFIRM.km);
    const r = await book((await firstFree()).at, { phone: "011404041", name: "ភ្ញៀវ ថ្ងៃ" });
    const { ref, number } = r.json() as { ref: string; number: string };
    expect((await page(`/book/done/${ref}`)).body).toContain("នឹងបញ្ជាក់ក្នុងរយៈពេល ៣០ នាទី");
    const rows = await sql<{ text: string; silent: boolean }[]>`select text, silent from telegram_outbox where text like ${"%" + number + "%"}`;
    expect(rows.length).toBe(2); for (const x of rows) { expect(x.silent).toBe(false); expect(x.text).toContain("សូមបញ្ជាក់ក្នុង ៣០ នាទី"); }
    hubCalls.length = 0;
    await deliver(number);
    for (const c of hubCalls.filter((c) => c.path === "/internal/send" && String(c.body.text).includes(number))) expect(c.body.silent).toBeUndefined();
    const x = (await internal("customer-subscribed", { code: (await linkToken(ref))!, subscriber_id: 79 })).json();
    expect(x.text.split("\n")[1]).toBe(`ការកក់ #${number} រង់ចាំបញ្ជាក់ (≤៣០ នាទី)`);
  });

  it("the 30 / 60 minutes count 08:00–20:00 only: made at 21:00 → Admin + GM at 08:30, the CEO at 09:00; made at 19:45 → 08:15 / 08:45", async () => {
    // days in the past, so the bookings of the other tests (made just now) stay out of these runs
    const d0 = ppDate(new Date(Date.now() - 3 * 86_400_000)), d1 = ppDate(new Date(Date.now() - 2 * 86_400_000));
    const alertsAt = (t: Date) => { clock.now = () => t; return webBookingAlerts(t); };
    const none = { reminded: 0, escalated: 0, expired: 0 };
    clock.now = () => DAY;
    const b = await bookingOf((await book((await firstFree()).at, { phone: "011404042", name: "ភ្ញៀវ ម៉ោង ៩ យប់" })).json().ref);
    await sql`update bookings set created_at = ${localAt(d0, "21:00")} where id = ${b.id}`;
    expect(await alertsAt(localAt(d0, "23:30"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "07:59"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "08:29"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "08:30"))).toEqual({ reminded: 1, escalated: 0, expired: 0 });
    for (const u of [s.users.admin!, s.users.gm01!]) expect((await sql`select 1 from notifications where user_id = ${u} and title like ${"%" + b.number + "%៣០ នាទីហើយ%"}`).length).toBe(1);
    expect((await sql`select 1 from notifications where user_id = ${s.users.ceo!} and title like ${"%" + b.number + "%"}`).length).toBe(0);
    expect(await alertsAt(localAt(d1, "08:59"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "09:00"))).toEqual({ reminded: 0, escalated: 1, expired: 0 });
    expect((await sql`select 1 from notifications where user_id = ${s.users.ceo!} and title like ${"%" + b.number + "%"}`).length).toBe(1);
    clock.now = () => DAY;
    const b2 = await bookingOf((await book((await firstFree()).at, { phone: "011404043", name: "ភ្ញៀវ ម៉ោង ៨ យប់" })).json().ref);
    await sql`update bookings set created_at = ${localAt(d0, "19:45")} where id = ${b2.id}`;
    expect(await alertsAt(localAt(d0, "23:59"))).toEqual(none); // 15 minutes that evening
    expect(await alertsAt(localAt(d1, "08:14"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "08:15"))).toEqual({ reminded: 1, escalated: 0, expired: 0 });
    expect(await alertsAt(localAt(d1, "08:44"))).toEqual(none);
    expect(await alertsAt(localAt(d1, "08:45"))).toEqual({ reminded: 0, escalated: 1, expired: 0 });
    expect((await bookingOf(b2.web_ref)).web_status).toBe("pending"); // still never declined by itself
  });
});

describe("D-120 test phones (Settings, CEO only): a test reaches the CEO only, holds nobody, stays out of reports and lists, ends after 24 h", () => {
  const TEST_PHONE = "017888999", CEO_CHAT = 920001;
  const testRefs: string[] = [];
  let realT = "", tb: Record<string, any> = {}, quoteId = "";
  beforeAll(async () => { await sql`update users set telegram_chat_id = ${CEO_CHAT}, telegram_user_id = ${CEO_CHAT} where id = ${s.users.ceo!}`; });
  afterAll(async () => { await sql`update users set telegram_chat_id = null, telegram_user_id = null where id = ${s.users.ceo!}`; });
  const notesOf = async (user: string, text: string) => (await sql<{ title: string }[]>`select title from notifications where user_id = ${user} and (title like ${"%" + text + "%"} or body like ${"%" + text + "%"}) order by id`).map((x) => x.title);
  const chatsFor = async (text: string) => [...new Set((await sql<{ chat_id: string }[]>`select chat_id::text as chat_id from telegram_outbox where text like ${"%" + text + "%"}`).map((x) => Number(x.chat_id)))];

  it("Settings: only the CEO reads and writes the list; numbers are checked and kept in one form; audited; other settings readers never see it", async () => {
    expect((await admin.req("GET", "/api/settings/test-phones")).status).toBe(403);
    expect((await gm.req("PUT", "/api/settings/test-phones", { phones: [TEST_PHONE] })).status).toBe(403);
    expect((await ceo.req("GET", "/api/settings/test-phones")).json).toEqual({ phones: [], max: 10 });
    expect((await ceo.req("PUT", "/api/settings/test-phones", { phones: ["12 34"] })).json.error).toBe("INVALID_PHONE");
    expect((await ceo.req("PUT", "/api/settings/test-phones", { phones: Array.from({ length: 11 }, (_, i) => `0119000${String(i).padStart(2, "0")}`) })).json.error).toBe("TOO_MANY_PHONES");
    expect((await ceo.req("PUT", "/api/settings/test-phones", { phones: ["+855 17 888 999", "017888999", " "] })).json).toEqual({ ok: true, phones: [TEST_PHONE] });
    expect((await ceo.req("GET", "/api/settings/test-phones")).json.phones).toEqual([TEST_PHONE]);
    expect((await sql`select new_data from audit_log where action = 'settings.test_phones' order by at desc limit 1`)[0]!.new_data).toEqual({ phones: [TEST_PHONE] });
    expect("test_phones" in (await admin.req("GET", "/api/settings/company")).json).toBe(false);
    realT = (await ceo.req("POST", "/api/customers", { name: "ម្ចាស់លេខពិត", phones: [TEST_PHONE], zone: "inside" })).json.id; // a real customer with the same number
  });

  it("a booking from a test phone: its own test customer (the real one untouched), only the CEO is told (🧪), no technician held, no daily phone limit", async () => {
    const slot = await firstFree();
    for (let i = 0; i < 4; i++) { const r = await book(slot.at, { phone: "017 888 999", name: "Heng សាកល្បង" }); expect(r.statusCode).toBe(200); testRefs.push(r.json().ref); }
    expect((await days()).flatMap((d) => d.slots).find((x) => x.at === slot.at)!.free).toBe(true); // a real booking would take a technician each time
    tb = await bookingOf(testRefs[0]!);
    expect(tb).toMatchObject({ is_test: true, web_status: "pending", cname: "Heng សាកល្បង" });
    expect(tb.customer_id).not.toBe(realT);
    expect((await sql`select is_test from customers where id = ${tb.customer_id}`)[0]!.is_test).toBe(true);
    expect(new Set((await Promise.all(testRefs.map(bookingOf))).map((x) => x.customer_id)).size).toBe(1); // the same test record each time
    expect((await sql`select name, is_test, tg_subscriber_id from customers where id = ${realT}`)[0]).toMatchObject({ name: "ម្ចាស់លេខពិត", is_test: false, tg_subscriber_id: null });
    expect((await requestOf(tb.id)).is_test).toBe(true);
    const mine = await notesOf(s.users.ceo!, tb.number);
    expect(mine.length).toBe(1); expect(mine[0]).toMatch(/^🧪 /);
    for (const u of [s.users.admin!, s.users.gm01!]) expect(await notesOf(u, tb.number)).toEqual([]);
    expect(await chatsFor(tb.number)).toEqual([CEO_CHAT]);
  });

  it("the CEO sees tests (🧪) in requests and bookings; Admin / GM, the bot list, the customer list, reports and the CSV never do", async () => {
    const reqA = (await admin.req("GET", "/api/requests?all=1")).json as any[];
    expect(reqA.some((x) => x.is_test || x.booking_id === tb.id)).toBe(false);
    expect(((await ceo.req("GET", "/api/requests?all=1")).json as any[]).find((x) => x.booking_id === tb.id)).toMatchObject({ is_test: true });
    expect(((await gm.req("GET", "/api/bookings")).json as any[]).some((x) => x.id === tb.id)).toBe(false);
    expect(((await ceo.req("GET", "/api/bookings")).json as any[]).find((x) => x.id === tb.id)).toMatchObject({ is_test: true });
    const custs = (await ceo.req("GET", "/api/customers")).json as any[];
    expect(custs.some((x) => x.id === tb.customer_id)).toBe(false); expect(custs.some((x) => x.id === realT)).toBe(true);
    expect(JSON.stringify((await internal("tg-menu", { chat_id: CHAT.admin, view: "req" })).json())).not.toContain(tb.number);
    const day = ppDate(new Date());
    const real = (await sql`select count(*)::int as n from bookings where company_id = ${s.a} and not is_test and (created_at at time zone 'Asia/Phnom_Penh')::date = ${day}::date`)[0]!.n;
    expect((await ceo.req("GET", `/api/reports/summary?from=${day}&to=${day}`)).json.jobs.created).toBe(real);
    const until = ppDate(new Date(Date.now() + 8 * 86_400_000));
    const csv = await app.inject({ method: "GET", url: `/api/reports/export?kind=jobs&from=${day}&to=${until}`, headers: { cookie: ceo.cookie! } });
    expect(csv.statusCode).toBe(200); expect(csv.body).not.toContain(tb.number);
  });

  it("a quote from a test phone, and what the CEO does with a test (confirm, assign, cancel): nobody else hears; the customer side works as real", async () => {
    const gmBefore = (await sql`select count(*)::int as n from notifications where user_id = ${s.users.gm01!}`)[0]!.n;
    const q = await quote({ phone: TEST_PHONE, name: "Heng សាកល្បង" });
    expect(q.statusCode).toBe(200);
    const rq = (await sql<Record<string, any>[]>`select * from service_requests where kind = 'quote' order by created_at desc limit 1`)[0]!;
    quoteId = rq.id;
    expect(rq.is_test).toBe(true);
    expect((await sql`select is_test from customers where id = ${rq.customer_id}`)[0]!.is_test).toBe(true);
    expect((await sql`select count(*)::int as n from notifications where user_id = ${s.users.gm01!}`)[0]!.n).toBe(gmBefore);
    expect((await notesOf(s.users.ceo!, "សំណើសុំតម្លៃ · Heng សាកល្បង")).at(-1)).toMatch(/^🧪 /);
    // the tester links the chat; the CEO confirms → the password arrives there and signs in to the TEST account (not the real customer)
    expect((await internal("customer-subscribed", { code: (await linkToken(tb.web_ref))!, subscriber_id: 91 })).json().ok).toBe(true);
    const staffIds = [s.users.admin!, s.users.gm01!, s.users.kim!, s.users.dara!, (await sql<{ id: string }[]>`select id from users where username = 'cfo'`)[0]!.id];
    const countOf = async () => (await sql<{ n: number }[]>`select count(*)::int as n from notifications where user_id = any(${sql.array(staffIds)}::uuid[])`)[0]!.n;
    const staffBefore = await countOf();
    expect((await ceo.req("POST", `/api/requests/${(await requestOf(tb.id)).id}/confirm`, {})).status).toBe(200);
    expect(told(91).some((t) => t.startsWith(`✅ បានបញ្ជាក់ #${tb.number}`))).toBe(true); // the tester gets the real customer messages
    const pw = told(91).map(pwIn).find(Boolean)!;
    expect(pw).toMatch(/^\d{4}$/);
    expect((await tryLogin(TEST_PHONE, pw)).statusCode).toBe(200);
    expect((await sql`select tg_subscriber_id::text as sub from customers where id = ${tb.customer_id}`)[0]!.sub).toBe("91");
    // assign (whichever technician is free) → cancel, by the CEO: the group, the technicians, Admin, GM and CFO hear nothing
    let assigned = 0;
    for (const tech of [s.users.kim!, s.users.dara!]) if (!assigned && (await ceo.req("POST", `/api/bookings/${tb.id}/assign`, { lead: tech, assistants: [] })).status === 200) assigned++;
    expect(assigned).toBe(1);
    expect((await notesOf(s.users.ceo!, tb.number)).some((t) => t === `🧪 ${tb.number}`)).toBe(true); // the job message the group would get
    expect((await ceo.req("POST", `/api/bookings/${tb.id}/cancel`, { reason: "សាកល្បងរួចរាល់" })).status).toBe(200);
    expect(await countOf()).toBe(staffBefore);
    for (const u of staffIds) expect(await notesOf(u, tb.number)).toEqual([]);
    expect(await chatsFor(tb.number)).toEqual([CEO_CHAT]);
  });

  it("after 24 h whatever is still open is cancelled by itself — no message to anybody, audited; real bookings are never touched", async () => {
    const open = testRefs.slice(1);
    const ids = (await Promise.all(open.map(bookingOf))).map((x) => x.id as string);
    const realB = await bookingOf((await book((await firstFree()).at, { phone: "011404044", name: "ភ្ញៀវ ពិត" })).json().ref);
    await sql`update bookings set created_at = now() - interval '25 hours' where id = any(${sql.array([...ids, realB.id])}::uuid[])`;
    await sql`update service_requests set created_at = now() - interval '25 hours' where id = ${quoteId}`;
    const before = (await sql`select (select count(*) from notifications)::int as n, (select count(*) from telegram_outbox)::int as o`)[0];
    hubCalls.length = 0;
    expect(await cancelOldTests()).toEqual({ bookings: 3, requests: 4 });
    for (const r of open) { const b = await bookingOf(r); expect(b.status).toBe("cancelled"); expect(b.cancel_reason).toMatch(/^🧪 /); }
    expect((await sql`select status, outcome from service_requests where id = ${quoteId}`)[0]).toMatchObject({ status: "done", outcome: "expired" });
    expect(await bookingOf(realB.web_ref)).toMatchObject({ status: "new", web_status: "pending" });
    expect((await sql`select (select count(*) from notifications)::int as n, (select count(*) from telegram_outbox)::int as o`)[0]).toEqual(before);
    expect(hubCalls.filter((c) => c.path === "/internal/notify-subscriber")).toEqual([]);
    expect((await sql`select count(*)::int as n from audit_log where action = 'booking.test_expired'`)[0]!.n).toBe(3);
    expect(await cancelOldTests()).toEqual({ bookings: 0, requests: 0 }); // once
  });
});
