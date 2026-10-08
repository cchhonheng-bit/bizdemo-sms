// Release QA (D-134): every flow of every role on the STAGING CLONE of the live shop (`staging.sh up` first) — Edge headless at a
// phone's width (360 px; staff pages at 1280 and checked at 360), the fake Telegram (tg-mock.mjs) for the bot side, Mini App launches
// signed with the clone's test token. Results table + screenshots → %TEMP%/hangkh-qa/. Only the clone's ports are used (tunnel); the
// live shop and the live hub are never called.
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node run.mjs        (QA_SSH=hangkh443 on port-22-blocked networks)
import { execFileSync, spawn } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../..");
const SSH = process.env.QA_SSH || "hangkh";
const BASE = "https://oneteam-staging.localhost:8443", HUB = "http://127.0.0.1:3995", MOCK = "http://127.0.0.1:3994";
const API = "https://localhost:8443"; // the same front for scripted calls (Node resolves no *.localhost names; the browser does)
const WORK = join(tmpdir(), "hangkh-qa");
rmSync(WORK, { recursive: true, force: true }); mkdirSync(join(WORK, "shots"), { recursive: true });
const { chromium, request } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const { readXlsx, writeXlsx } = await import(pathToFileURL(join(ROOT, "Source/apps/server/src/lib/xlsx.ts")).href);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remote = (args, input) => execFileSync("ssh", [SSH, `bash /opt/hangkh/staging-qa/staging.sh ${args}`], { input, maxBuffer: 50e6 }).toString().trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sql = (stmt) => remote(`sql ${q(stmt)}`);
const sqlhub = (stmt) => remote("sqlhub", stmt);
const newPw = () => `Qa${randomBytes(9).toString("base64url")}!7`;
// two real work photos for the uploads (QA_PHOTOS = a folder with 1600 px copies; else One Team's originals)
const PHOTOS = process.env.QA_PHOTOS ? ["gallery-01.jpg", "gallery-03.jpg"].map((f) => join(process.env.QA_PHOTOS, f))
  : ["15052026-Pr6-1pcs-02.jpg", "15032026-Eco-Veranda-11.jpg"].map((f) => join(ROOT, "Doc_Sup/00_Reference_Customer/New Support", f));

// ---------------------------------------------------------------- results
const results = [], narrow = [], jsErrors = [];
let shotN = 0;
async function shot(page, name) {
  try { const f = join(WORK, "shots", `${String(++shotN).padStart(3, "0")}-${name.replace(/[^A-Za-z0-9]+/g, "-").slice(0, 70)}.png`); await page.screenshot({ path: f }); return f; } catch { return null; }
}
function rec(area, name, pass, detail = "") { results.push({ area, name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  [${area}] ${name}${detail ? ` — ${detail}` : ""}`); }
async function step(area, name, page, fn) {
  try { const d = await fn(); rec(area, name, true, typeof d === "string" ? d : ""); return true; }
  catch (e) { const f = page ? await shot(page, `${area}-${name}`) : null; rec(area, name, false, `${String(e?.message ?? e).split("\n")[0].slice(0, 260)}${f ? ` [${f.split(/[\\/]/).pop()}]` : ""}`); return false; }
}
const must = (c, msg) => { if (!c) throw new Error(msg); };
async function fits(page, label) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  if (sw > iw + 1) { narrow.push(`${label} (${sw} > ${iw})`); await shot(page, `overflow-${label}`); }
}

// ---------------------------------------------------------------- the clone: a fresh copy of the live shop, tunnel, https front (plays Caddy), secrets
if (process.env.QA_KEEP !== "1") {
  execFileSync("ssh", [SSH, "mkdir -p /opt/hangkh/staging-qa && chmod 755 /opt/hangkh/staging-qa && cat > /opt/hangkh/staging-qa/tg-mock.mjs && chmod 644 /opt/hangkh/staging-qa/tg-mock.mjs"], { input: readFileSync(join(HERE, "tg-mock.mjs"), "utf8").replace(/\r/g, "") });
  execFileSync("ssh", [SSH, "cat > /opt/hangkh/staging-qa/staging.sh && chmod 755 /opt/hangkh/staging-qa/staging.sh"], { input: readFileSync(join(HERE, "staging.sh"), "utf8").replace(/\r/g, "") });
  console.log(remote("up").split("\n").filter((l) => !/^NOTICE/.test(l)).slice(-2).join("\n"));
}
const tunnel = spawn("ssh", ["-N", "-L", "3994:127.0.0.1:3994", "-L", "3995:127.0.0.1:3995", "-L", "3996:127.0.0.1:3996", SSH], { stdio: "ignore" });
for (let i = 0; i < 40 && !(await fetch("http://127.0.0.1:3996/healthz").then((r) => r.ok).catch(() => false)); i++) await sleep(1000);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(WORK, "key.pem"), "-out", join(WORK, "cert.pem"), "-days", "2", "-subj", "/CN=oneteam-staging.localhost"], { stdio: "ignore" });
const front = httpsServer({ key: readFileSync(join(WORK, "key.pem")), cert: readFileSync(join(WORK, "cert.pem")) }, (req, res) => {
  const headers = { ...req.headers, "x-forwarded-for": String(req.headers["x-qa-ip"] ?? "203.0.113.200"), "x-forwarded-proto": "https", "x-forwarded-host": "oneteam-staging.localhost:8443" };
  delete headers["x-qa-ip"];
  const p = httpRequest({ host: "127.0.0.1", port: 3996, method: req.method, path: req.url, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  p.on("error", (e) => { try { res.writeHead(502); res.end(String(e)); } catch { /* gone */ } });
  req.pipe(p);
}).listen(8443);
// the hub and the shop keep «no bot» for a short while after they start (30 s / 60 s caches): wait until the site links to the bot
for (let i = 0; !(await fetch("http://127.0.0.1:3996/").then((r) => r.text()).catch(() => "")).includes("t.me/staging_oneteam_bot"); i++) {
  if (i >= 40) throw new Error("the clone's site never linked to its bot"); await sleep(4000);
}
const TOKEN = remote("secret token");
const HOOK = (await (await fetch(`${MOCK}/__calls`)).json()).find((c) => c.method === "setWebhook")?.payload?.secret_token;
must(HOOK, "the staging hub never set its webhook (fake Telegram)");

// ---------------------------------------------------------------- the fake Telegram: updates to the staging hub, the bot's answers from the mock
let upd = Math.floor(Date.now() / 1000) % 1_000_000;
const now = () => Math.floor(Date.now() / 1000);
const from = (chat) => ({ id: chat, is_bot: false, first_name: "QA", language_code: "km" });
const tgPost = (u) => fetch(`${HUB}/tg/oneteam`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": HOOK }, body: JSON.stringify({ update_id: ++upd, ...u }) }).then((r) => r.status);
const tgText = (chat, text) => tgPost({ message: { message_id: ++upd, date: now(), chat: { id: chat, type: "private", first_name: "QA" }, from: from(chat), text } });
const tgButton = (chat, messageId, data) => tgPost({ callback_query: { id: String(++upd), from: from(chat), chat_instance: "qa", data, message: { message_id: messageId, date: now(), chat: { id: chat, type: "private" }, text: "" } } });
const calls = async (since = 0) => (await fetch(`${MOCK}/__calls?since=${since}`)).json();
const lastN = async () => { const c = await calls(); return c.length ? c[c.length - 1].n : 0; };
const textOf = (c) => String(c.payload?.text ?? c.payload?.caption ?? "");
async function botSays(chat, test, since, timeout = 25_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const hit = (await calls(since)).find((c) => String(c.payload?.chat_id) === String(chat) && /^(send|edit)/.test(c.method) && test(textOf(c), c));
    if (hit) return hit;
    await sleep(800);
  }
  throw new Error(`the bot never told chat ${chat} the expected text`);
}
const PWRE = /ពាក្យសម្ងាត់(?:ថ្មី)?៖ (\d{4})/;
function initData(user) {
  const p = new URLSearchParams({ auth_date: String(now()), query_id: `AAQA${randomBytes(6).toString("hex")}`, user: JSON.stringify(user) });
  const dcs = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
  p.set("hash", createHmac("sha256", createHmac("sha256", "WebAppData").update(TOKEN).digest()).update(dcs).digest("hex"));
  return p.toString();
}
const tgHash = (id) => `#tgWebAppData=${encodeURIComponent(initData({ id, first_name: "QA", language_code: "km" }))}&tgWebAppVersion=7.10&tgWebAppPlatform=android`;

// ---------------------------------------------------------------- devices and sessions (each with its own address, as different phones)
const hourIn = (tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const ZONES = ["Asia/Phnom_Penh", "Asia/Bangkok", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland", "Pacific/Honolulu", "America/Los_Angeles", "America/Denver", "America/New_York", "Atlantic/Azores", "Europe/London", "Europe/Berlin", "Asia/Dubai", "Asia/Kolkata"];
const DAY_TZ = ZONES.find((z) => hourIn(z) >= 9 && hourIn(z) <= 12), NIGHT_TZ = ZONES.find((z) => hourIn(z) >= 21 || hourIn(z) <= 5);
must(DAY_TZ && NIGHT_TZ, "no day / night time zone found");
const TGJS = "window.Telegram={WebApp:{initData:(new URLSearchParams(location.hash.slice(1))).get('tgWebAppData')||'',initDataUnsafe:{},version:'7.10',platform:'android',colorScheme:'light',themeParams:{},isExpanded:true,viewportHeight:780,viewportStableHeight:780,ready(){},expand(){},close(){},onEvent(){},offEvent(){},sendData(){},openLink(u){location.href=u},openTelegramLink(){},setHeaderColor(){},setBackgroundColor(){},enableClosingConfirmation(){},disableClosingConfirmation(){},disableVerticalSwipes(){},MainButton:{show(){},hide(){},setText(){},onClick(){},offClick(){}},BackButton:{show(){},hide(){},onClick(){},offClick(){}},HapticFeedback:{impactOccurred(){},notificationOccurred(){},selectionChanged(){}}}};";
const browser = await chromium.launch({ channel: "msedge", headless: true });
let ipN = 10;
async function device(o = {}) {
  const ctx = await browser.newContext({ viewport: o.desktop ? { width: 1280, height: 800 } : { width: o.width ?? 360, height: 780 }, deviceScaleFactor: o.desktop ? 1 : 2,
    isMobile: !o.desktop, hasTouch: !o.desktop, locale: "km-KH", timezoneId: DAY_TZ, ignoreHTTPSErrors: true, acceptDownloads: true,
    geolocation: { latitude: 11.5231, longitude: 104.9512, accuracy: 10 }, permissions: ["geolocation"], extraHTTPHeaders: { "x-qa-ip": `203.0.113.${o.ip ?? ++ipN}` } });
  ctx.tme = [];
  await ctx.route(/^https:\/\/t\.me\//, (r) => { ctx.tme.push(r.request().url()); return r.abort("aborted"); });
  await ctx.route(/^https:\/\/telegram\.org\//, (r) => r.fulfill({ contentType: "application/javascript", body: TGJS }));
  await ctx.route(/^https:\/\/(maps\.google\.com|www\.google\.com)\//, (r) => r.fulfill({ contentType: "text/html", body: "<p>map</p>" }));
  // a phone with a GPS fix answers at once (headless Edge's own location waits)
  await ctx.addInitScript(() => {
    const pos = () => ({ coords: { latitude: 11.5231, longitude: 104.9512, accuracy: 10, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() });
    navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok(pos()), 200);
    navigator.geolocation.watchPosition = (ok) => { setTimeout(() => ok(pos()), 200); return 1; };
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { if (!/SSL certificate|ServiceWorker/.test(e.message)) jsErrors.push(`${page.url().replace(BASE, "")} · ${e.message.split("\n")[0]}`); });
  // the staff app's service worker refuses the clone's self-signed certificate (a staging artefact, not a page error)
  // (answers like 401 before sign-in or 409 «slot taken» are logged by the browser as failed resources — expected, not errors)
  page.on("console", (m) => { if (m.type() === "error" && !/SSL certificate|ServiceWorker|fetching the script|Failed to load resource/.test(m.text())) jsErrors.push(`${page.url().replace(BASE, "").slice(0, 60)} · console: ${m.text().slice(0, 140)}`); });
  return { ctx, page };
}
async function staffApi(user, pw) {
  const rc = await request.newContext({ baseURL: API, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-qa-ip": `203.0.113.${++ipN}` } });
  const r = await rc.post("/api/auth/login", { data: { identifier: user, password: pw } });
  must(r.ok(), `login ${user}: ${r.status()}`);
  const j = await r.json();
  let pwNow = pw;
  if (j.me?.must_change_password ?? j.must_change_password) { pwNow = newPw(); const c = await rc.post("/api/me/password", { data: { new_password: pwNow } }); must(c.ok(), `new password ${user}: ${c.status()}`); }
  return { rc, pw: pwNow, call: (m, p, d) => api(rc, m, p, d) };
}
async function api(rc, method, path, data) {
  const r = await rc.fetch(path, { method, data });
  const t = await r.text();
  if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${t.slice(0, 180)}`);
  return t ? JSON.parse(t) : null;
}
async function visitor() { const rc = await request.newContext({ baseURL: API, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-qa-ip": `203.0.113.${++ipN}` } }); return { rc, call: (m, p, d) => api(rc, m, p, d), text: async (p) => (await rc.get(p)).text(), raw: (m, p, d) => rc.fetch(p, { method: m, data: d }) }; }
async function uiLogin(page, user, pw) {
  await page.goto(`${BASE}/app/login`);
  await page.locator('input[name="identifier"]').fill(user);
  await page.locator('input[name="password"]').fill(pw);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((u) => !/\/app\/login/.test(String(u)), { timeout: 20_000 });
}
const idle = (page) => page.waitForLoadState("networkidle").catch(() => {});
/** a person takes more than 2 s from opening a form to sending it — the site's anti-bot clock drops faster sends without a word */
const human = () => sleep(2300);
const ymdIn = (days) => new Intl.DateTimeFormat("en-CA", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + days * 86_400_000));

const S = { u: {} };
console.log(`staging clone · day zone ${DAY_TZ} (${hourIn(DAY_TZ)}h) · night zone ${NIGHT_TZ} (${hourIn(NIGHT_TZ)}h)`);
sql(`update companies set timezone = '${DAY_TZ}'`);

// ================================================================ 1 · CEO first login, staff accounts (Users page)
const boss = await device({ desktop: true });
{
  const A = "1 CEO + users", page = boss.page;
  const temp = /temp password:\s*(\S+)/.exec(remote("cli reset-password oneteam ceo"))?.[1];
  await step(A, "CEO first sign-in asks for a new password, then the dashboard", page, async () => {
    must(temp, "no temporary password from the clone");
    await uiLogin(page, "ceo", temp);
    await page.waitForURL(/first-login/, { timeout: 15_000 });
    S.ceoPw = newPw();
    const f = page.locator('input[type="password"]');
    await f.nth(0).fill(S.ceoPw); await f.nth(1).fill(S.ceoPw);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !/first-login|login/.test(String(u)), { timeout: 15_000 });
    await page.locator('[data-testid="dashboard-panel"]').waitFor({ timeout: 15_000 });
  });
  const people = [["admin1", "QA រដ្ឋបាល", "admin", "012000601"], ["gm1", "QA អ្នកគ្រប់គ្រង", "gm", "012000602"], ["jang1", "QA ជាង ១", "tech", "012000603", true], ["jang2", "QA ជាង ២", "tech", "012000604"], ["cfo1", "QA ហិរញ្ញវត្ថុ", "cfo", "012000605"]];
  for (const [username, full, role, phone, lead] of people) {
    await step(A, `CEO adds ${role} «${username}» (temporary password shown once)`, page, async () => {
      await page.goto(`${BASE}/app/settings/users`); await idle(page);
      await page.getByRole("button", { name: "អ្នកប្រើថ្មី" }).click();
      const dlg = page.locator('[role="dialog"]').last();
      await dlg.locator('input[name="full_name"]').fill(full); await dlg.locator('input[name="username"]').fill(username); await dlg.locator('input[name="phone"]').fill(phone);
      await dlg.locator('select[name="role"]').selectOption(role);
      if (lead) await dlg.getByRole("checkbox", { name: /មេជាង/ }).check();
      await dlg.getByRole("button", { name: "រក្សាទុក" }).click();
      const code = page.locator('[role="dialog"] code').last();
      await code.waitFor({ timeout: 10_000 });
      const pw = (await code.innerText()).trim();
      must(pw.length >= 8, "no temporary password on screen");
      await page.locator('[role="dialog"]').last().getByRole("button", { name: "បិទ", exact: true }).click();
      S.u[username] = { username, temp: pw, role };
    });
  }
  await step(A, "every new person signs in once and sets a password (first login)", null, async () => {
    for (const u of Object.values(S.u)) { const s = await staffApi(u.username, u.temp); u.pw = s.pw; u.id = (await s.call("GET", "/api/me")).id; }
  });
  await step(A, "Admin links Telegram: «ខ្ញុំ» → «ភ្ជាប់ Telegram» → START in the bot → linked (staff alerts reach this chat)", null, async () => {
    const { ctx, page: p } = await device();
    await uiLogin(p, "admin1", S.u.admin1.pw);
    await p.goto(`${BASE}/app/me`); await p.locator('[data-testid="tg-link"]').click();
    const href = await p.locator('[data-testid="tg-open"]').getAttribute("href", { timeout: 10_000 });
    const code = /start=([A-Za-z0-9_-]+)/.exec(href ?? "")?.[1]; must(code, `no link code (${href})`);
    const since = await lastN();
    await tgText(990011, `/start ${code}`);
    await botSays(990011, () => true, since);
    must(sql("select telegram_chat_id from users where username = 'admin1'") === "990011", "the shop did not link the chat");
    await ctx.close();
  });
  await step(A, "Users page: HangKH Support last and locked, demo staff off", page, async () => {
    await page.goto(`${BASE}/app/settings/users`); await idle(page);
    await page.locator('[data-testid="user-platform"]').waitFor({ timeout: 10_000 });
    const off = await page.getByRole("row", { name: /\(Demo\)/ }).count();
    must(off >= 4, `demo rows seen: ${off}`);
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "users-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
}
const ceoApi = await staffApi("ceo", S.ceoPw);
const catalog = await ceoApi.call("GET", "/api/catalog");
const item = (code) => (Array.isArray(catalog) ? catalog : catalog.items).find((x) => x.code === code);
const AC = item("AC-CLEAN"), EL = item("EL-REPAIR");

// ================================================================ 2 · customer: website → booking → Telegram link → password → signed in
const cust = await device({ ip: 21 });
{
  const A = "2 Customer website", page = cust.page;
  await step(A, "home: logo, «ចាប់ពី $15» tiles, 11 work photos, both phones, address", page, async () => {
    await page.goto(`${BASE}/`); await page.locator("#cats").waitFor();
    const before = await page.evaluate(() => [...document.querySelectorAll(".gal img")].filter((i) => i.getAttribute("src")).length);
    await page.locator(".gal").scrollIntoViewIfNeeded(); // the photos come when the visitor scrolls near them (D-134)
    await page.waitForFunction(() => [...document.querySelectorAll(".gal img")].every((i) => i.getAttribute("src") && i.complete), null, { timeout: 20_000 });
    S.galleryAtOpen = before;
    const d = await page.evaluate(async () => {
      const imgs = [...document.querySelectorAll(".gal img")];
      return { tiles: [...document.querySelectorAll(".tile.cat .tp")].map((x) => x.textContent), gal: imgs.filter((i) => i.naturalWidth > 0).length, tel: [...document.querySelectorAll('a[href^="tel:"]')].map((a) => a.getAttribute("href")),
        addr: document.body.innerText.includes("S-01"), logo: document.querySelector(".av img")?.naturalWidth ?? 0 };
    });
    must(d.tiles.filter((t) => t.includes("$15")).length >= 4, `tiles: ${d.tiles.join(" | ")}`);
    must(d.gal === 11, `photos loaded: ${d.gal}`); must(d.tel.includes("tel:077632899") && d.tel.includes("tel:015899632"), `phones: ${d.tel}`);
    must(d.addr, "address missing"); must(d.logo > 0, "logo not loaded");
    await fits(page, "home-360");
    return `photos fetched with the page (before scrolling): ${before}`;
  });
  await step(A, "English page: English only, prices in $", page, async () => {
    await page.goto(`${BASE}/?lang=en`); await page.locator("#cats").waitFor();
    const t = await page.locator("#pick").innerText();
    must(/From \$15/.test(t), `no «From $15»: ${t.slice(0, 120)}`);
    const h1 = await page.locator("#pick h1").innerText(); must(!/[ក-៿]/.test(h1), `Khmer in the English heading: ${h1}`);
    await fits(page, "home-en-360");
    await page.goto(`${BASE}/?lang=km`);
  });
  await step(A, "book: AC cleaning ×2 → price $30 → a day + time (12:00 open: no lunch) → GPS → details → «កក់ និងភ្ជាប់ Telegram»", page, async () => {
    await page.goto(`${BASE}/`); await page.locator('#cats .cat[data-cat="ac"]').click();
    const sel = page.locator("#lines .line select").first();
    const val = await sel.evaluate((s) => [...s.options].find((o) => o.textContent.startsWith("លាងម៉ាស៊ីនត្រជាក់"))?.value);
    must(val, "AC cleaning not in the list"); await sel.selectOption(val);
    await page.locator('#lines [data-q="1"]').first().click();
    must((await page.locator("#price").innerText()).includes("$30"), `price: ${await page.locator("#price").innerText()}`);
    await page.locator("#go").click(); await page.locator("#days").waitFor();
    const day = page.locator("#days .day:not([disabled])").nth(1); S.dayA = await day.getAttribute("data-day"); await day.click();
    const slots = page.locator(".slots:not([hidden]) .slot");
    const times = await slots.allInnerTexts();
    must(times.some((t) => t.includes("12:00")), `no 12:00 slot (lunch?): ${times.join(",")}`);
    await page.locator(".slots:not([hidden]) .slot:not([disabled])").first().click();
    await page.locator("#gps").click(); await page.locator("#loc-ok:not([hidden])").waitFor({ timeout: 12_000 });
    await page.locator("#addr").fill("ផ្ទះលេខ 21 ផ្លូវសាកល្បង");
    await fits(page, "book-360");
    await page.locator("#next").click(); await page.locator("#s3:not([hidden])").waitFor();
    await page.locator("#name").fill("QA អតិថិជន ក"); await page.locator("#phone").fill("12 000 701");
    await page.locator("#consent-text").waitFor();
    await human(); await page.locator("#send").click();
    await page.locator('body[data-page="done"]').waitFor({ timeout: 20_000 });
    const link = cust.ctx.tme.at(-1) ?? (await page.locator("#tg-open").getAttribute("href").catch(() => null));
    S.tokA = /start=(b-[A-Za-z0-9_-]{20})/.exec(link ?? "")?.[1];
    must(S.tokA, `no link token (${link})`);
    must(/staging_oneteam_bot/.test(link), `bot: ${link}`);
    S.refA = await page.locator(".sum").innerText();
    await fits(page, "done-360");
    return `times shown ${times.length} · ${times[0]}–${times.at(-1)}`;
  });
  await step(A, "Telegram START → linked at once: «✅ ភ្ជាប់រួចរាល់» + 4-digit password + hint + the grid keyboard + menu button", null, async () => {
    const since = await lastN();
    must((await tgText(990001, `/start ${S.tokA}`)) === 200, "webhook refused");
    const m = await botSays(990001, (t) => PWRE.test(t), since);
    S.pwA = PWRE.exec(textOf(m))[1];
    must(textOf(m).includes("ភ្ជាប់រួចរាល់"), "no «ភ្ជាប់រួចរាល់»");
    await botSays(990001, (t) => t.includes("អាចប្ដូរជាលេខដែលងាយចាំ"), since);
    const all = (await calls(since)).filter((c) => String(c.payload?.chat_id) === "990001");
    const kb = all.flatMap((c) => c.payload?.reply_markup?.keyboard ?? []).flat().map((b) => b.text);
    must(kb.some((t) => t.includes("📅")) && kb.some((t) => t.includes("📍")), `keyboard: ${kb.join(" | ")}`);
    must(all.some((c) => c.method === "setChatMenuButton"), "no chat menu button (Mini App)");
  });
  await step(A, "staff hear about the new booking (a message to a staff chat)", null, async () => {
    // the Admin linked in step 1 (990011); the clone's hub refuses chats it does not know (the live HangKH Support chat copied over)
    const t0 = Date.now(); let got = false;
    while (!got && Date.now() - t0 < 25_000) { got = (await calls()).some((c) => c.method === "sendMessage" && String(c.payload?.chat_id) === "990011" && /QA អតិថិជន ក/.test(textOf(c))); if (!got) await sleep(1000); }
    must(got, "no alert to the Admin's Telegram with the customer's name");
  });
  await step(A, "website sign-in: phone + the bot's password → «គណនីរបស់ខ្ញុំ» → my booking", page, async () => {
    await page.goto(`${BASE}/my/login`); await page.locator("#phone").fill("12 000 701"); await page.locator("#pw").fill(S.pwA); await page.locator("#login").click();
    await page.locator('body[data-page="my"]').waitFor({ timeout: 15_000 });
    await page.goto(`${BASE}/my/bookings`); await page.locator("section[data-booking]").first().waitFor({ timeout: 15_000 });
    S.numA = /#(BK-\d+)/.exec(await page.locator("section[data-booking]").first().innerText())?.[1];
    must(S.numA, "no booking number on the card");
    await fits(page, "my-bookings-360");
    return S.numA;
  });
}

// ================================================================ 3 · Admin: requests → confirm + crew · decline
const adm = await device({ desktop: true });
{
  const A = "3 Admin requests", page = adm.page;
  await step(A, "a second website booking (customer B, through the public API)", null, async () => {
    const v = await visitor();
    const ts = /data-ts="([^"]+)"/.exec(await v.text(`/book?items=${AC.id}:1`))?.[1]; must(ts, "no form clock");
    const days = (await v.call("GET", `/api/public/slots?items=${AC.id}:1`)).days.filter((d) => d.slots.some((s) => s.free));
    const at = days[2].slots.find((s) => s.free).at;
    await sleep(2600);
    S.bookB = await v.call("POST", "/api/public/bookings", { items: `${AC.id}:1`, at, address: "ផ្ទះលេខ 22 ផ្លូវសាកល្បង", name: "QA អតិថិជន ខ", phone: "012000702", consent: true, ts });
  });
  await step(A, "Admin signs in (first login done) → «សំណើអតិថិជន»", page, async () => { await uiLogin(page, "admin1", S.u.admin1.pw); await page.goto(`${BASE}/app/requests`); await page.locator('[data-testid="req-card"]').first().waitFor({ timeout: 15_000 }); });
  await step(A, "«បញ្ជាក់» → one dialog: job length + crew (busy greyed) → confirmed + assigned; the customer is told in Telegram", page, async () => {
    const since = await lastN();
    const card = page.locator('[data-testid="req-card"]', { hasText: "QA អតិថិជន ក" }).locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " card ")][1]');
    await card.locator('[data-testid="req-yes"]').click();
    const dlg = page.locator('[role="dialog"]').last();
    S.minutesA = await dlg.locator('[data-testid="req-minutes"]').inputValue();
    await dlg.locator('[data-testid="crew-free"] label', { hasText: "QA ជាង ១" }).first().click();
    await page.locator('[data-testid="req-confirm-go"]').click();
    await botSays(990001, (t) => t.includes("បានបញ្ជាក់"), since);
    const b = (await ceoApi.call("GET", "/api/bookings?limit=200")); const list = Array.isArray(b) ? b : b.items ?? [];
    const row = list.find((x) => x.number === S.numA); must(row && ["assigned", "confirmed"].includes(row.status), `status ${row?.status}`);
    S.idA = row.id;
    return `job length shown ${S.minutesA} min`;
  });
  await step(A, "«មិនទទួល» with a reason → declined", page, async () => {
    const card = page.locator('[data-testid="req-card"]', { hasText: "QA អតិថិជន ខ" }).locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " card ")][1]');
    await card.locator('[data-testid="req-no"]').click(); await card.locator('[data-testid="req-reason"]').fill("ថ្ងៃនោះជាងពេញ"); await card.locator('[data-testid="req-no-go"]').click();
    await idle(page); await sleep(800);
    const r = (await ceoApi.call("GET", "/api/requests?all=1")); const rows = Array.isArray(r) ? r : r.items ?? r.requests ?? [];
    must(rows.some((x) => x.booking_number === S.bookB.number && x.outcome === "declined"), "not declined");
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "requests-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
}

// ================================================================ 4 · customer: track → another time → cancel a second booking
{
  const A = "4 Customer track", page = cust.page;
  await step(A, "«ស្នើប្ដូរម៉ោង» → a new day + time → sent; the shop approves → «🔁 បានប្ដូរម៉ោង» in Telegram", page, async () => {
    await page.goto(`${BASE}/my/bookings`);
    const card = page.locator("section[data-booking]", { hasText: `#${S.numA}` });
    await card.locator("[data-move]").click(); await card.locator(".pk .day").first().waitFor();
    // another day than the booking's (the same day + time is refused: «នេះជាម៉ោងដដែល»)
    const open = card.locator(".pk .day:not([disabled])"), dates = await open.evaluateAll((els) => els.map((e) => e.getAttribute("data-day")));
    const day = dates.slice(1).find((x) => x !== S.dayA); must(day, "no other free day"); await card.locator(`.pk .day[data-day="${day}"]`).click();
    await card.locator(`.pk .slots[data-for="${day}"] .slot:not([disabled])`).first().click();
    await card.locator("[data-move-go]").click(); await page.locator("section[data-booking] .note").first().waitFor({ timeout: 10_000 });
    const since = await lastN();
    await adm.page.goto(`${BASE}/app/requests`); await idle(adm.page);
    // the request's card: its header (req-card) and, next to it, the booking number + «យល់ព្រម»
    const rc = adm.page.locator(".card", { has: adm.page.locator('[data-testid="req-yes"]'), hasText: S.numA }).last();
    await rc.locator('[data-testid="req-yes"]').first().click();
    const dlg = adm.page.locator('[role="dialog"]');
    if (await dlg.count()) { const go = adm.page.locator('[data-testid="req-confirm-go"]'); if (await go.count()) await go.click(); }
    await botSays(990001, (t) => t.includes("បានប្ដូរម៉ោង"), since);
  });
  await step(A, "signed in, a second booking needs no Telegram step; «បោះបង់» with a reason → cancelled, the shop told", page, async () => {
    await page.goto(`${BASE}/book?items=${EL.id}:1`); await page.locator("#days").waitFor();
    await page.locator("#days .day:not([disabled])").nth(2).click(); await page.locator(".slots:not([hidden]) .slot:not([disabled])").first().click();
    await page.locator("#gps").click(); await page.locator("#loc-ok:not([hidden])").waitFor({ timeout: 12_000 });
    await page.locator("#next").click(); await page.locator("#s3:not([hidden])").waitFor();
    const tmeBefore = cust.ctx.tme.length;
    await human(); await page.locator("#send").click(); await page.locator('body[data-page="done"]').waitFor({ timeout: 20_000 });
    must(cust.ctx.tme.length === tmeBefore, "a signed-in booking still opened Telegram");
    const num = /BK-\d+/.exec(await page.locator(".sum").innerText())?.[0]; must(num, "no number"); S.numA2 = num;
    const since = await lastN();
    await page.goto(`${BASE}/my/bookings`);
    const card = page.locator("section[data-booking]", { hasText: `#${num}` });
    await card.locator("[data-cancel]").click(); await card.locator("textarea").fill("មិនទំនេរថ្ងៃនោះ"); await card.locator("[data-cancel-go]").click();
    await sleep(1500);
    const staffChats = sql("select string_agg(telegram_chat_id::text, ',') from users where telegram_chat_id is not null and is_active").split(",").filter(Boolean);
    const t0 = Date.now(); let told = false;
    while (!told && Date.now() - t0 < 20_000) { told = (await calls(since)).some((c) => staffChats.includes(String(c.payload?.chat_id)) && c.method === "sendMessage" && textOf(c).includes(num)); if (!told) await sleep(800); }
    must(told, "staff not told of the cancellation");
  });
}

// ================================================================ 5 · quote with photos → linked → password
{
  const A = "5 Quote + photos", { ctx, page } = await device();
  await step(A, "construction → «ស្នើសុំតម្លៃ» → description + 2 photos + name + GPS → sent → Telegram START → password", page, async () => {
    await page.goto(`${BASE}/`); await page.locator('#cats .cat[data-cat="construction"]').click(); await page.locator("#go").click();
    await page.locator("#add").waitFor();
    await page.locator("#desc").fill("ជញ្ជាំងបន្ទប់ទឹកសើម ទុយោលេចទឹក");
    await page.locator("#file").setInputFiles(PHOTOS); await page.locator("#photos .pt").nth(1).waitFor({ timeout: 10_000 });
    await page.locator("#name").fill("QA អតិថិជន គ"); await page.locator("#phone").fill("012 000 703");
    await page.locator("#gps").click(); await page.locator("#loc-ok:not([hidden])").waitFor({ timeout: 12_000 });
    await fits(page, "quote-360");
    await human(); await page.locator("#send").click(); await page.locator('body[data-page="done"]').waitFor({ timeout: 25_000 });
    const tok = /start=(b-[A-Za-z0-9_-]{20})/.exec(ctx.tme.at(-1) ?? "")?.[1]; must(tok, "no link token");
    const since = await lastN();
    await tgText(990003, `/start ${tok}`);
    await botSays(990003, (t) => PWRE.test(t), since);
    const r = await ceoApi.call("GET", "/api/requests"); const rows = Array.isArray(r) ? r : r.items ?? r.requests ?? [];
    const qr = rows.find((x) => x.kind === "quote" && JSON.stringify(x).includes("QA អតិថិជន គ"));
    must(qr, "no quote request in the inbox");
    return `photos in the request: ${JSON.stringify(qr).match(/photo/g)?.length ?? 0} mentions`;
  });
  await ctx.close();
}

// ================================================================ 6 · forgot / change password · notifications · Mini App
{
  const A = "6 Customer password + Mini App", page = cust.page;
  await step(A, "«ភ្លេចពាក្យសម្ងាត់» points to the bot; bot «🔑» → a new password; the old one stops working", page, async () => {
    await cust.ctx.clearCookies();
    const tme0 = cust.ctx.tme.length;
    await page.goto(`${BASE}/my/login`); await page.locator("#forgot").click(); await sleep(800);
    must(cust.ctx.tme.length > tme0 || /Telegram|bot/i.test(await page.locator("body").innerText()), "«forgot» neither opens the bot nor tells to use it");
    const since = await lastN();
    await tgText(990001, "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី");
    const m = await botSays(990001, (t) => /ពាក្យសម្ងាត់ថ្មី៖ \d{4}/.test(t), since);
    const next = PWRE.exec(textOf(m))[1];
    const v = await visitor();
    must((await v.raw("POST", "/api/public/login", { phone: "012000701", password: S.pwA })).status() >= 400, "old password still works");
    must((await v.raw("POST", "/api/public/login", { phone: "012000701", password: next })).ok(), "new password refused");
    S.pwA = next;
  });
  await step(A, "«គណនីរបស់ខ្ញុំ» → «ប្ដូរពាក្យសម្ងាត់» to an easy number → saved", page, async () => {
    await page.goto(`${BASE}/my/login`); await page.locator("#phone").fill("12 000 701"); await page.locator("#pw").fill(S.pwA); await page.locator("#login").click();
    await page.locator('body[data-page="my"]').waitFor({ timeout: 15_000 });
    await page.locator("#pw-open").scrollIntoViewIfNeeded(); await page.locator("#pw-open").click(); await page.locator("#pw-card:not([hidden])").waitFor();
    await page.locator("#pw-cur").fill(S.pwA); await page.locator("#pw-new").fill("2580");
    await page.locator("#pw-save").scrollIntoViewIfNeeded(); await page.locator("#pw-save").click();
    await page.locator("#pw-ok:not([hidden]), #pw-err:not([hidden])").first().waitFor({ timeout: 10_000 });
    must(!(await page.locator("#pw-err:not([hidden])").count()), `refused: ${await page.locator("#pw-err").innerText().catch(() => "")}`);
    S.pwA = "2580";
    await fits(page, "my-360");
  });
  await step(A, "bot «🔕» → choices → stop promotions → «បានឈប់ តែប្រូម៉ូសិន»; the website switch saves", page, async () => {
    const since = await lastN();
    await tgText(990001, "🔕 ឈប់ទទួលដំណឹង");
    const menu = await botSays(990001, (t, c) => !!c.payload?.reply_markup?.inline_keyboard, since);
    const btns = menu.payload.reply_markup.inline_keyboard.flat();
    const promo = btns.find((b) => /ប្រូម៉ូសិន/.test(b.text) && /ឈប់/.test(b.text)) ?? btns[0];
    const since2 = await lastN();
    await tgButton(990001, menu.payload?.message_id ?? 1, promo.callback_data);
    await botSays(990001, (t) => /ឈប់/.test(t) && /ប្រូម៉ូសិន/.test(t), since2);
    // the website shows the same choice (promotions off), and its switch saves both ways — left off for the promotion test
    await page.goto(`${BASE}/my`); await page.locator("#settings").scrollIntoViewIfNeeded();
    must(!(await page.locator("#n-promo").isChecked()), "the website still shows promotions on after the bot stop");
    const sw = page.locator("label.sw", { has: page.locator("#n-promo") }).locator("i");
    await sw.click(); await page.locator("#n-ok:not([hidden])").waitFor({ timeout: 10_000 }); must(await page.locator("#n-promo").isChecked(), "switch did not turn on");
    await page.reload(); await page.locator("#settings").scrollIntoViewIfNeeded();
    await page.locator("label.sw", { has: page.locator("#n-promo") }).locator("i").click(); await page.locator("#n-ok:not([hidden])").waitFor({ timeout: 10_000 });
    must(!(await page.locator("#n-promo").isChecked()), "switch did not turn off");
    return `button pressed: ${promo.text}`;
  });
  await step(A, "Mini App: «📍» opens «ការកក់របស់ខ្ញុំ» signed in by Telegram (no login screen)", null, async () => {
    const { ctx, page: p } = await device();
    await p.goto(`${BASE}/my/bookings${tgHash(990001)}`);
    await p.locator("section[data-booking]").first().waitFor({ timeout: 20_000 });
    must(!/\/my\/login/.test(p.url()), "landed on the login page");
    await p.goto(`${BASE}/book${tgHash(990001)}`); await p.locator("#cats, #lines").first().waitFor({ timeout: 15_000 });
    await ctx.close();
  });
}

// ================================================================ 7 · technician: today's jobs → directions → steps + photos → finish
const gmDev = await device({ desktop: true });
{
  const A = "7 Technician";
  const adminApi = await staffApi("admin1", S.u.admin1.pw);
  S.adminApi = adminApi;
  const nextHour = () => { const d = new Date(); d.setMinutes(0, 0, 0); return new Date(d.getTime() + 2 * 3_600_000); };
  await step(A, "today's job for «QA ជាង ១» (Admin, by phone)", null, async () => {
    const c = await adminApi.call("POST", "/api/customers", { name: "QA អតិថិជន ឃ", phones: ["012000704"], address: "ផ្ទះលេខ 24 ផ្លូវសាកល្បង", zone: "inside", lat: 11.5231, lng: 104.9512 });
    const b = await adminApi.call("POST", "/api/bookings", { customer_id: c.id, type: "A", category: "mep", service_item_id: AC.id, service_text: "លាងម៉ាស៊ីនត្រជាក់", scheduled_at: nextHour().toISOString(), address: "ផ្ទះលេខ 24 ផ្លូវសាកល្បង", zone: "inside", lat: 11.5231, lng: 104.9512 });
    await adminApi.call("POST", `/api/bookings/${b.id}/assign`, { lead: S.u.jang1.id, assistants: [] });
    S.techJob = b;
  });
  const tech = await device({ ip: 61 });
  const page = tech.page;
  await step(A, "«ថ្ងៃនេះ» shows the job (360 px)", page, async () => {
    await uiLogin(page, "jang1", S.u.jang1.pw);
    await page.goto(`${BASE}/app/tech`); await page.locator('[data-testid="job-card"]').first().waitFor({ timeout: 15_000 });
    await fits(page, "tech-today-360");
  });
  await step(A, "job page: directions link (Google Maps)", page, async () => {
    await page.goto(`${BASE}/app/tech/job/${S.techJob.id}`); await page.locator('[data-testid="cp-next"]').waitFor({ timeout: 15_000 });
    const maps = await page.locator('a[href*="google.com/maps"], a[href*="maps.google"]').count();
    must(maps > 0, "no directions link"); await fits(page, "tech-job-360");
  });
  await step(A, "4 steps with GPS + before / after photos + signature + report → «រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ» → back at the office", page, async () => {
    const next = page.locator('[data-testid="cp-next"]');
    const press = async () => { await next.scrollIntoViewIfNeeded(); await next.click(); await idle(page); await sleep(600); };
    await press(); await press();                                                           // depart, arrive (GPS)
    await page.locator('[data-testid="photo-before"]').setInputFiles(PHOTOS[0]); await idle(page); await sleep(800);
    await press(); await press();                                                           // start, finish
    await page.locator('[data-testid="photo-after"]').setInputFiles(PHOTOS[1]); await idle(page); await sleep(800);
    const pad = page.locator('[data-testid="signature"]'); await pad.scrollIntoViewIfNeeded();
    const b = await pad.boundingBox();
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.5); await page.mouse.down();
    for (const [x, y] of [[0.3, 0.3], [0.45, 0.7], [0.6, 0.3], [0.8, 0.6]]) await page.mouse.move(b.x + b.width * x, b.y + b.height * y, { steps: 6 });
    await page.mouse.up();
    await page.locator('[data-testid="report-submit"]').scrollIntoViewIfNeeded(); await page.locator('[data-testid="report-submit"]').click(); await idle(page);
    await page.getByText("រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ").first().waitFor({ timeout: 15_000 });
    await press();                                                                          // back at the office
    const cps = await adminApi.call("GET", `/api/bookings/${S.techJob.id}`);
    return `status ${cps.status ?? cps.booking?.status}`;
  });
  await step(A, "GM approves the report → the technician sees «ត្រឹមត្រូវ»", gmDev.page, async () => {
    await uiLogin(gmDev.page, "gm1", S.u.gm1.pw);
    await gmDev.page.goto(`${BASE}/app/bookings/${S.techJob.id}`); await gmDev.page.locator('[data-testid="review-ok"]').click(); await idle(gmDev.page);
    await page.goto(`${BASE}/app/tech/job/${S.techJob.id}`); await page.getByText("ត្រឹមត្រូវ").first().waitFor({ timeout: 15_000 });
  });
  await step(A, "attendance: «ចូលធ្វើការ» on «ថ្ងៃនេះ» → «ចេញពីការងារ» next; the month report counts the day", page, async () => {
    await page.goto(`${BASE}/app/tech`); await page.locator('[data-testid="attendance-in"]').waitFor({ timeout: 15_000 });
    const office = await page.getByText(/ការិយាល័យ/).count();
    await page.locator('[data-testid="attendance-in"]').click(); await page.locator('[data-testid="attendance-out"]').waitFor({ timeout: 15_000 });
    await page.goto(`${BASE}/app/attendance`); await idle(page); await fits(page, "attendance-360");
    return office ? "office location not set on the clone (as live): the press is kept and flagged" : "office location set";
  });
  await step(A, "staff Mini App: the technician's Telegram opens the app signed in", null, async () => {
    sql(`update users set telegram_user_id = 990061, telegram_chat_id = 990061 where username = 'jang1'`);
    const { ctx, page: p } = await device();
    await p.goto(`${BASE}/app/tg?to=${encodeURIComponent("/tech")}${tgHash(990061)}`);
    await p.waitForURL(/\/app\/tech/, { timeout: 20_000 }); await p.locator('[data-testid="attendance-in"], [data-testid="attendance-out"], [data-testid="job-card"]').first().waitFor({ timeout: 15_000 });
    await ctx.close();
  });
  S.tech = tech;
}

// ================================================================ 8 · invoice + PRINT with the real logo + ACLEDA QR (the QR must scan)
{
  const A = "8 Invoice + print", page = adm.page;
  await step(A, "from the finished job: invoice line at the catalog price ($15) → issued → paid by ACLEDA", page, async () => {
    await page.goto(`${BASE}/app/bookings/${S.techJob.id}`); await page.locator('[data-testid="invoice-create"]').click();
    await page.locator('[data-testid="invoice-save"]').waitFor({ timeout: 15_000 });
    const priceInputs = page.locator('input[inputmode="decimal"]');
    let prices = await priceInputs.evaluateAll((els) => els.map((e) => e.value));
    if (!prices.some((v) => v === "15")) {
      await page.getByRole("combobox", { name: "បន្ថែមទំនិញ" }).selectOption(AC.id).catch(async () => { await page.locator("select").first().selectOption(AC.id); });
      prices = await priceInputs.evaluateAll((els) => els.map((e) => e.value));
    }
    must(prices.includes("15"), `line prices: ${prices.join(",")}`);
    await page.locator('[data-testid="invoice-save"]').click(); await page.locator('[data-testid="invoice-issue"]').waitFor({ timeout: 15_000 });
    S.invUrl = page.url();
    await page.locator('[data-testid="invoice-issue"]').click(); await page.locator('[data-testid="invoice-issue-go"]').click(); await idle(page);
    await page.locator('[data-testid="pay-open"]').waitFor({ timeout: 10_000 }); await page.locator('[data-testid="pay-open"]').click();
    const total = (await page.locator('[data-testid="invoice-totals"]').innerText()).match(/\$([\d,.]+)/)?.[1]?.replace(/,/g, "") ?? "15";
    await page.locator('[data-testid="pay-amount"]').fill(total);
    await page.getByRole("radio", { name: "ACLEDA" }).click(); await page.locator('[data-testid="pay-save"]').click(); await idle(page);
    return `total $${total}`;
  });
  await step(A, "print page: One Team logo + ACLEDA QR load; the printed QR decodes to «One Team Service» KHQR (USD)", page, async () => {
    const id = /invoices\/([0-9a-f-]{36})/.exec(S.invUrl)?.[1]; must(id, "no invoice id");
    // printed at 2× (like a 300-dpi page): the QR is read from that picture, as a phone camera would
    const pctx = await browser.newContext({ storageState: await adm.ctx.storageState(), viewport: { width: 900, height: 1300 }, deviceScaleFactor: 2, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-qa-ip": "203.0.113.90" } });
    const page = await pctx.newPage();
    await page.goto(`${BASE}/app/invoices/${id}/print`); await page.locator('[data-testid="invoice-print"]').waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => [...document.querySelectorAll("img")].every((i) => i.complete), null, { timeout: 15_000 });
    const imgs = await page.evaluate(() => [...document.querySelectorAll("img")].map((i) => ({ src: i.getAttribute("src"), w: i.naturalWidth })));
    must(imgs.some((i) => /image\/logo/.test(i.src) && i.w > 0), "logo not loaded"); must(imgs.some((i) => /image\/qr/.test(i.src) && i.w > 0), "QR not loaded");
    const body = await page.locator('[data-testid="invoice-print"]').innerText(); must(/៛/.test(body), "no riel total");
    const png = await page.locator('[data-testid="invoice-print"]').screenshot({ path: join(WORK, "invoice-print.png") });
    const dec = await browser.newPage(); await dec.goto("about:blank"); await dec.addScriptTag({ url: "https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js" });
    const payload = await dec.evaluate(async (b64) => {
      const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
      const c = document.createElement("canvas"); c.width = img.width; c.height = img.height; const x = c.getContext("2d"); x.drawImage(img, 0, 0);
      return window.jsQR(x.getImageData(0, 0, c.width, c.height).data, c.width, c.height)?.data ?? null;
    }, png.toString("base64"));
    await dec.close();
    must(payload?.startsWith("000201"), "the printed QR does not decode");
    must(payload.includes("One Team Service") && payload.includes("5303840"), "not One Team's USD KHQR");
    await pctx.close();
    return `print screenshot ${join(WORK, "invoice-print.png")}`;
  });
}

// ================================================================ 9 · Admin / GM: phone booking, reschedule, cancel, board, catalog + Excel, unlock, promotion
{
  const A = "9 Admin / GM", page = adm.page;
  await step(A, "phone booking: new customer → service → date + start → end from the job length → created", page, async () => {
    await page.goto(`${BASE}/app/bookings/new`); await page.locator('input[name="customer_search"]').fill("012000705"); await idle(page); await sleep(800);
    await page.getByRole("button", { name: "អតិថិជនថ្មី" }).click();
    const dlg = page.locator('[role="dialog"]').last();
    await dlg.locator('input[name="name"]').fill("QA អតិថិជន ង"); await dlg.locator('input[name="phones"]').fill("012000705");
    await dlg.getByRole("button", { name: "រក្សាទុក" }).click(); await idle(page);
    await page.locator('select[name="category"]').selectOption("mep");
    await page.locator('select[name="service_item_id"]').selectOption(AC.id);
    await page.locator('input[name="date"]').fill(ymdIn(2)); await page.locator('input[name="start"]').fill("10:00");
    await sleep(400);
    const end = await page.locator('input[name="end"]').inputValue(); must(end === "11:00", `end ${end} (AC cleaning = 60 min)`);
    await page.locator('button[type="submit"]').click(); await page.waitForURL(/\/app\/bookings\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    S.phoneJob = /bookings\/([0-9a-f-]{36})/.exec(page.url())[1];
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "booking-detail-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step(A, "«ប្ដូរម៉ោង»: new date, who asked, reason → history", page, async () => {
    await S.adminApi.call("POST", `/api/bookings/${S.phoneJob}/assign`, { lead: S.u.jang2.id, assistants: [] });
    await page.goto(`${BASE}/app/bookings/${S.phoneJob}`); await page.locator('[data-testid="resched-btn"]').click();
    const dlg = page.locator('[role="dialog"]').last();
    await dlg.locator('input[name="resched_date"]').fill(ymdIn(3)); await dlg.getByRole("radio", { name: "អតិថិជន", exact: true }).check();
    await dlg.locator('textarea[name="resched_reason"]').fill("អតិថិជនមិននៅផ្ទះ"); await page.locator('[data-testid="resched-submit"]').click(); await idle(page);
    await page.locator('[data-testid="resched-history"]').waitFor({ timeout: 10_000 });
  });
  await step(A, "«បោះបង់ការងារ» needs a reason → cancelled", page, async () => {
    await page.locator('[data-testid="cancel-btn"]').click(); await page.locator('[role="dialog"]').last().locator("textarea").fill("អតិថិជនលែងត្រូវការ");
    await page.locator('[data-testid="cancel-submit"]').click(); await idle(page); await sleep(800);
    const b = await S.adminApi.call("GET", `/api/bookings/${S.phoneJob}`); must((b.status ?? b.booking?.status) === "cancelled", `status ${b.status ?? b.booking?.status}`);
  });
  await step(A, "board «ថ្ងៃនេះ»: a technician's step moves the card within ~15 s", page, async () => {
    const c = await S.adminApi.call("POST", "/api/customers", { name: "QA អតិថិជន ច", phones: ["012000706"], address: "ផ្ទះលេខ 26", zone: "outside", lat: 11.55, lng: 104.92 });
    const at = new Date(Date.now() + 3 * 3_600_000); at.setMinutes(0, 0, 0);
    const b = await S.adminApi.call("POST", "/api/bookings", { customer_id: c.id, type: "A", category: "mep", service_text: "ជួសជុលភ្លើង", scheduled_at: at.toISOString(), zone: "outside", lat: 11.55, lng: 104.92 });
    await S.adminApi.call("POST", `/api/bookings/${b.id}/assign`, { lead: S.u.jang2.id, assistants: [] });
    await page.goto(`${BASE}/app/bookings`); await page.locator('[data-testid="filters-toggle"]').click();
    await page.locator('[data-testid="filters"] select').first().selectOption("today"); await idle(page);
    await page.locator('[data-testid="col-assigned"] [data-testid="booking-card"]', { hasText: "QA អតិថិជន ច" }).waitFor({ timeout: 15_000 });
    const j2 = await staffApi("jang2", S.u.jang2.pw);
    await j2.call("POST", `/api/bookings/${b.id}/checkpoint`, { step: "depart", at: new Date().toISOString(), lat: 11.55, lng: 104.92, accuracy: 10, no_gps: false, offline: false });
    await page.locator('[data-testid="col-in_progress"] [data-testid="booking-card"]', { hasText: "QA អតិថិជន ច" }).waitFor({ timeout: 25_000 });
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "board-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step(A, "catalog: AC cleaning shows 60 min · $15 price · $15 from; edit saves with «កែប្រែចុងក្រោយ»", page, async () => {
    await page.goto(`${BASE}/app/catalog`); const row = page.locator("tr", { hasText: "AC-CLEAN" });
    await row.getByRole("button", { name: "កែ", exact: true }).click();
    const dlg = page.locator('[role="dialog"]').last();
    const dur = await dlg.locator('input[name="duration_min"]').inputValue(), from = await page.locator('[data-testid="cat-from"]').inputValue();
    must(dur === "60" && /^15(\.00?)?$/.test(from), `duration ${dur} · from ${from}`);
    await dlg.getByRole("button", { name: "រក្សាទុក" }).click(); await idle(page);
    await page.locator('[data-testid="cat-last"]').waitFor({ timeout: 10_000 });
  });
  await step(A, "catalog Excel: template → change a price → preview (1 changed) → apply", page, async () => {
    await page.goto(`${BASE}/app/catalog`);
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="cat-template"]').click()]);
    const file = join(WORK, "catalog.xlsx"); await dl.saveAs(file);
    const rows = readXlsx(readFileSync(file)).map((r) => [...r]);
    const code = rows.findIndex((r) => r[0] === "WT-PIPE"); must(code > 0, "WT-PIPE not in the template");
    rows[code][5] = "18";
    const edited = join(WORK, "catalog-edited.xlsx"); writeFileSync(edited, writeXlsx("Catalog", rows));
    await page.locator('input[type="file"]').setInputFiles(edited); await idle(page);
    const counts = await page.locator('[data-testid="cat-counts"]').innerText();
    await page.locator('[data-testid="cat-apply"]').click(); await idle(page); await sleep(800);
    const after = await ceoApi.call("GET", "/api/catalog"); const wt = (Array.isArray(after) ? after : after.items).find((x) => x.code === "WT-PIPE");
    must(wt.from_price === 1800, `WT-PIPE from ${wt.from_price}`);
    return counts.replace(/\s+/g, " ").slice(0, 120);
  });
  await step(A, "wrong website password 10× locks the customer (even the right one is refused); Admin «ដោះសោ» → signs in again", page, async () => {
    const v = await visitor();
    for (let i = 0; i < 10; i++) await v.raw("POST", "/api/public/login", { phone: "012000703", password: String(1000 + i) });
    const locked = await v.raw("POST", "/api/public/login", { phone: "012000703", password: "0000" });
    must(locked.status() >= 400, "no lock");
    await page.goto(`${BASE}/app/customers`); const row = page.locator("tr", { hasText: "012000703" }).first();
    await row.getByRole("button", { name: "ប្រវត្តិ", exact: true }).click();
    await page.locator('[data-testid="login-locked"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="login-unlock"]').click(); await idle(page); await sleep(800);
    must(!(await page.locator('[data-testid="login-locked"]').count()), "still shown locked");
    return `lock answer ${locked.status()} ${(await locked.text()).slice(0, 60)}`;
  });
  await step(A, "staff sign-in: 6 wrong passwords in a minute → refused (rate limit)", null, async () => {
    const rc = await request.newContext({ baseURL: API, ignoreHTTPSErrors: true, extraHTTPHeaders: { "x-qa-ip": "203.0.113.250" } });
    const st = [];
    for (let i = 0; i < 6; i++) st.push((await rc.post("/api/auth/login", { data: { identifier: "gm1", password: `wrong-${i}` } })).status());
    must(st.at(-1) === 429, `answers ${st.join(",")}`);
    return st.join(",");
  });
  await step(A, "promotion (GM): text → preview → send → reaches subscribed customers only (not the one who stopped promotions)", gmDev.page, async () => {
    const p = gmDev.page, since = await lastN();
    await p.goto(`${BASE}/app/subscribe`); await p.locator('[data-testid="bc-text"]').fill("QA ប្រូម៉ូសិន សាកល្បង — បញ្ចុះតម្លៃ 10%");
    await p.locator('[data-testid="bc-preview"]').click(); await p.locator('[data-testid="bc-shown"]').waitFor({ timeout: 10_000 });
    await p.locator('[data-testid="bc-send"]').click(); await p.locator('[role="dialog"]').last().getByRole("button", { name: "បញ្ជាក់", exact: true }).click(); await idle(p);
    const t0 = Date.now(); let got = [];
    while (Date.now() - t0 < 120_000) { got = (await calls(since)).filter((c) => c.method === "sendMessage" && textOf(c).includes("QA ប្រូម៉ូសិន")); if (got.length) break; await sleep(2000); }
    must(got.length > 0, "no promotion delivered (fake Telegram)");
    must(!got.some((c) => String(c.payload.chat_id) === "990001"), "sent to the customer who stopped promotions");
    return `delivered to ${got.length}`;
  });
}

// ================================================================ 10 · CEO / CFO: dashboard, reports, settings, website, audit, guides
{
  const A = "10 CEO / CFO", page = boss.page;
  await step(A, "dashboard: today's money", page, async () => { await page.goto(`${BASE}/app/dashboard`); await page.locator('[data-testid="dashboard-panel"]').waitFor(); return (await page.locator('[data-testid="dashboard-panel"]').innerText()).replace(/\s+/g, " ").slice(0, 120); });
  await step(A, "reports: this month, technician performance, Excel export", page, async () => {
    await page.goto(`${BASE}/app/reports`); await page.getByRole("button", { name: "ខែនេះ", exact: true }).click(); await idle(page);
    await page.locator('[data-testid="tech-perf"]').waitFor({ timeout: 10_000 });
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator('[data-testid="export-jobs"]').click()]);
    must((await dl.suggestedFilename()).length > 3, "no export file");
  });
  await step(A, "audit log: plain Khmer rows, type filter", page, async () => {
    await page.getByRole("tab", { name: "កំណត់ហេតុសកម្មភាព", exact: true }).click(); await page.locator('[data-testid="audit-row"]').first().waitFor({ timeout: 10_000 });
    const t = await page.locator('[data-testid="audit-row"]').first().innerText(); must(/[ក-៿]/.test(t), "row not in Khmer");
    await page.locator('[data-testid="audit-type"]').selectOption("money"); await idle(page);
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "reports-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step(A, "settings: last change, test phones (CEO), invoice logo + QR previews", page, async () => {
    await page.goto(`${BASE}/app/settings/company`); await page.locator('[data-testid="test-phones"]').waitFor({ timeout: 10_000 });
    const ok = await page.evaluate(async () => (await Promise.all(["logo", "qr"].map((k) => fetch(`/api/settings/image/${k}`).then((r) => r.status)))).join(","));
    must(ok === "200,200", `images ${ok}`);
  });
  await step(A, "website settings: phones, 11 photos, booking hours without lunch, Google off", page, async () => {
    await page.goto(`${BASE}/app/website`); await page.locator('[data-testid="web-phone"]').waitFor({ timeout: 10_000 });
    must((await page.locator('[data-testid="web-phone"]').inputValue()) === "077 632 899 / 015 899 632", "phone field");
    const ls = await page.locator('[data-testid="web-hours-lunch_start"]').inputValue(), le = await page.locator('[data-testid="web-hours-lunch_end"]').inputValue();
    must(ls === le, `lunch ${ls}–${le}`); must(!(await page.locator('[data-testid="web-published"]').isChecked()), "Google already on");
    const photos = await page.locator('img[src^="/pub/img/"]').count(); must(photos >= 11, `photos ${photos}`);
  });
  await step(A, "all-guide (CEO): tabs, a video plays, «✅ យល់ព្រម» saves", page, async () => {
    await page.goto(`${BASE}/app/all_guide`); await page.locator('[data-testid="all-guide"]').waitFor({ timeout: 15_000 });
    await page.locator('[data-testid="guide-clip"]').first().click();
    const v = page.locator('[data-testid="guide-player"] video, video').first(); await v.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => { const x = document.querySelector("video"); return x && x.readyState >= 1; }, null, { timeout: 20_000 });
    await page.locator('[data-testid="guide-ok"]').first().click(); await idle(page);
  });
  await step(A, "own guide «របៀបប្រើ» (CEO) lists the position's videos", page, async () => { await page.goto(`${BASE}/app/guide`); await page.locator("video, [data-testid='guide-clip']").first().waitFor({ timeout: 15_000 }); });
  await step(A, "language: «English» in «គណនីរបស់ខ្ញុំ» → English menus → back to Khmer", page, async () => {
    await page.goto(`${BASE}/app/me`); await page.getByRole("button", { name: "English", exact: true }).click(); await sleep(800);
    const nav = await page.locator("aside nav").innerText(); must(/Bookings|Reports|Settings/.test(nav) && !/[ក-៿]/.test(nav), `menu: ${nav.slice(0, 80)}`);
    await page.getByRole("button", { name: "ខ្មែរ", exact: true }).click(); await sleep(500);
  });
  await step(A, "cash: Admin counts the day → CFO verifies (locked)", null, async () => {
    await S.adminApi.call("POST", "/api/reports/cash-close", { day: ymdIn(0), counted_usd: 1500, counted_khr: 0, note: "QA" });
    const cfo = await device({ desktop: true }); S.cfo = cfo;
    await uiLogin(cfo.page, "cfo1", S.u.cfo1.pw);
    await cfo.page.goto(`${BASE}/app/reports`); await cfo.page.getByRole("tab", { name: "សាច់ប្រាក់", exact: true }).click();
    await cfo.page.getByRole("button", { name: "ថ្ងៃនេះ", exact: true }).click(); await idle(cfo.page);
    await cfo.page.locator('[data-testid="cash-verify"]').first().click(); await idle(cfo.page);
  });
}

// ================================================================ 11 · accounting (CFO): opening balances → transaction → GL / TB → statements → year-end → lock
{
  const A = "11 Accounting", page = S.cfo.page;
  const Y = new Date().getFullYear(), lastYearJan1 = `${Y - 1}-01-01`;
  await step(A, "opening balances: draft → corrected → «បញ្ជាក់សមតុល្យដើម»", page, async () => {
    await page.goto(`${BASE}/app/accounting`); await page.locator('[data-testid="go-setup"]').click(); await idle(page);
    await page.locator('[data-testid="op-date"]').fill(lastYearJan1);
    await page.locator('[data-testid="op-cash-usd"]').fill("2500"); await page.locator('[data-testid="op-aba"]').fill("12000"); await page.locator('[data-testid="op-acleda"]').fill("4000");
    await page.locator('[data-testid="op-retained"]').fill("8000"); await page.locator('[data-testid="op-draft"]').click(); await idle(page);
    await page.locator('[data-testid="op-retained"]').fill("9000"); await page.locator('[data-testid="op-draft"]').click(); await idle(page);
    await page.locator('[data-testid="op-save"]').click(); await page.locator('[role="dialog"]').last().getByRole("button", { name: "បញ្ជាក់" }).click(); await idle(page);
  });
  await step(A, "an expense → its journal entry (debit = credit)", page, async () => {
    await page.locator('[data-testid="tab-money"]').click(); await page.locator('[data-testid="tx-expense"]').click();
    await page.locator('[data-testid="tx-amount"]').fill("45"); await page.locator('[data-testid="tx-account"]').selectOption("6030");
    await page.locator('[data-testid="tx-pay"]').getByRole("radio", { name: "សាច់ប្រាក់ $" }).click();
    await page.locator('[data-testid="tx-memo"]').fill("QA សាំងឡាន"); await page.locator('[data-testid="tx-save"]').click(); await idle(page);
    await page.locator('[data-testid="tab-journal"]').click(); await page.locator('[data-testid="je-list"]').getByText("QA សាំងឡាន").first().waitFor({ timeout: 10_000 });
  });
  await step(A, "last year's entries (for the year-end close)", null, async () => {
    const cfoApi = await staffApi("cfo1", S.u.cfo1.pw); S.cfoApi = cfoApi;
    await cfoApi.call("POST", "/api/accounting/transactions", { date: `${Y - 1}-03-10`, type: "other_income", account_code: "4090", amount: 150000, pay: "aba", memo: "QA ចំណូលឆ្នាំមុន" });
    await cfoApi.call("POST", "/api/accounting/transactions", { date: `${Y - 1}-06-30`, type: "expense", account_code: "6040", amount: 60000, pay: "cash_usd", memo: "QA ថ្លៃឈ្នួលឆ្នាំមុន" });
  });
  await step(A, "trial balance balances; general ledger by code", page, async () => {
    await page.goto(`${BASE}/app/accounting`); await page.locator('[data-testid="rep-tb"]').click(); await page.locator('[data-testid="tb-balanced"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="rep-gl"]').click(); await page.locator('[data-testid="gl-code"]').fill("6030"); await idle(page); await page.locator('[data-testid="gl"]').waitFor();
  });
  await step(A, "Income Statement (inside / outside the borey, last month) · Balance Sheet (assets = liabilities + equity)", page, async () => {
    await page.locator('[data-testid="rep-pl"]').click(); await page.locator('[data-testid="is-zones"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-testid="rep-bs"]').click(); await page.getByText(/ទ្រព្យសកម្ម = បំណុល \+ មូលធន/).first().waitFor({ timeout: 10_000 });
    await page.setViewportSize({ width: 360, height: 780 }); await fits(page, "accounting-360"); await page.setViewportSize({ width: 1280, height: 800 });
  });
  await step(A, "year-end close of last year, then the period lock; a booking before the lock is refused", page, async () => {
    await page.locator('[data-testid="tab-setup"]').click(); await page.locator('[data-testid="close-year"]').click();
    await page.locator('[role="dialog"]').last().getByRole("button", { name: "បញ្ជាក់" }).click(); await idle(page);
    const lastMonthEnd = new Date(new Date().getFullYear(), new Date().getMonth(), 0);
    const lme = `${lastMonthEnd.getFullYear()}-${String(lastMonthEnd.getMonth() + 1).padStart(2, "0")}-${String(lastMonthEnd.getDate()).padStart(2, "0")}`;
    await page.locator('[data-testid="lock-input"]').fill(lme); await page.locator('[data-testid="lock-save"]').click(); await idle(page);
    await page.getByText(lme, { exact: true }).first().waitFor({ timeout: 10_000 }); // the lock is saved (the books card shows it) before anything else is posted
    const r = await S.cfoApi.rc.fetch("/api/accounting/transactions", { method: "POST", data: { date: lme, type: "expense", account_code: "6030", amount: 1000, pay: "cash_usd", memo: "QA after lock" } });
    must(r.status() >= 400 && /PERIOD_LOCKED/.test(await r.text()), `locked date answered ${r.status()}`);
  });
}

// ================================================================ 12 · edges: night booking · double-booking race · slow network
{
  const A = "12 Edges";
  await step(A, "night (20:00–08:00 shop time): «យើងនឹងបញ្ជាក់ ម៉ោង ៨ ព្រឹក» and the staff alert is silent", null, async () => {
    sql(`update companies set timezone = '${NIGHT_TZ}'`);
    try {
      const v = await visitor(); const since = await lastN();
      const html = await v.text(`/book?items=${AC.id}:1`); const ts = /data-ts="([^"]+)"/.exec(html)?.[1];
      const days = (await v.call("GET", `/api/public/slots?items=${AC.id}:1`)).days.filter((d) => d.slots.some((s) => s.free));
      await sleep(2600);
      const b = await v.call("POST", "/api/public/bookings", { items: `${AC.id}:1`, at: days[1].slots.find((s) => s.free).at, address: "ផ្ទះលេខ 30", name: "QA អតិថិជន យប់", phone: "012000707", consent: true, ts });
      const done = await v.text(`/book/done/${b.ref}`);
      must(/ម៉ោង ៨ ព្រឹក/.test(done), "no «ម៉ោង ៨ ព្រឹក» on the done page");
      let alert = null; const t0 = Date.now();
      while (!alert && Date.now() - t0 < 25_000) { alert = (await calls(since)).find((c) => c.method === "sendMessage" && String(c.payload?.chat_id) === "990011" && textOf(c).includes("QA អតិថិជន យប់")); if (!alert) await sleep(1000); }
      must(alert, "no staff alert"); must(alert.payload.disable_notification === true, "the night alert rings");
    } finally { sql(`update companies set timezone = '${DAY_TZ}'`); }
  });
  await step(A, "double booking race: two phones take the same time at once → one wins, the other is told", null, async () => {
    const [v1, v2] = [await visitor(), await visitor()];
    const ts1 = /data-ts="([^"]+)"/.exec(await v1.text(`/book?items=${AC.id}:1`))[1], ts2 = /data-ts="([^"]+)"/.exec(await v2.text(`/book?items=${AC.id}:1`))[1];
    const days = (await v1.call("GET", `/api/public/slots?items=${AC.id}:1`)).days.filter((d) => d.slots.filter((s) => s.free).length > 0);
    const at = days.at(-1).slots.filter((s) => s.free).at(-1).at;
    // one technician free at that time (the other turned off on the clone for this test): two customers tap at the same moment
    sql("update users set is_active = false where username = 'jang2'");
    try {
      await sleep(2600);
      const go = (v, ts, n) => v.raw("POST", "/api/public/bookings", { items: `${AC.id}:1`, at, address: "ផ្ទះលេខ 31", name: `QA ប្រណាំង ${n}`, phone: `01200071${n}`, consent: true, ts });
      const r = await Promise.all([go(v1, ts1, 1), go(v2, ts2, 2)]);
      const st = r.map((x) => x.status()).sort();
      must(st[0] === 200 && st[1] >= 400, `answers ${st.join(",")}`);
      return `answers ${st.join(",")} · ${(await r.find((x) => x.status() >= 400).text()).slice(0, 80)}`;
    } finally { sql("update users set is_active = true where username = 'jang2'"); }
  });
  await step(A, "slow network (3G): home and booking still work; a double tap books once", null, async () => {
    const { ctx, page } = await device();
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 400, downloadThroughput: 50_000, uploadThroughput: 25_000 });
    let bytes = 0; page.on("response", async (r) => { if (r.url().includes("/pub/img/")) bytes += Number(r.headers()["content-length"] ?? 0); });
    const t0 = Date.now(); await page.goto(`${BASE}/`, { timeout: 90_000, waitUntil: "domcontentloaded" }); await page.locator("#cats .cat").first().waitFor({ timeout: 60_000 }); const load = Date.now() - t0;
    must(load < 20_000, `the booking choices took ${(load / 1000).toFixed(1)} s on slow 3G`);
    await page.goto(`${BASE}/book?items=${AC.id}:1`, { timeout: 90_000, waitUntil: "domcontentloaded" }); await page.locator("#days").waitFor({ timeout: 60_000 });
    await page.locator("#days .day:not([disabled])").nth(3).click(); await page.locator(".slots:not([hidden]) .slot:not([disabled])").first().click();
    await page.locator("#gps").click(); await page.locator("#loc-ok:not([hidden])").waitFor({ timeout: 20_000 });
    await page.locator("#next").click(); await page.locator("#s3:not([hidden])").waitFor();
    await page.locator("#name").fill("QA បណ្ដាញយឺត"); await page.locator("#phone").fill("12 000 720");
    await human(); await Promise.all([page.locator("#send").click(), page.locator("#send").click({ force: true }).catch(() => {})]);
    await page.locator('body[data-page="done"]').waitFor({ timeout: 60_000 });
    const n = sql("select count(*) from bookings b join customers c on c.id = b.customer_id where '012000720' = any(c.phones)");
    must(n === "1", `bookings made: ${n}`);
    await ctx.close();
    return `booking choices usable in ${(load / 1000).toFixed(1)} s on slow 3G · work photos fetched ${Math.round(bytes / 1024)} KB`;
  });
}

// ---------------------------------------------------------------- summary
rec("13 Phone width", "no page wider than the screen at 360 px", narrow.length === 0, narrow.join(" · "));
rec("13 Page errors", "no JavaScript error on any page", jsErrors.length === 0, [...new Set(jsErrors)].slice(0, 6).join(" · "));
const pass = results.filter((r) => r.pass).length;
const table = results.map((r) => `${r.pass ? "PASS" : "FAIL"} | ${r.area} | ${r.name} | ${r.detail.replace(/\|/g, "/")}`).join("\n");
writeFileSync(join(WORK, "results.txt"), `${pass}/${results.length} passed\n${table}\n`);
console.log(`\n${pass}/${results.length} passed · results ${join(WORK, "results.txt")} · screens ${join(WORK, "shots")}`);
await browser.close(); front.close(); tunnel.kill();
process.exit(0);
