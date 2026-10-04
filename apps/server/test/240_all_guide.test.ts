// CEO 04-10 (D-128): the all-guide page /app/all_guide — the shop's CEO and the platform account only; the CEO's tabs and their
// videos; one review per video and reviewer (both see each other), «ត្រូវកែ» needs a comment and tells the platform owner (not the
// platform's own notes); every change audited; the videos are sent with ranges and cached privately by the browser.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginAs, makeApp, PW, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { setHubTransport } from "../src/services/hub-client.js";

let app: FastifyInstance; let s: Seed; let ceo: Client, support: Client;
const hubCalls: { path: string; body: any }[] = [];
const savedDir = config.guideDir;

/** the head of an MP4: ftyp + moov / mvhd (timescale 1000, duration 61 500 → 61.5 s) + some media bytes */
function fakeMp4(): Buffer {
  const box = (type: string, body: Buffer) => { const h = Buffer.alloc(8); h.writeUInt32BE(8 + body.length); h.write(type, 4, "latin1"); return Buffer.concat([h, body]); };
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(61_500, 16); // version 0: times 4 bytes each
  return Buffer.concat([box("ftyp", Buffer.from("isom0000isomavc1", "latin1")), box("moov", box("mvhd", mvhd)), Buffer.alloc(2000, 7)]);
}
const SIZE = fakeMp4().length;

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  const dir = mkdtempSync(join(tmpdir(), "guide-"));
  config.guideDir = dir;
  mkdirSync(join(dir, "Technician")); writeFileSync(join(dir, "Technician", "L1-00_overview_v1.mp4"), fakeMp4());
  const hash = await hashPassword(PW);
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password, tracks_attendance, is_platform) values
    (${s.a}, 'support', 'HangKH Support', 'admin', null, ${hash}, false, false, true), (${s.a}, 'cfo', 'CFO A', 'cfo', '012000008', ${hash}, false, false, false)`;
  ceo = await loginAs(app, "ceo"); support = await loginAs(app, "support");
  setHubTransport(async (_m, path, body) => { hubCalls.push({ path, body }); return { status: 200, json: { ok: true } }; });
});
afterAll(async () => { setHubTransport(null); config.guideDir = savedDir; await app.close(); });

describe("access: the shop's CEO and the platform account only", () => {
  it("CEO and HangKH Support open it; GM, Admin, CFO and a technician get 403 («គ្មានសិទ្ធិ»); nobody signed in: 401", async () => {
    expect((await ceo.req("GET", "/api/guide")).status).toBe(200);
    expect((await support.req("GET", "/api/guide")).status).toBe(200);
    for (const u of ["gm01", "admin", "cfo", "kim"]) {
      const c = await loginAs(app, u);
      expect((await c.req("GET", "/api/guide")).status).toBe(403);
      expect((await c.req("PUT", "/api/guide/reviews/L1-00", { verdict: "ok" })).status).toBe(403);
      expect((await c.req("GET", "/api/guide/videos/L1-00")).status).toBe(403);
    }
    expect((await app.inject({ method: "GET", url: "/api/guide" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/guide/videos/L1-00" })).statusCode).toBe(401);
  });
});

describe("tabs: the CEO's order and videos", () => {
  it("ជាង · រដ្ឋបាល · នាយកប្រតិបត្តិ · នាយកហិរញ្ញវត្ថុ · អតិថិជន = L1 · L2 · L3 · L3-00 + L3-01 + L4 · L5; 35 videos; a file not published yet = not ready", async () => {
    const d = (await ceo.req("GET", "/api/guide")).json;
    expect(d.tabs.map((t: any) => t.label)).toEqual(["ជាង", "រដ្ឋបាល", "នាយកប្រតិបត្តិ", "នាយកហិរញ្ញវត្ថុ", "អតិថិជន"]);
    const tab = (k: string) => d.tabs.find((t: any) => t.key === k).videos;
    expect(tab("engineer")).toEqual(["L1-00", "L1-01", "L1-02", "L1-03", "L1-04"]);
    expect(tab("admin")).toEqual(Array.from({ length: 10 }, (_, i) => `L2-0${i}`));
    expect(tab("ceo")).toEqual(["L3-00", "L3-01", "L3-02", "L3-03", "L3-04", "L3-05"]);
    expect(tab("cfo")).toEqual(["L3-00", "L3-01", "L4-00", "L4-01", "L4-02", "L4-03", "L4-04", "L4-05", "L4-06"]);
    expect(tab("customer")).toEqual(["L5-00", "L5-01", "L5-02", "L5-03", "L5-04", "L5-05", "L5-06"]);
    expect(d.total).toBe(35); expect(d.videos).toHaveLength(35); expect(new Set(d.tabs.flatMap((t: any) => t.videos)).size).toBe(35);
    const first = d.videos.find((v: any) => v.id === "L1-00");
    expect(first).toMatchObject({ title: "ទិដ្ឋភាពទូទៅ", ready: true, seconds: 61.5 });
    expect(first.url).toMatch(/^\/api\/guide\/videos\/L1-00\?v=[a-z0-9]+$/);
    expect(d.videos.find((v: any) => v.id === "L5-03")).toMatchObject({ ready: false, seconds: null, url: null });
    expect(d.pdfs).toEqual({ engineer: null, admin: null, ceo: null, cfo: null, customer: null });
  });
});

describe("videos: ranges for phones, kept by the browser", () => {
  it("a range → 206 + Content-Range; the whole file → 200; private + immutable (the address carries the version); not published → 404", async () => {
    const full = await app.inject({ method: "GET", url: "/api/guide/videos/L1-00?v=x", headers: { cookie: ceo.cookie! } });
    expect(full.statusCode).toBe(200); expect(full.headers["content-type"]).toMatch(/^video\/mp4/); expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.headers["cache-control"]).toBe("private, max-age=31536000, immutable"); expect(full.rawPayload.length).toBe(SIZE);
    const part = await app.inject({ method: "GET", url: "/api/guide/videos/L1-00", headers: { cookie: ceo.cookie!, range: "bytes=0-9" } });
    expect(part.statusCode).toBe(206); expect(part.headers["content-range"]).toBe(`bytes 0-9/${SIZE}`); expect(part.rawPayload.length).toBe(10);
    const tail = await app.inject({ method: "GET", url: "/api/guide/videos/L1-00", headers: { cookie: support.cookie!, range: "bytes=-100" } });
    expect(tail.statusCode).toBe(206); expect(tail.headers["content-range"]).toBe(`bytes ${SIZE - 100}-${SIZE - 1}/${SIZE}`);
    expect((await app.inject({ method: "GET", url: "/api/guide/videos/L1-00", headers: { cookie: ceo.cookie!, range: `bytes=${SIZE + 10}-` } })).statusCode).toBe(416);
    expect((await ceo.req("GET", "/api/guide/videos/L5-03")).status).toBe(404);
    expect((await ceo.req("GET", "/api/guide/videos/L9-99")).status).toBe(400);
  });
});

describe("reviews: one per video and reviewer, both see each other", () => {
  it("«ត្រូវកែ» needs a comment and tells the platform owner; the platform's own notes send nothing; changed in place, every change audited", async () => {
    expect((await ceo.req("PUT", "/api/guide/reviews/L1-00", { verdict: "fix" })).json.error).toBe("COMMENT_REQUIRED");
    hubCalls.length = 0;
    expect((await ceo.req("PUT", "/api/guide/reviews/L1-00", { verdict: "fix", comment: "សំឡេងតិចពេក" })).status).toBe(200);
    const alert = hubCalls.find((c) => c.path === "/internal/alert")!;
    expect(alert.body.kind).toBe("review");
    for (const x of ["L1-00", "CEO A", "សំឡេងតិចពេក", "/app/all_guide#L1-00"]) expect(alert.body.text).toContain(x);
    hubCalls.length = 0;
    expect((await support.req("PUT", "/api/guide/reviews/L1-00", { verdict: "ok", comment: "" })).status).toBe(200);
    expect((await support.req("PUT", "/api/guide/reviews/L2-03", { verdict: "fix", comment: "ខ្ញុំនឹងកែ" })).status).toBe(200);
    expect(hubCalls.filter((c) => c.path === "/internal/alert")).toHaveLength(0);
    expect((await ceo.req("PUT", "/api/guide/reviews/L1-00", { verdict: "ok", comment: "ល្អ" })).status).toBe(200);
    const d = (await support.req("GET", "/api/guide")).json;
    const l1 = d.reviews.filter((r: any) => r.video_id === "L1-00");
    expect(l1).toHaveLength(2);
    expect(l1.find((r: any) => r.name === "CEO A")).toMatchObject({ verdict: "ok", comment: "ល្អ", platform: false });
    expect(l1.find((r: any) => r.name === "HangKH Support")).toMatchObject({ verdict: "ok", comment: null, platform: true });
    expect(d.reviews.find((r: any) => r.video_id === "L2-03")).toMatchObject({ verdict: "fix", comment: "ខ្ញុំនឹងកែ" });
    const log = await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = 'guide.review' and user_id = ${s.users.ceo} order by id`;
    expect(log).toHaveLength(2);
    expect(log[0]!.old_data).toBeNull();
    expect(log[1]).toMatchObject({ old_data: { verdict: "fix", comment: "សំឡេងតិចពេក" }, new_data: { video: "L1-00", verdict: "ok", comment: "ល្អ" } });
    expect((await ceo.req("PUT", "/api/guide/reviews/L9-00", { verdict: "ok" })).status).toBe(400);
    expect((await ceo.req("PUT", "/api/guide/reviews/L1-00", { verdict: "maybe" })).status).toBe(400);
  });
});
