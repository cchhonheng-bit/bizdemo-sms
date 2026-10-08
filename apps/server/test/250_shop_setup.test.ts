// shop-setup (CLI · D-131): a shop's start material through the app's own functions, as its HangKH Support account. A dry run
// writes nothing; --apply sets phone / address / booking hours without a lunch break, the invoice logo, the ACLEDA QR, website
// photos (stored without their metadata), the catalog Excel and a field by code — every change audited as HangKH Support and
// shown on the public page. It never publishes; a bad file stops it before anything is written. D-132: the invoice price / cost by
// code, demo staff turned off with the Users page's own rules, demo customers and bookings marked as tests — never a delete.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { webHours, webSlotStarts } from "@sms/shared";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { writeXlsx } from "../src/lib/xlsx.js";
import { seedWebCatalog } from "../src/services/catalog.js";
import { shopSetup } from "../src/services/shop-setup.js";
import { cancelOldTests } from "../src/services/test-mode.js";
import { loginAs, makeApp, PW, resetDb, seed, type Seed } from "./helpers.js";

const cli = (input: unknown, ...args: string[]) =>
  execFileSync(process.execPath, ["--import", "tsx", join(__dirname, "..", "src", "cli.ts"), "shop-setup", ...args], {
    env: { ...process.env, APP_MODE: "shop" }, encoding: "utf8", timeout: 60_000, input: JSON.stringify(input),
  });
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
// a work photo that still carries the camera position and a comment — the public copy must not
const seg = (marker: number, body: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(body.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, body]); };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")),
  seg(0xe1, Buffer.from("Exif\0\0GPS-SECRET-11.5231,104.9512", "latin1")), seg(0xfe, Buffer.from("COMMENT-SECRET", "latin1")), seg(0xdb, Buffer.alloc(65, 1)),
  seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00, 0x56, 0x78]), Buffer.from([0xff, 0xd9])]).toString("base64");
const HEAD = ["Code", "Category", "Name (Khmer)", "Name (English)", "Unit", "From price ($)", "Duration (min)", "Show on website", "Quote only", "Active"];
const xlsx = (rows: (string | number)[][]) => writeXlsx("Catalog", [HEAD, ...rows]).toString("base64");
const PHONE = "077 632 899 / 015 899 632", ADDRESS = "បុរីប៉េងហួតបឹងស្នោរ ផ្ទះលេខ 111, ផ្លូវ S-01, គម្រោងអេកូសាន់រ៉ាយស៍";
const HOURS = { open: "08:00", close: "17:00", lunch_start: "12:00", lunch_end: "12:00" }; // the same time twice = no lunch break
const setup = () => ({
  website: { phone: PHONE, address: ADDRESS, hours: HOURS },
  logo: PNG, qr: PNG, gallery: [JPEG, PNG],
  // the shop's own Excel (the app's template, prices filled in) …
  catalog_xlsx: xlsx([["AC-CLEAN", "Air conditioner", "លាងម៉ាស៊ីនត្រជាក់", "AC cleaning", "គ្រឿង", 15, 120, "yes", "no", "yes"],
    ["AC-BUY", "Air conditioner", "ចង់ទិញម៉ាស៊ីនត្រជាក់", "Buy an air conditioner", "គ្រឿង", 100, 120, "yes", "yes", "yes"]]),
  // … and the job length it told separately («$15 per unit, 1 hour»)
  catalog: [{ code: "AC-CLEAN", duration_min: 60 }],
});

let app: FastifyInstance; let s: Seed; let support: string;
beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "website"; config.publicUrl = "https://oneteam.test";
  await seedWebCatalog(s.a, { prices: false });
  support = (await sql<{ id: string }[]>`insert into users (company_id, username, full_name, role, password_hash, is_platform)
    values (${s.a}, 'support', 'HangKH Support', 'admin', ${await hashPassword(PW)}, true) returning id`)[0]!.id;
});
afterAll(async () => { await app.close(); });

describe("CLI shop-setup (D-131)", () => {
  it("dry run: every file checked, the plan printed — nothing written", async () => {
    const audits = (await sql`select count(*)::int n from audit_log`)[0]!.n;
    const out = cli(setup(), "oneteam");
    expect(out).toContain("· as HangKH Support (support) · DRY RUN");
    expect(out).toContain(`website phone: — → ${PHONE}`);
    expect(out).toContain(`website address: — → ${ADDRESS}`);
    expect(out).toContain("website photos: 0 → 2 of 12");
    expect(out).toContain("catalog Excel: 0 new · 2 changed · 0 same");
    expect(out).toContain("AC-CLEAN: from_price — → $15.00");
    expect(out).toContain("AC-BUY: from_price — → $100.00");
    expect(out).toContain("catalog AC-CLEAN: duration_min 120 → 60");
    expect(out).not.toContain("applied");
    const st = (await sql<Record<string, unknown>[]>`select company_info, website, logo_path, qr_image_path from company_settings where company_id = ${s.a}`)[0]!;
    expect(st).toEqual({ company_info: {}, website: {}, logo_path: null, qr_image_path: null });
    expect((await sql`select count(*)::int n from catalog_items where from_price is not null or duration_min <> 120`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from job_files`)[0]!.n).toBe(0);
    expect((await sql`select count(*)::int n from audit_log`)[0]!.n).toBe(audits);
  });

  it("--apply: phone, address, hours without lunch, logo, QR, photos without metadata, catalog — each audited as HangKH Support", async () => {
    const out = cli(setup(), "oneteam", "--apply");
    expect(out).toContain("applied ✓");
    expect(out).not.toContain("DRY RUN");
    const st = (await sql<{ company_info: Record<string, string>; website: Record<string, any>; logo_path: string | null; qr_image_path: string | null }[]>`
      select company_info, website, logo_path, qr_image_path from company_settings where company_id = ${s.a}`)[0]!;
    expect(st.company_info).toEqual({ phone: PHONE, address: ADDRESS });
    expect(st.website.hours).toEqual(HOURS);
    expect(st.website.published).toBeUndefined();
    expect(st.logo_path).toBeTruthy(); expect(st.qr_image_path).toBeTruthy();
    expect(st.website.gallery).toHaveLength(2);
    // no lunch break: a one-hour job may start at 12:00; the last start is 16:00
    expect(webSlotStarts(webHours(st.website.hours), 60).map((m) => m / 60)).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const files = await sql<{ path: string; mime: string }[]>`select path, mime from job_files where company_id = ${s.a} and kind = 'website' and deleted_at is null order by created_at`;
    expect(files.map((f) => f.mime)).toEqual(["image/jpeg", "image/png"]);
    const kept = readFileSync(join(config.uploadsDir, files[0]!.path));
    expect(kept.includes("GPS-SECRET")).toBe(false); expect(kept.includes("COMMENT-SECRET")).toBe(false);
    const cat = await sql<Record<string, unknown>[]>`select code, from_price, duration_min, is_sample from catalog_items where company_id = ${s.a} and code in ('AC-BUY', 'AC-CLEAN', 'AC-GAS') order by code`;
    expect(cat).toEqual([
      { code: "AC-BUY", from_price: 10000, duration_min: 120, is_sample: false },
      { code: "AC-CLEAN", from_price: 1500, duration_min: 60, is_sample: false },
      { code: "AC-GAS", from_price: null, duration_min: 120, is_sample: true }]); // not in the file: untouched
    const acts = await sql<{ action: string; user_id: string | null }[]>`select action, user_id from audit_log where company_id = ${s.a} and action <> 'catalog.seed' order by id`;
    expect(acts.map((x) => x.action)).toEqual(["website.update", "settings.logo", "settings.qr", "website.photo", "website.photo", "catalog.import", "catalog.import", "catalog.upsert"]);
    expect(acts.every((x) => x.user_id === support)).toBe(true);
  });

  it("the public page shows the logo, the work photos, both phones and the address — still not published", async () => {
    const r = await app.inject({ method: "GET", url: "/" });
    expect(r.statusCode).toBe(200);
    const gallery = (await sql<{ g: string[] }[]>`select website->'gallery' as g from company_settings where company_id = ${s.a}`)[0]!.g;
    expect(r.body).toContain('<img src="/pub/logo"');
    for (const id of gallery) expect(r.body).toContain(`<img data-src="/pub/img/${id}"`); // D-134: loaded when the visitor comes near, not with the page
    expect(r.body).not.toMatch(/<img src="\/pub\/img\//);
    expect(r.body).toContain('href="tel:077632899"'); expect(r.body).toContain('href="tel:015899632"');
    expect(r.body).toContain(ADDRESS);
    expect(r.body).toContain('<meta name="robots" content="noindex,nofollow">'); // search engines: only when the shop ticks «published»
    expect((await app.inject({ method: "GET", url: "/pub/logo" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `/pub/img/${gallery[0]}` })).statusCode).toBe(200);
  });

  it("never publishes; a bad file, too many photos, an unknown code or no HangKH Support account stop it before anything is written", async () => {
    const snap = async () => (await sql`select (select count(*) from audit_log)::int as a, (select count(*) from job_files)::int as f,
      (select company_info::text from company_settings where company_id = ${s.a}) as i, (select website::text from company_settings where company_id = ${s.a}) as w`)[0];
    const before = await snap();
    const phone = { phone: "012 345 678" };
    await expect(shopSetup("oneteam", { website: { published: true } }, true)).rejects.toThrow(/published/);
    await expect(shopSetup("oneteam", { website: phone, gallery: Array(11).fill(PNG) }, true)).rejects.toThrow("website photos: 2 now + 11 new > 12");
    await expect(shopSetup("oneteam", { website: phone, logo: Buffer.from("<svg onload=alert(1)></svg>").toString("base64") }, true)).rejects.toThrow("BAD_IMAGE");
    await expect(shopSetup("oneteam", { website: phone, catalog_xlsx: xlsx([["ac clean!", "Nowhere", "", "", "", "x", 5, "maybe", "", ""]]) }, true)).rejects.toThrow(/catalog Excel has errors: row 2/);
    await expect(shopSetup("oneteam", { website: phone, catalog: [{ code: "NOPE-1", duration_min: 60 }] }, true)).rejects.toThrow("catalog: no item with code NOPE-1");
    await expect(shopSetup("otherco", { website: phone }, true)).rejects.toThrow(/no active HangKH Support account/);
    await expect(shopSetup("nowhere", {}, true)).rejects.toThrow('company "nowhere" not found');
    expect(await snap()).toEqual(before);
  });

  it("D-132: invoice price / cost by code, demo staff off (sessions end, Telegram unlinked), demo customers + bookings marked test — preview first, audited as HangKH Support", async () => {
    // as on the live shop: a demo price + cost on one service, a demo technician signed in with Telegram linked, a demo customer with a booking
    await sql`update catalog_items set sell_price = 18000, cost_price = 9500 where company_id = ${s.a} and code = 'AC-REPAIR'`;
    await sql`update users set telegram_user_id = 7001, telegram_chat_id = 7001 where id = ${s.users.kim!}`;
    const kim = await loginAs(app, "kim");
    expect((await kim.req("GET", "/api/me")).status).toBe(200);
    const cust = (await sql<{ id: string }[]>`insert into customers (company_id, name, phones, address, zone, notes)
      values (${s.a}, 'លោក សុខា (Demo)', ${sql.array(["012345678"])}, 'ផ្ទះ 12', 'inside', 'DEMO') returning id`)[0]!.id;
    const bk = (await sql<{ id: string }[]>`insert into bookings (company_id, number, customer_id, type, category, status, service_text, scheduled_at, ends_at, zone, notes)
      values (${s.a}, 'BK-0901', ${cust}, 'A', 'mep', 'new', 'ជួសជុលម៉ាស៊ីនត្រជាក់', now() + interval '1 day', now() + interval '1 day 2 hours', 'inside', 'DEMO') returning id`)[0]!.id;
    const req = (await sql<{ id: string }[]>`insert into service_requests (company_id, source, customer_id, text, kind, booking_id) values (${s.a}, 'website', ${cust}, 'ការកក់ពីគេហទំព័រ', 'booking', ${bk}) returning id`)[0]!.id;
    const plan = {
      catalog: [{ code: "AC-REPAIR", sell_price: 1500, cost_price: null }, { code: "EL-CHECK", duration_min: 60, sell_price: 1500 }],
      users: [{ username: "kim", active: false }, { username: "dara", active: false }],
      test: { customers: ["012 345 678"], bookings: ["BK-0901"] },
    };
    const audits = (await sql`select count(*)::int n from audit_log`)[0]!.n;
    const dry = (await shopSetup("oneteam", plan, false)).join("\n");
    expect(dry).toContain("catalog AC-REPAIR: sell_price $180.00 → $15.00 · cost_price $95.00 → —");
    expect(dry).toContain("catalog EL-CHECK: duration_min 120 → 60 · sell_price $0.00 → $15.00");
    expect(dry).toContain("user kim (Kim): active yes → no");
    expect(dry).toContain("user dara (Dara): active yes → no");
    expect(dry).toContain("customer 012345678 (លោក សុខា (Demo)): test no → yes");
    expect(dry).toContain("booking BK-0901 (new): test no → yes (+1 customer request)"); // D-133: its request goes with it
    expect((await sql`select count(*)::int n from audit_log`)[0]!.n).toBe(audits); // the preview writes nothing
    expect((await sql`select is_active from users where id = ${s.users.kim!}`)[0]!.is_active).toBe(true);

    await shopSetup("oneteam", plan, true);
    expect(await sql`select code, sell_price, cost_price, duration_min from catalog_items where company_id = ${s.a} and code in ('AC-REPAIR', 'EL-CHECK') order by code`).toEqual([
      { code: "AC-REPAIR", sell_price: 1500, cost_price: null, duration_min: 120 }, { code: "EL-CHECK", sell_price: 1500, cost_price: null, duration_min: 60 }]);
    expect(await sql`select username, is_active, telegram_user_id from users where company_id = ${s.a} and username in ('dara', 'kim') order by username`).toEqual([
      { username: "dara", is_active: false, telegram_user_id: null }, { username: "kim", is_active: false, telegram_user_id: null }]);
    expect((await kim.req("GET", "/api/me")).status).toBe(401); // the session ended at once
    expect((await sql`select is_test from customers where id = ${cust}`)[0]!.is_test).toBe(true);
    expect((await sql`select is_test from bookings where id = ${bk}`)[0]!.is_test).toBe(true);
    expect((await sql`select is_test from service_requests where id = ${req}`)[0]!.is_test).toBe(true);
    const acts = await sql<{ action: string; user_id: string | null }[]>`select action, user_id from audit_log where company_id = ${s.a} order by id desc limit 8`;
    expect(acts.map((x) => x.action).reverse()).toEqual(["catalog.upsert", "catalog.upsert", "user.update", "telegram.unlink", "user.update", "customer.test", "booking.test", "service.request_test"]);
    expect(acts.every((x) => x.user_id === support)).toBe(true);
    // the 24 h test rule then cancels the demo booking, without a message to anybody
    await cancelOldTests(new Date(Date.now() + 25 * 3_600_000));
    expect((await sql`select status from bookings where id = ${bk}`)[0]!.status).toBe("cancelled");
    expect(await sql`select status, outcome from service_requests where id = ${req}`).toEqual([{ status: "done", outcome: "expired" }]);
    // the Users page's rules hold here too: never a CEO account (HangKH Support is an Admin), never the platform account
    await expect(shopSetup("oneteam", { users: [{ username: "ceo", active: false }] }, true)).rejects.toThrow("a CEO account only by a CEO");
    await expect(shopSetup("oneteam", { users: [{ username: "support", active: false }] }, true)).rejects.toThrow("never changed here");
    await expect(shopSetup("oneteam", { test: { customers: ["099 999 999"] } }, true)).rejects.toThrow("0 customers have this phone");
    expect((await sql`select is_active from users where company_id = ${s.a} and username = 'ceo'`)[0]!.is_active).toBe(true);
  });

});
