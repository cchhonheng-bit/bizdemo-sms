// Hub with one Telegram bot PER SHOP (T1–T7) + the HangKH master bot: routing by webhook path, shop ⇄ hub internal API,
// Subscribe/Consent (A4/T5), Broadcast isolation (A5/T7), encrypted bot registry (T2), platform bot management (T6), alerts (T4).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { randomBytes } from "node:crypto";
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
import { invalidateBots, listBots, rotateSecret, setBot } from "../src/hub/bots.js";
import { resetAlertThrottle, sendAlert } from "../src/hub/alerts.js";
import { resetBotCache, setHubTransport } from "../src/services/hub-client.js";
import { flushOutbox } from "../src/services/telegram.js";

let shop: FastifyInstance, hub: FastifyInstance, s: Seed;
let ceo: Client, gm: Client, admin: Client, kim: Client;
type Sent = { method: string; payload: any; bot: string };
let sent: Sent[] = [];
let failNext: { error: string; permanent: boolean } | null = null;
let shopCalls = 0;
const tok = (n: string) => `${n}:AAH${"x".repeat(30)}${n}`;
const TOKENS: Record<string, { token: string; username: string }> = {
  ONETEAM: { token: tok("111111111"), username: "Oneteam_app_bot" },
  SHOPB: { token: tok("222222222"), username: "ShopB_bot" },
  HANGKH: { token: tok("333333333"), username: "Hangkh_bot" },
};
const byToken = (t: string) => Object.values(TOKENS).find((x) => x.token === t);

const texts = (chat?: number, bot?: string) => sent.filter((x) => x.method === "sendMessage" && (chat === undefined || Number(x.payload.chat_id) === chat) && (!bot || x.bot === bot)).map((x) => String(x.payload.text));
const lastText = (chat: number) => texts(chat).at(-1) ?? "";
const lastSent = (chat: number) => sent.filter((x) => x.method === "sendMessage" && Number(x.payload.chat_id) === chat).at(-1)!;
let uid = 1;
const secretOf = async (code: string) => (await listBots()).find((b) => b.code === code)?.secret ?? "no-such-bot";
const hook = async (path: string, u: Record<string, unknown>, secret?: string | null) => {
  const sec = secret === undefined ? await secretOf(path === "hangkh" ? "HANGKH" : path.toUpperCase()) : secret;
  return hub.inject({ method: "POST", url: `/tg/${path}`, payload: { update_id: uid++, ...u }, headers: sec ? { "x-telegram-bot-api-secret-token": sec } : {} });
};
const privateMsg = (user: number, text: string, extra: Record<string, unknown> = {}, path = "oneteam") =>
  hook(path, { message: { message_id: uid, chat: { id: user, type: "private" }, from: { id: user, first_name: `U${user}`, username: `u${user}` }, text, ...extra } });
const groupMsg = (user: number, chat: number, text: string, path = "oneteam") =>
  hook(path, { message: { message_id: uid, chat: { id: chat, type: "supergroup", title: "One Team Work" }, from: { id: user, first_name: `U${user}` }, text } });
const tick = (user: number, shopCode = "ONETEAM", version = CONSENT_VERSION, path = shopCode.toLowerCase()) =>
  hook(path, { callback_query: { id: `cb${uid}`, from: { id: user, first_name: `U${user}`, username: `u${user}` }, message: { message_id: 1, chat: { id: user, type: "private" } }, data: `sub:${shopCode}:${version}` } });
const internal = (code: string, key: string, method: "GET" | "POST", url: string, body?: unknown) =>
  hub.inject({ method, url, headers: { "x-shop-code": code, "x-hub-key": key, ...(body === undefined ? {} : { "content-type": "application/json" }) }, payload: body === undefined ? undefined : JSON.stringify(body) });

beforeAll(async () => {
  await resetDb(); s = await seed();
  process.env.HUB_KEY_ONETEAM = "key-oneteam-0123456789abcdef";
  process.env.HUB_KEY_SHOPB = "key-shopb-0123456789abcdef";
  Object.assign(config.shop, { code: "ONETEAM", hubKey: process.env.HUB_KEY_ONETEAM, features: "subscribe" });
  Object.assign(config.telegram, { webhookSecret: "legacy-secret", botUsername: "", botToken: "" });
  Object.assign(config.hub, { tokenKey: randomBytes(32).toString("base64"), masterUsername: "hangkh_bot" });
  config.publicUrl = "https://hub.test";
  await syncShops("ONETEAM|One Team Engineering|http://app-oneteam:3000|subscribe;SHOPB|Shop B|http://app-shopb:3000|subscribe;NOSUB|No Subscribe Shop|http://app-nosub:3000");
  await ensureConsentText();
  shop = await makeApp();
  hub = buildHubApp({ logger: false }); await hub.ready();
  setTelegramTransport(async (method, payload, bot) => {
    const who = byToken(bot.token);
    if (!who) return { ok: false, error: "401 Unauthorized", permanent: true };
    if (method === "getMe") return { ok: true, result: { username: who.username } };
    if (method === "getWebhookInfo") return { ok: true, result: { url: `https://hub.test/tg/${bot.code === "HANGKH" ? "hangkh" : bot.code.toLowerCase()}`, pending_update_count: 0 } };
    sent.push({ method, payload, bot: bot.code });
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
  for (const code of ["ONETEAM", "SHOPB", "HANGKH"]) expect((await setBot(code, TOKENS[code]!.token)).webhook.ok).toBe(true);
  resetBotCache();
  ceo = await loginAs(shop, "ceo"); gm = await loginAs(shop, "gm01"); admin = await loginAs(shop, "admin"); kim = await loginAs(shop, "kim");
  sent = [];
});
afterAll(async () => {
  setTelegramTransport(null); setShopTransport(null); setHubTransport(null);
  await shop.close(); await hub.close();
});

describe("bot registry (T1/T2/T6)", () => {
  it("each bot: own path + own webhook secret; tokens and secrets encrypted at rest; the master bot must be @hangkh_bot", async () => {
    const rows = await sql<{ code: string; path: string; username: string; token_enc: string; secret_enc: string }[]>`select code, path, username, token_enc, secret_enc from hub_bots order by code`;
    expect(rows.map((r) => `${r.code}:${r.path}:${r.username}`)).toEqual(["HANGKH:hangkh:Hangkh_bot", "ONETEAM:oneteam:Oneteam_app_bot", "SHOPB:shopb:ShopB_bot"]);
    for (const r of rows) { expect(r.token_enc).toMatch(/^v1\./); expect(r.token_enc).not.toContain(TOKENS[r.code]!.token.split(":")[1]!.slice(0, 10)); }
    const bots = await listBots();
    expect(new Set(bots.map((b) => b.secret)).size).toBe(3);
    await expect(setBot("HANGKH", TOKENS.ONETEAM!.token)).rejects.toMatchObject({ code: "NOT_MASTER_BOT" });
    await expect(setBot("SHOPB", TOKENS.ONETEAM!.token)).rejects.toMatchObject({ code: "BOT_IN_USE" }); // one bot = one shop
    await expect(setBot("NOSUB", "not-a-token")).rejects.toMatchObject({ code: "BAD_TOKEN" });
    await expect(setBot("NOSUB", tok("999999999"))).rejects.toMatchObject({ code: "TOKEN_REFUSED" });
    await expect(setBot("ZZZ", TOKENS.SHOPB!.token)).rejects.toMatchObject({ code: "UNKNOWN_SHOP" });
    // with a different key the stored values cannot be read (and are never returned as garbage)
    const key = config.hub.tokenKey; config.hub.tokenKey = randomBytes(32).toString("base64"); invalidateBots();
    await expect(listBots()).rejects.toThrow();
    config.hub.tokenKey = key; invalidateBots();
    expect(sent.filter((x) => x.method === "setWebhook").length).toBe(0); // (reset after setup)
  });

  it("webhook: wrong / missing / another bot's secret → 403; unknown path → 403; nothing is sent", async () => {
    const m = { message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/help" } };
    expect((await hook("oneteam", m, null)).statusCode).toBe(403);
    expect((await hook("oneteam", m, "wrong")).statusCode).toBe(403);
    expect((await hook("oneteam", m, await secretOf("SHOPB"))).statusCode).toBe(403);
    expect((await hook("nope", m, await secretOf("ONETEAM"))).statusCode).toBe(403);
    expect(sent.length).toBe(0);
  });

  it("rotate secret: the old secret stops working at once, Telegram gets the new one", async () => {
    const old = await secretOf("ONETEAM");
    expect((await rotateSecret("ONETEAM")).ok).toBe(true);
    const set = sent.filter((x) => x.method === "setWebhook").at(-1)!;
    expect(set.payload.url).toBe("https://hub.test/tg/oneteam"); expect(set.payload.secret_token).toBe(await secretOf("ONETEAM"));
    expect((await hook("oneteam", { message: { message_id: 1, chat: { id: 1, type: "private" }, from: { id: 1 }, text: "/help" } }, old)).statusCode).toBe(403);
    sent = [];
  });
});

describe("shop bot routing (T3)", () => {
  it("staff link: plain 8-char code in the shop bot's deep link → linked, reply from THAT bot, chat allow-listed, audited", async () => {
    const { code, link, bot } = (await kim.req("POST", "/api/telegram/link-code")).json;
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{8}$/); expect(bot).toBe("Oneteam_app_bot");
    expect(link).toBe(`https://t.me/Oneteam_app_bot?start=${code}`);
    expect((await privateMsg(700001, `/start ${code.toLowerCase()}`)).statusCode).toBe(200); // case-insensitive
    expect(lastText(700001)).toContain("✅"); expect(lastText(700001)).toContain("Kim");
    expect(lastSent(700001).bot).toBe("ONETEAM");
    expect(String((await sql`select telegram_user_id from users where id = ${s.users.kim!}`)[0]!.telegram_user_id)).toBe("700001");
    expect((await sql`select kind from hub_shop_chats where shop_code = 'ONETEAM' and chat_id = 700001`)[0]?.kind).toBe("staff");
    const log = await sql`select direction, kind, text, bot from hub_message_log where chat_id = 700001 order by id`;
    expect(log.map((l) => `${l.bot}:${l.direction}:${l.kind}`)).toEqual(["ONETEAM:in:/start", "ONETEAM:out:link.ok"]);
    expect(log[0]!.text).toBeNull(); // inbound: command only, no free text stored
    await privateMsg(700001, `/start ${code}`); // reused → refused
    expect(lastText(700001)).toContain("❌");
  });

  it("expired code refused; a code of shop A sent to shop B's bot never reaches shop A", async () => {
    const { code } = (await kim.req("POST", "/api/telegram/link-code")).json;
    await sql`update telegram_link_codes set expires_at = now() - interval '1 second' where code = ${code}`;
    await privateMsg(700002, `/start ${code}`);
    expect(lastText(700002)).toContain("❌");
    const fresh = (await kim.req("POST", "/api/telegram/link-code")).json.code;
    const before = shopCalls;
    await privateMsg(700003, `/start ${fresh}`, {}, "shopb"); // SHOPB's bot asks SHOPB (down) — never ONETEAM
    expect(shopCalls - before).toBe(1);
    expect((await sql`select used_at from telegram_link_codes where code = ${fresh}`)[0]!.used_at).toBeNull();
  });

  it("bad formats, legacy codes of another shop, free text and forwarded messages never reach a shop", async () => {
    const before = shopCalls;
    await privateMsg(700009, "/start SHOPB-S-ABCDEF");     // legacy prefix of another shop
    expect(lastText(700009)).toContain("❌");
    await privateMsg(700009, "/start garbage");
    await privateMsg(700009, "hello bot, my phone is 012345678"); // free text: ignored, not logged
    await privateMsg(700009, "/start ABCDEFGH", { forward_origin: { type: "user" } });
    await groupMsg(700009, -100555, "/register ABCDEFGH");  // 8 chars = staff length → not a group code
    expect(shopCalls).toBe(before);
    expect((await sql`select count(*)::int as n from hub_message_log where chat_id = 700009 and direction = 'in'`)[0]!.n).toBe(2);
    expect((await sql`select count(*)::int as n from hub_message_log where text like '%012345678%'`)[0]!.n).toBe(0);
  });

  it("brute force: 10 wrong codes per Telegram user per hour, then blocked before the shop is asked", async () => {
    resetRateLimits();
    for (let i = 0; i < 10; i++) await privateMsg(700010, "/start AAAAAAA" + "BCDEFGHJK"[i]);
    const calls = shopCalls;
    await privateMsg(700010, "/start BBBBBBBB");
    expect(shopCalls).toBe(calls);
    expect(lastText(700010)).toContain("⏳");
    resetRateLimits();
  });

  it("group: /register <6-char code> in the shop bot's group → work group set, single use; private chat refused", async () => {
    const g = (await ceo.req("POST", "/api/telegram/group-code")).json;
    expect(g.code).toMatch(/^[A-HJ-NP-Z2-9]{6}$/); expect(g.command).toBe(`/register ${g.code}`); expect(g.bot).toBe("Oneteam_app_bot");
    await privateMsg(700020, g.command);
    expect(lastText(700020)).toContain("Group");
    await groupMsg(700020, -1001234, `/register@Oneteam_app_bot ${g.code.toLowerCase()}`);
    expect(lastText(-1001234)).toContain("✅");
    const st = (await ceo.req("GET", "/api/settings/company")).json;
    expect(String(st.telegram_group_chat_id)).toBe("-1001234"); expect(st.telegram_group_title).toBe("One Team Work");
    expect((await sql`select kind from hub_shop_chats where chat_id = -1001234 and shop_code = 'ONETEAM'`)[0]?.kind).toBe("group");
    await groupMsg(700020, -1009999, `/register ${g.code}`);
    expect(lastText(-1009999)).toContain("❌");
    expect(String((await ceo.req("GET", "/api/settings/company")).json.telegram_group_chat_id)).toBe("-1001234");
    const audit = (await ceo.req("GET", "/api/settings/audit")).json.map((a: any) => a.action);
    expect(audit).toContain("telegram.group_registered"); expect(audit).toContain("telegram.group_code");
  });

  it("legacy prefixed codes of the same shop still work until they expire (migration without data loss)", async () => {
    const legacy = "ONETEAM-G-LEGACY";
    await sql`insert into telegram_link_codes (code, kind, company_id, created_by, expires_at) values (${"ONETEAM-G-QRSTUV"}, 'group', ${s.a}, ${s.users.ceo!}, now() + interval '1 hour')`;
    expect(legacy).toBeTruthy();
    await groupMsg(700021, -1004321, "/register ONETEAM-G-QRSTUV");
    expect(lastText(-1004321)).toContain("✅");
    // restore the work group used by the next tests
    const g = (await ceo.req("POST", "/api/telegram/group-code")).json;
    await groupMsg(700020, -1001234, `/register ${g.code}`);
    expect(String((await ceo.req("GET", "/api/settings/company")).json.telegram_group_chat_id)).toBe("-1001234");
  });

  it("commands addressed to another bot are ignored; /help answers", async () => {
    const n = sent.length;
    await groupMsg(700020, -1001234, "/register@hangkh_bot ABCDEF");
    expect(sent.length).toBe(n);
    await privateMsg(700030, "/help");
    expect(lastText(700030)).toContain("/stop promo");
  });
});

describe("shop → hub send (D-51 + T7: key, chat allowlist, own bot)", () => {
  it("booking confirmed goes out through the hub, via One Team's own bot, to allow-listed chats only", async () => {
    const cust = (await ceo.req("POST", "/api/customers", { name: "Hub Customer", phones: ["012777777"], zone: "inside", lat: 11.5, lng: 104.9 })).json.id;
    const when = new Date(Date.now() + 3 * 86400_000).toISOString();
    const bk = (await ceo.req("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "AC", zone: "inside", scheduled_at: when })).json.id;
    sent = [];
    expect((await gm.req("POST", `/api/bookings/${bk}/assign`, { scheduled_at: when, lead: s.users.kim, assistants: [] })).status).toBe(200);
    for (let i = 0; i < 40; i++) {
      await flushOutbox();
      if ((await sql`select 1 from telegram_outbox where text like '%Hub Customer%' and status = 'pending'`).length === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(texts(700001, "ONETEAM").some((t) => t.includes("Booking Confirmed"))).toBe(true);
    expect(texts(-1001234, "ONETEAM").some((t) => t.includes("Booking Confirmed"))).toBe(true);
    expect(sent.filter((x) => x.method === "sendMessage").every((x) => x.bot === "ONETEAM")).toBe(true);
    // I1: a 📱 button under the job message — technician → their job page, group → the booking page
    const kimMsg = sent.find((x) => x.method === "sendMessage" && Number(x.payload.chat_id) === 700001 && String(x.payload.text).includes("Booking Confirmed"))!;
    expect(kimMsg.payload.reply_markup.inline_keyboard.flat().some((b: any) => b.url === `https://hub.test/tech/job/${bk}`)).toBe(true);
    const grpMsg = sent.find((x) => x.method === "sendMessage" && Number(x.payload.chat_id) === -1001234 && String(x.payload.text).includes("Booking Confirmed"))!;
    expect(grpMsg.payload.reply_markup.inline_keyboard.flat().some((b: any) => b.url === `https://hub.test/bookings/${bk}`)).toBe(true);
    expect((await sql<{ status: string }[]>`select status from telegram_outbox where text like '%Hub Customer%'`).every((o) => o.status === "sent")).toBe(true);
  });

  it("wrong key → 401 · chat not allow-listed → CHAT_NOT_ALLOWED · shop B cannot write to One Team chats, and never through One Team's bot", async () => {
    expect((await internal("ONETEAM", "nope", "POST", "/internal/send", { chat_id: "700001", text: "x" })).statusCode).toBe(401);
    expect((await internal("NOKEY", "", "POST", "/internal/send", { chat_id: "700001", text: "x" })).statusCode).toBe(401);
    expect((await internal("ONETEAM", process.env.HUB_KEY_ONETEAM!, "POST", "/internal/send", { chat_id: "123456", text: "spam" })).json()).toMatchObject({ ok: false, error: "CHAT_NOT_ALLOWED", permanent: true });
    const b = await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/send", { chat_id: "700001", text: "hi from B" });
    expect(b.json().error).toBe("CHAT_NOT_ALLOWED");
    expect(texts(700001).some((t) => t.includes("hi from B"))).toBe(false);
    // a chat allow-listed for SHOPB is written by SHOPB's bot only
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values ('SHOPB', 700099, 'staff')`;
    sent = [];
    expect((await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/send", { chat_id: "700099", text: "B job" })).json().ok).toBe(true);
    expect(lastSent(700099).bot).toBe("SHOPB");
  });

  it("a shop without an active bot keeps its messages pending (retry), nothing goes through another bot", async () => {
    await sql`update hub_bots set status = 'disabled' where code = 'SHOPB'`; invalidateBots();
    expect((await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/send", { chat_id: "700099", text: "x" })).json()).toMatchObject({ ok: false, error: "NO_SHOP_BOT", permanent: false });
    await sql`update hub_bots set status = 'active' where code = 'SHOPB'`; invalidateBots();
  });

  it("shop /internal/* needs the hub key; stats are aggregate numbers only; the shop learns its bot from the hub", async () => {
    expect((await shop.inject({ method: "GET", url: "/internal/stats" })).statusCode).toBe(403);
    expect((await shop.inject({ method: "GET", url: "/internal/stats", headers: { "x-hub-key": "wrong" } })).statusCode).toBe(403);
    const st = (await shop.inject({ method: "GET", url: "/internal/stats", headers: { "x-hub-key": process.env.HUB_KEY_ONETEAM! } })).json();
    expect(Object.keys(st).sort()).toEqual(["bookings", "bookings_30d", "companies", "customers", "last_booking", "shop", "users"]);
    expect((await internal("ONETEAM", process.env.HUB_KEY_ONETEAM!, "GET", "/internal/bot")).json()).toEqual({ username: "Oneteam_app_bot" });
  });
});

describe("Customer Subscribe (A4/T5) + Broadcast (A5/T7)", () => {
  it("t.me/<shop bot>?start=s → consent (3 purposes) + ONE ☑ button + optional Follow HangKH link; nothing stored before the tick", async () => {
    await privateMsg(800001, "/start s");
    const prompt = lastSent(800001);
    expect(prompt.bot).toBe("ONETEAM");
    expect(prompt.payload.text).toContain("1) "); expect(prompt.payload.text).toContain("2) "); expect(prompt.payload.text).toContain("3) HangKH");
    expect(prompt.payload.text).toContain("One Team Engineering"); expect(prompt.payload.text).toContain("/privacy");
    expect(prompt.payload.reply_markup.inline_keyboard[0]).toHaveLength(1);
    expect(prompt.payload.reply_markup.inline_keyboard[0][0].callback_data).toBe(`sub:ONETEAM:${CONSENT_VERSION}`);
    expect(prompt.payload.reply_markup.inline_keyboard[1][0].url).toBe("https://t.me/Hangkh_bot?start=follow");
    expect((await sql`select count(*)::int as n from hub_subscribers where telegram_user_id = 800001`)[0]!.n).toBe(0);
    await privateMsg(800005, "/start s-ONETEAM"); // links printed before T3 still work on the shop bot
    expect(lastSent(800005).payload.reply_markup.inline_keyboard[0][0].callback_data).toBe(`sub:ONETEAM:${CONSENT_VERSION}`);
  });

  it("tick → subscriber + subscription + consent log; a consent button of shop B pressed in One Team's bot is ignored", async () => {
    await tick(800001);
    expect(lastText(800001)).toContain("✅");
    expect(await sql`select action, text_version, shop_code from hub_consent_log where telegram_user_id = 800001`).toEqual([{ action: "subscribe", text_version: CONSENT_VERSION, shop_code: "ONETEAM" }]);
    await tick(800008, "SHOPB", CONSENT_VERSION, "oneteam"); // forged / cross-shop callback
    expect((await sql`select count(*)::int as n from hub_subscribers where telegram_user_id = 800008`)[0]!.n).toBe(0);
    await tick(800009, "ONETEAM", "2020-01-01-v0");
    await privateMsg(800009, "/start s", {}, "nosub-none"); // no bot for NOSUB → 403, nothing happens
    expect((await sql`select count(*)::int as n from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 800009`)[0]!.n).toBe(0);
  });

  it("consent log and message log are append-only", async () => {
    await expect(sql`update hub_consent_log set action = 'stop'`).rejects.toThrow(/APPEND_ONLY/);
    await expect(sql`delete from hub_message_log`).rejects.toThrow(/APPEND_ONLY/);
  });

  it("broadcast: only the calling shop's subscribers, through that shop's own bot; /stop promo respected", async () => {
    await tick(800002); await tick(800002, "SHOPB"); // 800002: both shops (each through its own bot)
    await tick(800003);                              // 800003: ONETEAM, then promo off
    await tick(800004, "SHOPB");                     // 800004: SHOPB only
    await privateMsg(800003, "/stop promo");
    expect(lastText(800003)).toContain("One Team Engineering");
    expect((await sql`select action from hub_consent_log where telegram_user_id = 800003 order by id`).map((r) => r.action)).toEqual(["subscribe", "promo_off"]);
    const r = await admin.req("POST", "/api/subscribe/broadcast", { kind: "promo", text: "បញ្ចុះតម្លៃ 10% លាងម៉ាស៊ីនត្រជាក់" });
    expect(r.status).toBe(200); expect(r.json.recipients).toBe(2); // 800001 + 800002
    sent = [];
    expect((await flushHubOutbox(100)).sent).toBe(2);
    expect(sent.map((x) => Number(x.payload.chat_id)).sort()).toEqual([800001, 800002]);
    expect(sent.every((x) => x.bot === "ONETEAM")).toBe(true);
    expect(String(sent[0]!.payload.text)).toContain("📢 One Team Engineering");
    const b = await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/broadcast", { kind: "service", text: "Closed on Monday" });
    expect(b.json().recipients).toBe(2);
    sent = [];
    await flushHubOutbox(100);
    expect(sent.map((x) => Number(x.payload.chat_id)).sort()).toEqual([800002, 800004]);
    expect(sent.every((x) => x.bot === "SHOPB")).toBe(true);
    expect((await internal("SHOPB", process.env.HUB_KEY_SHOPB!, "POST", "/internal/broadcast", { kind: "service", text: "x", shop_code: "ONETEAM" })).statusCode).toBe(400);
  });

  it("1 broadcast per 10 minutes per shop · 1,000 characters · permission + feature flag", async () => {
    expect((await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "again" })).json.error).toBe("BROADCAST_TOO_SOON");
    expect((await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "x".repeat(1001) })).status).toBe(400);
    expect((await kim.req("GET", "/api/subscribe")).status).toBe(403);
    config.shop.features = "";
    expect((await admin.req("GET", "/api/subscribe")).status).toBe(404);
    config.shop.features = "subscribe";
  });

  it("shop page: t.me/<shop bot>?start=s + counts of its own subscribers only; history", async () => {
    const r = (await gm.req("GET", "/api/subscribe")).json;
    expect(r.link).toBe("https://t.me/Oneteam_app_bot?start=s"); expect(r.bot).toBe("Oneteam_app_bot");
    expect(r.total).toBe(3); expect(r.promo).toBe(2);
    const h = (await gm.req("GET", "/api/subscribe/broadcasts")).json;
    expect(h).toHaveLength(1); expect(h[0]).toMatchObject({ kind: "promo", recipients: 2, sent: 2, failed: 0 });
  });

  it("/stop in One Team's bot ends One Team only (T7); blocked bot (403) marks the subscriber", async () => {
    await privateMsg(800002, "/stop");
    const active = await sql`select s.shop_code from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 800002 and s.stopped_at is null`;
    expect(active.map((x) => x.shop_code)).toEqual(["SHOPB"]);
    await sql`update hub_broadcasts set created_at = now() - interval '11 minutes'`;
    failNext = { error: "403 Forbidden: bot was blocked by the user", permanent: true };
    const r = await admin.req("POST", "/api/subscribe/broadcast", { kind: "service", text: "Holiday notice" });
    expect(r.json.recipients).toBe(2); // 800001 + 800003
    sent = [];
    const f = await flushHubOutbox(100);
    expect(f.failed).toBe(1); expect(f.sent).toBe(1);
    expect((await sql`select count(*)::int as n from hub_subscribers where blocked_at is not null`)[0]!.n).toBe(1);
    expect((await sql`select count(*)::int as n from hub_subscribers`)[0]!.n).toBe(4); // records stay (A4)
  });
});

describe("master bot @hangkh_bot (T4)", () => {
  it("old printed links (t.me/hangkh_bot?start=s-ONETEAM) are pointed to the shop's own bot; Follow HangKH + /stop", async () => {
    await privateMsg(810001, "/start s-ONETEAM", {}, "hangkh");
    const m = lastSent(810001);
    expect(m.bot).toBe("HANGKH"); expect(m.payload.text).toContain("@Oneteam_app_bot");
    expect(m.payload.reply_markup.inline_keyboard[0][0].url).toBe("https://t.me/Oneteam_app_bot?start=s");
    expect((await sql`select count(*)::int as n from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 810001`)[0]!.n).toBe(0);
    await privateMsg(810001, "/start follow", {}, "hangkh");
    expect((await sql`select stopped_at from hub_followers where telegram_user_id = 810001`)[0]!.stopped_at).toBeNull();
    await privateMsg(810001, "/stop", {}, "hangkh");
    expect((await sql`select stopped_at from hub_followers where telegram_user_id = 810001`)[0]!.stopped_at).not.toBeNull();
    const before = shopCalls;
    await groupMsg(810001, -100888, "/register ABCDEF", "hangkh"); // groups register with the shop bot, never here
    expect(shopCalls).toBe(before);
  });

  it("owner alerts: link Telegram from the platform (10 min, single use), alerts via the master bot, throttled; shops report through their key", async () => {
    await createHubAdmin("heng", "Platform-Pass-2026!");
    const adminId = (await sql`select id from hub_admins where username = 'heng'`)[0]!.id;
    const { createAdminLinkCode } = await import("../src/hub/alerts.js");
    const code = await createAdminLinkCode(adminId);
    await privateMsg(820001, `/start a-${code}`, {}, "hangkh");
    expect(lastText(820001)).toContain("✅");
    await privateMsg(820002, `/start a-${code}`, {}, "hangkh"); // reused
    expect(lastText(820002)).toContain("❌");
    resetAlertThrottle(); sent = [];
    expect(await sendAlert("backup", "backup FAILED for shop_oneteam")).toBe(1);
    expect(lastSent(820001).bot).toBe("HANGKH"); expect(lastText(820001)).toContain("backup FAILED");
    expect(await sendAlert("backup", "again")).toBe(0); // throttled
    const r = await internal("ONETEAM", process.env.HUB_KEY_ONETEAM!, "POST", "/internal/alert", { kind: "outbox", text: "3 failed" });
    expect(r.json()).toMatchObject({ ok: true, sent: 1 });
    expect(lastText(820001)).toContain("[ONETEAM] 3 failed");
    expect((await internal("ONETEAM", "bad", "POST", "/internal/alert", { kind: "outbox", text: "x" })).statusCode).toBe(401);
  });
});

describe("platform page (owner): login + bot management (T6) + public pages", () => {
  let cookie = "";
  const form = (url: string, body: string, origin?: string) => hub.inject({ method: "POST", url, payload: body,
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}), ...(origin ? { origin } : {}) } });

  it("login required · wrong password 401 · foreign Origin 403 · page shows shops + bots, never a token", async () => {
    expect((await hub.inject({ method: "GET", url: "/platform" })).statusCode).toBe(303);
    resetRateLimits();
    expect((await form("/platform/login", "username=heng&password=wrong")).statusCode).toBe(401);
    expect((await form("/platform/login", `username=heng&password=${encodeURIComponent("Platform-Pass-2026!")}`, "https://evil.example")).statusCode).toBe(403);
    const ok = await form("/platform/login", `username=heng&password=${encodeURIComponent("Platform-Pass-2026!")}`);
    expect(ok.statusCode).toBe(303);
    expect(String(ok.headers["set-cookie"])).toMatch(/HttpOnly/i); expect(String(ok.headers["set-cookie"])).toMatch(/SameSite=Strict/i);
    cookie = String(ok.headers["set-cookie"]).split(";")[0]!;
    const page = await hub.inject({ method: "GET", url: "/platform", headers: { cookie } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("ONETEAM"); expect(page.body).toContain("offline"); // SHOPB unreachable
    expect(page.body).toContain("@Oneteam_app_bot"); expect(page.body).toContain("@Hangkh_bot"); expect(page.body).toContain("webhook OK");
    for (const t of Object.values(TOKENS)) expect(page.body).not.toContain(t.token.split(":")[1]!);
    for (const b of await listBots()) expect(page.body).not.toContain(b.secret);
    expect(page.body).not.toContain("Hub Customer");
  });

  it("replace / disable / enable / rotate / test from the page; a foreign Origin or no session cannot", async () => {
    const newTok = tok("444444444"); TOKENS.NOSUB = { token: newTok, username: "NoSub_bot" };
    expect((await form("/platform/bots/set", `code=NOSUB&token=${encodeURIComponent(newTok)}`, "https://evil.example")).statusCode).toBe(403);
    const r = await form("/platform/bots/set", `code=NOSUB&token=${encodeURIComponent(newTok)}`);
    expect(r.statusCode).toBe(303); expect(decodeURIComponent(String(r.headers.location))).toContain("@NoSub_bot saved");
    expect((await sql`select username from hub_bots where code = 'NOSUB'`)[0]!.username).toBe("NoSub_bot");
    expect(decodeURIComponent(String((await form("/platform/bots/NOSUB/disable", "")).headers.location))).toContain("disable OK");
    const m = { message: { message_id: 1, chat: { id: 5, type: "private" }, from: { id: 5 }, text: "/help" } };
    expect((await hook("nosub", m, await secretOf("NOSUB"))).statusCode).toBe(403); // disabled bot receives nothing
    expect(decodeURIComponent(String((await form("/platform/bots/NOSUB/enable", "")).headers.location))).toContain("enable OK");
    expect((await hook("nosub", m, await secretOf("NOSUB"))).statusCode).toBe(200);
    expect(decodeURIComponent(String((await form("/platform/bots/ONETEAM/rotate", "")).headers.location))).toContain("rotate OK");
    sent = [];
    expect(decodeURIComponent(String((await form("/platform/bots/ONETEAM/test", "")).headers.location))).toContain("test OK");
    expect(lastSent(820001).bot).toBe("ONETEAM");
    const saved = cookie; cookie = "";
    expect((await form("/platform/bots/ONETEAM/disable", "")).statusCode).toBe(303);
    expect((await sql`select status from hub_bots where code = 'ONETEAM'`)[0]!.status).toBe("active"); // no session → redirected, nothing done
    cookie = saved;
  });

  it("/privacy and /terms (km + en) on the hub; the shop exposes its company name and its own bot", async () => {
    const p = await hub.inject({ method: "GET", url: "/privacy" });
    expect(p.statusCode).toBe(200); expect(p.body).toContain("គោលការណ៍ឯកជនភាព"); expect(p.body).not.toContain("{{company_name}}");
    const terms = (await hub.inject({ method: "GET", url: "/terms" })).body; // I2: one page, Khmer first then English
    expect(terms).toContain("Terms of Service"); expect(terms.indexOf("លក្ខខណ្ឌ")).toBeLessThan(terms.indexOf("Terms of Service"));
    expect(terms).not.toContain("?lang=");
    resetBotCache();
    const c = (await shop.inject({ method: "GET", url: "/api/config" })).json();
    expect(c).toMatchObject({ companyName: "One Team Engineering", shopCode: "ONETEAM", telegramBot: "Oneteam_app_bot", features: ["subscribe"] });
  });
});

// ---- restored review fixes (R5 · R6 · R7 · R12) for per-shop bots ----
describe("independent review fixes (R5 · R6 · R7 · R12)", () => {
  it("R12: shops may attach https link buttons only — no callback buttons (forged consent / menu)", async () => {
    const key = process.env.HUB_KEY_ONETEAM!;
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values ('ONETEAM', 700077, 'staff') on conflict do nothing`;
    expect((await internal("ONETEAM", key, "POST", "/internal/send", { chat_id: "700077", text: "tap", reply_markup: { inline_keyboard: [[{ text: "☑", callback_data: "sub:SHOPB:x" }]] } })).statusCode).toBe(400);
    expect((await internal("ONETEAM", key, "POST", "/internal/send", { chat_id: "700077", text: "tap", reply_markup: { inline_keyboard: [[{ text: "☑", callback_data: "v:job:x" }]] } })).statusCode).toBe(400);
    expect((await internal("ONETEAM", key, "POST", "/internal/send", { chat_id: "700077", text: "x", reply_markup: { inline_keyboard: [[{ text: "go", url: "http://evil.example" }]] } })).statusCode).toBe(400);
    expect((await internal("ONETEAM", key, "POST", "/internal/send", { chat_id: "700077", text: "ok", reply_markup: { inline_keyboard: [[{ text: "🗺 Direction", url: "https://www.google.com/maps/dir/?api=1&destination=1,2" }]] } })).json().ok).toBe(true);
  });

  it("R5: the hub keeps no text of shop messages nor per-recipient broadcast copies", async () => {
    const rows = await sql`select text from hub_message_log where kind in ('shop.send', 'broadcast') and text is not null`;
    expect(rows.every((r) => /^\[\d+ chars\]$/.test(String(r.text)))).toBe(true);
    expect((await sql`select count(*)::int as n from hub_message_log where text like '%Hub Customer%'`)[0]!.n).toBe(0);
  });

  it("R7: concurrent wrong codes cannot bypass the 10/hour limit", async () => {
    resetRateLimits();
    const before = shopCalls;
    await Promise.all(Array.from({ length: 15 }, (_, i) => privateMsg(700050, `/start ZZZZ${"ABCDEFGHJKLMNPQ"[i]}ZZZ`)));
    expect(shopCalls - before).toBeLessThanOrEqual(10);
    resetRateLimits();
  });

  it("R6: deactivating a user unlinks Telegram at the hub (allowlist + user row)", async () => {
    const dara = await loginAs(shop, "dara");
    const { code } = (await dara.req("POST", "/api/telegram/link-code")).json;
    await privateMsg(700060, `/start ${code}`);
    expect((await sql`select 1 from hub_shop_chats where chat_id = 700060 and shop_code = 'ONETEAM'`).length).toBe(1);
    expect((await ceo.req("PATCH", `/api/users/${s.users.dara}`, { is_active: false })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect((await sql`select 1 from hub_shop_chats where chat_id = 700060`).length).toBe(0);
    expect((await sql`select telegram_chat_id from users where id = ${s.users.dara!}`)[0]!.telegram_chat_id).toBeNull();
    await ceo.req("PATCH", `/api/users/${s.users.dara}`, { is_active: true });
  });
});

// ---- owner I1: inline-button menus (edit in place, back/home), commands stay as fallback ----
describe("I1 Telegram inline menus", () => {
  let mid = 5000;
  const cb = (user: number, data: string, path = "oneteam", chat: { id: number; type: string } = { id: user, type: "private" }) =>
    hook(path, { callback_query: { id: `cbm${uid}`, from: { id: user, first_name: `U${user}` }, message: { message_id: ++mid, chat }, data } });
  const lastEdit = (chat: number) => sent.filter((x) => (x.method === "editMessageText" || x.method === "sendMessage") && Number(x.payload.chat_id) === chat).at(-1);
  const buttons = (m: Sent | undefined) => (m?.payload.reply_markup?.inline_keyboard ?? []).flat() as { text: string; callback_data?: string; url?: string }[];
  const datas = (m: Sent | undefined) => buttons(m).map((b) => b.callback_data ?? b.url ?? "");

  it("commands per chat type + menu button are set when a bot connects", async () => {
    sent = [];
    await rotateSecret("ONETEAM"); // reconnect
    const cmds = sent.filter((x) => x.method === "setMyCommands");
    expect(cmds.map((c) => c.payload.scope?.type).sort()).toEqual(["all_group_chats", "all_private_chats"]);
    expect(cmds.find((c) => c.payload.scope.type === "all_group_chats")!.payload.commands.map((c: any) => c.command)).toContain("register");
    expect(sent.some((x) => x.method === "setChatMenuButton" && x.payload.menu_button.type === "commands")).toBe(true);
  });

  it("customer: /start → menu → subscribe (consent) → promo off/on → stop with confirm; every step edits the same message", async () => {
    sent = [];
    await privateMsg(830001, "/start");
    const home = lastSent(830001);
    expect(home.bot).toBe("ONETEAM"); expect(home.payload.text).toContain("One Team Engineering");
    expect(datas(home)).toEqual(expect.arrayContaining(["c:sub", "c:about"]));
    expect(datas(home).some((d) => d.endsWith("/privacy"))).toBe(true);
    await cb(830001, "c:sub");
    const consent = lastEdit(830001)!;
    expect(consent.method).toBe("editMessageText"); expect(consent.payload.message_id).toBe(mid);
    expect(datas(consent)).toContain(`sub:ONETEAM:${CONSENT_VERSION}`); expect(datas(consent)).toContain("c:home");
    expect(sent.filter((x) => x.method === "answerCallbackQuery").length).toBeGreaterThan(0);
    await tick(830001);
    await privateMsg(830001, "/start");
    const subd = lastSent(830001);
    expect(datas(subd)).toEqual(expect.arrayContaining(["c:promo_off", "c:stop_ask"]));
    await cb(830001, "c:promo_off");
    expect((await sql`select s.promo from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 830001`)[0]!.promo).toBe(false);
    expect(datas(lastEdit(830001))).toContain("c:promo_on");
    await cb(830001, "c:promo_on");
    expect((await sql`select s.promo from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 830001`)[0]!.promo).toBe(true);
    expect((await sql`select action from hub_consent_log where telegram_user_id = 830001 order by id`).map((r) => r.action)).toEqual(["subscribe", "promo_off", "promo_on"]);
    await cb(830001, "c:stop_ask");
    expect(datas(lastEdit(830001))).toEqual(expect.arrayContaining(["c:stop_yes", "c:home"]));
    await cb(830001, "c:stop_yes");
    expect((await sql`select s.stopped_at from hub_subscriptions s join hub_subscribers u on u.id = s.subscriber_id where u.telegram_user_id = 830001`)[0]!.stopped_at).not.toBeNull();
  });

  it("staff: /start in the shop bot → own menu (today / upcoming / app) → job details with Direction + back; data comes from the shop", async () => {
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values ('ONETEAM', 700001, 'staff') on conflict do nothing`;
    await sql`update users set telegram_chat_id = 700001, telegram_user_id = 700001 where id = ${s.users.kim!}`;
    sent = [];
    await privateMsg(700001, "/start");
    const home = lastSent(700001);
    expect(home.payload.text).toContain("Kim");
    expect(datas(home)).toEqual(expect.arrayContaining(["v:today", "v:next"]));
    expect(datas(home).some((d) => d.startsWith("https://hub.test"))).toBe(true); // open the app
    await cb(700001, "v:next");
    const list = lastEdit(700001);
    const jobBtn = buttons(list).find((b) => b.callback_data?.startsWith("v:job:"));
    expect(jobBtn).toBeTruthy(); expect(datas(list)).toContain("v:home");
    await cb(700001, jobBtn!.callback_data!);
    const job = lastEdit(700001)!;
    expect(job.payload.text).toMatch(/BK-\d{4}/); expect(job.payload.text).toContain("Hub Customer");
    expect(datas(job).some((d) => d.includes("google.com/maps/dir"))).toBe(true);
    expect(datas(job)).toContain("v:next");
    expect(job.payload.text).not.toMatch(/\$|៛/); // technicians never see prices (AC-01)
  });

  it("security: a technician cannot open another technician's job; a non-staff chat never gets staff data; bad callback data does nothing", async () => {
    const custId = (await ceo.req("GET", "/api/customers")).json[0].id;
    const other = (await ceo.req("POST", "/api/bookings", { customer_id: custId, type: "A", category: "mep", service_text: "secret job", zone: "inside", scheduled_at: new Date(Date.now() + 5 * 86400_000).toISOString() })).json.id;
    await cb(700001, `v:job:${other}`);
    expect(lastEdit(700001)!.payload.text).not.toContain("secret job");
    sent = [];
    await cb(840001, "v:today"); // a customer chat pressing a staff button
    expect(JSON.stringify(sent)).not.toContain("Hub Customer");
    sent = [];
    await cb(700001, "v:job:not-a-uuid'; drop table users;--");
    await cb(700001, "zz:whatever");
    expect(sent.filter((x) => x.method !== "answerCallbackQuery")).toHaveLength(0);
    expect(sent.filter((x) => x.method === "answerCallbackQuery")).toHaveLength(2);
  });

  it("group: registered work group gets a group menu (today's jobs); an unregistered group gets /register help", async () => {
    sent = [];
    await groupMsg(700020, -1001234, "/start");
    expect(datas(lastSent(-1001234))).toContain("v:gtoday");
    await cb(700020, "v:gtoday", "oneteam", { id: -1001234, type: "supergroup" });
    expect(lastEdit(-1001234)!.payload.text).toBeTruthy();
    await groupMsg(700020, -1005555, "/help");
    expect(lastSent(-1005555).payload.text).toContain("/register");
  });

  it("master bot: /start menu → Follow / Unfollow buttons", async () => {
    sent = [];
    await privateMsg(850001, "/start", {}, "hangkh");
    expect(datas(lastSent(850001))).toContain("m:follow");
    await cb(850001, "m:follow", "hangkh");
    expect((await sql`select stopped_at from hub_followers where telegram_user_id = 850001`)[0]!.stopped_at).toBeNull();
    expect(datas(lastEdit(850001))).toContain("m:unfollow");
    await cb(850001, "m:unfollow", "hangkh");
    expect((await sql`select stopped_at from hub_followers where telegram_user_id = 850001`)[0]!.stopped_at).not.toBeNull();
  });
});

describe("FR-902 attendance by Telegram location (Flow 7c)", () => {
  let mid = 9000;
  const cb = (user: number, data: string) => hook("oneteam", { callback_query: { id: `cba${uid}`, from: { id: user, first_name: `U${user}` }, message: { message_id: ++mid, chat: { id: user, type: "private" } }, data } });
  const loc = (user: number, lat: number, lng: number, o: { accuracy?: number | null; date?: number; forward?: boolean; chat?: { id: number; type: string } } = {}) =>
    hook("oneteam", { message: { message_id: ++mid, date: o.date ?? Math.floor(Date.now() / 1000), chat: o.chat ?? { id: user, type: "private" }, from: { id: user, first_name: `U${user}` },
      location: { latitude: lat, longitude: lng, ...(o.accuracy === null ? {} : { horizontal_accuracy: o.accuracy ?? 10 }) }, ...(o.forward ? { forward_origin: { type: "user" } } : {}) } });
  const OFFICE = { lat: 11.5564, lng: 104.9282 };
  const link = async (user: string, chat: number) => {
    await sql`update users set telegram_chat_id = ${chat}, telegram_user_id = ${chat} where id = ${s.users[user]!}`;
    await sql`insert into hub_shop_chats (shop_code, chat_id, kind) values ('ONETEAM', ${chat}, 'staff') on conflict do nothing`;
  };
  const att = async (user: string) => (await sql`select in_at, out_at, in_out_of_range, out_out_of_range, in_no_gps, in_distance_m from attendance where user_id = ${s.users[user]!}`)[0];

  beforeAll(async () => {
    await ceo.req("PATCH", "/api/settings/company", { office_lat: OFFICE.lat, office_lng: OFFICE.lng, geofence_m: 100 });
    await link("kim", 700001); await link("gm01", 700777); await link("admin", 700888);
  });

  it("staff menu has «📍 វត្តមាន»; pressing it shows today's state and a «send my location» keyboard", async () => {
    sent = [];
    await privateMsg(700001, "/start");
    expect((lastSent(700001).payload.reply_markup.inline_keyboard as any[]).flat().map((b: any) => b.callback_data)).toContain("v:att");
    sent = [];
    await cb(700001, "v:att");
    const ask = sent.filter((x) => x.method === "sendMessage").at(-1)!;
    expect(ask.payload.reply_markup.keyboard[0][0]).toMatchObject({ request_location: true });
  });

  it("location near the office → check-in (no flag); again far away → check-out flagged; a third time → already done; keyboard removed", async () => {
    sent = [];
    await loc(700001, OFFICE.lat + 0.0002, OFFICE.lng);
    expect(lastText(700001)).toContain("ចូលធ្វើការ");
    expect(lastSent(700001).payload.reply_markup).toMatchObject({ remove_keyboard: true });
    expect(await att("kim")).toMatchObject({ in_out_of_range: false, out_at: null });
    await loc(700001, OFFICE.lat + 0.003, OFFICE.lng);
    expect(lastText(700001)).toContain("ចេញពីការងារ"); expect(lastText(700001)).toContain("ក្រៅរង្វង់");
    expect(await att("kim")).toMatchObject({ out_out_of_range: true });
    await loc(700001, OFFICE.lat, OFFICE.lng);
    expect(lastText(700001)).toContain("កត់រួចហើយ");
    const log = await sql`select kind, text from hub_message_log where chat_id = 700001 and kind = 'location'`;
    expect(log.length).toBeGreaterThan(0); expect(log.every((l) => l.text === null)).toBe(true); // coordinates are not stored in the hub
  });

  it("anti-spoofing: a location picked on the map (no GPS accuracy) is flagged «no GPS»; old or forwarded locations are refused/ignored", async () => {
    await loc(700777, OFFICE.lat, OFFICE.lng, { accuracy: null });
    expect(await att("gm01")).toMatchObject({ in_no_gps: true, in_out_of_range: true });
    sent = [];
    await loc(700888, OFFICE.lat, OFFICE.lng, { date: Math.floor(Date.now() / 1000) - 600 });
    expect(lastText(700888)).toContain("ចាស់");
    expect(await att("admin")).toBeUndefined();
    sent = [];
    await loc(700888, OFFICE.lat, OFFICE.lng, { forward: true });
    expect(sent.filter((x) => x.method === "sendMessage")).toHaveLength(0);
    expect(await att("admin")).toBeUndefined();
  });

  it("not staff → short info, nothing recorded; locations in groups are ignored", async () => {
    sent = [];
    await loc(840777, OFFICE.lat, OFFICE.lng);
    expect(lastText(840777)).toContain("បុគ្គលិក");
    sent = [];
    await loc(700001, OFFICE.lat, OFFICE.lng, { chat: { id: -100555, type: "supergroup" } });
    expect(sent.filter((x) => x.method === "sendMessage")).toHaveLength(0);
  });
});
