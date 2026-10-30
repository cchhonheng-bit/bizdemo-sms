// D-194 (owner 29-10, part 5): invoice → customer notice → pay by the shop's QR + a photo of the transfer receipt → the office confirms
// → the books, the invoice paid, the receipt. The Telegram notice carries a signed link to that ONE invoice (no PIN, no sign-in, 30 days,
// a changed or old link refused); the account shows own invoices only; receipts are private; one reminder after the days to pay.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { client, loginAs, makeApp, PLACE, PW, resetDb, seed, span, type Client, type Seed } from "./helpers.js";
import { customerNotices } from "../src/services/customer-notify.js";
import { quietUrl } from "../src/app.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { hashPassword } from "../src/lib/password.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { invoiceToken, payReminders, readInvoiceToken } from "../src/services/invoice-pay.js";
import { checkImage, writeImage } from "../src/services/jobs.js";

let app: FastifyInstance; let s: Seed;
let ceo: Client, admin: Client, kim: Client, cfo: Client, ceoB: Client, A: Client, B: Client;
const KEY = "key-oneteam-0123456789abcdef", SUB = 9101;
const hubCalls: { path: string; body: any }[] = [];
const told = (sub: number) => hubCalls.filter((c) => c.path === "/internal/notify-subscriber" && c.body.subscriber_id === sub).map((c) => c.body as { text: string; buttons?: { text: string; web_app?: string }[][] });
const seg = (marker: number, b: Buffer) => { const len = Buffer.alloc(2); len.writeUInt16BE(b.length + 2); return Buffer.concat([Buffer.from([0xff, marker]), len, b]); };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8]), seg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1")), seg(0xe1, Buffer.from("Exif\0\0GPS-SECRET-11.55,104.92", "latin1")),
  seg(0xdb, Buffer.alloc(65, 1)), seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])), Buffer.from([0x12, 0x34, 0xff, 0x00]), Buffer.from([0xff, 0xd9])]).toString("base64");
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(300, 1)]).toString("base64");
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(300, 0)]).toString("base64");
const page = (url: string, c?: Client) => app.inject({ method: "GET", url, headers: c?.cookie ? { cookie: c.cookie } : {} });
const pub = (url: string, body: unknown, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: JSON.stringify(body) });
const until = async (f: () => boolean | Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 20)); } throw new Error("timeout"); };
const line = (description: string, unit_price: number, qty = 1, kind: "service" | "product" = "service") => ({ description, kind, qty, unit: "", unit_price });
async function issued(customer: string, lines = [line("លាងម៉ាស៊ីនត្រជាក់", 7000), line("ហ្គាស R32", 2500, 2, "product")], c = admin) {
  const id = (await c.req("POST", "/api/invoices", { customer_id: customer, lines })).json.id as string;
  expect((await c.req("POST", `/api/invoices/${id}/issue`)).status).toBe(200);
  return id;
}
const numberOf = async (id: string) => (await sql<{ number: string }[]>`select number from invoices where id = ${id}`)[0]!.number;
const slip = (url: string, over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => pub(url, { photo: JPEG, amount: 5000, bank: "aba", ...over }, headers);
/** 10:00 / 21:00 today in Phnom Penh */
const local = (h: number) => { const d = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10); return new Date(`${d}T${String(h - 7).padStart(2, "0")}:00:00Z`); };

let custA = "", custB = "", invA = "", tokA = "", linkA = "";

beforeAll(async () => {
  config.shop.features = "website,subscribe,accounting";
  await resetDb(); s = await seed();
  config.publicUrl = "https://oneteam.test"; config.shop.hubKey = KEY; config.shop.hubUrl = "http://hub";
  setHubTransport(async (_method, path, body) => {
    hubCalls.push({ path, body });
    if (path === "/internal/bot") return { status: 200, json: { username: "Oneteam_app_bot" } };
    return { status: 200, json: { ok: true } };
  });
  resetBotCache();
  app = await makeApp();
  await sql`insert into users (company_id, username, full_name, role, phone, password_hash, must_change_password) values (${s.a}, 'cfo', 'CFO A', 'cfo', '+85512000008', ${await hashPassword(PW)}, false)`;
  ceo = await loginAs(app, "ceo"); admin = await loginAs(app, "admin"); kim = await loginAs(app, "kim"); cfo = await loginAs(app, "cfo");
  ceoB = await loginAs(app, "ceo_b", PW, "otherco");
  await ceo.req("POST", "/api/settings/fx", { rate: 4000 });
  expect((await cfo.req("GET", "/api/accounting/accounts")).status).toBe(200);
  const today = (await sql<{ t: string }[]>`select (now() at time zone 'Asia/Phnom_Penh')::date::text as t`)[0]!.t;
  expect((await cfo.req("POST", "/api/accounting/opening", { date: today, cash_usd: 1000000 })).status).toBe(200);
  custA = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "សុខា", phones: ["012 345 601"], zone: "inside" })).json.id;
  custB = (await ceo.req("POST", "/api/customers", { ...PLACE, name: "ដារ៉ា", phones: ["012 345 602"], zone: "outside" })).json.id;
  await sql`update customers set tg_subscriber_id = ${SUB}, password_hash = ${await hashPassword("4827")}, pin_history_from = null where id = ${custA}`;
  await sql`update customers set password_hash = ${await hashPassword("5938")}, pin_history_from = null where id = ${custB}`;
  // the shop's payment QR + bank line (Settings → Company / Website — the invoice print shows the same)
  const qr = await writeImage(s.a, checkImage(PNG));
  await sql`update company_settings set qr_image_path = ${qr.rel}, company_info = coalesce(company_info, '{}'::jsonb) || '{"bank_line":"ACLEDA · One Team Service · 0001-23-456789"}'::jsonb where company_id = ${s.a}`;
  A = client(app); expect((await A.req("POST", "/api/public/login", { phone: "012345601", pin: "4827" })).status).toBe(200);
  B = client(app); expect((await B.req("POST", "/api/public/login", { phone: "012345602", pin: "5938" })).status).toBe(200);
});
beforeEach(() => resetRateLimits());
afterAll(async () => { setHubTransport(null); config.shop.features = ""; await app.close(); });

describe("D-194 the invoice reaches the customer and is paid from the phone", () => {
  it("issue → the linked chat gets the amount, the day to pay by and the invoice button (a signed link — no PIN, no sign-in); no chat = no message", async () => {
    invA = await issued(custA);
    const no = await numberOf(invA);
    await until(() => told(SUB).some((m) => m.text.includes(no)));
    const m = told(SUB).find((x) => x.text.includes(no))!;
    expect(m.text).toContain(`🧾 វិក្កយបត្រ #${no}`); expect(m.text).toContain("$120.00"); expect(m.text).toContain("សូមបង់មុន");
    expect(m.text).not.toMatch(/លេខសម្ងាត់|PIN|ពាក្យសម្ងាត់/);
    linkA = m.buttons![0]![0]!.web_app!;
    expect(linkA).toMatch(/^https:\/\/oneteam\.test\/i\/[0-9a-f-]{36}\.[0-9a-z]{5,8}\.[A-Za-z0-9_-]{32}$/);
    tokA = linkA.split("/i/")[1]!;
    expect(readInvoiceToken(tokA)).toEqual({ id: invA });
    await until(async () => (await sql`select 1 from invoices where id = ${invA} and customer_notified_at is not null`).length === 1); // marked once the hub said yes
    // a customer without a chat: nothing sent, nothing marked
    const before = hubCalls.length, invB = await issued(custB);
    await new Promise((r) => setTimeout(r, 100));
    expect(hubCalls.slice(before).filter((c) => c.path === "/internal/notify-subscriber")).toHaveLength(0);
    expect((await sql`select 1 from invoices where id = ${invB} and customer_notified_at is null`).length).toBe(1);
  });

  it("the link shows that invoice (QR, bank line, amount, «ខ្ញុំបានបង់រួច») without signing in; the account shows it and «ត្រូវបង់»", async () => {
    const r = await page(`/i/${tokA}`);
    expect(r.statusCode).toBe(200); expect(r.headers["set-cookie"]).toBeUndefined();
    const no = await numberOf(invA);
    for (const x of [no, "$120.00", 'src="/pub/qr"', "ACLEDA · One Team Service", "ខ្ញុំបានបង់រួច", "សូមបង់មុន", "សុខា"]) expect(r.body).toContain(x);
    expect(r.body).toContain(`data-api="/api/public/invoice/${tokA}/slip"`);
    const qr = await page("/pub/qr");
    expect(qr.statusCode).toBe(200); expect(qr.headers["content-type"]).toBe("image/png");
    const mine = await page(`/my/invoice/${invA}`, A);
    expect(mine.statusCode).toBe(200); expect(mine.body).toContain(no); expect(mine.body).toContain('class="tabbar"');
    const home = await page("/my/bookings", A);
    expect(home.body).toContain(`href="/my/invoice/${invA}"`); expect(home.body).toContain("ត្រូវបង់ $120.00");
    expect((await page(`/my/invoice/${invA}`)).body).toContain('data-page="gate"'); // no session: the skeleton, never the invoice
  });

  it("a changed link → 404, an old one → 410 with the account offer; another shop's invoice is never reachable; the log never holds a link", async () => {
    const bad = `${tokA.slice(0, -1)}${tokA.endsWith("A") ? "B" : "A"}`;
    expect((await page(`/i/${bad}`)).statusCode).toBe(404);
    expect((await page(`/i/${invA}.zzzzzz.${"A".repeat(32)}`)).statusCode).toBe(404);
    const old = await page(`/i/${invoiceToken(invA, Date.now() - 31 * 86_400_000)}`);
    expect(old.statusCode).toBe(410); expect(old.body).toContain("តំណនេះផុតកំណត់ហើយ"); expect(old.body).toContain('href="/my/bookings"');
    expect((await slip(`/api/public/invoice/${invoiceToken(invA, Date.now() - 31 * 86_400_000)}/slip`)).statusCode).toBe(410);
    const custOther = (await ceoB.req("POST", "/api/customers", { ...PLACE, name: "ក្រុមហ៊ុនផ្សេង", phones: ["012 888 999"], zone: "inside" })).json.id;
    const other = await issued(custOther, [line("សេវា", 1000)], ceoB);
    expect((await page(`/i/${invoiceToken(other)}`)).statusCode).toBe(404);
    expect(quietUrl(`/i/${tokA}?lang=en`)).toBe("/i/…?lang=en");
    expect(quietUrl(`/api/public/invoice/${tokA}/slip`)).toBe("/api/public/invoice/…/slip");
    expect(quietUrl("/book/done/abcdefghijklmnopqrstuv")).toBe("/book/done/…");
    expect(quietUrl("/my/bookings")).toBe("/my/bookings");
  });

  it("another customer: the invoice does not exist for them (page, receipt); the receipt photos are staff-only (payment.record)", async () => {
    expect((await page(`/my/invoice/${invA}`, B)).statusCode).toBe(404);
    expect((await B.req("POST", `/api/my/invoices/${invA}/slip`, { photo: JPEG, amount: 5000, bank: "aba" })).status).toBe(404);
    expect((await page("/my/bookings", B)).body).not.toContain(invA);
  });

  it("the receipt: not a photo / more than the balance / from another site → refused; a real photo → waiting, camera data removed, the office alerted", async () => {
    const url = `/api/public/invoice/${tokA}/slip`;
    expect((await slip(url, { photo: EXE })).json().error).toBe("BAD_IMAGE");
    expect((await slip(url, { amount: 12001 })).json().error).toBe("AMOUNT_TOO_LARGE");
    expect((await slip(url, {}, { origin: "https://evil.example" })).statusCode).toBe(403);
    const r = await slip(url);
    expect(r.statusCode, r.body).toBe(200); expect(r.json().status).toBe("pending");
    const x = (await sql<{ id: string; file_path: string; via: string }[]>`select id, file_path, via from payment_slips where invoice_id = ${invA}`)[0]!;
    expect(x.via).toBe("link");
    expect((await readFile(join(config.uploadsDir, x.file_path))).includes("GPS-SECRET")).toBe(false);
    const alerts = await sql<{ username: string }[]>`select u.username from notifications n join users u on u.id = n.user_id where n.kind = 'payment.slip' order by u.username`;
    expect(alerts.map((a) => a.username)).toEqual(["admin", "ceo"]); // payment.record — never the technician
    expect((await sql`select 1 from audit_log where action = 'payment.slip' and new_data->>'via' = 'link'`).length).toBe(1);
    const p = await page(`/i/${tokA}`);
    expect(p.body).toContain("ហាងកំពុងពិនិត្យ"); expect(p.body).not.toContain('id="slip-card"');
    const photo = (c: Client) => app.inject({ method: "GET", url: `/api/invoices/${invA}/slips/${x.id}/photo`, headers: c.cookie ? { cookie: c.cookie } : {} });
    const ok = await photo(admin);
    expect(ok.statusCode).toBe(200); expect(ok.headers["cache-control"]).toContain("no-store"); expect(ok.rawPayload.includes("GPS-SECRET")).toBe(false);
    expect((await photo(kim)).statusCode).toBe(403); expect((await photo(cfo)).statusCode).toBe(403); expect((await photo(ceoB)).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: `/api/invoices/${invA}/slips/${x.id}/photo` })).statusCode).toBe(401);
  });

  it("the office confirms → an ABA payment on the books, part paid, the customer told; twice → 409; refused with a reason → the customer reads it and sends again", async () => {
    const d = (await admin.req("GET", `/api/invoices/${invA}`)).json;
    expect(d.slips).toHaveLength(1); expect(d.slips[0]).toMatchObject({ status: "pending", amount: 5000, bank: "aba", via: "link" });
    const sid = d.slips[0].id as string, no = d.number as string;
    expect((await kim.req("POST", `/api/invoices/${invA}/slips/${sid}/confirm`, { amount: 5000, method: "aba" })).status).toBe(403);
    expect((await cfo.req("POST", `/api/invoices/${invA}/slips/${sid}/confirm`, { amount: 5000, method: "aba" })).status).toBe(403);
    const c = await admin.req("POST", `/api/invoices/${invA}/slips/${sid}/confirm`, { amount: 5000, method: "aba" });
    expect(c.status, JSON.stringify(c.json)).toBe(200); expect(c.json).toMatchObject({ balance: 7000, payment_status: "partial" });
    const pay = (await sql<{ id: string; method: string; usd_cents: number }[]>`select p.id, p.method::text as method, p.usd_cents from payments p join payment_slips x on x.payment_id = p.id where x.id = ${sid}`)[0]!;
    expect(pay).toMatchObject({ method: "aba", usd_cents: 5000 });
    const je = (await sql<{ dr: number; cr: number }[]>`select coalesce(sum(l.debit_cents), 0)::int as dr, coalesce(sum(l.credit_cents), 0)::int as cr from journal_entries e join journal_lines l on l.entry_id = e.id
      where e.source = 'payment' and e.source_id = ${pay.id}`)[0]!;
    expect(je).toEqual({ dr: 5000, cr: 5000 }); // the books: the mapped ABA account against the receivable
    await until(() => told(SUB).some((m) => m.text.includes("✅ បានទទួលប្រាក់ $50.00")));
    expect(told(SUB).find((m) => m.text.includes("✅ បានទទួលប្រាក់"))!.text).toContain("នៅសល់ $70.00");
    expect((await admin.req("POST", `/api/invoices/${invA}/slips/${sid}/confirm`, { amount: 5000, method: "aba" })).json.error).toBe("SLIP_DECIDED");
    // the second receipt from the account; refused with a reason
    expect((await A.req("POST", `/api/my/invoices/${invA}/slip`, { photo: JPEG, amount: 7000, bank: "acleda", note: "ផ្ទេរពីគណនីប្ដី" })).status).toBe(200);
    const s2 = (await sql<{ id: string }[]>`select id from payment_slips where invoice_id = ${invA} and status = 'pending'`)[0]!.id;
    expect((await admin.req("POST", `/api/invoices/${invA}/slips/${s2}/reject`, { reason: "x" })).status).toBe(400);
    expect((await admin.req("POST", `/api/invoices/${invA}/slips/${s2}/reject`, { reason: "មិនឃើញប្រាក់ចូលគណនី" })).status).toBe(200);
    await until(() => told(SUB).some((m) => m.text.includes(`❌ មិនទាន់ទទួលការបង់ #${no}`)));
    const again = await page(`/my/invoice/${invA}`, A);
    expect(again.body).toContain("មិនឃើញប្រាក់ចូលគណនី"); expect(again.body).toContain('id="slip-card"');
    // the third one pays the rest → paid in full: the receipt, no pay card, nothing more to send
    expect((await A.req("POST", `/api/my/invoices/${invA}/slip`, { photo: JPEG, amount: 7000, bank: "acleda" })).status).toBe(200);
    const s3 = (await sql<{ id: string }[]>`select id from payment_slips where invoice_id = ${invA} and status = 'pending'`)[0]!.id;
    expect((await admin.req("POST", `/api/invoices/${invA}/slips/${s3}/confirm`, { amount: 7000, method: "acleda" })).json).toMatchObject({ balance: 0, payment_status: "paid" });
    const done = await page(`/i/${tokA}`);
    expect(done.body).toContain("បង្កាន់ដៃទទួលប្រាក់"); expect(done.body).toContain("បានបង់គ្រប់"); expect(done.body).not.toContain('id="pay"');
    expect((await slip(`/api/public/invoice/${tokA}/slip`)).json().error).toBe("ALREADY_PAID");
    expect((await page("/my/bookings", A)).body).not.toContain(`href="/my/invoice/${invA}"`);
    const acts = await sql<{ action: string; n: number }[]>`select action, count(*)::int as n from audit_log where action like 'payment.slip%' group by action order by action`;
    expect(acts).toEqual([{ action: "payment.slip", n: 3 }, { action: "payment.slip_confirm", n: 2 }, { action: "payment.slip_reject", n: 1 }]);
  });

  it("at most 3 receipts wait per invoice", async () => {
    const inv = await issued(custA, [line("ជួសជុល", 9000)]);
    for (let i = 0; i < 3; i++) expect((await A.req("POST", `/api/my/invoices/${inv}/slip`, { photo: JPEG, amount: 1000, bank: "aba" })).status).toBe(200);
    expect((await A.req("POST", `/api/my/invoices/${inv}/slip`, { photo: JPEG, amount: 1000, bank: "aba" })).json.error).toBe("TOO_MANY_SLIPS");
  });

  it("one reminder after the days to pay (09–17 shop time) — never twice, never when paid, never for an invoice not notified this way, none with 0 days", async () => {
    const back = (id: string, days: number) => sql`update invoices set issued_at = now() - make_interval(days => ${days}) where id = ${id}`;
    const due = await issued(custA, [line("ពិនិត្យភ្លើង", 4000)]), paid = await issued(custA, [line("លាងម៉ាស៊ីន", 3000)]), quiet = await issued(custA, [line("ដំឡើង", 6000)]);
    await until(async () => (await sql`select 1 from invoices where id = any(${sql.array([due, paid, quiet])}::uuid[]) and customer_notified_at is not null`).length === 3);
    expect((await admin.req("POST", `/api/invoices/${paid}/payments`, { amount: 3000, currency: "usd", method: "cash_usd" })).status).toBe(200);
    await sql`update invoices set customer_notified_at = null where id = ${quiet}`; // e.g. issued before D-194
    for (const id of [due, paid, quiet]) await back(id, 4);
    expect(await payReminders(local(21))).toBe(0); // night
    expect(await payReminders(local(10))).toBe(1);
    const no = await numberOf(due);
    expect(told(SUB).filter((m) => m.text.includes(`⏰ វិក្កយបត្រ #${no} មិនទាន់បង់`))).toHaveLength(1);
    expect(told(SUB).find((m) => m.text.includes("⏰"))!.buttons![0]![0]!.web_app).toMatch(/\/i\//);
    expect(await payReminders(local(11))).toBe(0); // once
    // 0 days = no «pay by» day and no reminder (Settings → Website)
    expect((await ceo.req("PUT", "/api/website", { pay_due_days: 0 })).status).toBe(200);
    const none = await issued(custA, [line("សេវា", 2000)]);
    await until(async () => (await sql`select 1 from invoices where id = ${none} and customer_notified_at is not null`).length === 1);
    const noneNo = await numberOf(none);
    expect(told(SUB).find((m) => m.text.includes(noneNo))!.text).not.toContain("សូមបង់មុន");
    await back(none, 10);
    expect(await payReminders(local(10))).toBe(0);
    expect((await ceo.req("PUT", "/api/website", { pay_due_days: 31 })).status).toBe(400);
    expect((await ceo.req("PUT", "/api/website", { pay_due_days: 3 })).status).toBe(200);
  });
});

// D-195 (owner 30-10, BK-0012: «the invoice did not reach the client — stuck at «វិក្កយបត្រ»»): the open page stopped following the
// job once it was done; a customer without Telegram heard nothing; a guest without an account could not see the invoice at all.
describe("D-195 the invoice reaches every customer of a job", () => {
  let bk = "", inv = "";
  const REF = "d195RefAbcdefghijklmno";
  it("job done, no invoice yet: the page keeps following (not final), «ហាងកំពុងរៀបចំវិក្កយបត្រ» under the invoice step", async () => {
    const gm = await loginAs(app, "gm01");
    const svc = (await ceo.req("POST", "/api/catalog", { name_km: "លាងម៉ាស៊ីនត្រជាក់", kind: "service", category: "mep", unit: "job", sell_price: 2500 })).json.id;
    bk = (await ceo.req("POST", "/api/bookings", { customer_id: custA, type: "A", category: "mep", service_text: "លាងម៉ាស៊ីនត្រជាក់", zone: "inside", ...span(new Date(Date.now() + 3 * 3600_000).toISOString()), service_item_id: svc })).json.id;
    expect((await gm.req("POST", `/api/bookings/${bk}/assign`, { lead: s.users.kim, assistants: [] })).status).toBe(200);
    for (const st of ["on_site", "work_done", "pending_review", "reviewed"]) await sql`update bookings set status = ${st}::booking_status where id = ${bk}`;
    await sql`update bookings set web_ref = ${REF} where id = ${bk}`; // as if booked online (the guest's tracking address)
    const d = (await A.req("GET", `/api/my/bookings/${bk}`)).json;
    expect(d.final).toBe(false); expect(d.sig).toBe("done|"); expect(d.html).toContain("ហាងកំពុងរៀបចំវិក្កយបត្រ");
    const p = (await page(`/my/b/${bk}`, A)).body;
    expect(p).toContain('data-final="0"'); expect(p).toContain('data-sig="done|"'); expect(p).not.toContain('id="inv"');
  });

  it("issued: the signature changes (the open page reloads), the invoice sits on top with «មើល / បង់ប្រាក់»; the guest page shows it through its signed link", async () => {
    inv = (await admin.req("POST", "/api/invoices", { booking_id: bk, lines: [line("លាងម៉ាស៊ីនត្រជាក់", 2500, 2)] })).json.id;
    expect((await admin.req("POST", `/api/invoices/${inv}/issue`)).status).toBe(200);
    const d = (await A.req("GET", `/api/my/bookings/${bk}`)).json;
    expect(d.sig).toBe(`done|${inv}:5000:0`); expect(d.final).toBe(false); expect(d.html).toContain("រង់ចាំការបង់ប្រាក់");
    const p = (await page(`/my/b/${bk}`, A)).body;
    // D-196 (client): the invoice sits inside the timeline, at its «វិក្កយបត្រ» step — the live update carries it too
    expect(p.indexOf('class="trk-inv"')).toBeGreaterThan(p.indexOf('id="tl"')); expect(d.html).toContain(`href="/my/invoice/${inv}"`);
    expect(p).toContain(`href="/my/invoice/${inv}"`); expect(p).toContain("មើល / បង់ប្រាក់"); expect(p).toContain("ត្រូវបង់ $50.00");
    const g = await page(`/book/done/${REF}`); // a guest: no cookie
    expect(g.statusCode).toBe(200);
    const href = /href="(\/i\/[^"]+)"/.exec(g.body)?.[1];
    expect(href).toMatch(/^\/i\/[0-9a-f-]{36}\.[0-9a-z]+\.[A-Za-z0-9_-]{32}$/);
    expect((await page(href!)).body).toContain("ខ្ញុំបានបង់រួច");
    expect((await app.inject({ method: "GET", url: `/api/public/track/${REF}` })).json().sig).toBe(`done|${inv}:5000:0`);
  });

  it("the office sends it by hand: the link (audited; invoice.issue only), Telegram again (a linked chat, something owed)", async () => {
    await until(async () => !!(await admin.req("GET", `/api/invoices/${inv}`)).json.customer_notified_at); // the notice at issue (async)
    const info = (await admin.req("GET", `/api/invoices/${inv}`)).json;
    expect(info).toMatchObject({ customer_linked: true, customer_has_account: true }); expect(info.customer_notified_at).toBeTruthy();
    const l = await admin.req("GET", `/api/invoices/${inv}/customer-link`);
    expect(l.status).toBe(200); expect(l.json.url).toMatch(/^https:\/\/oneteam\.test\/i\//);
    expect((await page(l.json.url.replace("https://oneteam.test", ""))).statusCode).toBe(200);
    for (const c of [kim, cfo]) expect((await c.req("GET", `/api/invoices/${inv}/customer-link`)).status).toBe(403);
    expect((await ceoB.req("GET", `/api/invoices/${inv}/customer-link`)).status).toBe(404);
    expect((await sql`select 1 from audit_log where action = 'invoice.link' and row_id = ${inv}`).length).toBe(1);
    const before = told(SUB).length;
    expect((await admin.req("POST", `/api/invoices/${inv}/notify`, {})).json).toEqual({ sent: true });
    expect(told(SUB).length).toBe(before + 1); expect(told(SUB).at(-1)!.text).toContain("🧾 វិក្កយបត្រ");
    const noChat = await issued(custB, [line("សេវា", 1500)]);
    expect((await admin.req("POST", `/api/invoices/${noChat}/notify`, {})).json.error).toBe("NOT_LINKED");
    expect((await admin.req("GET", `/api/invoices/${noChat}`)).json).toMatchObject({ customer_linked: false, customer_notified_at: null });
  });

  it("paid → final (the page stops following); «job done» on Telegram carries «⭐ វាយតម្លៃសេវា»; a changed link shows the site's own 404 page", async () => {
    expect((await admin.req("POST", `/api/invoices/${inv}/payments`, { amount: 5000, currency: "usd", method: "aba" })).status).toBe(200);
    const d = (await A.req("GET", `/api/my/bookings/${bk}`)).json;
    expect(d.final).toBe(true); expect(d.invoices[0].balance).toBe(0);
    expect((await admin.req("POST", `/api/invoices/${inv}/notify`, {})).json.error).toBe("ALREADY_PAID");
    await sql`update bookings set closed_at = coalesce(closed_at, now()) where id = ${bk}`;
    await customerNotices();
    const done = told(SUB).find((m) => m.text.includes("✅ ការងាររួចរាល់"))!;
    expect(done.buttons![0]!.map((b) => b.text)).toEqual(["⭐ វាយតម្លៃសេវា", "កក់ម្ដងទៀត"]);
    expect(done.buttons![0]![0]!.web_app).toBe(`https://oneteam.test/my/b/${bk}#rate`);
    const bad = await page(`/i/${invA}.zzzzzz.${"A".repeat(32)}`);
    expect(bad.statusCode).toBe(404); expect(bad.headers["content-type"]).toContain("text/html");
  });
});
