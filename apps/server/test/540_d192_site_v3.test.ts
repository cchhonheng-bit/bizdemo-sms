// D-192 (owner + client 29-10): the customer site in One Team's colours with the FixME frame — header band, banner, round service
// icons, a page per service category (price + quantity per service, the total), the bottom tab bar, «ជំនួយ»; the catalog's
// «តម្លៃថេរ» (an exact price without «from»); photos of the problem on an online booking (cleaned, private, in the staff inbox);
// shop-setup sets «shown on the website» / «quote only» / «fixed price» by code (the client's CCTV off, water + electric by quote).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { client, loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { seedWebCatalog } from "../src/services/catalog.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { formToken } from "../src/services/site.js";
import { WEB_MAX_LINES } from "@sms/shared";

let app: FastifyInstance; let s: Seed; let ceo: Client, admin: Client;
const ID: Record<string, string> = {};
const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const pub = (method: "GET" | "POST", url: string, body?: unknown) =>
  app.inject({ method, url, headers: body === undefined ? {} : { "content-type": "application/json" }, payload: body === undefined ? undefined : JSON.stringify(body) });
const at = async (items: string, day: number, i = 0) => ((await pub("GET", `/api/public/slots?items=${encodeURIComponent(items)}`)).json().days[day].slots as { at: string; free: boolean }[]).filter((x) => x.free)[i]!.at;
// a photo that carries a camera position — the server must keep the picture and drop that
const seg = (marker: number, b: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(b.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, b]); };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), seg(0xe1, Buffer.from("Exif\0\0GPS-SECRET-11.55,104.92", "latin1")),
  seg(0xdb, Buffer.alloc(65, 1)), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00]), Buffer.from([0xff, 0xd9])]).toString("base64");

beforeAll(async () => {
  await resetDb(); s = await seed();
  config.publicUrl = "https://oneteam.test"; config.shop.hubKey = "key-oneteam-0123456789abcdef"; config.shop.hubUrl = "http://hub"; config.shop.features = "website,subscribe,reminders";
  setHubTransport(async (_m, path) => (path === "/internal/bot" ? { status: 200, json: { username: "Oneteam_app_bot" } } : { status: 200, json: { ok: true } }));
  resetBotCache();
  app = await makeApp();
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin");
  await seedWebCatalog(s.a, { prices: true });
  for (const r of await sql<{ id: string; code: string }[]>`select id, code from catalog_items where company_id = ${s.a}`) ID[r.code] = r.id;
  expect((await ceo.req("PATCH", "/api/settings/company", { work_days: [1, 2, 3, 4, 5, 6, 7] })).status).toBe(200);
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-192 the FixME-style site in One Team's colours", () => {
  it("home: the navy band, the banner, one round icon per category (→ its page), the four tabs — no item dropdown any more", async () => {
    const h = (await page("/")).body;
    for (const x of ['class="band tall"', 'id="banner"', 'class="sgrid"', 'href="/s/ac"', 'href="/s/water"', 'class="tabbar"', 'href="/?tab=home" aria-current="page"', 'href="/my/bookings"', 'href="/help"', 'content="#314075"'])
      expect(h, x).toContain(x);
    expect(h).not.toContain('id="lines"'); expect(h).not.toContain("<select");
    // an older link with lines opens the service page of its first line
    const old = await page(`/?items=${ID["AC-CLEAN"]}:2`);
    expect(old.statusCode).toBe(302); expect(old.headers.location).toBe(`/s/ac?items=${ID["AC-CLEAN"]}:2`);
    expect((await page("/s/nothing")).headers.location).toBe("/?tab=home");
    const help = (await page("/help")).body;
    expect(help).toContain('href="/help" aria-current="page"'); expect(help).toContain('href="/guide"');
  });

  it("a category page: every service with its price, a stepper (the link's lines filled in), quote-only rows ask for a quote; the total + «continue»", async () => {
    const p = (await page(`/s/ac?items=${ID["AC-CLEAN"]}:2`)).body;
    expect(p).toContain(`data-id="${ID["AC-CLEAN"]}"`); expect(p).toMatch(new RegExp(`class="pkg on" data-id="${ID["AC-CLEAN"]}"[^]*?<output data-qty>2</output>`));
    expect(p).toContain(`href="/quote?items=${ID["AC-BUY"]}:1"`); expect(p).toContain('id="go"'); expect(p).toContain("ចាប់ពី $15");
    expect(p).toContain(`data-max="${WEB_MAX_LINES}"`);
    const cn = (await page("/s/construction")).body;
    expect(cn).not.toContain('id="go"'); expect(cn).toContain('class="tabbar"'); // only quotes here: no booking bar
    // the booking page's «change» and back arrow lead to the category page with the lines
    const b = (await page(`/book?items=${ID["AC-CLEAN"]}:2`)).body;
    expect(b).toContain(`href="/s/ac?items=${ID["AC-CLEAN"]}:2"`); expect(b).toContain('id="photos"'); expect(b).toContain('data-max="4"'); expect(b).toContain("ពិពណ៌នាបញ្ហា");
  });

  it("«តម្លៃថេរ»: the catalog form saves it (audited); the website shows «$15» instead of «from $15»; a mixed booking still says «from»", async () => {
    const it0 = (await ceo.req("GET", "/api/catalog")).json.find((x: any) => x.id === ID["AC-CLEAN"]);
    const r = await ceo.req("POST", "/api/catalog", { id: it0.id, name_km: it0.name_km, name_en: it0.name_en ?? "", kind: "service", category: it0.category, unit: it0.unit, sell_price: it0.sell_price, duration_min: it0.duration_min, price_fixed: true });
    expect(r.status).toBe(200);
    expect((await sql`select new_data from audit_log where action = 'catalog.upsert' and row_id = ${ID["AC-CLEAN"]!} order by id desc limit 1`)[0]!.new_data).toEqual({ price_fixed: true });
    const p = (await page("/s/ac")).body;
    expect(p).toMatch(new RegExp(`data-id="${ID["AC-CLEAN"]}" data-p="\\d+" data-f="1"`));
    const fixed = (await page(`/book?items=${ID["AC-CLEAN"]}:2`)).body;
    expect(fixed).toMatch(/<span>តម្លៃ \$30 · /); expect(fixed).not.toMatch(/<span>តម្លៃប្រហែល ចាប់ពី/);
    const mixed = (await page(`/book?items=${ID["AC-CLEAN"]}:1,${ID["AC-REPAIR"]}:1`)).body;
    expect(mixed).toMatch(/<span>តម្លៃប្រហែល ចាប់ពី \$/);
    expect((await admin.req("POST", "/api/catalog", { id: it0.id, name_km: it0.name_km, kind: "service", category: it0.category, unit: it0.unit, sell_price: it0.sell_price, price_fixed: false })).status).toBe(200); // the Admin may edit too
  });

  it("photos of the problem on a booking: at most 4, cleaned of the camera position, private, shown to the staff with the request", async () => {
    const items = `${ID["AC-CLEAN"]}:1`;
    const body = (over: Record<string, unknown>) => ({ items, address: "ផ្ទះ 3", name: "ភ្ញៀវ រូបថត", phone: "012 300 400", note: "ទឹកស្រក់", consent: true, ts: formToken(Date.now() - 60_000), ...over });
    expect((await pub("POST", "/api/public/bookings", body({ at: await at(items, 2), photos: [JPEG, JPEG, JPEG, JPEG, JPEG] }))).json().error).toBe("TOO_MANY_PHOTOS");
    expect((await pub("POST", "/api/public/bookings", body({ at: await at(items, 2), photos: [Buffer.from("<svg/>").toString("base64")] }))).json().error).toBe("BAD_IMAGE");
    const r = await pub("POST", "/api/public/bookings", body({ at: await at(items, 2), photos: [JPEG, JPEG] }));
    expect(r.statusCode, r.body).toBe(200);
    const rq = (await sql<{ id: string; text: string; meta: any }[]>`select r.id, r.text, r.meta from service_requests r join bookings b on b.id = r.booking_id where b.web_ref = ${r.json().ref}`)[0]!;
    expect(rq.text).toContain("📷 ២"); expect(rq.meta.photos).toBe(2);
    const files = await sql<{ id: string; path: string }[]>`select id, path from service_request_files where request_id = ${rq.id}`;
    expect(files).toHaveLength(2);
    expect(readFileSync(join(config.uploadsDir, files[0]!.path)).includes("GPS-SECRET")).toBe(false);
    const list = (await admin.req("GET", "/api/requests")).json;
    expect(list.find((x: any) => x.id === rq.id).photos).toHaveLength(2);
    expect((await app.inject({ method: "GET", url: `/api/requests/${rq.id}/photos/${files[0]!.id}`, headers: { cookie: admin.cookie! } })).statusCode).toBe(200);
    expect((await page(`/api/requests/${rq.id}/photos/${files[0]!.id}`)).statusCode).toBe(401);
    expect((await page(`/pub/img/${files[0]!.id}`)).statusCode).toBe(404);
  });

  it("shop-setup by code: CCTV off the website, water + electric by quote, a fixed price — dry run shows it, apply writes it (audited as HangKH Support)", async () => {
    await sql`insert into users (company_id, username, full_name, role, password_hash, is_platform) values (${s.a}, 'support', 'HangKH Support', 'ceo', ${await hashPassword("Support-Pass-2026!")}, true)`;
    const plan = { catalog: [{ code: "CC-INSTALL", show_on_website: false }, { code: "CC-REPAIR", show_on_website: false }, { code: "WT-PIPE", quote_only: true }, { code: "AC-CLEAN", price_fixed: true }] };
    const dry = await shopSetup("oneteam", plan, false);
    expect(dry).toContain("catalog CC-INSTALL: show_on_website true → false"); expect(dry).toContain("catalog WT-PIPE: quote_only false → true"); expect(dry).toContain("catalog AC-CLEAN: price_fixed false → true");
    expect((await page("/")).body).toContain('href="/s/cctv"'); // nothing written by the dry run
    await shopSetup("oneteam", plan, true);
    const home = (await page("/")).body;
    expect(home).not.toContain('href="/s/cctv"');
    const water = (await page("/s/water")).body;
    expect(water).toContain(`href="/quote?items=${ID["WT-PIPE"]}:1"`);
    expect((await sql<{ price_fixed: boolean }[]>`select price_fixed from catalog_items where id = ${ID["AC-CLEAN"]!}`)[0]!.price_fixed).toBe(true);
    const who = await sql<{ full_name: string }[]>`select u.full_name from audit_log a join users u on u.id = a.user_id where a.action = 'catalog.upsert' order by a.id desc limit 1`;
    expect(who[0]!.full_name).toBe("HangKH Support");
  });

  it("the customer's own pages carry the frame too: account and bookings with their tab, the booking page with the band", async () => {
    await sql`update customers set password_hash = ${await hashPassword("4827")} where '+85512300400' = any(phones)`;
    const c = client(app);
    expect((await c.req("POST", "/api/public/login", { phone: "012 300 400", pin: "4827" })).status).toBe(200);
    expect((await page("/my", { cookie: c.cookie! })).body).toContain('href="/my" aria-current="page"');
    expect((await page("/my/bookings", { cookie: c.cookie! })).body).toContain('href="/my/bookings" aria-current="page"');
    expect((await page("/?tab=home", { cookie: c.cookie! })).statusCode).toBe(200); // the Home tab still opens home on a signed-in device
  });
});
