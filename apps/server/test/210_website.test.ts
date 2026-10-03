// Public shop website (flag "website", D-95): the page at "/" for visitors without a session and at "/site" — content from the
// shop's own data and Settings → Website, never prices or another company's data; the request form (no login) creates a service
// request (source "website") that Admin / GM are told about and handle; abuse guards; only website photos are public.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { formToken } from "../src/services/site.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, gm: Client, kim: Client, ceoB: Client;
let acId: string, cust: string;
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const page = (url: string, headers: Record<string, string> = {}) => app.inject({ method: "GET", url, headers });
const form = (fields: Record<string, string>, lang = "km") => app.inject({ method: "POST", url: `/site/request${lang === "en" ? "?lang=en" : ""}`,
  headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(fields).toString() });
const oldToken = () => formToken(Date.now() - 60_000);
const requests = async () => sql<{ id: string; source: string; name: string; phone: string; text: string; customer_id: string | null; status: string; meta: Record<string, unknown> }[]>`
  select id, source, name, phone, text, customer_id, status, meta from service_requests order by created_at`;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  config.shop.features = "website,subscribe";
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim"); ceoB = await loginAs(app, "ceo_b");
  acId = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", name_en: "AC cleaning", kind: "service", category: "mep", unit: "unit", sell_price: 4500 })).json.id;
  await ceo.req("POST", "/api/catalog", { name_km: "ដំឡើងកាមេរ៉ា", kind: "service", category: "camera", unit: "unit", sell_price: 25000 });
  await ceo.req("POST", "/api/catalog", { name_km: "ទុយោ PVC", kind: "product", category: "mep", unit: "m", sell_price: 250 });
  const off = (await ceo.req("POST", "/api/catalog", { name_km: "សេវាចាស់", kind: "service", category: "mep", unit: "unit", sell_price: 100 })).json.id;
  await ceo.req("POST", `/api/catalog/${off}/active`, { active: false });
  await ceoB.req("POST", "/api/catalog", { name_km: "សេវារបស់ក្រុមហ៊ុន B", kind: "service", category: "mep", unit: "unit", sell_price: 100 });
  cust = (await ceo.req("POST", "/api/customers", { name: "អតិថិជន គេហទំព័រ", phones: ["012777888"], zone: "inside" })).json.id;
  expect(cust).toBeTruthy();
});
beforeEach(() => resetRateLimits());
afterAll(async () => { config.shop.features = ""; await app.close(); });

describe("the public page", () => {
  it("module off → no website: /site does not exist and \"/\" stays the app", async () => {
    config.shop.features = "subscribe";
    expect((await page("/site")).statusCode).toBe(404);
    expect((await page("/robots.txt")).statusCode).toBe(404);
    expect((await page("/")).body).not.toContain("/site/request");
    config.shop.features = "website,subscribe";
  });

  it("\"/\" without a session = the website: company, services by category (no prices, no products, no inactive, no other company), form, staff link, Powered by HangKH; not indexed until published", async () => {
    const r = await page("/");
    expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toContain("text/html");
    const h = r.body;
    expect(h).toContain("One Team Engineering"); expect(h).toContain("លាងម៉ាស៊ីនត្រជាក់"); expect(h).toContain("ដំឡើងកាមេរ៉ា"); expect(h).toContain("កាមេរ៉ាសុវត្ថិភាព");
    expect(h).not.toContain("ទុយោ PVC"); expect(h).not.toContain("សេវាចាស់"); expect(h).not.toContain("ក្រុមហ៊ុន B");
    expect(h).not.toMatch(/45\.00|25,?000|250\.00|\$/); // never a price
    expect(h).toContain('action="/site/request"'); expect(h).toContain('href="/app"'); expect(h).toContain("/brand/hangkh-wordmark-white.svg"); expect(h).toContain("ដំណើរការដោយ");
    expect(h).toContain('content="noindex,nofollow"'); expect(h).toContain('<html lang="km">');
    expect(h).not.toMatch(/<script/i); // no script on the public page
    expect((await page("/robots.txt")).body).toContain("Disallow: /\n");
  });

  it("English page: one language (labels English, service names from name_en); a session cookie keeps \"/\" for the app while /site still previews", async () => {
    const en = (await page("/?lang=en")).body;
    expect(en).toContain('<html lang="en">'); expect(en).toContain("Request service"); expect(en).toContain("AC cleaning"); expect(en).toContain("Powered by");
    expect(en).not.toContain("ស្នើសេវាកម្ម"); expect(en).not.toContain("ដំណើរការដោយ");
    const withCookie = await page("/", { cookie: ceo.cookie! });
    expect(withCookie.body).not.toContain("/site/request"); // the app (in tests: no web build → 404)
    expect((await page("/site", { cookie: ceo.cookie! })).body).toContain('action="/site/request"');
  });
});

describe("request form → service request", () => {
  it("a valid request: saved (source website, matched to the existing customer by phone), Admin + GM notified, listed in the app; done once", async () => {
    const r = await form({ name: "សុខ ដារ៉ា", phone: "012 777 888", service: acId, date: "2099-01-05", area: "បុរីប៉េងហួត ផ្ទះ 12", message: "ម៉ាស៊ីនត្រជាក់មិនត្រជាក់", ts: oldToken(), company_url: "" });
    expect(r.statusCode).toBe(303); expect(r.headers.location).toBe("/site/thanks");
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: "website", name: "សុខ ដារ៉ា", phone: "012 777 888", customer_id: cust, status: "new" }); // typed with spaces, matched by digits
    expect(rows[0]!.text).toContain("លាងម៉ាស៊ីនត្រជាក់"); expect(rows[0]!.text).toContain("បុរីប៉េងហួត"); expect(rows[0]!.text).toContain("មិនត្រជាក់"); expect(rows[0]!.text).toContain("2099-01-05");
    expect(rows[0]!.meta).toMatchObject({ service_item_id: acId, date: "2099-01-05", lang: "km" });
    for (const u of ["admin", "gm01"]) expect((await sql`select link from notifications where kind = 'service.request' and user_id = ${s.users[u]!}`)[0]).toMatchObject({ link: "/requests" });
    expect((await sql`select 1 from notifications where kind = 'service.request' and user_id = ${s.users.kim!}`).length).toBe(0);
    expect((await page("/site/thanks")).body).toContain("✅");
    const list = (await admin.req("GET", "/api/requests")).json as any[];
    expect(list).toHaveLength(1); expect(list[0]).toMatchObject({ source: "website", customer_name: "អតិថិជន គេហទំព័រ", status: "new" });
    expect((await kim.req("GET", "/api/requests")).status).toBe(403);
    expect((await gm.req("POST", `/api/requests/${rows[0]!.id}/done`)).status).toBe(200);
    expect((await gm.req("POST", `/api/requests/${rows[0]!.id}/done`)).status).toBe(404);
    expect((await admin.req("GET", "/api/requests")).json).toHaveLength(0);
    expect(((await admin.req("GET", "/api/requests?all=1")).json as any[])[0]).toMatchObject({ status: "done", handled_by_name: "GM A" });
    expect((await ceoB.req("GET", "/api/requests?all=1")).json).toHaveLength(0); // another company sees nothing
  });

  it("validation keeps what was typed and escapes it; bots (hidden field, instant submit) get a «thank you» and nothing is stored; a stale page is refused", async () => {
    const n0 = (await requests()).length;
    const bad = await form({ name: "<script>alert(1)</script>", phone: "abc", ts: oldToken() });
    expect(bad.statusCode).toBe(400); expect(bad.body).toContain("សូមបញ្ចូលលេខទូរស័ព្ទ"); expect(bad.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;"); expect(bad.body).not.toContain("<script>alert");
    const noName = await form({ name: "", phone: "012345678", ts: oldToken() }, "en");
    expect(noName.statusCode).toBe(400); expect(noName.body).toContain("Please enter your name"); expect(noName.body).toContain('value="012345678"');
    expect((await form({ name: "Bot", phone: "012345678", ts: oldToken(), company_url: "http://spam.example" })).statusCode).toBe(303);
    expect((await form({ name: "Fast", phone: "012345678", ts: formToken() })).statusCode).toBe(303);
    expect((await form({ name: "Old", phone: "012345678", ts: "1.aaaaaaaaaaaaaaaaaaaaaa" })).statusCode).toBe(400);
    expect((await form({ name: "No token", phone: "012345678" })).statusCode).toBe(400);
    expect((await requests()).length).toBe(n0);
  });

  it("rate limit: the 6th request of one visitor within an hour is refused with a clear message", async () => {
    const n0 = (await requests()).length;
    for (let i = 0; i < 5; i++) expect((await form({ name: `Visitor ${i}`, phone: `01155500${i}`, ts: oldToken() })).statusCode).toBe(303);
    const sixth = await form({ name: "Visitor 6", phone: "011555006", ts: oldToken() });
    expect(sixth.statusCode).toBe(429); expect(sixth.body).toContain("សំណើច្រើនពេក");
    expect((await requests()).length).toBe(n0 + 5);
    expect((await requests()).at(-1)).toMatchObject({ customer_id: null, text: "—" }); // unknown phone, nothing else typed
  });
});

describe("Settings → Website", () => {
  it("CEO only; texts, phones and address appear on the page; published switches indexing; an office position adds the map", async () => {
    expect((await admin.req("GET", "/api/website")).status).toBe(403);
    expect((await ceo.req("PUT", "/api/website", { facebook: "https://evil.example/x" })).status).toBe(400);
    expect((await ceo.req("PUT", "/api/website", { tagline_km: "ជួសជុលរហ័ស ធានាគុណភាព", about_km: "យើងមានបទពិសោធន៍ 10 ឆ្នាំ", highlights_km: ["ធានា 30 ថ្ងៃ", "<b>ជាងជំនាញ</b>"], name_km: "វ័ន ធីម អែនជីនៀរីង",
      phone: "077 632 899 / 015 899 632", address: "បុរីប៉េងហួតបឹងស្នោរ", area_km: "ភ្នំពេញ", hours_km: "ច័ន្ទ–សៅរ៍ 8:00–17:00", facebook: "https://www.facebook.com/oneteam", published: true })).status).toBe(200);
    await ceo.req("PATCH", "/api/settings/company", { office_lat: 11.5564, office_lng: 104.9282 });
    const h = (await page("/")).body;
    for (const x of ["ជួសជុលរហ័ស ធានាគុណភាព", "យើងមានបទពិសោធន៍ 10 ឆ្នាំ", "ធានា 30 ថ្ងៃ", "វ័ន ធីម អែនជីនៀរីង", "បុរីប៉េងហួតបឹងស្នោរ", "ច័ន្ទ–សៅរ៍ 8:00–17:00", 'href="tel:077632899"', 'href="tel:015899632"',
      "https://www.facebook.com/oneteam", "maps.google.com/maps?q=11.5564,104.9282"]) expect(h).toContain(x);
    expect(h).toContain("&lt;b&gt;ជាងជំនាញ&lt;/b&gt;"); expect(h).not.toContain("noindex");
    expect((await page("/robots.txt")).body).toContain("Allow: /");
    expect((await page("/?lang=en")).body).not.toContain("ជួសជុលរហ័ស"); // the English page never shows the Khmer texts
    const got = (await ceo.req("GET", "/api/website")).json;
    expect(got.website).toMatchObject({ published: true, tagline_km: "ជួសជុលរហ័ស ធានាគុណភាព" }); expect(got.company_info).toMatchObject({ phone: "077 632 899 / 015 899 632" });
    await ceo.req("PUT", "/api/website", { published: false });
    expect((await page("/")).body).toContain("noindex");
    expect((await sql`select 1 from audit_log where action = 'website.update' and company_id = ${s.a}`).length).toBeGreaterThan(1);
  });

  it("photos: only website photos are public — a job photo is never served; removing a photo takes it off the page", async () => {
    const g = (await ceo.req("POST", "/api/website/photos", { slot: "gallery", data: PNG })).json.id;
    const hero = (await ceo.req("POST", "/api/website/photos", { slot: "hero", data: PNG })).json.id;
    expect((await admin.req("POST", "/api/website/photos", { slot: "gallery", data: PNG })).status).toBe(403);
    const h = (await page("/")).body;
    expect(h).toContain(`/site/img/${g}`); expect(h).toContain(`/site/img/${hero}`);
    const img = await page(`/site/img/${g}`);
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/png"); expect(String(img.headers["cache-control"])).toContain("public");
    const priv = (await sql<{ id: string }[]>`insert into job_files (company_id, booking_id, kind, path, mime, bytes) select company_id, null, 'receipt'::job_file_kind, path, mime, bytes from job_files where id = ${g} returning id`)[0]!.id;
    expect((await page(`/site/img/${priv}`)).statusCode).toBe(404); // same file, not a website photo → never public
    expect((await page("/site/logo")).statusCode).toBe(404); // no logo uploaded
    const hero2 = (await ceo.req("POST", "/api/website/photos", { slot: "hero", data: PNG })).json.id;
    expect((await page(`/site/img/${hero}`)).statusCode).toBe(404); // the old hero is replaced
    expect((await ceo.req("DELETE", `/api/website/photos/${g}`)).status).toBe(200);
    const h2 = (await page("/")).body;
    expect(h2).not.toContain(`/site/img/${g}`); expect(h2).toContain(`/site/img/${hero2}`);
    expect((await page(`/site/img/${g}`)).statusCode).toBe(404);
    expect((await ceoB.req("DELETE", `/api/website/photos/${hero2}`)).status).toBe(404); // another company cannot touch it
  });
});
