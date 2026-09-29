// v2.1 hub: Telegram routing (A3), shop ⇄ hub internal API, Subscribe/Consent (A4), Broadcast isolation (A5), platform page.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { CONSENT_VERSION } from "@sms/shared";
import { loginAs, makeApp, resetDb, seed, type Client, type Seed } from "./helpers.js";
import { config } from "../src/config.js";
import { sql } from "../src/db.js";
import { resetRateLimits } from "../src/lib/rate-limit.js";
import { buildHubApp } from "../src/hub/app.js";
import { setShopTransport, shopKey, syncShops } from "../src/hub/shops.js";
import { ensureConsentText, flushHubOutbox } from "../src/hub/subscribers.js";
import { setTelegramTransport } from "../src/hub/telegram-api.js";
import { createHubAdmin } from "../src/hub/platform.js";
import { setHubTransport } from "../src/services/hub-client.js";
import { flushOutbox } from "../src/services/telegram.js";

let shop: FastifyInstance, hub: FastifyInstance, s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
type Sent = { method: string; payload: any };
let sent: Sent[] = [];
let failNext: { error: string; permanent: boolean } | null = null;
let shopCalls = 0;
const WH = "whsec-test";

const texts = (chat?: number) => sent.filter((x) => x.method === "sendMessage" && (chat === undefined || Number(x.payload.chat_id) === chat)).map((x) => String(x.payload.text));
const lastText = (chat: number) => texts(chat).at(-1) ?? "";
let uid = 1;
const update = (u: Record<string, unknown>, secret: string | null = WH) =>
  hub.inject({ method: "POST", url: "/telegram/webhook", payload: { update_id: uid++, ...u }, headers: secret ? { "x-telegram-bot-api-secret-token": secret } : {} });
const privateMsg = (user: number, text: string, extra: Record<string, unknown> = {}) =>
  update({ message: { message_id: uid, chat: { id: user, type: "private" }, from: { id: user, first_name: `U${user}`, username: `u${user}` }, text, ...extra } });
const groupMsg = (user: number, chat: number, text: string) =>
  update({ message: { message_id: uid, chat: { id: chat, type: "supergroup", title: "One Team Work" }, from: { id: user, first_name: `U${user}` }, text } });
const tick = (user: number, shopCode = "ONETEAM", version = CONSENT_VERSION) =>
  update({ callback_query: { id: `cb${uid}`, from: { id: user, first_name: `U${user}`, username: `u${user}` }, message: { message_id: 1, chat: { id: user, type: "private" } }, data: `sub:${shopCode}:${version}` } });
const internal = (code: string, key: string, method: "GET" | "POST", url: string, body?: unknown) =>
  hub.inject({ method, url, headers: { "x-shop-code": code, "x-hub-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  await resetDb(); s = await seed();
  process.env.HUB_KEY_ONETEAM = "key-oneteam-0123456789abcdef";
  process.env.HUB_KEY_SHOPB = "key-shopb-0123456789abcdef";
  Object.assign(config.shop, { code: "ONETEAM", hubKey: process.env.HUB_KEY_ONETEAM, features: "subscribe" });
  Object.assign(config.telegram, { webhookSecret: WH, botUsername: "hangkh_bot" });
  await syncShops("ONETEAM|One Team Engineering|http://app-oneteam:3000|subscribe;SHOPB|Shop B|http://app-shopb:3000|subscribe;NOSUB|No Subscribe Shop|http://app-nosub:3000");
  await ensureConsentText();
  shop = await makeApp();
  hub = buildHubApp({ logger: false }); await hub.ready();
  setTelegramTransport(async (method, payload) => {
    sent.push({ method, payload });
    if (method === "sendMessage" && failNext) { const f = failNext; failNext = null; return { ok: false, ...f }; }
    return { ok: true };
  });
  setShopTransport(async (sh, method, path, body) => {
    shopCalls++;
    if (sh.code !== "ONETEAM") throw new Error("connection refused");
    const r = await shop.inject({ method, url: path, headers: { "x-hub-key": shopKey(sh.code), ...(body === undefined ? {} : { "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.statusCode, json: r.json() };
  });
  setHubTransport(async (method, path, body) => {
    const r = await internal(config.shop.code, config.shop.hubKey, method, path, body);
    return { status: r.statusCode, json: r.json() };
  });
  ceo = await loginAs(shop, "ceo"); gm = await loginAs(shop, "gm01"); admin = await loginAs(shop, "admin"); kim = await loginAs(shop, "kim");
});
afterAll(async () => {
  setTelegramTransport(null); setShopTransport(null); setHubTransport(null);
  await shop.close(); await hub.close();
});

describe("hub webhook + Telegram routing (A3)", () => {
  it("webhook: secret header required (missing / wrong → 403)", async () => {
    expect((await update({ message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/help" } }, null)).statusCode).toBe(403);
    expect((await update({ message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/help" } }, "wrong")).statusCode).toBe(403);
    expect(sent.length).toBe(0);
  });

  it("staff link: ONETEAM-S code → routed to the shop by prefix → linked, reply, chat allow-listed, audited", async () => {
    const { code, link } = (await kim.req("POST", "/api/telegram/link-code")).json;
    expect(link).toBe(`https://t.me/hangkh_bot?start=${code}`);
    expect((await privateMsg(700001, `/start ${code.toLowerCase()}`)).statusCode).toBe(200); // case-insensitive
    expect(lastText(700001)).toContain("✅");
    expect(lastText(700001)).toContain("Kim");
    expect(String((await sql`select telegram_user_id from users where id = ${s.users.kim!}`)[0]!.telegram_user_id)).toBe("700001");
    expect((await sql`select kind from hub_shop_chats where shop_code = 'ONETEAM' and chat_id = 700001`)[0]?.kind).toBe("staff");
    const log = await sql`select direction, kind, text from hub_message_log where chat_id = 700001 order by id`;
    expect(log.map((l) => `${l.direction}:${l.kind}`)).toEqual(["in:/start", "out:link.ok"]);
    expect(log[0]!.text).toBeNull(); // inbound: command only, no free text stored
    // single use
    await privateMsg(700001, `/start ${code}`);
    expect(lastText(700001)).toContain("❌");
  });

  it("unknown shop prefix, wrong kind, free text and forwarded messages never reach a shop", async () => {
    const before = shopCalls;
    await privateMsg(700009, "/start ZZZ-S-ABCDEF");
    expect(lastText(700009)).toContain("❌");
    await privateMsg(700009, "/start garbage");
    await privateMsg(700009, "hello bot, my phone is 012345678"); // free text: ignored, not logged
    await privateMsg(700009, "/start ONETEAM-S-ABCDEF", { forward_origin: { type: "user" } });
    await groupMsg(700009, -100555, "/register ONETEAM-S-ABCDEF"); // staff code in /register → wrong kind
    expect(shopCalls).toBe(before);
    expect((await sql`select count(*)::int as n from hub_message_log where chat_id = 700009 and direction = 'in'`)[0]!.n).toBe(2);
    expect((await sql`select count(*)::int as n from hub_message_log where text like '%012345678%'`)[0]!.n).toBe(0);
  });

  it("brute force: 10 wrong codes per Telegram user per hour, then blocked before the shop is asked", async () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) await privateMsg(700010, "/start ONETEAM-S-AAAAA" + "BCDEFGHJK"[i]);
    const calls = shopCalls;
    await privateMsg(700010, "/start ONETEAM-S-BBBBBB");
    expect(shopCalls).toBe(calls);
    expect(lastText(700010)).toContain("⏳");
    resetRateLimits();
  });

  it("group: /register ONETEAM-G code (created in Settings) → work group set, single use; private chat refused", async () => {
    const g = (await ceo.req("POST", "/api/telegram/group-code")).json;
    await privateMsg(700020, g.command);
    expect(lastText(700020)).toContain("Group");
    await groupMsg(700020, -1001234, `/register@hangkh_bot ${g.code}`); // any member may type it: the code is the authorisation
    expect(lastText(-1001234)).toContain("✅");
    const st = (await ceo.req("GET", "/api/settings/company")).json;
    expect(String(st.telegram_group_chat_id)).toBe("-1001234");
    expect(st.telegram_group_title).toBe("One Team Work");
    expect((await sql`select kind from hub_shop_chats where chat_id = -1001234`)[0]?.kind).toBe("group");
    await groupMsg(700020, -1009999, `/register ${g.code}`);
    expect(lastText(-1009999)).toContain("❌");
    expect(String((await ceo.req("GET", "/api/settings/company")).json.telegram_group_chat_id)).toBe("-1001234");
    const audit = (await ceo.req("GET", "/api/settings/audit")).json.map((a: any) => a.action);
    expect(audit).toContain("telegram.group_registered");
    expect(audit).toContain("telegram.group_code");
  });

  it("commands addressed to another bot are ignored; /help answers", async () => {
    const n = sent.length;
    await groupMsg(700020, -1001234, "/register@other_bot ONETEAM-G-ABCDEF");
    expect(sent.length).toBe(n);
    await privateMsg(700030, "/help");
    expect(lastText(700030)).toContain("/stop promo");
  });
});

describe("shop → hub send (D-51: key + chat allowlist)", () => {
  it("booking confirmed goes out through the hub to allow-listed chats only", async () => {
    const cust = (await ceo.req("POST", "/api/customers", { name: "Hub Customer", phones: ["012777777"], zone: "inside", lat: 11.5, lng: 104.9 })).json.id;
    const bk = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "AC", zone: "inside" })).json.id;
    sent = [];
    await gm.req("POST", `/api/bookings/${bk}/assign`, { scheduled_at: "2026-10-02T02:00:00Z", lead: s.users.kim, assistants: [] });
    expect((await sql`select status from bookings where id = ${bk}`)[0]!.status).toBe("assigned");
    await flushOutbox(); // default sender = hub
    expect(texts(700001).some((t) => t.includes("Booking Confirmed"))).toBe(true);   // kim (linked through the hub)
    expect(texts(-1001234).some((t) => t.includes("Booking Confirmed"))).toBe(true); // registered group
    const out = await sql<{ status: string }[]>`select status from telegram_outbox where text like '%Hub Customer%'`;
    expect(out.every((o) => o.status === "sent")).toBe(true);
  });

  it("wrong key → 401 · chat not allow-listed → CHAT_NOT_ALLOWED (permanent) · another shop cannot write to ONETEAM chats", async () => {
    expect((await internal("ONETEAM", "nope", "POST", "/internal/send", { chat_id: "700001", text: "x" })).statusCode).toBe(401);
    expect((await internal("NOKEY", "", "POST", "/internal/send", { chat_id: "700001", text: "x" })).statusCode).toBe(401);
    const r = await internal("ONETEAM", process.env.HUB_KEY_ONETEAM!, "POST", "/internal/send", { chat_id: "123456", text: "spam" });
    expect(r.json()).toMatchObject({ ok: false, error: "CHAT_NOT_ALLOWED", permanent: true });
    const b = await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/send", { chat_id: "700001", text: "hi from B" });
    expect(b.json().error).toBe("CHAT_NOT_ALLOWED");
    expect(texts(700001).some((t) => t.includes("hi from B"))).toBe(false);
  });

  it("shop /internal/* needs the hub key; stats are aggregate numbers only", async () => {
    expect((await shop.inject({ method: "GET", url: "/internal/stats" })).statusCode).toBe(403);
    expect((await shop.inject({ method: "GET", url: "/internal/stats", headers: { "x-hub-key": "wrong" } })).statusCode).toBe(403);
    const st = (await shop.inject({ method: "GET", url: "/internal/stats", headers: { "x-hub-key": process.env.HUB_KEY_ONETEAM! } })).json();
    expect(Object.keys(st).sort()).toEqual(["bookings", "bookings_30d", "companies", "customers", "last_booking", "shop", "users"]);
  });
});

describe("Customer Subscribe A+B (A4) + Broadcast (A5)", () => {
  it("s-ONETEAM → consent text (3 purposes, privacy link) + one ☑ button; nothing stored before the tick", async () => {
    await privateMsg(800001, "/start s-ONETEAM");
    const prompt = sent.filter((x) => x.method === "sendMessage" && x.payload.chat_id === 800001).at(-1)!;
    expect(prompt.payload.text).toContain("1️⃣"); expect(prompt.payload.text).toContain("2️⃣"); expect(prompt.payload.text).toContain("3️⃣");
    expect(prompt.payload.text).toContain("One Team Engineering");
    expect(prompt.payload.text).toContain("/privacy");
    expect(prompt.payload.reply_markup.inline_keyboard[0]).toHaveLength(1);
    expect(prompt.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe(`sub:ONETEAM:${CONSENT_VERSION}`);
    expect((await sql`select count(*)::int as n from hub_subscribers where telegram_user_id = 800001`)[0]!.n).toBe(0);
  });

  it("tick → subscriber + subscription + consent log (who / when / text version)", async () => {
    await tick(800001);
    expect(lastText(800001)).toContain("✅");
    const log = await sql`select action, text_version, shop_code from hub_consent_log where telegram_user_id = 800001`;
    expect(log).toEqual([{ action: "subscribe", text_version: CONSENT_VERSION, shop_code: "ONETEAM" }]);
    expect((await sql`select body_km from hub_consent_texts where version = ${CONSENT_VERSION}`)[0]!.body_km).toContain("3️⃣");
    // old consent version or a shop without the module → nothing stored
    await tick(800009, "ONETEAM", "2020-01-01-v0");
    await privateMsg(800009, "/start s-NOSUB");
    expect(lastText(800009)).toContain("❌");
    await tick(800009, "NOSUB");
    expect((await sql`select count(*)::int as n from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 800009`)[0]!.n).toBe(0);
  });

  it("consent log and message log are append-only", async () => {
    await expect(sql`update hub_consent_log set action = 'stop'`).rejects.toThrow(/APPEND_ONLY/);
    await expect(sql`delete from hub_message_log`).rejects.toThrow(/APPEND_ONLY/);
  });

  it("broadcast reaches only the calling shop's subscribers; promo respects /stop promo (no cross-shop messages)", async () => {
    await tick(800002); await tick(800002, "SHOPB"); // 800002: both shops
    await tick(800003);                              // 800003: ONETEAM, then promo off
    await tick(800004, "SHOPB");                     // 800004: SHOPB only
    await privateMsg(800003, "/stop promo");
    expect(lastText(800003)).toContain("One Team Engineering");
    expect((await sql`select action from hub_consent_log where telegram_user_id = 800003 order by id`).map((r) => r.action)).toEqual(["subscribe", "promo_off"]);

    const r = await admin.req("POST", "/api/subscribe/broadcast", { kind: "promo", text: "បញ្ចុះតម្លៃ 10% លាងម៉ាស៊ីនត្រជាក់" });
    expect(r.status).toBe(200); expect(r.json.recipients).toBe(2); // 800001 + 800002 (not 800003 promo off, not 800004 SHOPB)
    sent = [];
    const f = await flushHubOutbox(100, undefined, false);
    expect(f.sent).toBe(2);
    expect(sent.map((x) => Number(x.payload.chat_id)).sort()).toEqual([800001, 800002]);
    expect(String(sent[0]!.payload.text)).toContain("📢 One Team Engineering");
    expect(String(sent[0]!.payload.text)).toContain("/stop promo");

    // SHOPB (its own key) broadcasts a service notice: only SHOPB subscribers, never ONETEAM-only customers
    const b = await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/broadcast", { kind: "service", text: "Closed on Monday" });
    expect(b.json().recipients).toBe(2);
    sent = [];
    await flushHubOutbox(100, undefined, false);
    expect(sent.map((x) => Number(x.payload.chat_id)).sort()).toEqual([800002, 800004]);
    // the shop id comes from the key, never from the body
    expect((await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/broadcast", { kind: "service", text: "x", shop_code: "ONETEAM" })).statusCode).toBe(400);
  });

  it("1 broadcast per 10 minutes per shop · 1,000 characters · permission + feature flag", async () => {
    expect((await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "again" })).json.error).toBe("BROADCAST_TOO_SOON");
    expect((await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "x".repeat(1001) })).status).toBe(400);
    expect((await kim.req("GET", "/api/subscribe")).status).toBe(403);
    expect((await kim.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "x" })).status).toBe(403);
    config.shop.features = "";
    expect((await admin.req("GET", "/api/subscribe")).status).toBe(404);
    expect((await shop.inject({ method: "GET", url: "/api/config" })).json().features).toEqual([]);
    config.shop.features = "subscribe";
  });

  it("shop page: subscribe link + counts of its own subscribers only; history", async () => {
    const r = (await gm.req("GET", "/api/subscribe")).json;
    expect(r.link).toBe("https://t.me/hangkh_bot?start=s-ONETEAM");
    expect(r.total).toBe(3); expect(r.promo).toBe(2);
    expect(r.subscribers.map((x: any) => x.username).sort()).toEqual(["u800001", "u800002", "u800003"]);
    const h = (await gm.req("GET", "/api/subscribe/broadcasts")).json;
    expect(h).toHaveLength(1); expect(h[0]).toMatchObject({ kind: "promo", recipients: 2, sent: 2, failed: 0 });
    expect((await ceo.req("GET", "/api/settings/audit")).json.map((a: any) => a.action)).toContain("broadcast.send");
  });

  it("/stop ends every subscription of that customer; blocked bot (403) marks the subscriber", async () => {
    await privateMsg(800002, "/stop");
    expect((await sql`select count(*)::int as n from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 800002 and s.stopped_at is null`)[0]!.n).toBe(0);
    await sql`update hub_broadcasts set created_at = now() - interval '11 minutes'`;
    failNext = { error: "403 Forbidden: bot was blocked by the user", permanent: true };
    const r = await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "Holiday notice" });
    expect(r.json.recipients).toBe(2); // 800001 + 800003 (service still on)
    sent = [];
    const f = await flushHubOutbox(100, undefined, false);
    expect(f.failed).toBe(1); expect(f.sent).toBe(1);
    expect((await sql`select count(*)::int as n from hub_subscribers where blocked_at is not null`)[0]!.n).toBe(1);
    // records stay (A4): nothing deleted
    expect((await sql`select count(*)::int as n from hub_subscribers`)[0]!.n).toBe(4);
  });
});

describe("platform page (owner) + public pages", () => {
  it("login required · wrong password 401 · foreign Origin 403 · page shows shops with aggregate numbers only", async () => {
    expect((await hub.inject({ method: "GET", url: "/platform" })).statusCode).toBe(303);
    await createHubAdmin("heng", "Platform-Pass-2026!");
    const form = (u: string, p: string, origin?: string) => hub.inject({ method: "POST", url: "/platform/login", payload: `username=${u}&password=${encodeURIComponent(p)}`,
      headers: { "content-type": "application/x-www-form-urlencoded", ...(origin ? { origin } : {}) } });
    resetRateLimits();
    expect((await form("heng", "wrong")).statusCode).toBe(401);
    expect((await form("heng", "Platform-Pass-2026!", "https://evil.example")).statusCode).toBe(403);
    const ok = await form("heng", "Platform-Pass-2026!");
    expect(ok.statusCode).toBe(303);
    const cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/i);
    expect(String(ok.headers["set-cookie"])).toMatch(/SameSite=Strict/i);
    const page = await hub.inject({ method: "GET", url: "/platform", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("ONETEAM"); expect(page.body).toContain("online"); expect(page.body).toContain("offline"); // SHOPB unreachable
    expect(page.body).not.toContain("Hub Customer"); // no personal data of shop customers
    await hub.inject({ method: "POST", url: "/platform/logout", headers: { cookie } });
    expect((await hub.inject({ method: "GET", url: "/platform", headers: { cookie } })).statusCode).toBe(303);
  });

  it("/privacy and /terms (km + en) on the hub; the shop exposes its company name for {{company_name}}", async () => {
    const p = await hub.inject({ method: "GET", url: "/privacy" });
    expect(p.statusCode).toBe(200); expect(p.body).toContain("គោលការណ៍ឯកជនភាព"); expect(p.body).not.toContain("{{company_name}}");
    expect((await hub.inject({ method: "GET", url: "/terms?lang=en" })).body).toContain("Terms of Service");
    const c = (await shop.inject({ method: "GET", url: "/api/config" })).json();
    expect(c).toMatchObject({ companyName: "One Team Engineering", shopCode: "ONETEAM", telegramBot: "hangkh_bot", features: ["subscribe"] });
  });
});
