// Public shop website v2 (D-96, flag "website") — tests first. Routing ("/" is always the customer site, the staff app lives
// under /app), "from" prices (who may set them), online booking (slots only when a technician is free, consent, hold, race),
// the single-use Telegram link of a booking, confirm / decline by Admin + GM, quote requests with photos (metadata stripped),
// the customer home (Telegram login, own data only) and what stays from v1 (Settings → Website, indexing, one language per page).
// The Telegram signature checks themselves run on the hub: see 40_hub_telegram (the hub is a stub here).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SITE_CONSENT_VERSION } from "@sms/shared";
import { client, loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { formToken } from "../src/services/site.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, cfo: Client, admin: Client, gm: Client, kim: Client, ceoB: Client;
let acId: string, camId: string, productId: string, custK: string, custB: string;
const KEY = "key-oneteam-0123456789abcdef";
const CHAT = { admin: 920004, gm: 920003 };
const SUB = { a: 71, b: 72, c: 73 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const hubCalls: { path: string; body: any }[] = [];
const told = (sub: number) => hubCalls.filter((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === sub).map((c) => String(c.body.text));

const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const pub = (method: "GET" | "POST", url: string, body?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, payload: body === undefined ? undefined : JSON.stringify(body) });
const internal = (path: string, body: unknown) => app.inject({ method: "POST", url: `/internal/${path}`, headers: { "x-hub-key": KEY, "content-type": "application/json" }, payload: JSON.stringify(body) });
const oldToken = () => formToken(Date.now() - 60_000);
const code = async (r: Promise<{ statusCode: number; json: () => any }>) => { const x = await r; return [x.statusCode, x.json()?.error]; };

type Slot = { time: string; at: string; free: boolean };
type Day = { date: string; open: boolean; slots: Slot[] };
const days = async (service = acId): Promise<Day[]> => (await pub("GET", `/api/public/slots?service=${service}`)).json().days;
const slotOf = async (i: number, time: string) => (await days())[i]!.slots.find((x) => x.time === time)!;
const free = (d: Day, ...times: string[]) => times.map((t) => d.slots.find((x) => x.time === t)!.free);
const book = (at: string, over: Record<string, unknown> = {}) => pub("POST", "/api/public/bookings",
  { service_id: acId, at, address: "ផ្ទះ 12 ផ្លូវ 271", name: "សុខ ដារ៉ា", phone: "12 345 678", note: "ម៉ាស៊ីន ២ គ្រឿង", consent: true, ts: oldToken(), ...over });
const quote = (over: Record<string, unknown> = {}) => pub("POST", "/api/public/quotes",
  { category: "construction", description: "ចង់ធ្វើពិដានបន្ទប់ទទួលភ្ញៀវ 4×5 ម៉ែត្រ", photos: [], name: "ចាន់ ថា", phone: "+855 11 222 333", location: "សង្កាត់ទួលគោក", consent: true, ts: oldToken(), ...over });
/** a job made by the staff at a slot; with a crew it is assigned (those technicians are busy) */
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
const bookingOf = async (ref: string) => (await sql<Record<string, any>[]>`select b.*, c.name as cname, c.phones, c.consent_at, c.consent_version, c.origin as corigin, c.tg_subscriber_id::text as csub
  from bookings b join customers c on c.id = b.customer_id where b.web_ref = ${ref}`)[0]!;
const requestOf = async (bookingId: string, kind = "booking") => (await sql<Record<string, any>[]>`select * from service_requests where booking_id = ${bookingId} and kind = ${kind} order by created_at desc limit 1`)[0]!;
const linkToken = async (ref: string) => /start=(b-[A-Za-z0-9_-]{20})"/.exec((await page(`/book/done/${ref}`)).body)?.[1] ?? null;
/** the Telegram Login Widget comes back to /my/auth — the hub (stub) says who it is */
async function tgLogin(hash: string): Promise<Client> {
  const c = client(app);
  await c.req("GET", `/my/auth?id=1&first_name=x&auth_date=${Math.floor(Date.now() / 1000)}&hash=${hash}`);
  return c;
}
const counts = async () => (await sql`select (select count(*) from customers)::int as c, (select count(*) from bookings)::int as b, (select count(*) from service_requests)::int as r`)[0];

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
  setHubTransport(async (_method, path, body) => {
    hubCalls.push({ path, body });
    if (path === "/internal/bot") return { status: 200, json: { username: "Oneteam_app_bot" } };
    if (path === "/internal/tg-login-verify") {
      const who = ({ "good-a": { tg_user: 501, subscriber_id: SUB.a, first_name: "Sok" }, "good-b": { tg_user: 502, subscriber_id: SUB.b, first_name: "Bopha" },
        "good-c": { tg_user: 503, subscriber_id: SUB.c, first_name: "Chan" }, "good-none": { tg_user: 504, subscriber_id: null, first_name: "New" } } as Record<string, object>)[String((body as any).data.hash)];
      return { status: 200, json: who ? { ok: true, ...who } : { ok: false, error: "BAD_SIGNATURE" } };
    }
    if (path === "/internal/tg-verify") return { status: 200, json: (body as any).init_data === "mini-a" ? { ok: true, tg_user: 501, subscriber_id: SUB.a, first_name: "Sok" } : { ok: false, error: "BAD_SIGNATURE" } };
    return { status: 200, json: { ok: true } };
  });
  resetBotCache();
  app = await makeApp();
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password) values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${await hashPassword(PW)}, false)`;
  await sql`update users set is_active = false where username = 'newbie'`; // two technicians work: Kim and Dara
  await sql`update users set telegram_chat_id = ${CHAT.admin}, telegram_user_id = ${CHAT.admin} where id = ${s.users.admin!}`;
  await sql`update users set telegram_chat_id = ${CHAT.gm}, telegram_user_id = ${CHAT.gm} where id = ${s.users.gm01!}`;
  ceo = await loginAs(app, "ceo"); cfo = await loginAs(app, "cfo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  acId = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", name_en: "AC cleaning", kind: "service", category: "mep", unit: "unit", sell_price: 4500 })).json.id;
  camId = (await ceo.req("POST", "/api/catalog", { name_km: "ដំឡើងកាមេរ៉ា", name_en: "Camera installation", kind: "service", category: "camera", unit: "unit", sell_price: 25000 })).json.id;
  productId = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោ PVC", kind: "product", category: "mep", unit: "m", sell_price: 250 })).json.id;
  const off = (await ceo.req("POST", "/api/catalog", { name_km: "សេវាចាស់", kind: "service", category: "mep", unit: "unit", sell_price: 100 })).json.id;
  await ceo.req("POST", `/api/catalog/${off}/active`, { active: false });
  await ceoB.req("POST", "/api/catalog", { name_km: "សេវារបស់ក្រុមហ៊ុន B", kind: "service", category: "mep", unit: "unit", sell_price: 100 });
  custK = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន ចាស់", phones: ["012777888"], zone: "inside" })).json.id;
  custB = (await ceo.req("POST", "/api/customers", { name: "បុប្ផា", phones: ["012666555"], zone: "inside" })).json.id;
  await sql`update customers set tg_subscriber_id = ${SUB.b} where id = ${custB}`;
  expect((await ceo.req("PATCH", "/api/settings/company", { work_days: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(200); // every day is a working day in these tests
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("routing: the customer site at \"/\", the staff app under /app", () => {
  it("\"/\" always shows the customer site — also with a staff session; /site redirects to /; old app paths move under /app", async () => {
    const anon = await page("/");
    expect(anon.statusCode).toBe(200); expect(anon.headers["content-type"]).toContain("text/html");
    expect(anon.body).toContain("ផ្ទះអ្នកត្រូវការជួសជុលអ្វី?"); expect(anon.body).toContain('<html lang="km">');
    const staff = await page("/", { cookie: ceo.cookie! });
    expect(staff.statusCode).toBe(200); expect(staff.body).toContain("ផ្ទះអ្នកត្រូវការជួសជុលអ្វី?"); expect(staff.body).not.toContain("SPA-INDEX");
    for (const u of ["/site", "/site/thanks", "/site/request"]) { const r = await page(u); expect(r.statusCode).toBe(301); expect(r.headers.location).toBe("/"); }
    for (const [from, to] of [["/login", "/app/login"], ["/bookings/abc?x=1", "/app/bookings/abc?x=1"], ["/tg?to=%2Fleave", "/app/tg?to=%2Fleave"], ["/tech/job/1", "/app/tech/job/1"], ["/privacy", "/app/privacy"], ["/app", "/app/"]]) {
      const r = await page(from!); expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(to);
    }
  });

  it("the staff app is served under /app/ only (page fallback there, real 404 elsewhere); the old root service worker retires itself", async () => {
    expect((await page("/app/")).body).toContain("SPA-INDEX");
    expect((await page("/app/bookings/5")).body).toContain("SPA-INDEX");
    expect((await page("/app/assets/app.js")).body).toContain("console.log");
    expect((await page("/app/assets/missing.js")).statusCode).toBe(404);
    expect((await page("/assets/app.js")).statusCode).toBe(404);
    expect((await page("/nothing-here")).statusCode).toBe(404);
    const api = await page("/api/nothing");
    expect(api.statusCode).toBe(404); expect(api.json()).toEqual({ error: "NOT_FOUND" });
    const sw = await page("/sw.js");
    expect(sw.statusCode).toBe(200); expect(String(sw.headers["content-type"])).toContain("javascript"); expect(sw.body).toContain("unregister"); expect(String(sw.headers["cache-control"])).toContain("no-cache");
  });

  it("module off → no website: \"/\" sends everybody to the app; the pages and their API do not exist", async () => {
    config.shop.features = "subscribe";
    const r = await page("/");
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe("/app/");
    for (const u of ["/book", "/quote", "/my", "/robots.txt", `/api/public/slots?service=${acId}`]) expect((await page(u)).statusCode).toBe(404);
    expect((await book(new Date(Date.now() + 86400_000).toISOString())).statusCode).toBe(404);
    config.shop.features = "website,subscribe,reminders";
  });

  it("bot links for staff open the app under /app", async () => {
    await sql`update users set telegram_chat_id = 920001, telegram_user_id = 920001 where id = ${s.users.kim!}`;
    const m = (await internal("tg-start", { chat_id: 920001, tg_user: 920001 })).json();
    expect(m.keyboard.flat().find((b: any) => b.text.includes("សុំច្បាប់")).web_app).toBe("https://oneteam.test/app/tg?to=%2Fleave");
  });
});

describe("prices: «from» price per service (GM, Admin, CEO, CFO only, audited)", () => {
  it("technicians may not set it; the four roles may; every change is in the audit log; another company's service is not found", async () => {
    expect((await kim.req("POST", `/api/catalog/${acId}/from-price`, { from_price: 1500 })).status).toBe(403);
    for (const [who, price] of [[gm, 1200], [admin, 1300], [cfo, 1400], [ceo, 1500]] as const) expect((await who.req("POST", `/api/catalog/${acId}/from-price`, { from_price: price })).status).toBe(200);
    expect((await ceo.req("POST", `/api/catalog/${acId}/from-price`, { from_price: -1 })).status).toBe(400);
    expect((await ceo.req("POST", `/api/catalog/${acId}/from-price`, { from_price: 12.5 })).status).toBe(400);
    expect((await ceoB.req("POST", `/api/catalog/${acId}/from-price`, { from_price: 1 })).status).toBe(404);
    const log = await sql<{ old_data: any; new_data: any; user_id: string }[]>`select old_data, new_data, user_id from audit_log where action = 'catalog.from_price' and row_id = ${acId} order by id`;
    expect(log).toHaveLength(4);
    expect(log.at(-1)).toMatchObject({ old_data: { from_price: 1400 }, new_data: { from_price: 1500 }, user_id: s.users.ceo });
    // the normal catalog form cannot change it
    await ceo.req("POST", "/api/catalog", { id: acId, name_km: "លាងម៉ាស៊ីនត្រជាក់", name_en: "AC cleaning", kind: "service", category: "mep", unit: "unit", sell_price: 4500, from_price: 1 });
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).find((x) => x.id === acId).from_price).toBe(1500);
    // clearing the price sends the service back to «request a quote»
    expect((await gm.req("POST", `/api/catalog/${camId}/from-price`, { from_price: 9900 })).status).toBe(200);
    expect((await gm.req("POST", `/api/catalog/${camId}/from-price`, { from_price: null })).status).toBe(200);
    expect(((await ceo.req("GET", "/api/catalog")).json as any[]).find((x) => x.id === camId).from_price).toBeNull();
  });

  it("the home page: a priced service shows «from $X» and opens the booking; one without a price shows «request a quote» and opens the quote screen; never the sell price, products, inactive or foreign services", async () => {
    const h = (await page("/")).body;
    expect(h).toContain(`href="/book?service=${acId}"`); expect(h).toContain("ចាប់ពី $15"); expect(h).toContain("លាងម៉ាស៊ីនត្រជាក់");
    expect(h).toContain(`href="/quote?service=${camId}"`); expect(h).toContain("ស្នើសុំតម្លៃ"); expect(h).toContain("ដំឡើងកាមេរ៉ា");
    expect(h).not.toContain("ទុយោ PVC"); expect(h).not.toContain("សេវាចាស់"); expect(h).not.toContain("ក្រុមហ៊ុន B"); expect(h).not.toMatch(/\$(45|250|2\.50|25,?000)\b/); // never the sell price
    await ceo.req("POST", `/api/catalog/${acId}/from-price`, { from_price: 1550 });
    expect((await page("/")).body).toContain("ចាប់ពី $15.50");
    await ceo.req("POST", `/api/catalog/${acId}/from-price`, { from_price: 1500 });
    // booking a service without a price is not possible: the visitor lands on the quote screen
    const r = await page(`/book?service=${camId}`);
    expect(r.statusCode).toBe(302); expect(r.headers.location).toBe(`/quote?service=${camId}`);
    expect((await page(`/book?service=${productId}`)).headers.location).toBe("/");
  });

  it("one language per page: Khmer by default, English with ?lang=en (remembered), service names from name_en", async () => {
    const km = (await page("/")).body;
    expect(km).toContain("កក់សេវា"); expect(km).toContain("ដំណើរការដោយ"); expect(km).not.toContain("Book a service"); expect(km).not.toContain("AC cleaning");
    const r = await page("/?lang=en");
    expect(String(r.headers["set-cookie"])).toContain("sl=en");
    expect(r.body).toContain('<html lang="en">'); expect(r.body).toContain("Book a service"); expect(r.body).toContain("AC cleaning"); expect(r.body).toContain("From $15"); expect(r.body).toContain("Request a quote"); expect(r.body).toContain("Powered by");
    expect(r.body).not.toContain("កក់សេវា"); expect(r.body).not.toContain("ដំណើរការដោយ"); expect(r.body).not.toContain("លាងម៉ាស៊ីនត្រជាក់");
    expect((await page(`/book?service=${acId}`, { cookie: "sl=en" })).body).toContain("Choose a time");
    expect((await page(`/book?service=${acId}`)).body).toContain("ជ្រើសម៉ោង");
  });
});

describe("time slots: only when a technician is free (booking rules R1–R5)", () => {
  it("7 days from today, one slot per hour inside the working hours for the service's length; closed days and holidays have no slots; nothing in the past", async () => {
    const d = await days();
    expect(d).toHaveLength(7);
    expect(d[2]!.slots.map((x) => x.time)).toEqual(["08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00", "15:00"]); // 07:30–17:30, 120 min
    expect(d[2]!.open).toBe(true); expect(d[2]!.slots.every((x) => x.free)).toBe(true);
    for (const x of d[0]!.slots) if (new Date(x.at).getTime() < Date.now() + 60 * 60_000) expect(x.free).toBe(false); // today: at least an hour ahead
    await ceo.req("PATCH", "/api/settings/company", { holidays: [d[1]!.date] });
    const closed = (await days())[1]!;
    expect(closed.open).toBe(false); expect(closed.slots.every((x) => !x.free)).toBe(true);
    await ceo.req("PATCH", "/api/settings/company", { holidays: [] });
    expect((await code(pub("GET", `/api/public/slots?service=${camId}`)))).toEqual([404, "SERVICE_NOT_BOOKABLE"]); // no price → no online booking
    expect((await code(pub("GET", `/api/public/slots?service=${productId}`)))).toEqual([404, "SERVICE_NOT_BOOKABLE"]);
    const pageHtml = (await page(`/book?service=${acId}`)).body;
    expect(pageHtml).toContain("ចាប់ពី $15 · ប្រហែល ២ ម៉ោង"); expect(pageHtml).toContain(`data-at="${d[2]!.slots[1]!.at}"`); expect(pageHtml).toContain("បង្ហាញតែម៉ោងជាងទំនេរ");
  });

  it("no overlap: a slot is offered while at least one technician is free for the whole job; jobs waiting for a technician take one each", async () => {
    const d = (await days())[2]!;
    const at = (t: string) => d.slots.find((x) => x.time === t)!.at;
    await staffJob(at("09:00"), [s.users.kim!]);            // Kim 09:00–11:00
    expect(free((await days())[2]!, "08:00", "09:00", "10:00", "11:00")).toEqual([true, true, true, true]); // Dara is still free
    await staffJob(at("10:00"), [s.users.dara!]);           // Dara 10:00–12:00
    expect(free((await days())[2]!, "08:00", "09:00", "10:00", "11:00", "12:00")).toEqual([true, false, false, true, true]);
    await staffJob(at("13:00"));                            // not assigned yet → holds one technician 13:00–15:00
    expect(free((await days())[2]!, "13:00", "14:00")).toEqual([true, true]);
    await staffJob(at("14:00"));                            // a second one 14:00–16:00
    expect(free((await days())[2]!, "12:00", "13:00", "14:00", "15:00")).toEqual([true, false, false, true]);
  });

  it("leave / absence: a technician on approved leave is not counted", async () => {
    const d = (await days())[3]!;
    await leave(kim, d.date);
    expect(free((await days())[3]!, "08:00", "09:00")).toEqual([true, true]); // Dara works
    await staffJob(d.slots.find((x) => x.time === "09:00")!.at, [s.users.dara!]);
    expect(free((await days())[3]!, "08:00", "09:00", "10:00", "11:00")).toEqual([false, false, false, true]);
  });
});

let ref1: string, bk1: string;
describe("online booking: consent, hold, race", () => {
  it("the consent tick is required; bad input is refused; nothing is saved", async () => {
    const dara = await loginAs(app, "dara");
    await leave(dara, (await days())[4]!.date); // day 4: only Kim works
    const at = (await slotOf(4, "09:00")).at;
    const n0 = await counts();
    expect(await code(book(at, { consent: false }))).toEqual([400, "CONSENT_REQUIRED"]);
    expect(await code(book(at, { consent: undefined }))).toEqual([400, "CONSENT_REQUIRED"]);
    expect(await code(book(at, { phone: "12 34" }))).toEqual([400, "INVALID_PHONE"]);
    expect(await code(book(at, { name: " " }))).toEqual([400, "NAME_REQUIRED"]);
    expect(await code(book(at, { address: "" }))).toEqual([400, "ADDRESS_REQUIRED"]);
    expect(await code(book(at, { service_id: camId }))).toEqual([404, "SERVICE_NOT_BOOKABLE"]);
    expect(await code(book(at, { ts: "1.aaaaaaaaaaaaaaaaaaaaaa" }))).toEqual([400, "FORM_EXPIRED"]);
    expect(await code(book(new Date(new Date(at).getTime() + 30 * 60_000).toISOString()))).toEqual([400, "SLOT_INVALID"]); // 09:30 is not a slot
    expect(await code(book(new Date(Date.now() - 3600_000).toISOString()))).toEqual([400, "SLOT_INVALID"]);
    expect((await book(at, { company_url: "http://spam.example" })).json()).toEqual({ ref: null }); // a bot filled the hidden field
    expect(await counts()).toEqual(n0);
  });

  it("a valid booking: «pending», the slot is held, the customer is saved with the consent time, Admin + GM are told, it is in «customer requests»", async () => {
    const s0 = await slotOf(4, "09:00");
    const r = await book(s0.at);
    expect(r.statusCode).toBe(200);
    const { ref, number } = r.json() as { ref: string; number: string };
    expect(number).toMatch(/^BK-\d{4}$/); expect(ref).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const b = await bookingOf(ref);
    ref1 = ref; bk1 = b.id;
    expect(b).toMatchObject({ status: "new", origin: "website", web_status: "pending", number, service_item_id: acId, created_by: null, address: "ផ្ទះ 12 ផ្លូវ 271", notes: "ម៉ាស៊ីន ២ គ្រឿង",
      cname: "សុខ ដារ៉ា", phones: ["012345678"], corigin: "website", csub: null, consent_version: SITE_CONSENT_VERSION });
    expect(new Date(b.scheduled_at).toISOString()).toBe(s0.at);
    expect(new Date(b.ends_at).getTime() - new Date(b.scheduled_at).getTime()).toBe(120 * 60_000);
    expect(b.consent_at).toBeTruthy();
    const rq = await requestOf(b.id);
    expect(rq).toMatchObject({ kind: "booking", source: "website", status: "new", name: "សុខ ដារ៉ា", phone: "012345678" });
    expect(rq.meta.consent).toMatchObject({ version: SITE_CONSENT_VERSION }); expect(rq.meta.consent.at).toBeTruthy();
    for (const u of ["admin", "gm01"]) expect((await sql`select title, link from notifications where kind = 'service.request' and user_id = ${s.users[u]!} order by id desc limit 1`)[0]).toMatchObject({ link: "/requests" });
    expect((await sql`select 1 from notifications where kind = 'service.request' and user_id = ${s.users.kim!}`).length).toBe(0);
    expect((await sql`select 1 from telegram_outbox where chat_id = ${CHAT.admin} and text like ${"%" + number + "%"}`).length).toBe(1); // …and in the bot
    // held: Kim is the only technician that day → this slot and the ones that overlap it are gone
    const d = (await days())[4]!;
    expect(free(d, "08:00", "09:00", "10:00", "11:00")).toEqual([false, false, false, true]);
    expect(await code(book(s0.at, { phone: "011222333", name: "អ្នកផ្សេង" }))).toEqual([409, "SLOT_TAKEN"]);
    const item = ((await admin.req("GET", "/api/requests")).json as any[]).find((x) => x.booking_id === b.id);
    expect(item).toMatchObject({ kind: "booking", booking_number: number, web_status: "pending", customer_name: "សុខ ដារ៉ា" });
    expect((await kim.req("GET", "/api/requests")).status).toBe(403);
    expect(((await ceoB.req("GET", "/api/requests")).json as any[])).toHaveLength(0);
  });

  it("race: two visitors send the last free slot at the same moment → exactly one booking, the other is told the slot is taken", async () => {
    const at = (await slotOf(4, "13:00")).at;
    const [a, b] = await Promise.all([book(at, { phone: "011000001", name: "ក" }), book(at, { phone: "011000002", name: "ខ" })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect([a, b].find((x) => x.statusCode === 409)!.json().error).toBe("SLOT_TAKEN");
    expect((await sql`select count(*)::int as n from bookings where scheduled_at = ${at} and status <> 'cancelled'`)[0]!.n).toBe(1);
  });

  it("a known phone number books under the existing customer — no duplicate, the customer's own name stays", async () => {
    const n0 = (await counts())!.c;
    const r = await book((await slotOf(4, "15:00")).at, { phone: "012 777 888", name: "ឈ្មោះក្លែង" });
    expect(r.statusCode).toBe(200);
    const b = await bookingOf(r.json().ref);
    expect(b.customer_id).toBe(custK); expect(b.cname).toBe("អតិថិជន ចាស់"); expect(b.corigin).toBe("staff"); expect(b.consent_at).toBeTruthy();
    expect((await counts())!.c).toBe(n0);
    expect((await requestOf(b.id)).name).toBe("ឈ្មោះក្លែង"); // what the visitor typed stays on the request
  });

  it("rate limit: the 6th booking of one visitor within an hour is refused", async () => {
    const d = (await days())[6]!;
    for (let i = 0; i < 5; i++) expect((await book(d.slots[i]!.at, { phone: `01155500${i}`, name: `ភ្ញៀវ ${i}` })).statusCode).toBe(200);
    expect(await code(book(d.slots[6]!.at, { phone: "011555006", name: "ភ្ញៀវ 6" }))).toEqual([429, "RATE_LIMITED"]);
  });
});

describe("«request sent» screen + the single-use Telegram link", () => {
  it("shows number, status, service and time — no personal data — and the one-click link t.me/<bot>?start=b-<token>", async () => {
    const r = await page(`/book/done/${ref1}`);
    expect(r.statusCode).toBe(200);
    const b = await bookingOf(ref1);
    expect(r.body).toContain(`#${b.number}`); expect(r.body).toContain("រង់ចាំបញ្ជាក់"); expect(r.body).toContain("លាងម៉ាស៊ីនត្រជាក់"); expect(r.body).toContain("09:00"); expect(r.body).toContain("ភ្ជាប់ Telegram (១ ចុច)");
    expect(r.body).toMatch(/href="https:\/\/t\.me\/Oneteam_app_bot\?start=b-[A-Za-z0-9_-]{20}"/);
    expect(r.body).not.toContain("សុខ ដារ៉ា"); expect(r.body).not.toContain("012345678"); expect(r.body).not.toContain("ផ្លូវ 271"); expect(r.body).toContain('content="noindex,nofollow"');
    expect((await page("/book/done/AAAAAAAAAAAAAAAAAAAAAA")).statusCode).toBe(404);
  });

  it("the token works once: the first chat is linked to this booking, a second use is refused; unknown and expired tokens are refused", async () => {
    const token = (await linkToken(ref1))!;
    expect(token).toBeTruthy();
    expect((await internal("customer-subscribed", { code: token, subscriber_id: SUB.a })).json()).toMatchObject({ ok: true, booking: (await bookingOf(ref1)).number });
    expect(Number((await bookingOf(ref1)).web_subscriber_id)).toBe(SUB.a);
    expect((await bookingOf(ref1)).csub).toBeNull(); // the customer record itself is linked when the staff confirm (they called the number)
    expect((await internal("customer-subscribed", { code: token, subscriber_id: SUB.b })).json()).toMatchObject({ ok: false, error: "CODE_USED" });
    expect(Number((await bookingOf(ref1)).web_subscriber_id)).toBe(SUB.a);
    expect((await internal("customer-subscribed", { code: "b-AAAAAAAAAAAAAAAAAAAA", subscriber_id: SUB.b })).json()).toMatchObject({ ok: false, error: "CODE_INVALID" });
    const done = (await page(`/book/done/${ref1}`)).body;
    expect(done).not.toContain("start=b-"); expect(done).toContain("បានភ្ជាប់ Telegram");
    // an expired token
    const other = (await sql<{ web_ref: string; id: string }[]>`select web_ref, id from bookings where origin = 'website' and id <> ${bk1} order by created_at limit 1`)[0]!;
    const t2 = (await linkToken(other.web_ref))!;
    await sql`update booking_link_tokens set expires_at = now() - interval '1 minute' where booking_id = ${other.id}`;
    expect((await internal("customer-subscribed", { code: t2, subscriber_id: SUB.b })).json()).toMatchObject({ ok: false, error: "CODE_INVALID" });
    expect((await page(`/book/done/${other.web_ref}`)).body).not.toContain("start=b-");
    await sql`update booking_link_tokens set expires_at = now() + interval '1 day' where booking_id = ${other.id}`;
  });
});

describe("Admin / GM confirm or decline (app and bot)", () => {
  it("confirm: only staff who take bookings; the booking is confirmed, the request is done, the customer is told on Telegram and linked", async () => {
    const rq = await requestOf(bk1);
    expect((await kim.req("POST", `/api/requests/${rq.id}/confirm`)).status).toBe(403);
    expect((await ceoB.req("POST", `/api/requests/${rq.id}/confirm`)).status).toBe(404);
    hubCalls.length = 0;
    expect((await admin.req("POST", `/api/requests/${rq.id}/confirm`)).status).toBe(200);
    const b = await bookingOf(ref1);
    expect(b).toMatchObject({ status: "new", web_status: "confirmed", web_decided_by: s.users.admin }); expect(Number(b.csub)).toBe(SUB.a);
    expect(await requestOf(bk1)).toMatchObject({ status: "done", outcome: "confirmed", handled_by: s.users.admin });
    expect(told(SUB.a).join("\n")).toContain(b.number); expect(told(SUB.a).join("\n")).toContain("បានបញ្ជាក់");
    expect((await admin.req("POST", `/api/requests/${rq.id}/confirm`)).status).toBe(404); // once
    expect((await page(`/book/done/${ref1}`)).body).toContain("បានបញ្ជាក់");
    expect((await sql`select 1 from audit_log where action = 'booking.web_confirm' and row_id = ${bk1}`).length).toBe(1);
  });

  it("decline needs a reason; the booking is cancelled with it and the slot is free again", async () => {
    const s0 = await slotOf(5, "09:00");
    const ref = (await book(s0.at, { phone: "011333444", name: "វណ្ណា" })).json().ref as string;
    const b = await bookingOf(ref);
    const rq = await requestOf(b.id);
    expect(await code(app.inject({ method: "POST", url: `/api/requests/${rq.id}/decline`, headers: { cookie: gm.cookie!, "content-type": "application/json" }, payload: JSON.stringify({ reason: "" }) }))).toEqual([400, "REASON_REQUIRED"]);
    expect((await gm.req("POST", `/api/requests/${rq.id}/decline`, { reason: "ជាងមិនទំនេរថ្ងៃនោះ" })).status).toBe(200);
    expect(await bookingOf(ref)).toMatchObject({ status: "cancelled", web_status: "declined", cancel_reason: "ជាងមិនទំនេរថ្ងៃនោះ" });
    expect(await requestOf(b.id)).toMatchObject({ status: "done", outcome: "declined" });
    expect((await page(`/book/done/${ref}`)).body).toContain("មិនអាចទទួលបាន");
    expect((await slotOf(5, "09:00")).free).toBe(true);
  });

  it("in the bot: the request list shows web bookings with ✅ / ❌; confirm works from the bot; decline asks for the reason first", async () => {
    const r1 = (await book((await slotOf(5, "10:00")).at, { phone: "011333555", name: "សុភា" })).json().ref as string;
    const r2 = (await book((await slotOf(5, "13:00")).at, { phone: "011333666", name: "រតនា" })).json().ref as string;
    const [q1, q2] = [await requestOf((await bookingOf(r1)).id), await requestOf((await bookingOf(r2)).id)];
    const list = (await internal("tg-menu", { chat_id: CHAT.admin, view: "req" })).json().menu;
    expect(list.text).toContain((await bookingOf(r1)).number); expect(list.text).toContain("សុភា");
    const btns = (list.buttons as any[][]).flat();
    expect(btns.some((b) => b.view === "req" && b.id === q1.id && b.arg === "confirm")).toBe(true);
    expect(btns.some((b) => b.view === "req" && b.id === q2.id && b.arg === "decline")).toBe(true);
    await internal("tg-menu", { chat_id: 920001, view: "req", id: q1.id, arg: "confirm" }); // Kim (technician) has no such menu
    expect((await bookingOf(r1)).web_status).toBe("pending");
    await internal("tg-menu", { chat_id: CHAT.admin, view: "req", id: q1.id, arg: "confirm" });
    expect(await bookingOf(r1)).toMatchObject({ web_status: "confirmed", web_decided_by: s.users.admin });
    const ask = (await internal("tg-menu", { chat_id: CHAT.gm, view: "req", id: q2.id, arg: "decline" })).json().menu;
    expect(ask.text).toContain("មូលហេតុ");
    expect((await bookingOf(r2)).web_status).toBe("pending");
    await internal("tg-text", { chat_id: CHAT.gm, tg_user: CHAT.gm, text: "ក្រៅតំបន់សេវា" });
    expect(await bookingOf(r2)).toMatchObject({ status: "cancelled", web_status: "declined", cancel_reason: "ក្រៅតំបន់សេវា", web_decided_by: s.users.gm01 });
  });

  it("when a technician is assigned, the customer hears who is coming", async () => {
    hubCalls.length = 0;
    expect((await gm.req("POST", `/api/bookings/${bk1}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    expect(told(SUB.a).join("\n")).toContain("Kim");
  });
});

describe("quote request (services without a price) with photos", () => {
  it("the screen: category chips, the service's category preselected, photo limit, the same consent", async () => {
    const h = (await page(`/quote?service=${camId}`)).body;
    expect(h).toContain("ស្នើសុំតម្លៃ"); expect(h).toContain("ប្រភេទការងារ"); expect(h).toContain("(អតិបរមា 5)"); expect(h).toContain("ផ្ញើសំណើតម្លៃ");
    expect(h).toMatch(/data-cat="camera"[^>]*aria-pressed="true"/); expect(h).toContain("ខ្ញុំយល់ព្រមឲ្យ One Team រក្សាទុក ឈ្មោះ លេខទូរស័ព្ទ និងទីតាំងរបស់ខ្ញុំ ក្នុងបញ្ជីអតិថិជន។");
  });

  it("consent, description, at most 5 real images; the request goes to the GM with the photos — stored without camera position or comments", async () => {
    const n0 = (await counts())!.r;
    expect(await code(quote({ consent: false }))).toEqual([400, "CONSENT_REQUIRED"]);
    expect(await code(quote({ description: " " }))).toEqual([400, "DESCRIPTION_REQUIRED"]);
    expect(await code(quote({ phone: "abc" }))).toEqual([400, "INVALID_PHONE"]);
    expect(await code(quote({ photos: [PNG, PNG, PNG, PNG, PNG, PNG] }))).toEqual([400, "TOO_MANY_PHOTOS"]);
    expect(await code(quote({ photos: [Buffer.from("<script>alert(1)</script>").toString("base64")] }))).toEqual([400, "BAD_IMAGE"]);
    expect((await counts())!.r).toBe(n0);
    const before = (await sql`select count(*)::int as n from notifications where kind = 'service.request' and user_id = ${s.users.admin!}`)[0]!.n;
    const r = await quote({ photos: [JPEG, PNG_META], lat: 11.5564, lng: 104.9282 });
    expect(r.statusCode).toBe(200); expect(r.json()).toEqual({ ok: true });
    const rq = (await sql<Record<string, any>[]>`select * from service_requests where kind = 'quote' order by created_at desc limit 1`)[0]!;
    expect(rq).toMatchObject({ source: "website", status: "new", name: "ចាន់ ថា", phone: "011222333", booking_id: null });
    expect(rq.text).toContain("សំណង់"); expect(rq.text).toContain("ពិដាន"); expect(rq.text).toContain("ទួលគោក");
    expect(rq.meta).toMatchObject({ category: "construction", lat: 11.5564, lng: 104.9282 }); expect(rq.meta.consent.at).toBeTruthy();
    expect((await sql`select 1 from notifications where kind = 'service.request' and user_id = ${s.users.gm01!} and title like '%តម្លៃ%'`).length).toBe(1);
    expect((await sql`select count(*)::int as n from notifications where kind = 'service.request' and user_id = ${s.users.admin!}`)[0]!.n).toBe(before); // a quote goes to the GM
    const files = await sql<{ id: string; path: string; mime: string }[]>`select id, path, mime from service_request_files where request_id = ${rq.id} order by created_at, id`;
    expect(files.map((f) => f.mime).sort()).toEqual(["image/jpeg", "image/png"]);
    const jpg = readFileSync(join(config.uploadsDir, files.find((f) => f.mime === "image/jpeg")!.path));
    for (const secret of ["Exif", "GPS-SECRET", "XMP-SECRET", "IPTC-SECRET", "COMMENT-SECRET"]) expect(jpg.includes(secret)).toBe(false);
    expect(jpg.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8])); expect(jpg.includes("JFIF")).toBe(true); expect(jpg.includes(SCAN)).toBe(true); expect(jpg.subarray(-2)).toEqual(Buffer.from([0xff, 0xd9]));
    const pngOut = readFileSync(join(config.uploadsDir, files.find((f) => f.mime === "image/png")!.path));
    expect(pngOut.includes("PNG-TEXT-SECRET")).toBe(false); expect(pngOut.includes("PNG-EXIF-SECRET")).toBe(false); expect(pngOut.includes("IDAT")).toBe(true); expect(pngOut.includes("IEND")).toBe(true);
    // the photos are for the staff only
    const item = ((await gm.req("GET", "/api/requests")).json as any[]).find((x) => x.id === rq.id);
    expect(item.kind).toBe("quote"); expect(item.photos).toHaveLength(2);
    const img = await page(`/api/requests/${rq.id}/photos/${files[0]!.id}`, { cookie: gm.cookie! });
    expect(img.statusCode).toBe(200); expect(String(img.headers["content-type"])).toMatch(/^image\//);
    expect((await page(`/api/requests/${rq.id}/photos/${files[0]!.id}`)).statusCode).toBe(401);
    expect((await page(`/api/requests/${rq.id}/photos/${files[0]!.id}`, { cookie: kim.cookie! })).statusCode).toBe(403);
    expect((await page(`/api/requests/${rq.id}/photos/${files[0]!.id}`, { cookie: ceoB.cookie! })).statusCode).toBe(404);
    expect((await page(`/pub/img/${files[0]!.id}`)).statusCode).toBe(404); // never public
    expect((await gm.req("POST", `/api/requests/${rq.id}/done`)).status).toBe(200);
  });
});

describe("customer home: Telegram login, own data only", () => {
  let bkB: string, closedB: string, bkC: string, refC: string;
  let A: Client, B: Client;
  it("without a session: the Telegram Login Widget of the shop's own bot; a wrong signature, or a Telegram account without any link, gets no session", async () => {
    const r = await page("/my");
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('src="https://telegram.org/js/telegram-widget.js?22"'); expect(r.body).toContain('data-telegram-login="Oneteam_app_bot"'); expect(r.body).toContain('data-auth-url="https://oneteam.test/my/auth"');
    expect((await pub("GET", "/api/my")).statusCode).toBe(401);
    expect((await page("/api/my", { cookie: ceo.cookie! })).statusCode).toBe(401); // a staff session is not a customer session
    hubCalls.length = 0;
    const bad = await page(`/my/auth?id=501&first_name=Sok&auth_date=${Math.floor(Date.now() / 1000)}&hash=forged`);
    expect(bad.statusCode).toBe(302); expect(bad.headers.location).toBe("/my?e=auth"); expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(hubCalls.find((c) => c.path === "/internal/tg-login-verify")!.body.data).toMatchObject({ id: "501", first_name: "Sok", hash: "forged" }); // the hub checks the hash with the bot token
    const none = await page(`/my/auth?id=504&auth_date=${Math.floor(Date.now() / 1000)}&hash=good-none`);
    expect(none.headers.location).toBe("/my?e=nolink"); expect(none.headers["set-cookie"]).toBeUndefined();
    expect((await pub("POST", "/api/public/tg-login", { init_data: "forged" })).statusCode).toBe(401);
  });

  it("logged in: the upcoming booking with status and technician, past jobs with the warranty end and «book again» — and nothing of other customers", async () => {
    // customer B (linked by the staff link): one upcoming job + one closed job
    bkB = await staffJob((await slotOf(5, "15:00")).at, [s.users.dara!], custB);
    closedB = await staffJob((await slotOf(6, "15:00")).at, [s.users.dara!], custB);
    await sql`update bookings set service_item_id = ${acId} where id = ${closedB}`;
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${closedB}`;
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: closedB, lines: [{ description: "លាង", kind: "service", qty: 1, unit: "job", unit_price: 1500 }] })).json.id;
    await admin.req("POST", `/api/invoices/${inv}/issue`);
    await admin.req("POST", `/api/invoices/${inv}/payments`, { amount: 1500, currency: "usd", method: "cash_usd" });
    expect((await ceo.req("GET", `/api/bookings/${closedB}`)).json.status).toBe("closed");
    A = await tgLogin("good-a"); B = await tgLogin("good-b");
    expect(A.cookie).toMatch(/^otc=/); expect(B.cookie).toMatch(/^otc=/);
    const a = (await A.req("GET", "/api/my")).json;
    expect(a.name).toBe("សុខ ដារ៉ា");
    expect(a.upcoming.map((x: any) => x.id)).toEqual([bk1]); expect(a.upcoming[0]).toMatchObject({ status: "confirmed", technician: "Kim", can_cancel: true, can_reschedule: true }); expect(a.past).toEqual([]);
    const b = (await B.req("GET", "/api/my")).json;
    expect(b.upcoming.map((x: any) => x.id)).toEqual([bkB]); expect(b.past.map((x: any) => x.id)).toEqual([closedB]);
    expect(b.past[0].warranty).toMatchObject({ active: true }); expect(b.past[0].rebook).toBe(`/book?service=${acId}`);
    expect(JSON.stringify(a)).not.toContain(bkB); expect(JSON.stringify(b)).not.toContain(bk1); expect(JSON.stringify(a)).not.toMatch(/sell_price|012666555|បុប្ផា/);
    const html = (await page("/my", { cookie: A.cookie! })).body;
    expect(html).toContain("សួស្តី"); expect(html).toContain("សុខ ដារ៉ា"); expect(html).toContain(`#${(await bookingOf(ref1)).number}`); expect(html).toContain("បានបញ្ជាក់"); expect(html).toContain("ជាង Kim");
    expect(html).toContain("ស្នើប្ដូរម៉ោង"); expect(html).toContain("កក់សេវាថ្មី"); expect(html).not.toContain("បុប្ផា");
    const htmlB = (await page("/my", { cookie: B.cookie! })).body;
    expect(htmlB).toContain("ធានាដល់"); expect(htmlB).toContain("កក់ម្ដងទៀត"); expect(htmlB).toContain(`href="/book?service=${acId}"`);
  });

  it("IDOR: a customer cannot read, cancel or move another customer's booking", async () => {
    expect((await A.req("POST", `/api/my/bookings/${bkB}/cancel`, { reason: "សាកល្បង" })).status).toBe(404);
    expect((await A.req("POST", `/api/my/bookings/${bkB}/reschedule`, { at: (await slotOf(6, "08:00")).at, reason: "សាកល្បង" })).status).toBe(404);
    expect((await A.req("GET", `/api/my/bookings/${bkB}/slots`)).status).toBe(404);
    expect((await A.req("GET", `/api/bookings/${bkB}`)).status).toBe(401); // the staff API does not know a customer session
    expect((await B.req("POST", `/api/my/bookings/${bk1}/cancel`, { reason: "សាកល្បង" })).status).toBe(404);
    expect((await sql`select status from bookings where id in (${bkB}, ${bk1})`).map((x) => x.status)).toEqual(["assigned", "assigned"]);
    expect((await sql`select 1 from service_requests where kind = 'reschedule'`).length).toBe(0);
  });

  it("a known phone number does not open that customer's history: the chat sees only the booking it made until the staff confirm", async () => {
    await staffJob((await slotOf(1, "08:00")).at, [], custK); // custK has other jobs
    refC = (await book((await slotOf(5, "11:00")).at, { phone: "012777888", name: "មិនមែនម្ចាស់" })).json().ref;
    bkC = (await bookingOf(refC)).id;
    expect((await internal("customer-subscribed", { code: (await linkToken(refC))!, subscriber_id: SUB.c })).json()).toMatchObject({ ok: true });
    const C = await tgLogin("good-c");
    const c = (await C.req("GET", "/api/my")).json;
    expect(c.upcoming.map((x: any) => x.id)).toEqual([bkC]); expect(c.upcoming[0].status).toBe("pending");
    expect(c.name).toBe("Chan"); // the Telegram name, not the customer record's
    expect(JSON.stringify(c)).not.toContain("អតិថិជន ចាស់");
    expect((await sql`select tg_subscriber_id from customers where id = ${custK}`)[0]!.tg_subscriber_id).toBeNull();
    expect((await admin.req("POST", `/api/requests/${(await requestOf(bkC)).id}/confirm`)).status).toBe(200); // the staff called the number
    expect(Number((await sql`select tg_subscriber_id::text as t from customers where id = ${custK}`)[0]!.t)).toBe(SUB.c);
    expect(((await C.req("GET", "/api/my")).json.upcoming as any[]).length).toBeGreaterThan(1);
  });

  it("reschedule is a REQUEST (requested_by = customer): the time moves only when the staff approve; one open request per booking", async () => {
    const target = await slotOf(6, "08:00");
    const mine = (await A.req("GET", `/api/my/bookings/${bk1}/slots`)).json.days as Day[];
    expect(mine).toHaveLength(7); expect(mine[6]!.slots.find((x) => x.time === "08:00")!.free).toBe(true);
    expect((await A.req("POST", `/api/my/bookings/${bk1}/reschedule`, { at: new Date(Date.now() - 1000).toISOString(), reason: "x" })).status).toBe(400);
    const before = (await bookingOf(ref1)).scheduled_at;
    expect((await A.req("POST", `/api/my/bookings/${bk1}/reschedule`, { at: target.at, reason: "ជាប់ធ្វើការ" })).status).toBe(200);
    expect((await bookingOf(ref1)).scheduled_at).toEqual(before);
    const rq = await requestOf(bk1, "reschedule");
    expect(rq).toMatchObject({ kind: "reschedule", source: "website", status: "new" }); expect(rq.meta).toMatchObject({ requested_by: "customer", new_start: target.at, reason: "ជាប់ធ្វើការ" });
    expect((await sql`select 1 from notifications where kind = 'service.request' and user_id = ${s.users.gm01!} and title like '%ប្ដូរម៉ោង%'`).length).toBe(1);
    expect(await code(app.inject({ method: "POST", url: `/api/my/bookings/${bk1}/reschedule`, headers: { cookie: A.cookie!, "content-type": "application/json" }, payload: JSON.stringify({ at: target.at, reason: "ម្ដងទៀត" }) }))).toEqual([409, "ALREADY_REQUESTED"]);
    expect(((await A.req("GET", "/api/my")).json.upcoming as any[]).find((x) => x.id === bk1).reschedule_pending).toBe(true);
    hubCalls.length = 0;
    expect((await kim.req("POST", `/api/requests/${rq.id}/approve`)).status).toBe(403);
    expect((await admin.req("POST", `/api/requests/${rq.id}/approve`)).status).toBe(200);
    expect(new Date((await bookingOf(ref1)).scheduled_at).toISOString()).toBe(target.at);
    expect((await sql`select requested_by, reason from booking_reschedules where booking_id = ${bk1} order by id desc limit 1`)[0]).toMatchObject({ requested_by: "customer", reason: "ជាប់ធ្វើការ" });
    expect(await requestOf(bk1, "reschedule")).toMatchObject({ status: "done", outcome: "approved" });
    expect(told(SUB.a).join("\n")).toContain("08:00");
    // a second request, rejected: the time stays
    expect((await A.req("POST", `/api/my/bookings/${bk1}/reschedule`, { at: (await slotOf(6, "10:00")).at, reason: "ចង់ប្ដូរទៀត" })).status).toBe(200);
    expect((await gm.req("POST", `/api/requests/${(await requestOf(bk1, "reschedule")).id}/reject`, { reason: "ជាងមិនទំនេរ" })).status).toBe(200);
    expect(new Date((await bookingOf(ref1)).scheduled_at).toISOString()).toBe(target.at);
    expect(await requestOf(bk1, "reschedule")).toMatchObject({ status: "done", outcome: "rejected" });
  });

  it("cancel needs a reason; the booking is cancelled (never deleted), the staff are told; Mini App login and logout", async () => {
    expect(await code(app.inject({ method: "POST", url: `/api/my/bookings/${bk1}/cancel`, headers: { cookie: A.cookie!, "content-type": "application/json" }, payload: JSON.stringify({ reason: "" }) }))).toEqual([400, "REASON_REQUIRED"]);
    expect((await A.req("POST", `/api/my/bookings/${bk1}/cancel`, { reason: "ជួសជុលរួចហើយ" })).status).toBe(200);
    const b = await bookingOf(ref1);
    expect(b).toMatchObject({ status: "cancelled", cancelled_by: null }); expect(b.cancel_reason).toContain("ជួសជុលរួចហើយ");
    expect((await sql`select 1 from notifications where kind = 'booking.cancelled' and user_id = ${s.users.admin!} and title like ${"%" + b.number + "%"}`).length).toBe(1);
    expect(((await A.req("GET", "/api/my")).json.upcoming as any[]).some((x) => x.id === bk1)).toBe(false);
    expect((await A.req("POST", `/api/my/bookings/${bk1}/cancel`, { reason: "ម្ដងទៀត" })).status).toBe(400); // already cancelled
    // opened inside Telegram (Mini App): the launch data is checked by the hub → the same session
    const mini = client(app);
    expect((await mini.req("POST", "/api/public/tg-login", { init_data: "mini-a" })).status).toBe(200);
    expect(mini.cookie).toMatch(/^otc=/); expect((await mini.req("GET", "/api/my")).json.name).toBe("សុខ ដារ៉ា");
    expect((await mini.req("POST", "/api/my/logout")).status).toBe(200);
    expect((await sql`select count(*)::int as n from customer_sessions where subscriber_id = ${SUB.a}`)[0]!.n).toBe(1); // A's first session is still there
    expect((await A.req("POST", "/api/my/logout")).status).toBe(200);
    expect((await A.req("GET", "/api/my")).status).toBe(401);
  });
});

describe("Settings → Website, indexing, photos (kept from v1)", () => {
  it("CEO only; the texts appear on the home page; Google indexing stays off until the CEO switches it on; booking pages are never indexed", async () => {
    expect((await admin.req("GET", "/api/website")).status).toBe(403);
    expect((await ceo.req("PUT", "/api/website", { facebook: "https://evil.example/x" })).status).toBe(400);
    const h0 = (await page("/")).body;
    expect(h0).toContain('content="noindex,nofollow"'); expect((await page("/robots.txt")).body).toContain("Disallow: /\n");
    expect(h0).toContain(">One Team<"); expect(h0).toContain(">Engineering<"); expect(h0).toContain(">OT<"); // short name + rest of the name + initials
    expect((await ceo.req("PUT", "/api/website", { about_km: "យើងមានបទពិសោធន៍ 10 ឆ្នាំ", highlights_km: ["<b>ជាងជំនាញ</b>"], short_name: "វ័ន ធីម", name_km: "វ័ន ធីម អែនជីនៀរីង",
      phone: "077 632 899 / 015 899 632", address: "បុរីប៉េងហួតបឹងស្នោរ", area_km: "ភ្នំពេញ", hours_km: "ច័ន្ទ–សៅរ៍ 8:00–17:00", facebook: "https://www.facebook.com/oneteam", published: true })).status).toBe(200);
    await ceo.req("PATCH", "/api/settings/company", { office_lat: 11.5564, office_lng: 104.9282 });
    const h = (await page("/")).body;
    for (const x of ["យើងមានបទពិសោធន៍ 10 ឆ្នាំ", "&lt;b&gt;ជាងជំនាញ&lt;/b&gt;", ">វ័ន ធីម<", "អែនជីនៀរីង", "បុរីប៉េងហួតបឹងស្នោរ", "ភ្នំពេញ · ច័ន្ទ–សៅរ៍ 8:00–17:00", 'href="tel:077632899"', "https://www.facebook.com/oneteam",
      "maps.google.com/maps?q=11.5564,104.9282"]) expect(h).toContain(x);
    expect(h).not.toContain("noindex"); expect((await page("/robots.txt")).body).toContain("Allow: /");
    expect((await page(`/book?service=${acId}`)).body).toContain("ខ្ញុំយល់ព្រមឲ្យ វ័ន ធីម រក្សាទុក");
    for (const u of [`/book?service=${acId}`, "/quote", "/my"]) expect((await page(u)).body).toContain('content="noindex,nofollow"');
    expect((await page("/?lang=en")).body).not.toContain("យើងមានបទពិសោធន៍"); // the English page never shows the Khmer texts
    await ceo.req("PUT", "/api/website", { published: false });
    expect((await page("/")).body).toContain("noindex");
    expect((await sql`select 1 from audit_log where action = 'website.update' and company_id = ${s.a}`).length).toBeGreaterThan(1);
  });

  it("photos: only website photos are public; removing one takes it off the page", async () => {
    const g = (await ceo.req("POST", "/api/website/photos", { slot: "gallery", data: PNG })).json.id;
    expect((await admin.req("POST", "/api/website/photos", { slot: "gallery", data: PNG })).status).toBe(403);
    expect((await page("/")).body).toContain(`/pub/img/${g}`);
    const img = await page(`/pub/img/${g}`);
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/png"); expect(String(img.headers["cache-control"])).toContain("public");
    const priv = (await sql<{ id: string }[]>`insert into job_files (company_id, booking_id, kind, path, mime, bytes) select company_id, null, 'receipt'::job_file_kind, path, mime, bytes from job_files where id = ${g} returning id`)[0]!.id;
    expect((await page(`/pub/img/${priv}`)).statusCode).toBe(404);
    expect((await page("/pub/logo")).statusCode).toBe(404); // no logo uploaded
    expect((await ceo.req("DELETE", `/api/website/photos/${g}`)).status).toBe(200);
    expect((await page("/")).body).not.toContain(`/pub/img/${g}`); expect((await page(`/pub/img/${g}`)).statusCode).toBe(404);
    for (const f of ["site.css", "site.js"]) { const r = await page(`/pub/${f}`); expect(r.statusCode).toBe(200); expect(String(r.headers["cache-control"])).toContain("max-age"); }
    expect((await page("/pub/..%2f..%2fpackage.json")).statusCode).toBe(404);
  });
});
