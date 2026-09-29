#!/usr/bin/env node
// Mobile audit harness (04 QA + 06 UI/UX) — plain Node ESM + Playwright, no test runner.
// Logs in as ceo / gm01 / admin / kim, visits every reachable page at mobile viewports, takes full-page
// screenshots and runs automatic mobile checks (overflow, iOS-zoom inputs, touch targets, bottom-nav overlap,
// wide tables, dialogs, console errors, Khmer clipping / line-height, viewport meta, CLS).
//
// Usage:
//   node mobile-audit.mjs --base http://localhost:5173 --out <dir> [--label before|after]
//        [--password Passw0rd!x] [--roles ceo,gm01,admin,kim] [--viewports 360,390,412,pwa,pwa-inset]
//        [--lang km|en] [--prep] [--md]
//   --prep  (dev DB only) assigns the first booking to "kim" when kim has no jobs, so /tech/job/<id> has data.
//   --md    also writes <out>/FINDINGS.md (findings.json is always written).
// Playwright must be resolvable: run from a folder where `npm i playwright@1` was done
// (or set NODE_PATH to its node_modules). Dev-only credentials: the seeded demo password.
import { mkdirSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(join(process.cwd(), "noop.js"));
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = await import("playwright")); }

// ---------- args ----------
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(`--${name}`); if (i < 0) return def; const v = argv[i + 1]; return v === undefined || v.startsWith("--") ? true : v; };
const BASE = String(arg("base", "http://localhost:5173")).replace(/\/$/, "");
const OUT = resolve(String(arg("out", "./mobile-audit-out")));
const LABEL = String(arg("label", "before"));
const PASSWORD = String(arg("password", "Passw0rd!x"));
const ROLES = String(arg("roles", "ceo,gm01,admin,kim")).split(",");
const LANG = String(arg("lang", "km"));
const PREP = !!arg("prep", false);
const WRITE_MD = !!arg("md", false);
mkdirSync(OUT, { recursive: true });

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const ALL_VIEWPORTS = {
  "360": { name: "360x800", width: 360, height: 800 },
  "390": { name: "390x844", width: 390, height: 844 },
  "412": { name: "412x915", width: 412, height: 915 },
  // installed PWA: display-mode standalone emulated via CDP
  pwa: { name: "pwa390x844", width: 390, height: 844, standalone: true },
  // PWA with a simulated 34px bottom safe-area inset (home indicator): env(safe-area-inset-*) cannot be
  // injected, so the viewport is shortened by 34px (844 -> 810) to show what the inset would cover.
  "pwa-inset": { name: "pwa390x810inset", width: 390, height: 810, standalone: true, inset: 34 },
};
const VIEWPORTS = String(arg("viewports", "360,390,412,pwa,pwa-inset")).split(",").map((k) => ALL_VIEWPORTS[k]).filter(Boolean);

const BOARD_TXT = ["Board", "ក្ដារ"];

// ---------- page list ----------
// expect: the pathname prefix that must still be shown after navigation; otherwise the role was redirected => "not allowed"
function pagesFor(role, ids) {
  const bk = ids.booking, job = ids.techJob ?? ids.booking;
  const list = [
    { key: "dashboard", path: "/dashboard" },
    { key: "bookings-list", path: "/bookings" },
    { key: "bookings-board", path: "/bookings", action: "board" },
    { key: "bookings-new", path: "/bookings/new" },
    bk && { key: "booking-detail", path: `/bookings/${bk}` },
    bk && { key: "booking-assign", path: `/bookings/${bk}`, action: "assign" },
    bk && { key: "booking-edit", path: `/bookings/${bk}/edit` },
    { key: "customers", path: "/customers" },
    { key: "customers-new", path: "/customers", action: "new" },
    { key: "catalog", path: "/catalog" },
    { key: "subscribe", path: "/subscribe" },
    { key: "users", path: "/settings/users" },
    { key: "users-new", path: "/settings/users", action: "new" },
    { key: "company", path: "/settings/company" },
    { key: "me", path: "/me" },
    { key: "notifications", path: "/notifications" },
    { key: "tech", path: "/tech" },
    job && { key: "tech-job", path: `/tech/job/${job}` },
  ].filter(Boolean);
  return list;
}
const PUBLIC_PAGES = [
  { key: "login", path: "/login" },
  { key: "terms", path: "/terms" },
  { key: "privacy", path: "/privacy" },
];

// ---------- in-page checks (runs in the browser) ----------
function inPageChecks(opts) {
  const MAX_EX = 8;
  // With isMobile, Chrome widens the layout viewport to fit overflowing content (page gets zoomed out),
  // so window.innerWidth is NOT the device width. Measure against the configured device width.
  const W = opts.vw, H = window.innerHeight; // H in layout coordinates (fixed nav / dialogs are laid out against it)
  const layoutW = window.innerWidth;
  const KH = /[ក-៿᧠-᧿]/;
  const sel = (el) => {
    if (!el || el.nodeType !== 1) return "";
    let s = el.tagName.toLowerCase();
    const tid = el.getAttribute("data-testid"); if (tid) return `${s}[data-testid="${tid}"]`;
    if (el.id) return `${s}#${el.id}`;
    const cls = (typeof el.className === "string" ? el.className : "").trim().split(/\s+/).filter((c) => c && !c.includes(":") && !c.includes("[")).slice(0, 3);
    if (cls.length) s += "." + cls.join(".");
    const txt = (el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.value || "").trim().replace(/\s+/g, " ").slice(0, 24);
    const parent = el.parentElement && el.parentElement !== document.body ? el.parentElement.tagName.toLowerCase() + ">" : "";
    return parent + s + (txt ? ` "${txt}"` : "");
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    const cs = getComputedStyle(el); if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return false;
    return !!el.offsetParent || cs.position === "fixed";
  };
  const res = {};
  const dialog = document.querySelector('[role="dialog"]');

  // (a) horizontal overflow
  const sw = document.documentElement.scrollWidth;
  const offenders = [];
  if (sw > W) {
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      // fixed inset-x-0 layers (bottom nav, modal backdrop) merely stretch to the widened layout viewport: symptoms, not causes
      let fixedLayer = null;
      for (let q = el; q && q !== document.body; q = q.parentElement) if (getComputedStyle(q).position === "fixed") { fixedLayer = q; break; }
      const symptom = fixedLayer && Math.abs(fixedLayer.getBoundingClientRect().width - layoutW) < 2;
      if (r.width > 0 && r.right > W + 1 && !symptom) {
        // skip children of an element already listed or inside a horizontal scroller
        let p = el.parentElement, inside = false;
        while (p && p !== document.body) { const ox = getComputedStyle(p).overflowX; if (ox === "auto" || ox === "scroll" || ox === "hidden") { inside = true; break; } p = p.parentElement; }
        if (!inside && !offenders.some((o) => o.el.contains(el))) offenders.push({ el, right: Math.round(r.right) });
      }
    }
  }
  res.overflow = { scrollWidth: sw, deviceWidth: W, layoutViewportWidth: layoutW, zoomedOut: layoutW > W, visualScale: +(window.visualViewport?.scale ?? 1).toFixed(3), overflow: sw > W || layoutW > W, offenders: offenders.slice(0, MAX_EX).map((o) => ({ sel: sel(o.el), right: o.right })) };

  // (b) inputs with font-size < 16px (iOS focus-zoom)
  const small = [];
  for (const el of document.querySelectorAll("input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=file]), select, textarea")) {
    if (!visible(el)) continue;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    if (fs < 16) small.push({ sel: sel(el), fontSize: fs });
  }
  res.inputFont = { count: small.length, examples: small.slice(0, MAX_EX) };

  // (c) touch targets < 44x44
  const tiny = [];
  const cands = new Set(document.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button], summary"));
  for (const lab of document.querySelectorAll("label")) if (lab.querySelector("input[type=checkbox],input[type=radio]") || (lab.htmlFor && document.getElementById(lab.htmlFor)?.matches("input[type=checkbox],input[type=radio]"))) cands.add(lab);
  for (const el of cands) {
    if (el.matches("input[type=checkbox],input[type=radio]") && (el.closest("label") || (el.id && document.querySelector(`label[for="${el.id}"]`)))) continue; // measured via its label
    if (!visible(el)) continue;
    if (dialog && !dialog.contains(el)) continue; // behind modal
    const r = el.getBoundingClientRect();
    if (r.width < 44 || r.height < 44) tiny.push({ sel: sel(el), w: Math.round(r.width), h: Math.round(r.height) });
  }
  res.touchTargets = { count: tiny.length, examples: tiny.slice(0, MAX_EX) };

  // (d) content under the fixed bottom nav (page scrolled to the end)
  let navH = 0, navEl = null;
  for (const el of document.querySelectorAll("nav, footer, div")) {
    const cs = getComputedStyle(el); if (cs.position !== "fixed" || !visible(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom >= H - 1 && r.top > H / 2 && r.width >= W * 0.9) { navH = Math.round(r.height); navEl = el; break; }
  }
  res.bottomNav = { present: !!navEl, height: navH, sel: navEl ? sel(navEl) : null, hidden: [] };
  if (navEl && !dialog) {
    const main = document.querySelector("main");
    res.bottomNav.mainPaddingBottom = main ? parseFloat(getComputedStyle(main).paddingBottom) : null;
    const foc = main ? [...main.querySelectorAll("a[href], button, input:not([type=hidden]), select, textarea, [role=button]")].filter(visible) : [];
    const hidden = foc.filter((el) => { const r = el.getBoundingClientRect(); return r.bottom > H - navH && r.top < H; });
    const last = foc[foc.length - 1];
    res.bottomNav.lastFocusable = last ? { sel: sel(last), bottom: Math.round(last.getBoundingClientRect().bottom), limit: H - navH } : null;
    res.bottomNav.hidden = hidden.slice(0, MAX_EX).map((el) => ({ sel: sel(el), bottom: Math.round(el.getBoundingClientRect().bottom), limit: H - navH }));
    // clearance between end of main content and the nav top
    if (main) {
      let maxBottom = 0; for (const el of main.querySelectorAll("*")) { if (!visible(el)) continue; const b = el.getBoundingClientRect().bottom; if (b > maxBottom) maxBottom = b; }
      res.bottomNav.contentBottom = Math.round(maxBottom); res.bottomNav.clearance = Math.round((H - navH) - maxBottom);
    }
    if (opts.inset) res.bottomNav.note = `safe-area simulated: nav (h=${navH}) has no env(safe-area-inset-bottom) padding check possible; see screenshot at height ${H}`;
  }

  // (e) tables wider than viewport
  res.tables = [...document.querySelectorAll("table")].filter(visible).map((t) => {
    const r = t.getBoundingClientRect(); let p = t.parentElement, scroller = null;
    while (p && p !== document.body) { const ox = getComputedStyle(p).overflowX; if (ox === "auto" || ox === "scroll") { scroller = p; break; } p = p.parentElement; }
    return { sel: sel(t), width: Math.round(r.width), viewport: W, wider: r.width > W || t.scrollWidth > (t.parentElement?.clientWidth ?? W) + 1, inScroller: !!scroller, cols: t.querySelectorAll("thead th").length };
  }).filter((t) => t.wider);

  // (f) dialogs taller than viewport / not scrollable / off-screen
  res.dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible).map((d) => {
    const r = d.getBoundingClientRect(), cs = getComputedStyle(d);
    const scrollable = ["auto", "scroll"].includes(cs.overflowY);
    const footer = d.querySelector("footer"); const fr = footer?.getBoundingClientRect();
    return { sel: sel(d), height: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom), viewportH: H, tallerThanViewport: r.height > H, overflowsContent: d.scrollHeight > d.clientHeight + 1, scrollable,
      footerVisible: fr ? fr.bottom <= H && fr.top >= 0 : null, problem: r.height > H || r.top < 0 || r.bottom > H + 1 || (d.scrollHeight > d.clientHeight + 1 && !scrollable) };
  });

  // (h) Khmer clipping / line-height
  const clipped = [], tightLH = [];
  let khCount = 0;
  for (const el of document.querySelectorAll("body *")) {
    if (!visible(el)) continue;
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("");
    if (!KH.test(own)) continue;
    khCount++;
    const cs = getComputedStyle(el); const fs = parseFloat(cs.fontSize);
    const ofh = [cs.overflow, cs.overflowY, cs.overflowX].some((v) => v === "hidden" || v === "clip");
    if (ofh && (el.scrollHeight > el.clientHeight + 2 || (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1)))
      clipped.push({ sel: sel(el), sh: el.scrollHeight, ch: el.clientHeight, sw: el.scrollWidth, cw: el.clientWidth, ellipsis: cs.textOverflow === "ellipsis" });
    const lh = cs.lineHeight === "normal" ? null : parseFloat(cs.lineHeight);
    if (lh !== null && lh < 1.5 * fs - 0.01) tightLH.push({ sel: sel(el), fontSize: fs, lineHeight: lh, ratio: +(lh / fs).toFixed(2) });
  }
  res.khmer = { elements: khCount, clipped: { count: clipped.length, examples: clipped.slice(0, MAX_EX) }, tightLineHeight: { count: tightLH.length, examples: tightLH.slice(0, MAX_EX) } };

  // (i) viewport meta
  res.viewportMeta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? null;
  // (j) CLS
  res.cls = +(window.__cls ?? 0).toFixed(4);
  res.clsSources = (window.__clsSources ?? []).slice(0, 5);
  res.displayModeStandalone = matchMedia("(display-mode: standalone)").matches;
  res.docHeight = document.documentElement.scrollHeight;
  return res;
}

const CLS_INIT = `(() => { window.__cls = 0; window.__clsSources = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (e.hadRecentInput) continue; window.__cls += e.value;
    for (const s of (e.sources || [])) { const n = s.node; if (n && n.nodeType === 1) window.__clsSources.push((n.tagName||'').toLowerCase() + (n.className && typeof n.className==='string' ? '.' + n.className.trim().split(/\\s+/).slice(0,2).join('.') : '') + ' +' + e.value.toFixed(3)); } } })
    .observe({ type: 'layout-shift', buffered: true }); } catch {} })();`;

// ---------- helpers ----------
async function settle(page) {
  await page.waitForLoadState("networkidle", { timeout: 6000 }).catch(() => undefined);
  await page.waitForFunction(() => !document.querySelector("[aria-busy]") && !/Loading|កំពុង/.test(document.querySelector("#root")?.innerText?.slice(0, 40) ?? ""), null, { timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(400);
}

async function newContext(browser, vp, storageState) {
  const ctx = await browser.newContext({ storageState,
    viewport: { width: vp.width, height: vp.height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA,
    locale: LANG === "km" ? "km-KH" : "en-US", serviceWorkers: "block",
  });
  await ctx.addInitScript(CLS_INIT);
  await ctx.addInitScript(`try { localStorage.setItem('lang', ${JSON.stringify(LANG)}); } catch {}`);
  const page = await ctx.newPage();
  if (vp.standalone) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] });
  }
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(`console: ${m.text().slice(0, 300)}`); });
  page.on("pageerror", (e) => errors.push(`pageerror: ${String(e.message || e).slice(0, 300)}`));
  return { ctx, page, errors };
}

async function login(ctx, username) {
  const r = await ctx.request.post(`${BASE}/api/auth/login`, { data: { identifier: username, password: PASSWORD } });
  if (!r.ok()) throw new Error(`login ${username} failed: ${r.status()} ${await r.text()}`);
  const me = (await r.json()).me;
  if (LANG && me.language !== LANG) await ctx.request.post(`${BASE}/api/me/language`, { data: { language: LANG } }).catch(() => undefined);
  return me;
}

async function doAction(page, action) {
  if (action === "board") {
    for (const txt of BOARD_TXT) { const b = page.locator("main button", { hasText: new RegExp(`^\\s*${txt}\\s*$`) }); if (await b.count()) { await b.first().click(); await page.waitForTimeout(400); return "ok"; } }
    return "board toggle not found";
  }
  if (action === "assign") {
    const b = page.locator('[data-testid="assign-btn"]');
    if (!(await b.count())) return "assign button not present";
  } else if (action === "new") {
    const b = page.locator("main button:has(svg.lucide-plus)").first();
    if (!(await b.count())) return "new button not present";
  }
  const btn = action === "assign" ? page.locator('[data-testid="assign-btn"]') : page.locator("main button:has(svg.lucide-plus)").first();
  // a real tap first; if the control is off-screen / covered, record it and fall back to a DOM click so the dialog is still audited
  const box = await btn.boundingBox();
  const vw = page.viewportSize().width;
  let tapNote = box && box.x + box.width > vw + 1 ? `trigger off-screen (right=${Math.round(box.x + box.width)} > ${vw})` : null;
  try { await btn.tap({ timeout: 4000 }); } catch { tapNote = tapNote ?? "trigger not tappable (covered or not scrollable into view)"; await btn.evaluate((el) => el.click()); }
  await page.locator('[role="dialog"]').first().waitFor({ state: "visible", timeout: 5000 }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => undefined);
  await page.waitForTimeout(400);
  if (!(await page.locator('[role="dialog"]').count())) return "dialog did not open";
  return tapNote ? `ok:${tapNote}` : "ok";
}

async function audit(page, errors, vp, role, def) {
  errors.length = 0;
  const shot = `${vp.name}_${role}_${def.key}.png`;
  const rec = { viewport: vp.name, role, page: def.key, path: def.path, status: "ok", screenshot: shot };
  try {
    await page.goto(BASE + def.path, { waitUntil: "load", timeout: 20000 });
    await settle(page);
    const final = new URL(page.url()).pathname;
    rec.finalPath = final;
    if (final !== def.path) { rec.status = "not allowed"; rec.note = `redirected to ${final}`; return rec; }
    if (def.action) {
      const a = await doAction(page, def.action);
      if (!a.startsWith("ok")) { rec.status = "skipped"; rec.note = a; return rec; }
      if (a.startsWith("ok:")) rec.triggerProblem = a.slice(3);
    }
    // scroll to the end for the bottom-nav check, measure, then back to the top for the screenshot
    await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); if (d) d.scrollTop = d.scrollHeight; window.scrollTo(0, document.documentElement.scrollHeight); });
    await page.waitForTimeout(250);
    rec.checks = await page.evaluate(inPageChecks, { inset: vp.inset ?? 0, vw: vp.width, vh: vp.height });
    const hasDialog = await page.locator('[role="dialog"]').count();
    if (rec.checks.docHeight > vp.height + 4 || hasDialog) await page.screenshot({ path: join(OUT, shot.replace(/\.png$/, "_end.png")) }); // viewport at scroll end
    await page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); if (d) d.scrollTop = 0; window.scrollTo(0, 0); });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(OUT, shot), fullPage: true });
    rec.checks.errors = [...errors];
  } catch (e) {
    rec.status = "error"; rec.note = String(e.message || e).slice(0, 400);
    await page.screenshot({ path: join(OUT, shot), fullPage: true }).catch(() => undefined);
  }
  return rec;
}

// ---------- main ----------
const browser = await chromium.launch();
const started = Date.now();
const screens = [];
const sessions = {}; // role -> Playwright storageState (cookies)

// ids from the API (as ceo)
const ids = {};
{
  const { ctx } = await newContext(browser, VIEWPORTS[0]);
  await login(ctx, "ceo");
  const bks = await (await ctx.request.get(`${BASE}/api/bookings`)).json();
  ids.booking = bks[0]?.id;
  // tech job: first booking of kim
  const kctx = await browser.newContext();
  await login(kctx, "kim");
  let kb = await (await kctx.request.get(`${BASE}/api/bookings`)).json();
  if (!kb.length && PREP && ids.booking) {
    const users = await (await ctx.request.get(`${BASE}/api/users`)).json();
    const kim = users.find((u) => u.username === "kim");
    const at = new Date(Date.now() + 2 * 3600e3); at.setMinutes(0, 0, 0);
    const r = await ctx.request.post(`${BASE}/api/bookings/${ids.booking}/assign`, { data: { lead: kim?.id, assistants: [], vehicle_id: "", scheduled_at: at.toISOString() } });
    console.log(`prep: assign ${bks[0]?.number} to kim -> ${r.status()} ${r.ok() ? "" : (await r.text()).slice(0, 200)}`);
    kb = await (await kctx.request.get(`${BASE}/api/bookings`)).json();
  }
  ids.techJob = kb[0]?.id;
  sessions.ceo = await ctx.storageState(); sessions.kim = await kctx.storageState();
  await kctx.close(); await ctx.close();
  console.log(`booking=${ids.booking ?? "-"} techJob=${ids.techJob ?? "(kim has no jobs; using booking id)"}`);
}

for (const vp of VIEWPORTS) {
  // public pages (anonymous)
  {
    const { ctx, page, errors } = await newContext(browser, vp);
    for (const def of PUBLIC_PAGES) { const r = await audit(page, errors, vp, "anon", def); screens.push(r); console.log(`${vp.name} anon ${def.key}: ${r.status}`); }
    await ctx.close();
  }
  for (const role of ROLES) {
    // one login per role for the whole run (the API rate-limits logins); the session cookie is reused per viewport
    const { ctx, page, errors } = await newContext(browser, vp, sessions[role]);
    if (!sessions[role]) {
      let me;
      try { me = await login(ctx, role); } catch (e) { screens.push({ viewport: vp.name, role, page: "(login)", status: "error", note: String(e.message) }); await ctx.close(); continue; }
      if (me.must_change_password) screens.push({ viewport: vp.name, role, page: "(login)", status: "note", note: "must_change_password=true" });
      sessions[role] = await ctx.storageState();
    }
    for (const def of pagesFor(role, ids)) {
      const r = await audit(page, errors, vp, role, def);
      screens.push(r);
      console.log(`${vp.name} ${role} ${def.key}: ${r.status}${r.note ? " (" + r.note + ")" : ""}`);
    }
    await ctx.close();
  }
}
await browser.close();

// ---------- blank screenshot check ----------
for (const s of screens) {
  if (!s.screenshot || s.status !== "ok") continue;
  try { const sz = statSync(join(OUT, s.screenshot)).size; s.screenshotBytes = sz; if (sz < 8000) s.blankSuspect = true; } catch { s.screenshotMissing = true; }
}

// ---------- summary ----------
const ok = screens.filter((s) => s.status === "ok" && s.checks);
const group = (fn) => { const m = new Map(); for (const s of ok) { const v = fn(s); if (!v) continue; const k = `${s.page}`; const g = m.get(k) ?? { page: s.page, hits: [] }; g.hits.push({ viewport: s.viewport, role: s.role, ...v }); m.set(k, g); } return [...m.values()]; };
const summary = {
  horizontalOverflow: group((s) => s.checks.overflow.overflow ? { scrollWidth: s.checks.overflow.scrollWidth, offenders: s.checks.overflow.offenders } : null),
  inputFontUnder16: group((s) => s.checks.inputFont.count ? { count: s.checks.inputFont.count, examples: s.checks.inputFont.examples } : null),
  touchTargetsUnder44: group((s) => s.checks.touchTargets.count ? { count: s.checks.touchTargets.count, examples: s.checks.touchTargets.examples } : null),
  hiddenUnderBottomNav: group((s) => s.checks.bottomNav.hidden?.length ? { navHeight: s.checks.bottomNav.height, hidden: s.checks.bottomNav.hidden, clearance: s.checks.bottomNav.clearance } : null),
  tablesWiderThanViewport: group((s) => s.checks.tables.length ? { tables: s.checks.tables } : null),
  dialogProblems: group((s) => s.checks.dialogs.some((d) => d.problem || d.footerVisible === false) ? { dialogs: s.checks.dialogs } : null),
  consoleErrors: group((s) => s.checks.errors.length ? { errors: [...new Set(s.checks.errors)].slice(0, 5) } : null),
  khmerClipped: group((s) => s.checks.khmer.clipped.count ? s.checks.khmer.clipped : null),
  khmerTightLineHeight: group((s) => s.checks.khmer.tightLineHeight.count ? s.checks.khmer.tightLineHeight : null),
  clsOver01: group((s) => s.checks.cls > 0.1 ? { cls: s.checks.cls, sources: s.checks.clsSources } : null),
  viewportMeta: [...new Set(ok.map((s) => s.checks.viewportMeta))],
  // chromium-headless-shell ignores the display-mode media feature override; false => standalone-only CSS was NOT exercised
  standaloneEmulationWorked: ok.filter((s) => s.viewport.startsWith("pwa")).some((s) => s.checks.displayModeStandalone),
  dialogTriggerProblems: screens.filter((s) => s.triggerProblem).map((s) => `${s.viewport} ${s.role} ${s.page}: ${s.triggerProblem}`),
  notAllowed: screens.filter((s) => s.status === "not allowed").map((s) => `${s.viewport} ${s.role} ${s.page} -> ${s.finalPath}`),
  skippedOrError: screens.filter((s) => s.status === "skipped" || s.status === "error").map((s) => `${s.viewport} ${s.role} ${s.page}: ${s.status} ${s.note ?? ""}`),
  blankSuspect: screens.filter((s) => s.blankSuspect || s.screenshotMissing).map((s) => s.screenshot),
};
const result = { label: LABEL, base: BASE, lang: LANG, date: new Date().toISOString(), seconds: Math.round((Date.now() - started) / 1000),
  viewports: VIEWPORTS, roles: ROLES, ids, screenshots: ok.length, notes: [
    "pwa* viewports emulate display-mode: standalone via CDP; env(safe-area-inset-*) cannot be emulated in Chromium, so pwa390x810inset shortens the viewport by 34px to approximate a home-indicator inset.",
    "Each audited screen also gets <name>_end.png (viewport-only, scrolled to the end) when the page is taller than the viewport or a dialog is open.",
  ], summary, screens };
writeFileSync(join(OUT, "findings.json"), JSON.stringify(result, null, 2));

if (WRITE_MD) {
  const L = [];
  L.push(`# Mobile audit — ${LABEL}`, "", `Base ${BASE} · lang ${LANG} · ${result.date} · ${ok.length} screens`, "");
  const sec = (title, arr, fmt) => { L.push(`## ${title} (${arr.length} pages)`, ""); for (const g of arr) { L.push(`- **${g.page}** — ${g.hits.length} screen(s)`); for (const h of g.hits.slice(0, 3)) L.push(`  - ${h.viewport} ${h.role}: ${fmt(h)}`); } L.push(""); };
  sec("Horizontal overflow", summary.horizontalOverflow, (h) => `scrollWidth ${h.scrollWidth}; ${h.offenders.map((o) => o.sel + "@" + o.right).join(", ")}`);
  sec("Input font < 16px", summary.inputFontUnder16, (h) => `${h.count}: ${h.examples.slice(0, 3).map((e) => e.sel + " " + e.fontSize + "px").join(", ")}`);
  sec("Touch targets < 44px", summary.touchTargetsUnder44, (h) => `${h.count}: ${h.examples.slice(0, 4).map((e) => `${e.sel} ${e.w}x${e.h}`).join(", ")}`);
  sec("Hidden under bottom nav", summary.hiddenUnderBottomNav, (h) => h.hidden.map((e) => e.sel).join(", "));
  sec("Tables wider than viewport", summary.tablesWiderThanViewport, (h) => h.tables.map((t) => `${t.sel} ${t.width}px scroller=${t.inScroller}`).join(", "));
  sec("Dialog problems", summary.dialogProblems, (h) => h.dialogs.map((d) => `h=${d.height}/${d.viewportH} footerVisible=${d.footerVisible}`).join(", "));
  sec("Console errors", summary.consoleErrors, (h) => h.errors.join(" | "));
  sec("Khmer clipped", summary.khmerClipped, (h) => `${h.count}: ${h.examples.slice(0, 3).map((e) => e.sel).join(", ")}`);
  sec("Khmer line-height < 1.5", summary.khmerTightLineHeight, (h) => `${h.count}: ${h.examples.slice(0, 3).map((e) => `${e.sel} ${e.ratio}`).join(", ")}`);
  sec("CLS > 0.1", summary.clsOver01, (h) => `${h.cls} ${h.sources.join(", ")}`);
  L.push(`## Viewport meta`, "", ...summary.viewportMeta.map((v) => `- \`${v}\``), "", `## Dialog trigger problems`, "", ...summary.dialogTriggerProblems.map((v) => `- ${v}`), "", `## Not allowed`, "", ...summary.notAllowed.map((v) => `- ${v}`), "", `## Skipped / errors`, "", ...summary.skippedOrError.map((v) => `- ${v}`), "");
  writeFileSync(join(OUT, "FINDINGS.md"), L.join("\n"));
}
if (VIEWPORTS.some((v) => v.standalone) && !summary.standaloneEmulationWorked) console.warn("WARNING: display-mode: standalone emulation did not take effect in this Chromium build (pwa* screens render as browser tab).");
console.log(`\nDone: ${ok.length} screens, ${summary.notAllowed.length} not allowed, ${summary.skippedOrError.length} skipped/errors, ${summary.blankSuspect.length} blank-suspect -> ${OUT}`);
