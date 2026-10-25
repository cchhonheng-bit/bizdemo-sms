// D-171 quick check on a STAGING CLONE of the live shop (nothing on live is written): Bookings, Stock «ជាងដក» and Accounting «ប្លង់គណនី»,
// on a desktop (1280) and a phone (390): change a filter → the table changes → «ទាញយក Excel» downloads a file that equals the table.
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> QA_SSH=hangkh2222 QA_IMAGE=hangkh/app:<tag> node export-check.mjs
import { execFileSync, spawn } from "node:child_process";
import { createServer as httpsServer } from "node:https";
import { request as httpRequest } from "node:http";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../..");
const SSH = process.env.QA_SSH || "hangkh", BASE = "https://oneteam-staging.localhost:8443", API = "https://localhost:8443";
const WORK = join(tmpdir(), "hangkh-export-check");
rmSync(WORK, { recursive: true, force: true }); mkdirSync(join(WORK, "shots"), { recursive: true });
const { chromium, request } = await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href);
const { readWorkbook } = await import(pathToFileURL(join(ROOT, "Source/apps/server/src/lib/xlsx.ts")).href);
const KM = JSON.parse(readFileSync(join(ROOT, "Source/apps/web/src/locales/km.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remote = (args, input) => execFileSync("ssh", [SSH, `${process.env.QA_IMAGE ? `STAGING_IMAGE=${process.env.QA_IMAGE} ` : ""}bash /opt/hangkh/staging-qa/staging.sh ${args}`], { input, maxBuffer: 50e6 }).toString().trim();
const results = [];
const rec = (name, pass, detail = "") => { results.push({ name, pass, detail }); console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`); };
const must = (c, m) => { if (!c) throw new Error(m); };
const ymd = (n) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Phnom_Penh", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + n * 86_400_000));

// ---- the clone, the tunnel, an https front (plays Caddy)
execFileSync("ssh", [SSH, "mkdir -p /opt/hangkh/staging-qa && cat > /opt/hangkh/staging-qa/tg-mock.mjs"], { input: readFileSync(join(HERE, "tg-mock.mjs"), "utf8").replace(/\r/g, "") });
execFileSync("ssh", [SSH, "cat > /opt/hangkh/staging-qa/staging.sh && chmod 755 /opt/hangkh/staging-qa/staging.sh"], { input: readFileSync(join(HERE, "staging.sh"), "utf8").replace(/\r/g, "") });
console.log(remote("up").split("\n").filter((l) => !/^NOTICE/.test(l)).slice(-1).join("\n"));
const tunnel = spawn("ssh", ["-N", "-L", "3994:127.0.0.1:3994", "-L", "3995:127.0.0.1:3995", "-L", "3996:127.0.0.1:3996", SSH], { stdio: "ignore" });
for (let i = 0; i < 40 && !(await fetch("http://127.0.0.1:3996/healthz").then((r) => r.ok).catch(() => false)); i++) await sleep(1000);
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(WORK, "key.pem"), "-out", join(WORK, "cert.pem"), "-days", "2", "-subj", "/CN=oneteam-staging.localhost"], { stdio: "ignore" });
const front = httpsServer({ key: readFileSync(join(WORK, "key.pem")), cert: readFileSync(join(WORK, "cert.pem")) }, (req, res) => {
  const headers = { ...req.headers, "x-forwarded-for": "203.0.113.77", "x-forwarded-proto": "https", "x-forwarded-host": "oneteam-staging.localhost:8443" };
  const p = httpRequest({ host: "127.0.0.1", port: 3996, method: req.method, path: req.url, headers }, (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
  p.on("error", (e) => { try { res.writeHead(502); res.end(String(e)); } catch { /* gone */ } });
  req.pipe(p);
}).listen(8443);

let exitCode = 0;
try {
  // ---- the CEO (a fresh password on the clone) and the data the three screens need — all on the clone
  const temp = /temp password:\s*(\S+)/.exec(remote("cli reset-password oneteam ceo"))?.[1]; must(temp, "no temp password");
  const rc = await request.newContext({ baseURL: API, ignoreHTTPSErrors: true });
  must((await rc.post("/api/auth/login", { data: { identifier: "ceo", password: temp } })).ok(), "login");
  const pw = `Qa${randomBytes(9).toString("base64url")}!7`;
  await rc.post("/api/me/password", { data: { new_password: pw } });
  const call = async (m, p, d) => { const r = await rc.fetch(p, { method: m, data: d }); const t = await r.text(); must(r.ok(), `${m} ${p} → ${r.status()} ${t.slice(0, 160)}`); return t ? JSON.parse(t) : null; };
  const cust = await call("POST", "/api/customers", { province_code: "12", district_code: "1212", commune_code: "121201", name: "QA export", phones: ["012 000 777"], zone: "inside" });
  const at = (h) => ({ scheduled_at: new Date(Date.now() + h * 3600e3).toISOString(), ends_at: new Date(Date.now() + (h + 1) * 3600e3).toISOString() });
  for (const [cat, h] of [["mep", 26], ["camera", 29]]) await call("POST", "/api/bookings", { customer_id: cust.id, type: "A", category: cat, service_text: `QA-EXPORT-${cat}`, zone: "inside", ...at(h) });
  let techs = (await call("GET", "/api/users/basic")).filter((u) => u.role === "tech" && u.is_active);
  for (let i = techs.length; i < 2; i++) { await call("POST", "/api/users", { username: `qatech${i}`, full_name: `QA ជាង ${i}`, role: "tech", phone: `09700077${i}`, password: pw }); }
  techs = (await call("GET", "/api/users/basic")).filter((u) => u.role === "tech" && u.is_active);
  const accounts = await call("GET", "/api/accounting/accounts"), acc = (code) => accounts.find((a) => a.code === code).id;
  const info = await call("GET", "/api/accounting/lock");
  if (!info.books_start) await call("POST", "/api/accounting/opening", { date: ymd(-3), cash_usd: 100000 });
  const item = (await call("POST", "/api/inventory/in", { name: "QA ទុយោ export", account_id: acc("13400"), unit: "m", qty: 20, unit_cost: 100, pay: "cash_usd" })).item_id;
  await call("POST", "/api/inventory/out", { item_id: item, qty: 2, technician_id: techs[0].id, place: "QA ផ្ទះ 1" });
  await call("POST", "/api/inventory/out", { item_id: item, qty: 3, technician_id: techs[1].id, place: "QA ផ្ទះ 2" });
  await call("POST", "/api/accounting/journal", { date: ymd(0), memo: "QA ចំណូល export", lines: [{ account_id: acc("11001"), debit: 5000 }, { account_id: acc("40006"), credit: 5000 }] });

  const browser = await chromium.launch({ channel: "msedge", headless: true });
  for (const vp of [{ name: "desktop", width: 1280, height: 800 }, { name: "phone", width: 390, height: 844 }]) {
    const phone = vp.name === "phone";
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1, locale: "km-KH", timezoneId: "Asia/Phnom_Penh", ignoreHTTPSErrors: true, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/app/login`);
    await page.locator('input[name="identifier"]').fill("ceo"); await page.locator('input[name="password"]').fill(pw); await page.locator('button[type="submit"]').click();
    await page.waitForURL((u) => !/\/app\/login/.test(String(u)), { timeout: 20_000 });
    /** open the filters (the «តម្រង» sheet on a phone), run `fn`, close the sheet */
    const filters = async (fn) => { if (phone) { await page.locator('[data-testid="toolbar-filter"]').click(); await page.locator('[data-testid="toolbar-sheet"]').waitFor(); } await fn(phone ? page.locator('[data-testid="toolbar-sheet"]') : page.locator('[data-testid="toolbar"]')); if (phone) await page.locator('[data-testid="toolbar-done"]').click(); };
    const download = async (testid) => { const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 30_000 }), page.locator(`[data-testid="${testid}"]`).click()]); const file = join(WORK, `${vp.name}-${dl.suggestedFilename()}`); await dl.saveAs(file); return { name: dl.suggestedFilename(), wb: readWorkbook(readFileSync(file)) }; };
    const step = async (name, fn) => { try { rec(`[${vp.name}] ${name}`, true, await fn() ?? ""); } catch (e) { rec(`[${vp.name}] ${name}`, false, String(e.message ?? e).split("\n")[0]); exitCode = 1; await page.screenshot({ path: join(WORK, "shots", `${vp.name}-${name.slice(0, 20).replace(/\W+/g, "-")}.png`), fullPage: true }).catch(() => {}); } };

    await step("Bookings: category filter → the board / list changes → Excel = the same rows", async () => {
      await page.goto(`${BASE}/app/bookings`); await page.getByText("QA-EXPORT-mep").first().waitFor({ timeout: 20_000 });
      const count = async () => page.evaluate(() => [...document.querySelectorAll("main *")].filter((e) => e.childElementCount === 0 && /QA-EXPORT-/.test(e.textContent ?? "") && e.getClientRects().length > 0).length); // visible only (the phone list keeps a hidden table)
      const before = await count(); must(before >= 2, `before ${before}`);
      await filters(async (bar) => { await bar.locator('[data-testid="filters"] select').nth(1).selectOption("camera"); });
      await page.waitForTimeout(400); const after = await count(); must(after === 1 , `after ${after}`);
      const f = await download("export-bookings"); const rows = f.wb[0].rows;
      must(/^bookings_/.test(f.name), f.name); must(rows.some((r) => r[10] === "QA-EXPORT-camera") && !rows.some((r) => r[10] === "QA-EXPORT-mep"), "file rows differ from the screen");
      must(rows[3][0].includes("camera"), `filters line: ${rows[3][0]}`);
      return `${before} → ${after} on screen · ${f.name}`;
    });
    await step("Stock ជាងដក: technician filter → the table changes → Excel = the table", async () => {
      await page.goto(`${BASE}/app/inventory?tab=withdrawals`); await page.locator('[data-testid="sheet-table"]').waitFor({ timeout: 20_000 });
      const body = () => page.locator('[data-testid="sheet-table"] tr[data-row="body"]');
      const before = await body().count(); must(before >= 2, `before ${before}`);
      await filters(async (bar) => { await bar.locator('[data-testid="pick-technician"] label', { hasText: techs[0].full_name }).locator("input").check(); });
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid="sheet-table"] tr[data-row="body"]').length !== n, before, { timeout: 15_000 });
      const after = await body().count(); must(after >= 1 && after < before, `after ${after}`);
      const f = await download("export-tech-withdrawals"); const rows = f.wb[0].rows;
      const fileBody = rows.slice(7).filter((r) => r[0] && r[0] !== "សរុប" && !/គ្មានទិន្នន័យ/.test(r[0])).length;
      must(fileBody === after, `file ${fileBody} rows, screen ${after}`); must(rows[3][0].includes(techs[0].full_name), `filters: ${rows[3][0]}`);
      return `${before} → ${after} rows · file ${fileBody} rows`;
    });
    await step("Accounting COA: range → the table changes → Excel = the table (cash 11001 movement)", async () => {
      await page.goto(`${BASE}/app/accounting?tab=reports`); await page.locator('[data-testid="rep-coa"]').click(); await page.locator('[data-testid="sheet-table"]').waitFor({ timeout: 20_000 });
      const cash = async () => (await page.locator('[data-testid="sheet-table"] tr[data-row="body"]', { hasText: "11001" }).first().locator("td").nth(4).innerText()).trim();
      const before = await cash(); must(before && before !== "", "no cash row");
      await filters(async (bar) => { await bar.locator("button", { hasText: KM.range.last }).first().click(); });
      await page.waitForFunction((b) => { const tr = [...document.querySelectorAll('[data-testid="sheet-table"] tr[data-row="body"]')].find((x) => x.textContent.includes("11001")); return tr && tr.querySelectorAll("td")[4].textContent.trim() !== b; }, before, { timeout: 15_000 });
      const after = await cash();
      const f = await download("export-coa"); const tb = f.wb.find((s) => s.name === "Trial Balance"); must(tb, "no Trial Balance sheet");
      const fileCash = Number(tb.rows.find((r) => r[2] === "11001")?.[4] ?? 0), screenCash = Number(after.replace(/[$,()]/g, "") || 0) * (after.startsWith("(") ? -1 : 1);
      must(Math.abs(fileCash - screenCash) < 0.005, `file ${fileCash} vs screen ${after}`); must(f.wb.length === 3, `sheets ${f.wb.map((s) => s.name)}`);
      must(/^Year to date Last month/.test(tb.rows[6][6]) && /\d\d\/\d\d\/\d{4}/.test(tb.rows[6][6]), `heading ${tb.rows[6][6]}`);
      return `cash movement ${before} → ${after} · file ${fileCash.toFixed(2)}`;
    });
    await page.screenshot({ path: join(WORK, "shots", `${vp.name}-last.png`), fullPage: true });
    await ctx.close();
  }
  await browser.close();
} catch (e) { console.log("SETUP FAILED —", e.message); exitCode = 1; }
finally {
  front.close(); tunnel.kill();
  try { remote("down"); } catch { /* the next run cleans up */ }
}
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed · files + screens in ${WORK}`);
process.exit(exitCode);
