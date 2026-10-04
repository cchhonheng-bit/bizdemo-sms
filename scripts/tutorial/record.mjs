// Tutorial videos — the recorder (runs on the PC: Playwright + installed Edge, headless). A window of the video size holding a stage
// (phone 540×960 ×2 = 1080×1920 · desktop 1280×720 ×1.5 = 1920×1080; pages keep their layout, text is drawn at full size): the screen
// (iframes: a Telegram look-alike that shows the bot's REAL answers, a map, the REAL app of a throwaway DEMO instance) under an HTML
// caption box (Noto Sans Khmer — the browser shapes the Khmer; every caption stays ≥ 3 s), a tap circle, chapter cards and the intro /
// outro card (One Team × HangKH). Frames come from the browser's own screencast with their timestamps; server.sh encodes them with the
// generated music (music.mjs) into H.264 MP4s → Doc_Sup/09_Tutorials/<folder>/<name>.mp4. A level file = one video, or a set
// (level.videos: overview + clips) recorded in one run on one demo instance. Demo data only: the level's setup() creates fake names on
// the demo instance (level.hub: plus a throwaway hub with fake subscribers); nothing touches the live shop or the live hub.
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node record.mjs levels/l2-admin-gm.mjs     (TUTORIAL_SSH=hangkh443 on port-22-blocked networks)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../.."), SSH = process.env.TUTORIAL_SSH || "hangkh";
const BASE = "http://localhost:3998";
const level = (await import(pathToFileURL(resolve(process.argv[2] ?? "levels/l1-technician.mjs")).href)).default;
// TUTORIAL_ONLY=L2-07,L2-08 re-records only those clips (a changed feature = only its clip again); the setup still makes all the data
const ONLY = (process.env.TUTORIAL_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const VIDEOS = (level.videos ?? [{ name: level.name, folder: "", prepare: level.prepare, play: level.play }]).filter((x) => !ONLY.length || ONLY.some((p) => x.name.startsWith(p)));
if (!VIDEOS.length) throw new Error(`TUTORIAL_ONLY matches no video of ${level.name}`);
// the stage in CSS px × scale = the video size
const SZ = level.size ?? { w: 540, h: 960, scale: 2 }, W = SZ.w, H = SZ.h, S = SZ.scale, DESK = level.layout === "desktop", CAP = level.captionSize ?? 27;
const CAP_MIN = 3000; // a caption is never replaced sooner (the viewer must be able to read it)
const { chromium, request } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const WORK = join(tmpdir(), "hangkh-tutorial", level.name);
rmSync(WORK, { recursive: true, force: true }); mkdirSync(WORK, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const remote = (args, input) => execFileSync("ssh", [SSH, `bash /tmp/tutorial-server.sh ${args}`], { input, maxBuffer: 300e6 }).toString().trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- the demo instance (server) ----------
execFileSync("ssh", [SSH, "cat > /tmp/tutorial-server.sh"], { input: readFileSync(join(HERE, "server.sh")) });
log(remote(level.hub ? "up hub" : "up"));
let tunnel = null, browser = null, page = null;
try {
  await run();
} catch (e) {
  try { await page?.screenshot({ path: join(WORK, "error.png") }); log(`screen at the error: ${join(WORK, "error.png")}`); } catch { /* no page */ }
  try { await browser?.close(); } catch { /* closed */ }
  try { log(remote("down")); } catch { /* best effort */ }
  tunnel?.kill();
  throw e;
}

async function run() {
  log(remote("seed"));
  if (!(await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false))) { tunnel = spawn("ssh", ["-N", "-L", "3998:127.0.0.1:3998", SSH], { stdio: "ignore" }); await sleep(2500); }
  const HUBKEY = remote("secret hubkey"), CEO_TEMP = remote("secret ceo");

  browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: W * S, height: H * S }, deviceScaleFactor: 1, locale: "km-KH", timezoneId: "Asia/Phnom_Penh", bypassCSP: true,
    geolocation: { latitude: 11.5566, longitude: 104.9284, accuracy: 12 }, permissions: ["geolocation"] });
  const password = () => "Dm" + randomBytes(9).toString("base64url") + "!7";
  async function staffSession(rc, user, pw) { // log in; the first login asks for a new password → the password in use now
    let r;
    for (let i = 0; ; i++) { // the server allows 5 staff logins a minute per address: past that, wait for the next minute
      r = await rc.post(`${BASE}/api/auth/login`, { data: { identifier: user, password: pw } });
      if (r.status() !== 429 || i >= 2) break;
      await sleep(62_000 - (Date.now() % 60_000));
    }
    if (!r.ok()) throw new Error(`login ${user}: ${r.status()}`);
    const j = await r.json();
    if (j.me?.must_change_password ?? j.must_change_password) {
      const next = password();
      const c = await rc.post(`${BASE}/api/me/password`, { data: { new_password: next } });
      if (!c.ok()) throw new Error(`password ${user}: ${c.status()}`);
      return next;
    }
    return pw;
  }
  const ceo = await request.newContext({ baseURL: BASE });
  await staffSession(ceo, "ceo", CEO_TEMP);
  const call = async (rc, method, path, data) => {
    const r = await rc.fetch(`${BASE}${path}`, { method, data, headers: path.startsWith("/internal/") ? { "x-hub-key": HUBKEY } : {} });
    const t = await r.text();
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${t.slice(0, 200)}`);
    return t ? JSON.parse(t) : null;
  };

  // ---------- the stage ----------
  const ASSETS = { "oneteam.png": join(ROOT, "Doc_Sup/00_Reference_Customer/One Team Logo.png"), "hangkh.svg": join(ROOT, "Doc_Sup/10_Brand/final_v2/hangkh-lockup-stacked.svg") };
  const font = (w) => `@font-face{font-family:KH;font-weight:${w};src:url(/pub/fonts/noto-sans-khmer-${w}.woff2) format("woff2")}`;
  const STAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${font(400)}${font(600)}${font(700)}
@font-face{font-family:PO;font-weight:600;src:url(/pub/fonts/poppins-600.woff2) format("woff2")}
html,body{margin:0;width:${W * S}px;height:${H * S}px;overflow:hidden;background:#fff}
#st{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;transform:scale(${S});transform-origin:0 0}
#scr{position:absolute;inset:0;transition:transform .5s cubic-bezier(.2,.8,.2,1)}
iframe{position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;background:#fff}
#map{opacity:0;transition:opacity .45s;z-index:5;pointer-events:none}#map.in{opacity:1}
#appw{position:absolute;inset:0;z-index:6;background:#fff;transform:translateX(100%);transition:transform .5s cubic-bezier(.2,.8,.2,1)}#appw.in{transform:none}
#bar{height:48px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #E5E9EC;font:600 17px PO,KH,sans-serif;color:#14213D;background:#fff}
#bar i{font-style:normal;font-size:22px;color:#5B6B7A}#bar span{flex:1}
#appw iframe{top:48px;height:${H - 48}px}
#cap{position:absolute;left:22px;right:22px;bottom:44px;z-index:9;font:600 ${CAP}px/1.62 KH,sans-serif;color:#fff;background:rgba(15,23,42,.8);border-radius:18px;padding:12px 18px;
  text-align:center;white-space:pre-line;pointer-events:none;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s}
#cap.on{opacity:1;transform:none}
#tap{position:absolute;left:0;top:0;width:60px;height:60px;margin:-30px 0 0 -30px;border-radius:50%;border:4px solid #fff;background:rgba(20,184,166,.38);
  box-shadow:0 0 0 3px rgba(15,118,110,.6),0 4px 16px rgba(0,0,0,.35);opacity:0;pointer-events:none;z-index:10}
#tap.go{animation:tap .9s ease-out forwards}#tap.drag{opacity:1;width:30px;height:30px;margin:-15px 0 0 -15px;animation:none}
@keyframes tap{0%{opacity:0;transform:scale(.3)}25%{opacity:1;transform:scale(1)}55%{opacity:1;transform:scale(.8)}100%{opacity:0;transform:scale(1.5)}}
#card{position:absolute;inset:0;z-index:12;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;transition:opacity .5s}
#card.off{opacity:0;pointer-events:none}#card .x{font:600 40px PO,sans-serif;color:#94A3B8}#card .t{font:600 30px PO,sans-serif;color:#14213D;letter-spacing:.5px;margin-top:10px}
#pre{position:absolute;left:-999px;font:600 20px KH}
#card .lg{display:flex;flex-direction:${DESK ? "row" : "column"};align-items:center;gap:${DESK ? 44 : 26}px}
#chap{position:absolute;inset:0;z-index:11;background:#14213D;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;opacity:0;pointer-events:none;transition:opacity .4s}
#chap.on{opacity:1}#chap .k{font:700 ${Math.round(CAP * 1.5)}px/1.5 KH,sans-serif;text-align:center;padding:0 40px}#chap .f{font:600 ${Math.round(CAP * 0.6)}px PO,sans-serif;color:#94A3B8;letter-spacing:.5px}
${DESK ? `#tgf{display:none}#appw{transform:none;transition:none}#bar{display:none}#appw iframe{top:0;height:${H}px}#map{z-index:7}#cap{left:50%;right:auto;max-width:${Math.round(W * 0.72)}px;transform:translate(-50%,10px)}#cap.on{transform:translate(-50%,0)}` : ""}</style></head><body><div id="st"><div id="scr">
<iframe id="tgf" name="tg" src="/__tg"></iframe><iframe id="map"></iframe><div id="appw"><div id="bar"><i>✕</i><span>One Team</span><i>⋮</i></div><iframe name="app"></iframe></div></div>
<div id="tap"></div><div id="cap"></div><span id="pre">ការងារ</span>
<div id="card"><div class="lg"><img src="/__asset/oneteam.png" style="width:360px" alt=""><div class="x">×</div><img src="/__asset/hangkh.svg" style="width:230px" alt=""></div><div class="t">OneTeam × HangKH</div></div>
<div id="chap"><div class="k"></div><div class="f">OneTeam × HangKH</div></div>
</div></body></html>`;
  // a Telegram-style chat that shows what the bot answers (the texts and buttons come from the demo instance = the live code)
  const TG = `<!doctype html><html><head><meta charset="utf-8"><style>${font(400)}${font(600)}
*{box-sizing:border-box}html,body{margin:0;height:100%}body{display:flex;flex-direction:column;font:15px/1.5 KH,"Segoe UI",sans-serif;color:#111}
.hd{height:58px;flex:none;background:#517DA2;color:#fff;display:flex;align-items:center;gap:14px;padding:0 14px}
.hd .ar{font-size:24px}.av{width:42px;height:42px;border-radius:50%;background:#fff;display:grid;place-items:center;overflow:hidden}.av img{width:38px}
.nm b{display:block;font:600 17px "Segoe UI",sans-serif}.nm span{font-size:13px;opacity:.85}
#chat{flex:1;overflow-y:auto;background:#DCE6EE;padding:12px 10px 132px;display:flex;flex-direction:column;gap:6px;scroll-behavior:smooth}
.m{max-width:88%;padding:7px 11px 6px;border-radius:14px;background:#fff;align-self:flex-start;box-shadow:0 1px 1px rgba(0,0,0,.08);white-space:pre-wrap;animation:in .3s ease-out}
.m.me{align-self:flex-end;background:#EFFDDE}.m time{float:right;font:11px "Segoe UI",sans-serif;color:#8A9AA8;margin:8px 0 0 10px}.m.me time{color:#5FAE5B}
.ik{align-self:flex-start;width:88%;display:flex;flex-direction:column;gap:4px;animation:in .3s ease-out}.ik div{display:flex;gap:4px}
.ik button{flex:1;min-height:40px;border:0;border-radius:9px;background:rgba(70,104,138,.58);color:#fff;font:600 14px KH,"Segoe UI",sans-serif;position:relative;padding:6px 12px}
.ik button.u::after{content:"↗";position:absolute;top:3px;right:7px;font-size:11px}
.in{flex:none;height:52px;background:#fff;display:flex;align-items:center;gap:16px;padding:0 16px;color:#8A9AA8;font-size:22px;border-top:1px solid #E5E9EC}.in span{flex:1}
#kb{flex:none;background:#EEF0F2;padding:6px;display:grid;grid-template-columns:1fr 1fr;gap:6px}
#kb button{height:46px;border:0;border-radius:9px;background:#fff;box-shadow:0 1px 0 rgba(0,0,0,.14);font:600 14px KH,"Segoe UI",sans-serif;color:#1F2937}
@keyframes in{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}</style></head><body>
<div class="hd"><span class="ar">←</span><div class="av"><img src="/__asset/oneteam.png" alt=""></div><div class="nm"><b>One Team</b><span>bot</span></div></div>
<div id="chat"></div><div class="in">😊<span></span>📎 🎤</div><div id="kb"></div>
<script>
const chat = document.getElementById("chat"), kb = document.getElementById("kb"), esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let n = 0;
const ik = (id, rows) => (rows && rows.length ? '<div class="ik" id="' + id + 'k">' + rows.map((r) => "<div>" + r.map((b) => '<button class="' + (b.url || b.web_app ? "u" : "") + '">' + esc(b.text) + "</button>").join("") + "</div>").join("") + "</div>" : "");
const down = () => setTimeout(() => chat.scrollTo({ top: chat.scrollHeight, behavior: "smooth" }), 30);
window.tg = {
  time: "",
  bot(text, rows) { const id = "m" + ++n; chat.insertAdjacentHTML("beforeend", '<div class="m" id="' + id + '">' + esc(text) + "<time>" + tg.time + "</time></div>" + ik(id, rows)); down(); return id; },
  me(text) { chat.insertAdjacentHTML("beforeend", '<div class="m me">' + esc(text) + "<time>" + tg.time + " ✓✓</time></div>"); down(); },
  edit(id, text, rows) { document.getElementById(id).innerHTML = esc(text) + "<time>" + tg.time + "</time>"; const k = document.getElementById(id + "k"); if (k) k.remove(); document.getElementById(id).insertAdjacentHTML("afterend", ik(id, rows)); down(); },
  keyboard(rows) { kb.innerHTML = rows.flat().map((b) => "<button>" + esc(b.text) + "</button>").join(""); },
};
</script></body></html>`;
  await ctx.route(`${BASE}/__stage`, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: STAGE }));
  await ctx.route(`${BASE}/__tg`, (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: TG }));
  const TYPES = { svg: "image/svg+xml", png: "image/png", html: "text/html; charset=utf-8" };
  await ctx.route(new RegExp(`^${BASE}/__asset/`), (r) => {
    const name = decodeURIComponent(new URL(r.request().url()).pathname.slice("/__asset/".length)), file = ASSETS[name] ?? join(WORK, name);
    return r.fulfill({ contentType: TYPES[name.split(".").pop()] ?? "image/jpeg", body: readFileSync(file) });
  });

  // ---------- what a level uses ----------
  page = await ctx.newPage();
  let inflight = 0;
  page.on("request", (r) => { if (r.url().startsWith(BASE)) inflight++; });
  for (const ev of ["requestfinished", "requestfailed"]) page.on(ev, (r) => { if (r.url().startsWith(BASE)) inflight = Math.max(0, inflight - 1); });
  const marks = [];
  let capOn = false, capAt = 0, capTop = false, capBottom = 44;
  /** the caption never hides what is pressed: a target under it sends it to the other edge of the screen (until the next caption) */
  async function keepClear(box, z) {
    if (!capOn) return;
    const r = await page.evaluate(() => { const c = document.getElementById("cap").getBoundingClientRect(); return [c.left, c.top, c.right, c.bottom]; });
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2, hw = (box.width * z) / 2 + 10, hh = (box.height * z) / 2 + 10;
    const hits = (top, bottom) => cx + hw > r[0] && cx - hw < r[2] && cy + hh > top && cy - hh < bottom;
    if (!hits(r[1], r[3])) return;
    const h = r[3] - r[1], other = capTop ? [H * S - capBottom * S - h, H * S - capBottom * S] : [44 * S, 44 * S + h];
    if (hits(other[0], other[1])) return; // a big target: no better place
    capTop = !capTop;
    await page.evaluate(() => document.getElementById("cap").classList.remove("on"));
    await sleep(200);
    await page.evaluate(([top, b]) => { const c = document.getElementById("cap"); c.style.top = top ? "44px" : ""; c.style.bottom = top ? "auto" : b + "px"; c.classList.add("on"); }, [capTop, capBottom]);
    await sleep(250);
  }
  const v = {
    base: BASE, password,
    api: (method, path, data) => call(ceo, method, path, data),
    internal: (path, data) => call(ceo, "POST", path, data),
    sql: (stmt) => remote(`sql ${q(stmt)}`),
    /** a statement for the demo hub's database (sent on stdin: Khmer text stays intact) */
    sqlhub: (stmt) => remote("sqlhub", stmt),
    loginStaff: (user, pw) => staffSession(ctx.request, user, pw),
    hold: sleep,
    get tgf() { return page.frame("tg"); },
    get app() { return page.frame("app"); },
    /** a file in the work folder (served as /__asset/<name>) → its path */
    write: (name, body) => { writeFileSync(join(WORK, name), body); return join(WORK, name); },
    /** a demo picture made in the browser (html → jpeg in the work folder; served as /__asset/<name>) */
    async picture(name, html) { const p = await ctx.newPage(); await p.setViewportSize({ width: 800, height: 600 }); await p.setContent(html); await p.screenshot({ path: join(WORK, name), type: "jpeg", quality: 88 }); await p.close(); return join(WORK, name); },
    tg: (fn, ...args) => page.frame("tg").evaluate(([f, a]) => window.tg[f](...a), [fn, args]),
    tgButton: (label, where = "ik") => page.frame("tg").locator(`${where === "kb" ? "#kb" : "#chat"} button`, { hasText: label }).last(),
    /** caption (null hides it); the one on screen stays ≥ 3 s. pos: "low" (bottom of the screen) or "tg" (just above the Telegram keyboard) */
    async caption(text, pos = "low") {
      const bottom = pos === "tg" ? (await page.frame("tg").evaluate(() => document.getElementById("kb").offsetHeight + document.querySelector(".in").offsetHeight)) + 14 : 44;
      if (capOn) { const left = CAP_MIN - (Date.now() - capAt); if (left > 0) await sleep(left); }
      await page.evaluate(() => document.getElementById("cap").classList.remove("on"));
      capOn = false;
      await sleep(text ? 220 : 240);
      if (!text) return;
      await page.evaluate(([t, b]) => { const c = document.getElementById("cap"); c.textContent = t; c.style.top = ""; c.style.bottom = b + "px"; c.classList.add("on"); }, [text, bottom]);
      capOn = true; capAt = Date.now(); capTop = false; capBottom = bottom;
      marks.push({ at: Date.now() / 1000 + 1.6, text });
    },
    /** ~2 s pause (the viewer reads the caption), the tap circle on the target, then the action (default: a real click) */
    async tap(loc, action, o = {}) {
      let b0 = await loc.boundingBox();
      if (!b0) throw new Error("tap target not visible");
      if (b0.y < 0 || b0.y + b0.height > H * S) { // off the screen: bring it to the middle first (as a person scrolls)
        await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })); await sleep(550);
        b0 = await loc.boundingBox();
      }
      const small = o.zoom !== false && (o.zoom || (b0.width / S < 72 && b0.height / S < 46));
      await keepClear(b0, small ? (typeof o.zoom === "number" ? o.zoom : 2) : 1);
      if (small) {
        await sleep(Math.max(0, (o.before ?? level.tapBefore ?? 2000) - 550));
        await page.evaluate(([x, y, z]) => { const r = document.getElementById("scr"); r.style.transformOrigin = x + "px " + y + "px"; r.style.transform = "scale(" + z + ")"; }, [(b0.x + b0.width / 2) / S, (b0.y + b0.height / 2) / S, typeof o.zoom === "number" ? o.zoom : 2]);
        await sleep(550);
      } else await sleep(o.before ?? level.tapBefore ?? 2000);
      const b = await loc.boundingBox();
      if (o.circle !== false) await page.evaluate(([x, y]) => { const t = document.getElementById("tap"); t.className = ""; t.style.left = x + "px"; t.style.top = y + "px"; void t.offsetWidth; t.className = "go"; }, [(b.x + b.width / 2) / S, (b.y + b.height / 2) / S]);
      await sleep(430);
      if (action) await action(); else await loc.click({ noWaitAfter: true });
      await sleep(o.after ?? 450);
      if (small) { await page.evaluate(() => { document.getElementById("scr").style.transform = ""; }); await sleep(350); }
    },
    /** point at something without pressing it: zoom in, hold, zoom out */
    async look(loc, o = {}) { await v.tap(loc, () => sleep(10), { circle: false, zoom: o.zoom ?? 1.7, before: o.before ?? 700, after: o.after ?? 1600 }); },
    /** tap a field, then type like a person (clear: empty it first) */
    async type(loc, text, o = {}) { await v.tap(loc, async () => { await loc.click(); if (o.clear) await loc.fill(""); }, o); await loc.pressSequentially(text, { delay: o.delay ?? 45 }); await sleep(o.after ?? 500); },
    /** tap a download link; the file is saved in the work folder → its path */
    async download(loc, o = {}) { const ev = page.waitForEvent("download"); await v.tap(loc, null, o); const d = await ev; const p = join(WORK, d.suggestedFilename()); await d.saveAs(p); return p; },
    /** a chapter card (2 s) between the parts */
    async chapter(text) { await v.caption(null); await page.evaluate((t) => { const c = document.getElementById("chap"); c.querySelector(".k").textContent = t; c.classList.add("on"); }, text); await sleep(2000); await page.evaluate(() => document.getElementById("chap").classList.remove("on")); await sleep(300); },
    /** another signed-in user of the demo (e.g. a technician pressing steps) or a visitor (user null) → call(method, path, data);
     *  pw = the password in use after the login (the first login replaces the one given) */
    async session(user, pw) { const rc = await request.newContext({ baseURL: BASE }); const now = user ? await staffSession(rc, user, pw) : null; return { pw: now, call: (m, p, d) => call(rc, m, p, d), text: async (p) => (await rc.get(`${BASE}${p}`)).text() }; },
    async scrollTo(loc) { await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })); await sleep(550); },
    /** wait until the demo instance has answered everything the page asked for */
    async idle(max = 1500) { const t0 = Date.now(); let quiet = 0; while (Date.now() - t0 < max) { await sleep(100); quiet = inflight ? 0 : quiet + 100; if (quiet >= 250) return; } },
    /** a finger drawing (signature): points 0..1 inside the target, the small circle follows */
    async draw(loc, strokes) {
      const b = await loc.boundingBox();
      for (const s of strokes) {
        const p = (i) => [b.x + s[i][0] * b.width, b.y + s[i][1] * b.height];
        await page.mouse.move(...p(0)); await page.mouse.down();
        for (let i = 1; i < s.length; i++) {
          const [x, y] = p(i);
          await page.mouse.move(x, y, { steps: 5 });
          await page.evaluate(([px, py]) => { const t = document.getElementById("tap"); t.className = "drag"; t.style.left = px + "px"; t.style.top = py + "px"; }, [x / S, y / S]);
          await sleep(40);
        }
        await page.mouse.up();
      }
      await page.evaluate(() => { document.getElementById("tap").className = ""; });
    },
    /** the overlay frame (a map, or any page from the work folder) */
    async map(on, url) { await page.evaluate(([o, u]) => { const m = document.getElementById("map"); if (u) m.src = u; m.classList.toggle("in", o); }, [on, url ?? null]); await sleep(500); },
    async preloadApp(path) { await page.evaluate((p) => { document.querySelector('iframe[name="app"]').src = p; }, path); },
    async openApp() { await page.evaluate(() => document.getElementById("appw").classList.add("in")); await sleep(600); },
    async card(on) { await page.evaluate((o) => document.getElementById("card").classList.toggle("off", !o), on); await sleep(550); },
  };

  // ---------- record: every video on a fresh stage, frames into its own folder ----------
  const data = await level.setup(v);
  const cdp = await ctx.newCDPSession(page);
  let cur = null, writing = Promise.resolve();
  cdp.on("Page.screencastFrame", (f) => {
    cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
    if (!cur) return;
    const c = cur, file = `f${String(c.frames.length + 1).padStart(5, "0")}.jpg`;
    c.frames.push({ t: f.metadata.timestamp, file });
    writing = writing.then(() => writeFileSync(join(c.dir, "frames", file), Buffer.from(f.data, "base64")));
  });
  const done = [];
  for (const vid of VIDEOS) {
    const dir = join(WORK, vid.name);
    mkdirSync(join(dir, "frames"), { recursive: true });
    marks.length = 0; capOn = false;
    await page.goto(`${BASE}/__stage`);
    await page.evaluate(() => document.fonts.ready);
    await page.frame("tg").evaluate(() => document.fonts.ready);
    await vid.prepare?.(v, data);
    await sleep(1500);
    cur = { dir, frames: [] };
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 80, maxWidth: W * S, maxHeight: H * S, everyNthFrame: 1 });
    await sleep(300);
    const t0 = Date.now() / 1000;
    await vid.play(v, data);
    const tEnd = Date.now() / 1000;
    await cdp.send("Page.stopScreencast");
    const c = cur; cur = null; await writing;
    // from t0: the last frame painted before it stands for the start (a still intro card paints nothing new)
    const used = c.frames.slice(Math.max(0, c.frames.findLastIndex((f) => f.t <= t0)));
    used[0] = { ...used[0], t: Math.max(used[0].t, t0) };
    const lines = ["ffconcat version 1.0"];
    used.forEach((f, i) => { lines.push(`file 'frames/${f.file}'`, `duration ${Math.max(0.001, (i + 1 < used.length ? used[i + 1].t : tEnd) - f.t).toFixed(4)}`); });
    lines.push(`file 'frames/${used.at(-1).file}'`);
    writeFileSync(join(dir, "frames.txt"), lines.join("\n") + "\n");
    const keep = new Set(used.map((f) => f.file));
    for (const f of readdirSync(join(dir, "frames"))) if (!keep.has(f)) rmSync(join(dir, "frames", f));
    const seconds = Math.round((tEnd - used[0].t) * 100) / 100;
    const caps = marks.map((m, i) => ({ at: m.at - 1.6 - t0, len: (marks[i + 1]?.at ?? tEnd + 1.6) - m.at, text: m.text, frame: used.filter((f) => f.t <= m.at).at(-1)?.file }));
    done.push({ name: vid.name, folder: vid.folder ?? "", dir, seconds, caps });
    log(`${vid.name}: ${used.length} frames · ${seconds} s`);
  }

  // contact sheets of the captions (for checking the Khmer and the screens) → <work>/contact-<n>.png
  const thumbs = done.flatMap((d) => d.caps.filter((x) => x.frame).map((x, i) => ({ src: join(d.dir, "frames", x.frame), label: `${d.name.split("_")[0]} · ${i + 1}` })));
  const cols = DESK ? 4 : 5, tw = Math.round((W * S) / cols), th = Math.round((tw * H) / W), per = cols * 6, sheets = [];
  const sheet = await ctx.newPage();
  for (let k = 0; k * per < thumbs.length; k++) {
    const part = thumbs.slice(k * per, (k + 1) * per);
    await sheet.setViewportSize({ width: tw * cols, height: Math.ceil(part.length / cols) * th });
    await sheet.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(${cols},${tw}px);background:#000">${part.map((p) => `<div style="position:relative;width:${tw}px;height:${th}px"><img src="data:image/jpeg;base64,${readFileSync(p.src).toString("base64")}" style="width:100%;height:100%"><b style="position:absolute;left:4px;top:4px;background:#000c;color:#fff;font:600 14px sans-serif;padding:1px 6px;border-radius:4px">${p.label}</b></div>`).join("")}</body>`);
    const out = join(WORK, `contact-${k + 1}.png`); await sheet.screenshot({ path: out }); sheets.push(out);
  }
  await browser.close(); browser = null; await ceo.dispose();

  // ---------- encode on the server, bring the MP4s home, remove the demo instance ----------
  writeFileSync(join(WORK, "music.mjs"), readFileSync(join(HERE, "music.mjs")));
  await new Promise((res, rej) => {
    const tar = spawn("tar", ["-cf", "-", "-C", WORK, "music.mjs", ...done.map((d) => d.name)]), ssh = spawn("ssh", [SSH, "tar -xf - -C /tmp/tutorial/work"]);
    tar.stdout.pipe(ssh.stdin); ssh.on("close", (code) => (code === 0 ? res() : rej(new Error("upload failed"))));
  });
  for (const d of done) {
    log(`${d.name}: ${remote(`encode ${d.name} ${d.seconds}`)}`);
    d.out = join(ROOT, "Doc_Sup/09_Tutorials", d.folder, `${d.name}.mp4`);
    mkdirSync(dirname(d.out), { recursive: true });
    const tmp = join(WORK, `${d.name}.mp4`);
    writeFileSync(tmp, execFileSync("ssh", [SSH, `cat /tmp/tutorial/work/${d.name}.mp4`], { maxBuffer: 300e6 }));
    copyFileSync(tmp, d.out);
    d.size = statSync(d.out).size;
  }
  log(remote("down"));
  tunnel?.kill();
  const report = done.map((d) => [`→ ${d.out} · ${d.seconds} s · ${(d.size / 1e6).toFixed(2)} MB`,
    ...d.caps.map((x) => `  ${x.at.toFixed(1)}s +${x.len.toFixed(1)}s  ${x.text.replace(/\n/g, " / ")}`)].join("\n")).join("\n");
  writeFileSync(join(WORK, "captions.txt"), report);
  log(report);
  log(`${done.length} videos · ${Math.round(done.reduce((a, d) => a + d.seconds, 0))} s · ${(done.reduce((a, d) => a + d.size, 0) / 1e6).toFixed(2)} MB · contact sheets: ${sheets.join(", ")}`);
}
