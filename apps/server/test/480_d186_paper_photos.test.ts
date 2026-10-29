// D-186 (client 29-10): the technician photographs the paper work sheet filled in on site — optional, beside the before / after
// photos; up to 10 a job; the crew may still add / remove them while the report waits for review; the office sees and corrects them;
// a sent report never needs one (the before / after minimum stays); a technician not on the job never; locked once reviewed.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, PLACE, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, dara: Client;
let cust: string, id: string;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const job = async (c: Client, b: string) => (await c.req("GET", `/api/bookings/${b}/job`)).json;
const papers = async (b: string) => ((await job(ceo, b)).photos as any[]).filter((p) => p.kind === "paper");
const paper = (c: Client, b: string) => c.req("POST", `/api/bookings/${b}/photos`, { kind: "paper", data: JPEG });

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "លោក វុទ្ធី", phones: ["012345679"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + 100 * 3600_000).toISOString()) })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - 3 * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${id}`;
});
afterAll(async () => { await app.close(); });

describe("D-186 photos of the paper work sheet", () => {
  it("not before the technician is on site; then optional — the report goes without one; another technician never", async () => {
    expect((await paper(kim, id)).json.error).toBe("NOT_ON_SITE");
    for (const step of ["depart", "arrive", "start", "finish"]) expect((await kim.req("POST", `/api/bookings/${id}/checkpoint`, { step, no_gps: true })).status).toBe(200);
    expect((await paper(dara, id)).status).toBe(403);
    expect((await paper(kim, id)).status).toBe(200);
    expect(await papers(id)).toHaveLength(1);
    for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind, data: JPEG })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "តាមក្រដាស", signature: PNG })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("pending_review");
  });

  it("while the report waits for review the technician still adds / removes sheet photos (marked as a correction), never before / after; up to 10", async () => {
    expect((await paper(kim, id)).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG })).json.error).toBe("REPORT_LOCKED");
    expect((await job(gm, id)).report.edited_by_name).toBe("Kim");
    const first = (await papers(id))[0].id;
    expect((await kim.req("DELETE", `/api/bookings/${id}/photos/${first}`)).status).toBe(200);
    expect(await papers(id)).toHaveLength(1);
    for (let i = 0; i < 9; i++) expect((await paper(kim, id)).status).toBe(200);
    expect(await papers(id)).toHaveLength(10);
    expect((await paper(kim, id)).json.error).toBe("TOO_MANY_PHOTOS");
  });

  it("the office removes every sheet photo (optional), never the last before / after; after the review the technician is locked out; audited", async () => {
    for (const p of await papers(id)) expect((await admin.req("DELETE", `/api/bookings/${id}/photos/${p.id}`)).status).toBe(200);
    expect(await papers(id)).toHaveLength(0);
    const after = ((await job(admin, id)).photos as any[]).find((p) => p.kind === "after").id;
    expect((await admin.req("DELETE", `/api/bookings/${id}/photos/${after}`)).json.error).toBe("PHOTOS_REQUIRED");
    expect((await admin.req("POST", `/api/bookings/${id}/photos`, { kind: "paper", data: JPEG })).status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "approve", note: "" })).status).toBe(200);
    expect((await paper(kim, id)).json.error).toBe("REPORT_LOCKED");
    expect((await paper(admin, id)).status).toBe(200); // the office until the invoice (D-146)
    expect(Number((await sql<{ n: number }[]>`select count(*)::int as n from audit_log where action = 'job.photo' and new_data->>'kind' = 'paper' and new_data->>'booking_id' = ${id}`)[0]!.n)).toBe(13);
  });
});
