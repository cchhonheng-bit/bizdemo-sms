// The Cambodia gazetteer (D-137) from the OFFICIAL source: the NCDD gazetteer database of the Ministry of Interior
// (https://db.ncdd.gov.kh/gazetteer). Per province: the Excel download (province/downloadprovince.castle — district, commune,
// village with Khmer + Latin name and code) + the province page (view/province.castle — the province's own Khmer / Latin name).
// Nothing is typed by hand: names and codes are taken as published (only invisible zero-width characters and doubled spaces
// are removed). Checks before writing: 25 provinces, unique codes, every unit under an existing parent, Phnom Penh = 14 khan,
// 105 sangkat, 953 phum. Output: apps/server/src/data/gazetteer-kh.json.
//   node scripts/gazetteer/build.mjs            (downloads; GAZ_CACHE=<dir> reuses / keeps the downloaded files)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "../../apps/server/src/data/gazetteer-kh.json");
const BASE = "https://db.ncdd.gov.kh/gazetteer";
const CACHE = process.env.GAZ_CACHE || join(HERE, ".cache");
mkdirSync(CACHE, { recursive: true });

async function post(path, body, file) {
  const f = join(CACHE, file);
  if (existsSync(f)) return readFileSync(f, "utf8");
  const r = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  if (!r.ok) throw new Error(`${path} ${body}: HTTP ${r.status}`);
  const t = await r.text();
  writeFileSync(f, t);
  return t;
}
const dec = (s) => s.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const clean = (s) => s.replace(/[​-‍﻿]/g, "").replace(/\s+/g, " ").trim();
/** SpreadsheetML (Excel 2003 XML) → rows of the first sheet */
function rows(xml) {
  const ws = /<Worksheet[^>]*>([\s\S]*?)<\/Worksheet>/.exec(xml);
  if (!ws) throw new Error("no worksheet");
  const out = [];
  for (const r of ws[1].matchAll(/<Row\b[^>]*?(?:\/>|>([\s\S]*?)<\/Row>)/g)) {
    const row = []; let col = 0;
    for (const c of (r[1] || "").matchAll(/<Cell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Cell>)/g)) {
      const idx = /ss:Index="(\d+)"/.exec(c[1]); if (idx) col = +idx[1] - 1;
      const d = /<Data[^>]*>([\s\S]*?)<\/Data>/.exec(c[2] || "");
      row[col++] = d ? dec(d[1].replace(/<[^>]+>/g, "")).trim() : "";
    }
    out.push(row);
  }
  return out;
}
// unit types: c = capital (រាជធានី), p = province (ខេត្ត); h = khan, s = srok, k = krong; g = sangkat, u = khum; v = phum
const TYPE = { "ខណ្ឌ": "h", "ស្រុក": "s", "ក្រុង": "k", "សង្កាត់": "g", "ឃុំ": "u", "ភូមិ": "v" };
const LEN = { h: 4, s: 4, k: 4, g: 6, u: 6, v: 8 };

const units = [];
for (let pv = 1; pv <= 25; pv++) {
  const page = (await post("/view/province.castle", `pv=${pv}`, `province-${pv}.html`)).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
  const m = /Province Code (\d+) Khmer (.+?) Latin (.+?) Reference/.exec(page);
  if (!m || Number(m[1]) !== pv) throw new Error(`province ${pv}: page not understood`);
  const code = String(pv).padStart(2, "0");
  units.push([code, clean(dec(m[2])), clean(dec(m[3])), clean(dec(m[2])).startsWith("រាជធានី") ? "c" : "p"]);
  const sheet = rows(await post("/province/downloadprovince.castle", `pv=${pv}`, `province-${pv}.xls`));
  if (sheet[2]?.slice(0, 4).join("|") !== "Type|Code|Name (Khmer)|Name (Latin)") throw new Error(`province ${pv}: unexpected columns ${JSON.stringify(sheet[2])}`);
  for (const r of sheet.slice(3)) {
    if (!r[0]) continue;
    const t = TYPE[r[0]];
    if (!t || !/^\d+$/.test(r[1]) || !r[2]) throw new Error(`province ${pv}: bad row ${JSON.stringify(r)}`);
    units.push([r[1].padStart(LEN[t], "0"), clean(r[2]), clean(r[3] ?? ""), t]);
  }
}
// checks
const byCode = new Map();
for (const u of units) { if (byCode.has(u[0])) throw new Error(`duplicate code ${u[0]}`); byCode.set(u[0], u); }
for (const u of units) if (u[0].length > 2 && !byCode.has(u[0].slice(0, u[0].length - 2))) throw new Error(`${u[0]} ${u[1]}: no parent`);
const count = (prefix, len) => units.filter((u) => u[0].length === len && u[0].startsWith(prefix)).length;
if (count("", 2) !== 25) throw new Error("not 25 provinces");
const pp = [count("12", 4), count("12", 6), count("12", 8)];
if (pp.join("/") !== "14/105/953") throw new Error(`Phnom Penh ${pp.join("/")} ≠ 14/105/953`);
units.sort((a, b) => (a[0] < b[0] ? -1 : 1));
mkdirSync(dirname(OUT), { recursive: true });
const day = new Date().toISOString().slice(0, 10);
writeFileSync(OUT, `{"source":"NCDD Gazetteer, Ministry of Interior — https://db.ncdd.gov.kh/gazetteer","downloaded":"${day}",\n"units":[\n${units.map((u) => JSON.stringify(u)).join(",\n")}\n]}\n`);
console.log(`${units.length} units → ${OUT}`);
console.log(`provinces ${count("", 2)} · districts ${units.filter((u) => u[0].length === 4).length} · communes ${units.filter((u) => u[0].length === 6).length} · villages ${units.filter((u) => u[0].length === 8).length} · Phnom Penh ${pp.join(" / ")}`);
