// Tutorial videos — the recorder (runs on the PC: Playwright + installed Edge, headless). A 1080×1920 window holding a 540×960 phone
// stage scaled ×2 (pages keep their phone layout, text is drawn at full size; the screencast captures CSS pixels) = 1080×1920 frames: the screen (iframes: a Telegram look-alike that shows the bot's REAL answers, a map, the REAL app of a
// throwaway DEMO instance) under an HTML caption box (Noto Sans Khmer — the browser shapes the Khmer), a tap circle and the intro /
// outro card (One Team × HangKH). Frames come from the browser's own screencast with their timestamps; server.sh encodes them with
// the generated music (music.mjs) into an H.264 MP4 → Doc_Sup/09_Tutorials/<name>.mp4. A new video = a new file in levels/ (steps +
// captions). Demo data only: the level's setup() creates fake names on the demo instance; nothing touches the live shop.
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node record.mjs levels/l1-technician.mjs     (TUTORIAL_SSH=hangkh443 on port-22-blocked networks)
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../.."), SSH = process.env.TUTORIAL_SSH || "hangkh";
const BASE = "http://localhost:3998", W = 540, H = 960;
const level = (await import(pathToFileURL(resolve(process.argv[2] ?? "levels/l1-technician.mjs")).href)).default;
const { chromium, request } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const WORK = join(tmpdir(), "hangkh-tutorial", level.name), FRAMES = join(WORK, "frames");
rmSync(WORK, { recursive: true, force: true }); mkdirSync(FRAMES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
const remote = (args, input) => execFileSync("ssh", [SSH, `bash /tmp/tutorial-server.sh ${args}`], { input, maxBuffer: 300e6 }).toString().trim();
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

// ---------- the demo instance (server) ----------
execFileSync("ssh", [SSH, "cat > /tmp/tutorial-server.sh"], { input: readFileSync(join(HERE, "server.sh")) });
log(remote("up")); log(remote("seed"));
let tunnel = null;
if (!(await fetch(`${BASE}/healthz`).then((r) => r.ok).catch(() => false))) { tunnel = spawn("ssh", ["-N", "-L", "3998:127.0.0.1:3998", SSH], { stdio: "ignore" }); await sleep(2500); }
const HUBKEY = remote("secret hubkey"), CEO_TEMP = remote("secret ceo");

const browser = await chromium.launch({ channel: "msedge", headless: true });
const ctx = await browser.newContext({ viewport: { width: W * 2, height: H * 2 }, deviceScaleFactor: 1, locale: "km-KH", timezoneId: "Asia/Phnom_Penh", bypassCSP: true,
  geolocation: { latitude: 11.5566, longitude: 104.9284, accuracy: 12 }, permissions: ["geolocation"] });
const password = () => "Dm" + randomBytes(9).toString("base64url") + "!7";
async function staffSession(rc, user, pw) { // log in; the first login asks for a new password
  const r = await rc.post(`${BASE}/api/auth/login`, { data: { identifier: user, password: pw } });
  if (!r.ok()) throw new Error(`login ${user}: ${r.status()}`);
  const j = await r.json();
  if (j.me?.must_change_password ?? j.must_change_password) {
    const c = await rc.post(`${BASE}/api/me/password`, { data: { new_password: password() } });
    if (!c.ok()) throw new Error(`password ${user}: ${c.status()}`);
  }
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
const asset = (p) => readFileSync(p);
const ASSETS = { "oneteam.png": join(ROOT, "Doc_Sup/00_Reference_Customer/One Team Logo.png"), "hangkh.svg": join(ROOT, "Doc_Sup/10_Brand/final_v2/hangkh-lockup-stacked.svg") };
const font = (w) => `@font-face{font-family:KH;font-weight:${w};src:url(/pub/fonts/noto-sans-khmer-${w}.woff2) format("woff2")}`;
const STAGE = `<!doctype html><html><head><meta charset="utf-8"><style>${font(400)}${font(600)}${font(700)}
@font-face{font-family:PO;font-weight:600;src:url(/pub/fonts/poppins-600.woff2) format("woff2")}
html,body{margin:0;width:${W * 2}px;height:${H * 2}px;overflow:hidden;background:#fff}
#st{position:absolute;left:0;top:0;width:${W}px;height:${H}px;overflow:hidden;transform:scale(2);transform-origin:0 0}
iframe{position:absolute;left:0;top:0;width:${W}px;height:${H}px;border:0;background:#fff}
#map{opacity:0;transition:opacity .45s;z-index:5;pointer-events:none}#map.in{opacity:1}
#appw{position:absolute;inset:0;z-index:6;background:#fff;transform:translateX(100%);transition:transform .5s cubic-bezier(.2,.8,.2,1)}#appw.in{transform:none}
#bar{height:48px;display:flex;align-items:center;gap:14px;padding:0 16px;border-bottom:1px solid #E5E9EC;font:600 17px PO,KH,sans-serif;color:#14213D;background:#fff}
#bar i{font-style:normal;font-size:22px;color:#5B6B7A}#bar span{flex:1}
#appw iframe{top:48px;height:${H - 48}px}
#cap{position:absolute;left:22px;right:22px;bottom:44px;z-index:9;font:600 27px/1.62 KH,sans-serif;color:#fff;background:rgba(15,23,42,.8);border-radius:18px;padding:12px 18px;
  text-align:center;white-space:pre-line;pointer-events:none;opacity:0;transform:translateY(10px);transition:opacity .3s,transform .3s}
#cap.on{opacity:1;transform:none}
#tap{position:absolute;left:0;top:0;width:60px;height:60px;margin:-30px 0 0 -30px;border-radius:50%;border:4px solid #fff;background:rgba(20,184,166,.38);
  box-shadow:0 0 0 3px rgba(15,118,110,.6),0 4px 16px rgba(0,0,0,.35);opacity:0;pointer-events:none;z-index:10}
#tap.go{animation:tap .9s ease-out forwards}#tap.drag{opacity:1;width:30px;height:30px;margin:-15px 0 0 -15px;animation:none}
@keyframes tap{0%{opacity:0;transform:scale(.3)}25%{opacity:1;transform:scale(1)}55%{opacity:1;transform:scale(.8)}100%{opacity:0;transform:scale(1.5)}}
#card{position:absolute;inset:0;z-index:12;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:26px;transition:opacity .5s}
#card.off{opacity:0;pointer-events:none}#card .x{font:600 40px PO,sans-serif;color:#94A3B8}#card .t{font:600 30px PO,sans-serif;color:#14213D;letter-spacing:.5px;margin-top:10px}
#pre{position:absolute;left:-999px;font:600 20px KH}</style></head><body><div id="st">
<iframe name="tg" src="/__tg"></iframe><iframe id="map"></iframe><div id="appw"><div id="bar"><i>✕</i><span>One Team</span><i>⋮</i></div><iframe name="app"></iframe></div>
<div id="tap"></div><div id="cap"></div><span id="pre">ការងារ</span>
<div id="card"><img src="/__asset/oneteam.png" style="width:360px" alt=""><div class="x">×</div><img src="/__asset/hangkh.svg" style="width:230px" alt=""><div class="t">OneTeam × HangKH</div></div>
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
await ctx.route(new RegExp(`^${BASE}/__asset/`), (r) => {
  const name = decodeURIComponent(new URL(r.request().url()).pathname.slice("/__asset/".length)), file = ASSETS[name] ?? join(WORK, name);
  return r.fulfill({ contentType: name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".png") ? "image/png" : "image/jpeg", body: asset(file) });
});

// ---------- what a level uses ----------
const page = await ctx.newPage();
let inflight = 0;
page.on("request", (r) => { if (r.url().startsWith(BASE)) inflight++; });
for (const ev of ["requestfinished", "requestfailed"]) page.on(ev, (r) => { if (r.url().startsWith(BASE)) inflight = Math.max(0, inflight - 1); });
const marks = [];
const v = {
  base: BASE, password,
  api: (method, path, data) => call(ceo, method, path, data),
  internal: (path, data) => call(ceo, "POST", path, data),
  sql: (stmt) => remote(`sql ${q(stmt)}`),
  loginStaff: (user, pw) => staffSession(ctx.request, user, pw),
  hold: sleep,
  get tgf() { return page.frame("tg"); },
  get app() { return page.frame("app"); },
  /** a demo picture made in the browser (html → jpeg in the work folder; served as /__asset/<name>) */
  async picture(name, html) { const p = await ctx.newPage(); await p.setViewportSize({ width: 800, height: 600 }); await p.setContent(html); await p.screenshot({ path: join(WORK, name), type: "jpeg", quality: 88 }); await p.close(); return join(WORK, name); },
  tg: (fn, ...args) => page.frame("tg").evaluate(([f, a]) => window.tg[f](...a), [fn, args]),
  tgButton: (label, where = "ik") => page.frame("tg").locator(`${where === "kb" ? "#kb" : "#chat"} button`, { hasText: label }).last(),
  /** caption (null hides it). pos: "low" (bottom of the screen) or "tg" (just above the Telegram keyboard) */
  async caption(text, pos = "low") {
    const bottom = pos === "tg" ? (await page.frame("tg").evaluate(() => document.getElementById("kb").offsetHeight + document.querySelector(".in").offsetHeight)) + 14 : 44;
    await page.evaluate(() => document.getElementById("cap").classList.remove("on"));
    await sleep(text ? 280 : 300);
    if (!text) return;
    await page.evaluate(([t, b]) => { const c = document.getElementById("cap"); c.textContent = t; c.style.bottom = b + "px"; c.classList.add("on"); }, [text, bottom]);
    marks.push({ at: Date.now() / 1000 + 1.6, text });
  },
  /** ~2 s pause (the viewer reads the caption), the tap circle on the target, then the action (default: a real click) */
  async tap(loc, action, o = {}) {
    await sleep(o.before ?? 2000);
    const b = await loc.boundingBox();
    if (!b) throw new Error("tap target not visible");
    await page.evaluate(([x, y]) => { const t = document.getElementById("tap"); t.className = ""; t.style.left = x + "px"; t.style.top = y + "px"; void t.offsetWidth; t.className = "go"; }, [(b.x + b.width / 2) / 2, (b.y + b.height / 2) / 2]);
    await sleep(430);
    if (action) await action(); else await loc.click({ noWaitAfter: true });
    await sleep(o.after ?? 600);
  },
  async scrollTo(loc) { await loc.evaluate((el) => el.scrollIntoView({ behavior: "smooth", block: "center" })); await sleep(800); },
  /** wait until the demo instance has answered everything the page asked for */
  async idle(max = 1500) { const t0 = Date.now(); let quiet = 0; while (Date.now() - t0 < max) { await sleep(100); quiet = inflight ? 0 : quiet + 100; if (quiet >= 300) return; } },
  /** a finger drawing (signature): points 0..1 inside the target, the small circle follows */
  async draw(loc, strokes) {
    const b = await loc.boundingBox();
    for (const s of strokes) {
      const p = (i) => [b.x + s[i][0] * b.width, b.y + s[i][1] * b.height];
      await page.mouse.move(...p(0)); await page.mouse.down();
      for (let i = 1; i < s.length; i++) {
        const [x, y] = p(i);
        await page.mouse.move(x, y, { steps: 5 });
        await page.evaluate(([px, py]) => { const t = document.getElementById("tap"); t.className = "drag"; t.style.left = px + "px"; t.style.top = py + "px"; }, [x / 2, y / 2]);
        await sleep(40);
      }
      await page.mouse.up();
    }
    await page.evaluate(() => { document.getElementById("tap").className = ""; });
  },
  async map(on, url) { await page.evaluate(([o, u]) => { const m = document.getElementById("map"); if (u) m.src = u; m.classList.toggle("in", o); }, [on, url ?? null]); await sleep(500); },
  async preloadApp(path) { await page.evaluate((p) => { document.querySelector('iframe[name="app"]').src = p; }, path); },
  async openApp() { await page.evaluate(() => document.getElementById("appw").classList.add("in")); await sleep(600); },
  async card(on) { await page.evaluate((o) => document.getElementById("card").classList.toggle("off", !o), on); await sleep(550); },
};

// ---------- record ----------
const data = await level.setup(v);
await page.goto(`${BASE}/__stage`);
await page.evaluate(() => document.fonts.ready);
await page.frame("tg").evaluate(() => document.fonts.ready);
await level.prepare?.(v, data);
await sleep(1500);
const cdp = await ctx.newCDPSession(page);
const frames = [];
let writing = Promise.resolve();
cdp.on("Page.screencastFrame", (f) => {
  const i = frames.length + 1, file = `f${String(i).padStart(5, "0")}.jpg`;
  frames.push({ t: f.metadata.timestamp, file });
  writing = writing.then(() => writeFileSync(join(FRAMES, file), Buffer.from(f.data, "base64")));
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, maxWidth: W * 2, maxHeight: H * 2, everyNthFrame: 1 });
await sleep(300);
const t0 = Date.now() / 1000;
await level.play(v, data);
const tEnd = Date.now() / 1000;
await cdp.send("Page.stopScreencast"); await writing;
// from t0: the last frame painted before it stands for the start (a still intro card paints nothing new)
const used = frames.slice(Math.max(0, frames.findLastIndex((f) => f.t <= t0)));
used[0] = { ...used[0], t: Math.max(used[0].t, t0) };
const lines = ["ffconcat version 1.0"];
used.forEach((f, i) => { lines.push(`file 'frames/${f.file}'`, `duration ${Math.max(0.001, (i + 1 < used.length ? used[i + 1].t : tEnd) - f.t).toFixed(4)}`); });
lines.push(`file 'frames/${used.at(-1).file}'`);
writeFileSync(join(WORK, "frames.txt"), lines.join("\n") + "\n");
const seconds = Math.round((tEnd - used[0].t) * 100) / 100;
log(`recorded ${used.length} frames · ${seconds} s`);

// a contact sheet of the captions (for checking the Khmer and the screens) → <work>/contact.png
const pick = marks.map((m) => used.filter((f) => f.t <= m.at).at(-1)).filter(Boolean);
const sheet = await ctx.newPage();
await sheet.setViewportSize({ width: 1080, height: Math.ceil(pick.length / 5) * 384 });
await sheet.setContent(`<body style="margin:0;display:grid;grid-template-columns:repeat(5,216px);background:#000">${pick.map((f) => `<img src="data:image/jpeg;base64,${readFileSync(join(FRAMES, f.file)).toString("base64")}" style="width:216px;height:384px">`).join("")}</body>`);
await sheet.screenshot({ path: join(WORK, "contact.png") });
await browser.close(); await ceo.dispose();

// ---------- encode on the server, bring the MP4 home, remove the demo instance ----------
const used2 = new Set(used.map((f) => f.file));
for (const f of readdirSync(FRAMES)) if (!used2.has(f)) rmSync(join(FRAMES, f));
writeFileSync(join(WORK, "music.mjs"), readFileSync(join(HERE, "music.mjs")));
await new Promise((res, rej) => {
  const tar = spawn("tar", ["-cf", "-", "-C", WORK, "frames", "frames.txt", "music.mjs"]), ssh = spawn("ssh", [SSH, "tar -xf - -C /tmp/tutorial/work"]);
  tar.stdout.pipe(ssh.stdin); ssh.on("close", (c) => (c === 0 ? res() : rej(new Error("upload failed"))));
});
log(remote(`encode ${level.name} ${seconds}`));
const out = join(ROOT, "Doc_Sup/09_Tutorials", `${level.name}.mp4`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(join(WORK, "out.mp4"), execFileSync("ssh", [SSH, `cat /tmp/tutorial/work/${level.name}.mp4`], { maxBuffer: 300e6 }));
copyFileSync(join(WORK, "out.mp4"), out);
log(remote("down"));
if (tunnel) tunnel.kill();
log(`→ ${out} · ${(statSync(out).size / 1e6).toFixed(2)} MB · ${seconds} s · contact sheet ${join(WORK, "contact.png")}`);
writeFileSync(join(WORK, "captions.txt"), marks.map((m, i) => `${(m.at - 1.6 - t0).toFixed(1)}s +${((marks[i + 1]?.at ?? tEnd + 1.6) - m.at).toFixed(1)}s  ${m.text.replace(/\n/g, " / ")}`).join("\n"));
