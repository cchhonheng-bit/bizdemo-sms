// D-129: the guide per position — every staff member's own videos (/api/guide/mine) and only those (the CEO and the platform
// account: all), the position's PDF; the customers' public guide /guide (website module) with its videos, cached by anyone.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GUIDE_TABS } from "@sms/shared";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";

let app: FastifyInstance; let s: Seed; const c: Record<string, Client> = {};
const savedDir = config.guideDir;
function fakeMp4(): Buffer {
  const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(45_000, 16);
  return Buffer.concat([box("ftyp", Buffer.from("isom0000isomavc1", "latin1")), box("moov", box("mvhd", mvhd)), Buffer.alloc(1500, 3)]);
}
const tab = (key: string) => GUIDE_TABS.find((t) => t.key === key)!.videos;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const dir = mkdtempSync(join(tmpdir(), "guide-roles-"));
  config.guideDir = dir;
  for (const [folder, file] of [["Technician", "L1-00_overview_v1.mp4"], ["Admin_GM", "L2-00_overview_v1.mp4"], ["Customer", "L5-00_overview_v1.mp4"]]) {
    mkdirSync(join(dir, folder), { recursive: true }); writeFileSync(join(dir, folder, file), fakeMp4());
  }
  mkdirSync(join(dir, "pdf")); writeFileSync(join(dir, "pdf", "engineer.pdf"), "%PDF-1.4 demo");
  const hash = await hashPassword(PW);
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance) values (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false)`;
  for (const u of ["ceo", "admin", "gm01", "kim", "cfo"]) c[u] = await loginAs(app, u);
});
afterAll(async () => { config.guideDir = savedDir; config.shop.features = ""; await app.close(); });

describe("in the app: only the signed-in role's videos", () => {
  it("technician → ជាង (L1) · admin and GM → រដ្ឋបាល (L2) · CEO → នាយកប្រតិបត្តិ (L3) · CFO → L3-00 + L3-01 + L4; overview first; the PDF when there", async () => {
    const mine = async (u: string) => (await c[u]!.req("GET", "/api/guide/mine")).json;
    const k = await mine("kim");
    expect(k.tab).toMatchObject({ key: "engineer", label: "ជាង", label_en: "Technician" });
    expect(k.videos.map((v: any) => v.id)).toEqual(tab("engineer"));
    expect(k.videos[0]).toMatchObject({ id: "L1-00", title: "ទិដ្ឋភាពទូទៅ", title_en: "Overview", ready: true, seconds: 45 });
    expect(k.videos[1]).toMatchObject({ id: "L1-01", ready: false, url: null });
    expect(k.pdf).toBe("/api/guide/pdf/engineer");
    for (const u of ["admin", "gm01"]) expect((await mine(u)).videos.map((v: any) => v.id)).toEqual(tab("admin"));
    expect((await mine("ceo")).tab.key).toBe("ceo");
    const f = await mine("cfo");
    expect(f.videos.map((v: any) => v.id)).toEqual(["L3-00", "L3-01", "L4-00", "L4-01", "L4-02", "L4-03", "L4-04", "L4-05", "L4-06"]);
    expect(f.pdf).toBeNull();
  });

  it("a video or PDF of another position: 403 — the CEO (and the platform account) may open every one", async () => {
    const get = async (u: string, url: string) => (await app.inject({ method: "GET", url, headers: { cookie: c[u]!.cookie! } })).statusCode;
    expect(await get("kim", "/api/guide/videos/L1-00")).toBe(200);
    expect(await get("kim", "/api/guide/videos/L2-00")).toBe(403);
    expect(await get("admin", "/api/guide/videos/L2-00")).toBe(200);
    expect(await get("admin", "/api/guide/videos/L1-00")).toBe(403);
    expect(await get("cfo", "/api/guide/videos/L1-00")).toBe(403);
    expect(await get("ceo", "/api/guide/videos/L1-00")).toBe(200);
    expect(await get("ceo", "/api/guide/videos/L2-00")).toBe(200);
    expect(await get("kim", "/api/guide/pdf/engineer")).toBe(200);
    expect(await get("admin", "/api/guide/pdf/engineer")).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/guide/mine" })).statusCode).toBe(401);
  });
});

describe("the customers' guide on the public site: /guide", () => {
  it("public page (no login): the customer videos, overview on top, Khmer or English; the videos open for anyone and keep in any cache", async () => {
    config.shop.features = "website";
    const km = await app.inject({ method: "GET", url: "/guide", headers: { accept: "text/html" } });
    expect(km.statusCode).toBe(200);
    expect(km.body).toContain('data-page="guide"'); expect(km.body).toContain("វីដេអូណែនាំ"); expect(km.body).toContain("ទិដ្ឋភាពទូទៅ");
    expect(km.body).toMatch(/src="\/guide\/v\/L5-00\?v=[a-z0-9]+"/);
    expect(km.body).not.toContain("L1-00"); expect(km.body).not.toContain("L5-03"); // other positions, and clips not published
    const en = await app.inject({ method: "GET", url: "/guide?lang=en", headers: { accept: "text/html" } });
    expect(en.body).toContain("Video guide"); expect(en.body).toContain("Overview");
    const v = await app.inject({ method: "GET", url: "/guide/v/L5-00?v=x" });
    expect(v.statusCode).toBe(200); expect(v.headers["cache-control"]).toBe("public, max-age=31536000, immutable"); expect(v.headers["content-type"]).toMatch(/^video\/mp4/);
    expect((await app.inject({ method: "GET", url: "/guide/v/L5-00", headers: { range: "bytes=0-9" } })).statusCode).toBe(206);
    expect((await app.inject({ method: "GET", url: "/guide/v/L5-03" })).statusCode).toBe(404); // not published yet
    expect((await app.inject({ method: "GET", url: "/guide/v/L1-00" })).statusCode).toBe(400); // not a customer video
    expect((await app.inject({ method: "GET", url: "/", headers: { accept: "text/html" } })).body).toContain('href="/guide"'); // the site's footer links it
    config.shop.features = "";
    expect((await app.inject({ method: "GET", url: "/guide", headers: { accept: "text/html" } })).statusCode).toBe(404); // without the website module
  });
});
