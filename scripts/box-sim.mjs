#!/usr/bin/env node
// Box simulation (04): the built bundles run as on the server — hub + shop as SEPARATE processes, SEPARATE databases with
// NON-superuser roles created by deploy/server/pg-init.sh's SQL, real HTTP between them, a mock Bot API.
// Proves what test.cmd cannot: env wiring, internal HTTP + keys, migrations as owner roles, cron flush, memory use.
// Usage: node scripts/box-sim.mjs   (after pnpm --filter @sms/web build && pnpm --filter @sms/server build)
import EmbeddedPostgres from "embedded-postgres";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ROOT, Steps } from "./lib/common.mjs";
const postgres = createRequire(join(ROOT, "apps", "server", "package.json"))("postgres");

const PG = 55432, SHOP = 3100, HUB = 3101, TG = 3199;
const pw = { hub: "hubpw" + Date.now(), one: "onepw" + Date.now() };
const KEY = "sim-key-" + Math.random().toString(36).slice(2), WH = "sim-webhook-secret";
const steps = new Steps();
const check = (name, ok, note = "") => { steps.add(name, ok ? "PASS" : "FAIL", note); if (!ok) console.log("FAIL:", name, note); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- mock Telegram Bot API ----
const tgCalls = [];
const tg = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const method = req.url.split("/").pop(); const payload = b ? JSON.parse(b) : {};
    tgCalls.push({ method, payload });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result: true }));
  });
}).listen(TG);

// ---- PostgreSQL + pg-init.sh SQL ----
const dir = mkdtempSync(join(tmpdir(), "box-sim-")); if (process.getuid?.() === 0) chmodSync(dir, 0o777);
const pg = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port: PG, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => undefined, onError: () => undefined });
await pg.initialise(); await pg.start();
const initSh = readFileSync(join(ROOT, "deploy", "server", "pg-init.sh"), "utf8");
const initSql = initSh.split("<<SQL")[1].split("\nSQL")[0].replaceAll("${DB_PASSWORD_HUB}", pw.hub).replaceAll("${DB_PASSWORD_ONETEAM}", pw.one);
const admin = postgres(`postgres://postgres:postgres@127.0.0.1:${PG}/postgres`, { onnotice: () => undefined });
for (const stmt of initSql.split(";").map((s) => s.trim()).filter(Boolean)) await admin.unsafe(stmt);
for (const db of ["hub", "shop_oneteam"]) { const c = postgres(`postgres://postgres:postgres@127.0.0.1:${PG}/${db}`, { onnotice: () => undefined }); await c`create extension if not exists pgcrypto`; await c.end(); }
const roles = await admin`select rolname, rolsuper from pg_roles where rolname in ('hub', 'oneteam') order by rolname`;
check("pg-init: roles hub + oneteam exist and are NOT superusers", roles.length === 2 && roles.every((r) => !r.rolsuper));

// ---- processes (same env names as deploy/server/compose.yml) ----
const dist = join(ROOT, "apps", "server", "dist");
const base = { ...process.env, NODE_ENV: "production", CRON: "true", TRUST_PROXY: "false", LOG_LEVEL: "warn", TELEGRAM_BOT_USERNAME: "hangkh_bot" };
const hubEnv = { ...base, APP_MODE: "hub", PORT: String(HUB), DATABASE_URL: `postgres://hub:${pw.hub}@127.0.0.1:${PG}/hub`, PUBLIC_URL: `http://127.0.0.1:${HUB}`,
  SESSION_SECRET: "x".repeat(40), TELEGRAM_BOT_TOKEN: "123:SIM", TELEGRAM_API_BASE: `http://127.0.0.1:${TG}`, TELEGRAM_WEBHOOK_SECRET: WH,
  HUB_SHOPS: `ONETEAM|One Team Engineering|http://127.0.0.1:${SHOP}|subscribe`, HUB_KEY_ONETEAM: KEY, HUB_SEND_RATE: "50" };
const shopEnv = { ...base, APP_MODE: "shop", PORT: String(SHOP), DATABASE_URL: `postgres://oneteam:${pw.one}@127.0.0.1:${PG}/shop_oneteam`, PUBLIC_URL: `http://127.0.0.1:${SHOP}`,
  SESSION_SECRET: "y".repeat(40), SHOP_CODE: "ONETEAM", HUB_URL: `http://127.0.0.1:${HUB}`, HUB_KEY: KEY, FEATURES: "subscribe", WEB_DIST: join(ROOT, "apps", "web", "dist") };
const procs = [];
const start = (env, name) => { const p = spawn("node", [join(dist, "index.mjs")], { env, stdio: ["ignore", "inherit", "inherit"] }); procs.push(p); p.name = name; return p; };
const hubP = start(hubEnv, "hub"); const shopP = start(shopEnv, "shop");
const up = async (port) => { for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return true; } catch { /* starting */ } await sleep(500); } return false; };
check("hub starts, migrates its DB as role hub, /healthz", await up(HUB));
check("shop starts, migrates its DB as role oneteam, /healthz", await up(SHOP));

const cli = (env, ...a) => spawnSync("node", [join(dist, "cli.mjs"), ...a], { env, encoding: "utf8" });
const created = cli(shopEnv, "create-company", "One Team Engineering", "oneteam");
const ceoPw = created.stdout.match(/ceo\s+temp password: (\S+)/)?.[1];
check("cli create-company (ceo + support)", !!ceoPw && /support\s+temp password/.test(created.stdout));
const hubAdmin = cli(hubEnv, "hub-admin", "heng");
const hubPw = hubAdmin.stdout.match(/password: (\S+)/)?.[1];
check("cli hub-admin (platform owner)", !!hubPw);

// ---- HTTP helpers ----
let cookie = "";
const api = async (method, path, body) => {
  const r = await fetch(`http://127.0.0.1:${SHOP}${path}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, json: await r.json().catch(() => null) };
};
let uid = 1;
const hook = (u) => fetch(`http://127.0.0.1:${HUB}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": WH }, body: JSON.stringify({ update_id: uid++, ...u }) });
const pm = (user, text) => hook({ message: { message_id: uid, chat: { id: user, type: "private" }, from: { id: user, first_name: "Sim" + user, username: "sim" + user }, text } });
const sentTo = (chat) => tgCalls.filter((c) => c.method === "sendMessage" && Number(c.payload.chat_id) === chat).map((c) => c.payload.text);

// ---- flows ----
check("shop login (ceo, temp password)", (await api("POST", "/api/auth/login", { identifier: "ceo", password: ceoPw })).status === 200);
check("forced password change", (await api("POST", "/api/me/password", { new_password: "Sim-Strong-Pass-26", current_password: ceoPw })).status === 200);
// setWebhook needs an https PUBLIC_URL (real domain) → RT on the server; here it must NOT be attempted
check("hub does not register the webhook without https (RT-v21 on the server)", !tgCalls.some((c) => c.method === "setWebhook"));
const link = (await api("POST", "/api/telegram/link-code")).json;
await pm(910001, `/start ${link.code}`);
check("staff link over real HTTP hub → shop", sentTo(910001).some((t) => t.includes("✅")), link.code);
const g = (await api("POST", "/api/telegram/group-code")).json;
await hook({ message: { message_id: uid, chat: { id: -100777, type: "supergroup", title: "Sim group" }, from: { id: 910001 }, text: g.command } });
check("group /register over real HTTP", sentTo(-100777).some((t) => t.includes("✅")));
const me = (await api("GET", "/api/me")).json;
const cust = (await api("POST", "/api/customers", { name: "Sim Customer", phones: ["012555555"], zone: "inside", lat: 11.56, lng: 104.92 })).json.id;
const bk = (await api("POST", "/api/bookings", { customer_id: cust, type: "A", category: "mep", service_text: "AC service", zone: "inside" })).json.id;
// the CEO is not a technician: create one, link is not needed for the group message
const tech = (await api("POST", "/api/users", { username: "simtech", full_name: "Sim Tech", role: "tech", phone: "012000321" })).json.id;
const as = await api("POST", `/api/bookings/${bk}/assign`, { lead: tech, assistants: [], scheduled_at: "2026-10-05T02:00:00Z" });
await api("POST", "/api/telegram/flush");
await sleep(500);
check("Booking Confirmed: shop outbox → hub /internal/send → Bot API → group", as.status === 200 && sentTo(-100777).some((t) => t.includes("Booking Confirmed")), me.username);

// subscribe + broadcast
await pm(920001, "/start s-ONETEAM");
const prompt = tgCalls.filter((c) => c.method === "sendMessage" && c.payload.chat_id === 920001).at(-1);
await hook({ callback_query: { id: "cb1", from: { id: 920001, first_name: "Cust" }, message: { message_id: 5, chat: { id: 920001, type: "private" } }, data: prompt.payload.reply_markup.inline_keyboard[0][0].callback_data } });
const subs = (await api("GET", "/api/subscribe")).json;
check("customer subscribe (consent tick) visible in the shop", subs.total === 1 && subs.link === "https://t.me/hangkh_bot?start=s-ONETEAM");
const bc = (await api("POST", "/api/subscribe/broadcast", { kind: "promo", text: "Sim promo" })).json;
let delivered = false;
for (let i = 0; i < 15 && !delivered; i++) { await sleep(1000); delivered = sentTo(920001).some((t) => t.includes("Sim promo")); }
check("broadcast delivered by the hub cron (≤ 15 s)", bc.recipients === 1 && delivered);

// hub security
const noKey = await fetch(`http://127.0.0.1:${HUB}/internal/subscribers`);
check("hub /internal without key → 401", noKey.status === 401);
const shopNoKey = await fetch(`http://127.0.0.1:${SHOP}/internal/stats`);
check("shop /internal without key → 403", shopNoKey.status === 403);
const badHook = await fetch(`http://127.0.0.1:${HUB}/telegram/webhook`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check("webhook without secret → 403", badHook.status === 403);

// platform page
const login = await fetch(`http://127.0.0.1:${HUB}/platform/login`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `username=heng&password=${encodeURIComponent(hubPw)}` });
const hks = (login.headers.get("set-cookie") ?? "").split(";")[0];
const page = await (await fetch(`http://127.0.0.1:${HUB}/platform`, { headers: { cookie: hks } })).text();
check("platform page: login + shop online + aggregate numbers", login.status === 303 && page.includes("ONETEAM") && page.includes("online"));
check("legal pages: shop SPA /terms + hub /privacy", (await fetch(`http://127.0.0.1:${SHOP}/terms`)).status === 200 && (await (await fetch(`http://127.0.0.1:${HUB}/privacy`)).text()).includes("HangKH"));

// isolation at the database level: the shop role cannot read the hub DB and vice versa
let crossDenied = false;
try { const x = postgres(`postgres://oneteam:${pw.one}@127.0.0.1:${PG}/hub`, { onnotice: () => undefined, connect_timeout: 3 }); await x`select 1`; await x.end(); } catch { crossDenied = true; }
check("role oneteam cannot connect to DB hub (revoke connect from public)", crossDenied);

// memory
const rss = (p) => Number(readFileSync(`/proc/${p.pid}/status`, "utf8").match(/VmRSS:\s+(\d+)/)[1]) / 1024;
const mem = `hub ${rss(hubP).toFixed(0)} MB · shop ${rss(shopP).toFixed(0)} MB`;
check("memory after the flows within limits (hub < 256 MB, shop < 448 MB)", rss(hubP) < 256 && rss(shopP) < 448, mem);

if (process.argv.includes("--serve")) {
  steps.print("BOX SIMULATION (built bundles · separate DBs + roles · real HTTP)");
  console.log(`\nserving: shop http://127.0.0.1:${SHOP} (ceo / Sim-Strong-Pass-26) · hub http://127.0.0.1:${HUB} — Ctrl+C to stop`);
  await new Promise((r) => { process.on("SIGTERM", r); process.on("SIGINT", r); });
}
for (const p of procs) p.kill("SIGTERM");
await sleep(800);
await admin.end(); tg.close(); await pg.stop(); rmSync(dir, { recursive: true, force: true });
steps.print("BOX SIMULATION (built bundles · separate DBs + roles · real HTTP)");
process.exit(steps.failed() ? 1 : 0);
