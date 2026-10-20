// D-149 (owner 20-10): /healthz carries the build id baked into the image — the staff app reloads itself when it changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeApp, resetDb, seed } from "./helpers.js";

let app: FastifyInstance;
beforeAll(async () => { await resetDb(); await seed(); app = await makeApp(); });
afterAll(async () => { await app.close(); });

describe("D-149 build id", () => {
  it("/healthz answers ok + the build id (BUILD_SHA, «dev» outside an image); public, no cache", async () => {
    const r = await app.inject({ method: "GET", url: "/healthz" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true, build: process.env.BUILD_SHA || "dev" });
    process.env.BUILD_SHA = "abc123def0";
    expect((await app.inject({ method: "GET", url: "/healthz?b=1" })).json().build).toBe("abc123def0");
    delete process.env.BUILD_SHA;
  });
});
