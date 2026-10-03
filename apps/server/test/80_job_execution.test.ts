// Flow 1+2: checkpoints (M6, BR-07, AC-08, FR-601…606, FR-1001) + job report & GM review (M7, BR-08/09, AC-09, OQ-08) — tests first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { sql } from "../src/db.js";
import { consumeLinkCode } from "../src/services/telegram.js";
import { lateAlerts } from "../src/services/jobs.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client, dara: Client;
let cust: string, product: string;

function at(d: number, hh: number, mm = 0): string {
  const pp = new Date(Date.now() + 7 * 3600_000);
  return new Date(Date.UTC(pp.getUTCFullYear(), pp.getUTCMonth(), pp.getUTCDate() + d, hh - 7, mm)).toISOString();
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0)]).toString("base64");
const cp = (c: Client, id: string, step: string, extra: Record<string, unknown> = {}) => c.req("POST", `/api/bookings/${id}/checkpoint`, { step, lat: 11.55, lng: 104.93, accuracy: 12, ...extra });
const job = async (c: Client, id: string) => (await c.req("GET", `/api/bookings/${id}/job`)).json;

/** a booking assigned to kim (lead) + dara; each one gets its own 3-hour slot (the same crew never overlaps) */
let slot = 0;
async function assigned(start = new Date(Date.now() + (1 + 3 * slot++) * 3600_000).toISOString()): Promise<string> {
  const id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", scheduled_at: start })).json.id;
  expect((await gm.req("POST", `/api/bookings/${id}/assign`, { lead: s.users.kim, assistants: [s.users.dara] })).status).toBe(200);
  return id;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await ceo.req("POST", "/api/customers", { name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  product = (await ceo.req("POST", "/api/catalog", { name_km: "ទុយោ PVC", kind: "product", category: "mep", unit: "m", sell_price: 250, cost_price: 120 })).json.id;
  await ceo.req("PATCH", "/api/settings/company", { telegram_group_chat_id: "-100999" });
  const code = (await kim.req("POST", "/api/telegram/link-code")).json.code;
  expect((await consumeLinkCode(code, 930002, 930002)).ok).toBe(true);
});
afterAll(async () => { await app.close(); });

describe("checkpoints (M6)", () => {
  it("5 steps in order by a crew member; status follows; GPS + accuracy + no-GPS flag; idempotent", async () => {
    const id = await assigned();
    expect((await cp(kim, id, "arrive")).json.error).toBe("CHECKPOINT_ORDER"); // must depart first
    const d = await cp(kim, id, "depart");
    expect(d.status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("en_route");
    expect((await cp(kim, id, "depart")).status).toBe(200); // pressing twice = same checkpoint, no error, no duplicate
    expect((await cp(dara, id, "arrive", { lat: null, lng: null, accuracy: null, no_gps: true })).status).toBe(200); // any crew member; GPS off (FR-604)
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("on_site");
    await cp(kim, id, "start"); await cp(kim, id, "finish");
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("work_done");
    await cp(kim, id, "return");
    const j = await job(gm, id);
    expect(j.checkpoints.map((c: any) => c.step)).toEqual(["depart", "arrive", "start", "finish", "return"]);
    expect(j.checkpoints[0]).toMatchObject({ lat: 11.55, lng: 104.93, accuracy: 12, no_gps: false, by_name: "Kim" });
    expect(j.checkpoints[1]).toMatchObject({ no_gps: true, lat: null });
    expect(Object.keys(j.durations).sort()).toEqual(["return", "travel", "wait", "work"]);
    expect((await sql`select count(*)::int as n from booking_checkpoints where booking_id = ${id}`)[0]!.n).toBe(5);
  });

  it("only the crew (and a GM) may press; other technicians, admins and other companies may not", async () => {
    const id = await assigned();
    const other = await loginAs(app, "newbie");
    expect((await cp(other, id, "depart")).status).toBe(403); // newbie must change password first → 403 anyway
    await sql`update users set must_change_password = false where id = ${s.users.newbie!}`;
    const nb = await loginAs(app, "newbie");
    expect((await cp(nb, id, "depart")).status).toBe(403);   // technician not on this job
    expect((await cp(admin, id, "depart")).status).toBe(403); // admin records no checkpoints
    const ceoB = await loginAs(app, "ceo_b");
    expect((await cp(ceoB, id, "depart")).status).toBe(404); // other company
    expect((await cp(gm, id, "depart")).status).toBe(200);   // GM may (permission job.checkpoint)
  });

  it("offline: the real pressed time is kept; future / very old / out-of-order times are refused", async () => {
    const id = await assigned();
    const pressed = new Date(Date.now() - 20 * 60_000).toISOString();
    expect((await cp(kim, id, "depart", { at: pressed, offline: true })).status).toBe(200);
    const j = await job(gm, id);
    expect(new Date(j.checkpoints[0].at).toISOString()).toBe(pressed); expect(j.checkpoints[0].offline).toBe(true);
    expect((await cp(kim, id, "arrive", { at: new Date(Date.now() + 3600_000).toISOString() })).json.error).toBe("CHECKPOINT_TIME");
    expect((await cp(kim, id, "arrive", { at: new Date(Date.now() - 3 * 86400_000).toISOString() })).json.error).toBe("CHECKPOINT_TIME");
    expect((await cp(kim, id, "arrive", { at: new Date(Date.now() - 30 * 60_000).toISOString() })).json.error).toBe("CHECKPOINT_TIME"); // before depart
  });

  it("group notices: departed / arrived / finished go to the work group (FR-1001)", async () => {
    const id = await assigned();
    await cp(kim, id, "depart"); await cp(kim, id, "arrive"); await cp(kim, id, "start"); await cp(kim, id, "finish");
    const msgs = await sql<{ text: string }[]>`select text from telegram_outbox where chat_id = -100999 and dedupe_key like ${"cp:" + id + ":%"} order by id`;
    expect(msgs).toHaveLength(3);
    expect(msgs[0]!.text).toContain("🚐"); expect(msgs[1]!.text).toContain("📍"); expect(msgs[2]!.text).toContain("✅");
  });

  it("cancelled or not-yet-assigned jobs take no checkpoint", async () => {
    const id = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x x", zone: "inside", scheduled_at: at(2, 9) })).json.id;
    expect((await cp(gm, id, "depart")).json.error).toBe("BOOKING_NOT_ASSIGNED");
    const c = await assigned();
    await ceo.req("POST", `/api/bookings/${c}/cancel`, { reason: "customer cancelled" });
    expect((await cp(kim, c, "depart")).status).toBe(404);
  });
});

describe("late alert (BR-07 · AC-08)", () => {
  it("10 minutes past the appointment without «arrive» → Admin + GM notified ONCE; arrived jobs are not alerted", async () => {
    const late = await assigned();
    const ok = await assigned();
    await sql`update bookings set scheduled_at = now() - interval '40 minutes', ends_at = now() - interval '20 minutes' where id = ${ok}`;
    await sql`update bookings set scheduled_at = now() - interval '11 minutes', ends_at = now() + interval '5 minutes' where id = ${late}`;
    await cp(kim, ok, "depart", { at: new Date(Date.now() - 45 * 60_000).toISOString() });
    await cp(kim, ok, "arrive", { at: new Date(Date.now() - 41 * 60_000).toISOString() });
    const n1 = await lateAlerts();
    expect(n1).toBe(1);
    expect((await admin.req("GET", "/api/notifications")).json.some((x: any) => x.kind === "booking.late")).toBe(true);
    expect((await gm.req("GET", "/api/notifications")).json.some((x: any) => x.kind === "booking.late")).toBe(true);
    expect(await lateAlerts()).toBe(0); // once
  });
});

describe("job report + GM review (M7)", () => {
  let id: string;
  it("photos: crew only, validated image content (not by name), compressed size limit, served only to allowed users", async () => {
    id = await assigned();
    await cp(kim, id, "depart"); await cp(kim, id, "arrive");
    expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: EXE })).json.error).toBe("BAD_IMAGE");
    expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: Buffer.alloc(3_000_000, 1).toString("base64") })).status).toBe(413);
    const nb = await loginAs(app, "newbie");
    expect((await nb.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: JPEG })).status).toBe(403);
    const p = await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "before", data: JPEG });
    expect(p.status).toBe(200);
    const f = await app.inject({ method: "GET", url: `/api/files/${p.json.id}`, headers: { cookie: kim.cookie! } });
    expect(f.statusCode).toBe(200); expect(f.headers["content-type"]).toBe("image/jpeg");
    expect((await app.inject({ method: "GET", url: `/api/files/${p.json.id}`, headers: { cookie: nb.cookie! } })).statusCode).toBe(404); // not on the job
    expect((await app.inject({ method: "GET", url: `/api/files/${p.json.id}` })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: `/api/files/${p.json.id}`, headers: { cookie: gm.cookie! } })).statusCode).toBe(200);
  });

  it("materials from the catalog without prices; the technician never receives prices (AC-01)", async () => {
    expect((await kim.req("PUT", `/api/bookings/${id}/materials`, { items: [{ catalog_item_id: product, qty: 3.5 }] })).status).toBe(200);
    expect((await kim.req("PUT", `/api/bookings/${id}/materials`, { items: [{ catalog_item_id: product, qty: 0 }] })).status).toBe(400);
    const j = await job(kim, id);
    expect(j.materials).toEqual([expect.objectContaining({ name_km: "ទុយោ PVC", qty: 3.5, unit: "m" })]);
    expect(JSON.stringify(j)).not.toMatch(/sell_price|cost_price|:(250|120)[,}]]/) // prices as values only (a UUID may contain the digits);
  });

  it("submit: needs work finished, ≥ 1 before + ≥ 1 after photo, and the customer signature (BR-08, AC-09); → pending review + GM notified", async () => {
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ok", signature: PNG })).json.error).toBe("WORK_NOT_FINISHED");
    await cp(kim, id, "start"); await cp(kim, id, "finish");
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ok", signature: PNG })).json.error).toBe("PHOTOS_REQUIRED"); // no «after» yet
    await dara.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG });
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ok" })).json.error).toBe("SIGNATURE_REQUIRED");
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ok", signature: JPEG })).json.error).toBe("SIGNATURE_REQUIRED"); // must be a PNG drawing
    const r = await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ប្ដូរទុយោ 3.5m", signature: PNG });
    expect(r.status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("pending_review");
    expect((await gm.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "job.review")).toBe(true);
    // after submitting, photos are locked until a revision
    expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG })).json.error).toBe("REPORT_LOCKED");
  });

  it("GM review: send back with a note → crew notified → fix + resubmit → approve; permissions enforced", async () => {
    expect((await kim.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).status).toBe(403);
    expect((await admin.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).status).toBe(403);
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "revision", note: "" })).json.error).toBe("NOTE_REQUIRED");
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "revision", note: "រូបក្រោយមិនច្បាស់" })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("revision");
    expect((await kim.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "job.revision")).toBe(true);
    expect((await sql`select 1 from telegram_outbox where chat_id = 930002 and dedupe_key like ${"review:" + id + ":%"}`).length).toBe(1);
    await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG });
    expect((await kim.req("POST", `/api/bookings/${id}/report`, { notes: "ថតរូបថ្មី", signature: PNG })).status).toBe(200);
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).status).toBe(200);
    const b = (await ceo.req("GET", `/api/bookings/${id}`)).json;
    expect(b.status).toBe("reviewed");
    const j = await job(gm, id);
    expect(j.report).toMatchObject({ status: "reviewed", version: 2, notes: "ថតរូបថ្មី" });
    expect(j.photos.filter((p: any) => p.kind === "after")).toHaveLength(2);
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).json.error).toBe("NOT_PENDING_REVIEW");
    const audit = (await ceo.req("GET", "/api/settings/audit?limit=500")).json.map((a: any) => a.action);
    for (const a of ["job.checkpoint", "job.report", "job.review"]) expect(audit).toContain(a);
  });
});
