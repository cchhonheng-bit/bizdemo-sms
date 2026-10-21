// D-146 (owner 20-10) — tests first: after the technician sends the report, the Admin / GM correct it themselves (notes, before /
// after photos) while it waits for review or is reviewed — no «send back»; who corrected it is kept; at least one photo of each
// kind stays; the technician still cannot touch a sent report; an invoiced job locks it; «send back» still exists.
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
const photos = async (b: string, kind: string) => ((await job(ceo, b)).photos as any[]).filter((p) => p.kind === kind).length;

/** a job sent for review by kim: 1 before + 1 after photo, notes, signature — each in its own past window (the same technician never overlaps) */
let slotN = 0;
async function sent(h: number): Promise<string> {
  const b = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "ជួសជុល", zone: "inside", ...span(new Date(Date.now() + h * 3600_000).toISOString()) })).json.id;
  expect((await gm.req("POST", `/api/bookings/${b}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
  const start = Date.now() - (3 + 4 * slotN++) * 3600_000;
  await sql`update bookings set scheduled_at = ${new Date(start)}, ends_at = ${new Date(start + 2 * 3600_000)} where id = ${b}`;
  for (const step of ["depart", "arrive", "start", "finish"]) expect((await kim.req("POST", `/api/bookings/${b}/checkpoint`, { step, no_gps: true })).status).toBe(200);
  for (const kind of ["before", "after"]) expect((await kim.req("POST", `/api/bookings/${b}/photos`, { kind, data: JPEG })).status).toBe(200);
  expect((await kim.req("POST", `/api/bookings/${b}/report`, { notes: "ប្ដូរទុយោ", signature: PNG })).status).toBe(200);
  return b;
}

beforeAll(async () => {
  await resetDb(); s = await seed(); app = await makeApp();
  ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); dara = await loginAs(app, "dara");
  cust = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "លោក សុខា", phones: ["012345678"], zone: "inside", lat: 11.55, lng: 104.93 })).json.id;
  id = await sent(100);
});
afterAll(async () => { await app.close(); });

describe("D-146 the office corrects a sent report", () => {
  it("Admin edits the notes and adds / removes photos while the job waits for review; «corrected by» kept; audited old → new; the technician is locked out", async () => {
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("pending_review");
    expect((await admin.req("PATCH", `/api/bookings/${id}/report`, { notes: "ប្ដូរទុយោ 3.5 ម៉ែត្រ + ហ្គាស" })).status).toBe(200);
    expect((await admin.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG })).status).toBe(200);
    expect(await photos(id, "after")).toBe(2);
    const first = ((await job(admin, id)).photos as any[]).find((p) => p.kind === "after").id;
    expect((await admin.req("DELETE", `/api/bookings/${id}/photos/${first}`)).status).toBe(200);
    expect(await photos(id, "after")).toBe(1);
    const last = ((await job(admin, id)).photos as any[]).find((p) => p.kind === "after").id;
    expect((await admin.req("DELETE", `/api/bookings/${id}/photos/${last}`)).json.error).toBe("PHOTOS_REQUIRED"); // one of each kind stays
    const r = (await job(gm, id)).report;
    expect(r).toMatchObject({ status: "submitted", version: 1, notes: "ប្ដូរទុយោ 3.5 ម៉ែត្រ + ហ្គាស", edited_by_name: "Admin A" });
    expect(r.edited_at).toBeTruthy();
    const a = await sql<{ old_data: any; new_data: any }[]>`select old_data, new_data from audit_log where action = 'job.report_edit' and row_id = ${id} order by id`;
    expect(a[0]).toMatchObject({ old_data: { notes: "ប្ដូរទុយោ" }, new_data: { notes: "ប្ដូរទុយោ 3.5 ម៉ែត្រ + ហ្គាស" } });
    expect(a.length).toBe(3); // notes + photo added + photo removed
    // D-152: the technician on the job corrects the notes while it waits for review; a technician not on the job never
    expect((await kim.req("PATCH", `/api/bookings/${id}/report`, { notes: "ប្ដូរទុយោ 3.5 ម៉ែត្រ + ហ្គាស" })).status).toBe(200);
    expect((await kim.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG })).json.error).toBe("REPORT_LOCKED");
    expect((await dara.req("PATCH", `/api/bookings/${id}/report`, { notes: "x" })).status).toBe(403);
  });

  it("GM approves the corrected report without a round trip; after the review the office may still correct it; «send back» still works on another job", async () => {
    expect((await gm.req("POST", `/api/bookings/${id}/review`, { decision: "approve" })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${id}`)).json.status).toBe("reviewed");
    expect((await gm.req("PATCH", `/api/bookings/${id}/report`, { notes: "កែក្រោយពិនិត្យ" })).status).toBe(200);
    expect((await ceo.req("PATCH", `/api/bookings/${id}/report`, { notes: "កែដោយនាយក" })).status).toBe(200);
    expect((await job(gm, id)).report).toMatchObject({ status: "reviewed", version: 1, notes: "កែដោយនាយក", edited_by_name: "CEO A" });
    expect((await kim.req("GET", "/api/notifications")).json.some((n: any) => n.kind === "job.revision")).toBe(false); // nothing went back to the technician
    const other = await sent(130);
    expect((await gm.req("POST", `/api/bookings/${other}/review`, { decision: "revision", note: "រូបក្រោយមិនច្បាស់" })).status).toBe(200);
    expect((await ceo.req("GET", `/api/bookings/${other}`)).json.status).toBe("revision");
    expect((await admin.req("PATCH", `/api/bookings/${other}/report`, { notes: "x" })).json.error).toBe("REPORT_LOCKED"); // sent back = the technician's turn
  });

  it("once invoiced the report is locked for everyone; a job without a report has nothing to correct", async () => {
    const inv = (await admin.req("POST", "/api/invoices", { booking_id: id, lines: [{ description: "ជួសជុល", kind: "service", qty: 1, unit: "job", unit_price: 2500 }] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${inv}/issue`, {})).status).toBe(200);
    expect((await admin.req("PATCH", `/api/bookings/${id}/report`, { notes: "x" })).json.error).toBe("REPORT_LOCKED");
    expect((await admin.req("POST", `/api/bookings/${id}/photos`, { kind: "after", data: JPEG })).json.error).toBe("REPORT_LOCKED");
    const fresh = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "x", zone: "inside", ...span(new Date(Date.now() + 200 * 3600_000).toISOString()) })).json.id;
    expect((await admin.req("PATCH", `/api/bookings/${fresh}/report`, { notes: "x" })).json.error).toBe("REPORT_LOCKED");
  });
});
