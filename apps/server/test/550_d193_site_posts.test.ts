// D-193 (client 29-10): the shop's posts on the customer site — «ព័ត៌មាន» on the home page, /news, /news/<id>. Who writes (site.post:
// CEO, GM, Admin — never a technician, not the CFO by default), the cover photo cleaned of camera data, a YouTube / Facebook link plays in
// the page, a TikTok link opens TikTok, anything else is refused; hidden posts stay with the staff; delete; company scope; Excel = screen.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { videoOf } from "../src/services/site-posts.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, cfo: Client, ceoB: Client;
const page = (url: string) => app.inject({ method: "GET", url });
const seg = (marker: number, b: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(b.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, b]); };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), seg(0xe1, Buffer.from("Exif\0\0GPS-SECRET-11.55,104.92", "latin1")),
  seg(0xdb, Buffer.alloc(65, 1)), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00]), Buffer.from([0xff, 0xd9])]).toString("base64");
let first = "";

beforeAll(async () => {
  await resetDb(); s = await seed();
  config.publicUrl = "https://oneteam.test"; config.shop.features = "website";
  setHubTransport(async () => ({ status: 200, json: { ok: true } })); resetBotCache();
  app = await makeApp();
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password) values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000008', ${await hashPassword(PW)}, false)`;
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); cfo = await loginAs(app, "cfo");
  ceoB = await loginAs(app, "ceo_b", PW, "otherco");
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-193 the shop's posts on the customer site", () => {
  it("video links: YouTube / Facebook play in the page (privacy-friendly players), TikTok opens TikTok, anything else is refused", () => {
    expect(videoOf("https://youtu.be/dQw4w9WgXcQ")).toEqual({ embed: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" });
    expect(videoOf("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=3")).toEqual({ embed: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" });
    expect(videoOf("https://youtube.com/shorts/abcDEF12345")).toEqual({ embed: "https://www.youtube-nocookie.com/embed/abcDEF12345" });
    expect(videoOf("https://www.facebook.com/oneteam/videos/123")?.embed).toMatch(/^https:\/\/www\.facebook\.com\/plugins\/video\.php\?href=/);
    expect(videoOf("https://www.tiktok.com/@oneteam/video/1")).toEqual({ link: "https://www.tiktok.com/@oneteam/video/1" });
    for (const x of ["http://youtu.be/dQw4w9WgXcQ", "https://evil.example/watch?v=x", "javascript:alert(1)", "https://youtu.be/<script>"]) expect(videoOf(x)).toBeNull();
  });

  it("who writes: CEO, GM and Admin — a technician and (by default) the CFO get 403; a bad link or no title is refused", async () => {
    for (const c of [kim, cfo]) expect((await c.req("GET", "/api/site-posts")).status).toBe(403);
    expect((await kim.req("POST", "/api/site-posts", { title: "x y" })).status).toBe(403);
    expect((await gm.req("POST", "/api/site-posts", { title: "  " })).json.error).toBe("TITLE_REQUIRED");
    expect((await gm.req("POST", "/api/site-posts", { title: "វីដេអូថ្មី", video_url: "https://evil.example/v" })).json.error).toBe("VIDEO_LINK_INVALID");
    const r = await gm.req("POST", "/api/site-posts", { title: "លាងម៉ាស៊ីនត្រជាក់ឲ្យស្អាត", body: "មុន និងក្រោយ", video_url: "https://youtu.be/dQw4w9WgXcQ", photo: JPEG });
    expect(r.status).toBe(200); first = r.json.id;
    expect((await admin.req("POST", "/api/site-posts", { title: "ការងារនៅបុរី", video_url: "https://www.tiktok.com/@oneteam/video/1" })).status).toBe(200);
    expect((await ceo.req("GET", "/api/site-posts")).json).toHaveLength(2);
    expect((await sql`select new_data from audit_log where action = 'site.post_create' order by id limit 1`)[0]!.new_data).toMatchObject({ title: "លាងម៉ាស៊ីនត្រជាក់ឲ្យស្អាត", photo: true, video: true });
  });

  it("customers see them: «ព័ត៌មាន» on home (newest first, photos loaded when near), /news, one post with its YouTube player; the photo is cleaned", async () => {
    const home = (await page("/")).body;
    expect(home).toContain("ព័ត៌មាន"); expect(home).toContain(`href="/news/${first}"`); expect(home).toContain(`data-src="/pub/post/${first}"`); expect(home).toContain('href="/news"');
    expect(home.indexOf("ការងារនៅបុរី")).toBeLessThan(home.indexOf("លាងម៉ាស៊ីនត្រជាក់ឲ្យស្អាត"));
    expect((await page("/news")).body).toContain("ការងារនៅបុរី");
    const p = (await page(`/news/${first}`)).body;
    expect(p).toContain('src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"'); expect(p).toContain("មុន និងក្រោយ"); expect(p).toContain('class="tabbar"');
    const img = await page(`/pub/post/${first}`);
    expect(img.statusCode).toBe(200); expect(img.headers["content-type"]).toBe("image/jpeg"); expect(img.rawPayload.includes("GPS-SECRET")).toBe(false);
    const tik = (await ceo.req("GET", "/api/site-posts")).json.find((x: any) => x.title === "ការងារនៅបុរី").id;
    expect((await page(`/news/${tik}`)).body).toContain('href="https://www.tiktok.com/@oneteam/video/1"');
  });

  it("edit: the photo stays unless replaced or removed; a hidden post leaves the site (page + photo 404) but the staff still see it", async () => {
    expect((await ceo.req("POST", "/api/site-posts", { id: first, title: "លាងម៉ាស៊ីនត្រជាក់", body: null, video_url: null, published: true })).status).toBe(200);
    expect((await page(`/pub/post/${first}`)).statusCode).toBe(200); // kept
    expect((await ceo.req("POST", "/api/site-posts", { id: first, title: "លាងម៉ាស៊ីនត្រជាក់", published: false })).status).toBe(200);
    expect((await page(`/news/${first}`)).statusCode).toBe(404); expect((await page(`/pub/post/${first}`)).statusCode).toBe(404);
    expect((await page("/news")).body).not.toContain(`/news/${first}`);
    expect((await app.inject({ method: "GET", url: `/api/site-posts/${first}/photo`, headers: { cookie: ceo.cookie! } })).statusCode).toBe(200);
    expect((await ceo.req("POST", "/api/site-posts", { id: first, title: "លាងម៉ាស៊ីនត្រជាក់", published: true, photo: null })).status).toBe(200);
    expect((await page(`/pub/post/${first}`)).statusCode).toBe(404); // removed
    expect((await sql`select old_data, new_data from audit_log where action = 'site.post_update' order by id desc limit 1`)[0]).toMatchObject({ new_data: { photo: false } });
  });

  it("company scope: another shop never sees, edits or deletes it; delete is audited; the Excel file is the screen", async () => {
    expect((await ceoB.req("GET", "/api/site-posts")).json).toEqual([]);
    expect((await ceoB.req("POST", "/api/site-posts", { id: first, title: "ផ្លាស់ប្ដូរ" })).status).toBe(404);
    expect((await ceoB.req("DELETE", `/api/site-posts/${first}`)).status).toBe(404);
    const x = await app.inject({ method: "GET", url: "/api/export/posts.xlsx", headers: { cookie: ceo.cookie! } });
    expect(x.statusCode).toBe(200); expect(x.headers["content-type"]).toContain("spreadsheetml");
    expect((await kim.req("GET", "/api/export/posts.xlsx")).status).toBe(403);
    expect((await ceo.req("DELETE", `/api/site-posts/${first}`)).status).toBe(200);
    expect((await ceo.req("DELETE", `/api/site-posts/${first}`)).status).toBe(404);
    expect((await sql`select old_data from audit_log where action = 'site.post_delete'`)[0]!.old_data).toEqual({ title: "លាងម៉ាស៊ីនត្រជាក់" });
    expect((await page("/")).body).not.toContain(`/news/${first}`);
  });
});
