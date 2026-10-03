// Brand rollout (D-90): both modes serve the HangKH brand files; the hub pages carry the new header with the wordmark and the
// brand colours; the shop stays One Team branded (its index.html keeps the One Team icons) — no path traversal on /brand.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { BRAND } from "@sms/shared";
import { makeApp, resetDb } from "./helpers.js";
import { buildHubApp } from "../src/hub/app.js";

let shop: FastifyInstance, hub: FastifyInstance;
beforeAll(async () => { await resetDb(); shop = await makeApp(); hub = buildHubApp({ logger: false }); await hub.ready(); });
afterAll(async () => { await shop.close(); await hub.close(); });

describe("brand files", () => {
  it("the wordmark and favicon are served by the shop and the hub, cacheable, svg; unknown or traversal names are 404", async () => {
    for (const app of [shop, hub]) {
      const r = await app.inject({ method: "GET", url: "/brand/hangkh-wordmark.svg" });
      expect(r.statusCode).toBe(200); expect(r.headers["content-type"]).toContain("image/svg+xml"); expect(r.headers["cache-control"]).toContain("max-age");
      expect(r.body).toContain('id="wordmark-kh"'); expect(r.body).toContain(BRAND.gold); expect(r.body).not.toMatch(/<text/); // outlines, no live text
      expect((await app.inject({ method: "GET", url: "/brand/hangkh-favicon.svg" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/brand/nope.svg" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/brand/..%2Fpackage.json" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/brand/x.txt" })).statusCode).toBe(404);
    }
  });
});

describe("hub pages", () => {
  it("landing, terms, privacy and the platform login use the HangKH header (wordmark + navy), the brand favicon and no old colours", async () => {
    for (const url of ["/", "/terms", "/privacy", "/platform/login"]) {
      const r = await hub.inject({ method: "GET", url });
      expect(r.statusCode).toBe(200);
      expect(r.body).toContain('src="/brand/hangkh-wordmark-white.svg"');
      expect(r.body).toContain('href="/brand/hangkh-favicon.svg"');
      expect(r.body.toUpperCase()).toContain(BRAND.navy.toUpperCase());
      expect(r.body.toUpperCase()).not.toContain("#2E3A78");
    }
    // Terms & Privacy keep Khmer first, English below (D-89 exception)
    const t = (await hub.inject({ method: "GET", url: "/terms" })).body;
    expect(t.indexOf("លក្ខខណ្ឌ")).toBeLessThan(t.indexOf("Terms of Service"));
  });
});
