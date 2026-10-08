// One Team's final test before go-live (D-134): ONE page, Khmer only, by role, tick boxes — button and menu names exactly as on
// screen → Doc_Sup/08_Sales_Delivery/OneTeam_Final_Test_KH.pdf. Rendered by Edge (headless):
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node final-test-pdf.mjs
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../..");
const OUT = join(ROOT, "Doc_Sup/08_Sales_Delivery/OneTeam_Final_Test_KH.pdf");
const { chromium } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const dataUri = (file, type) => `data:${type};base64,${readFileSync(join(ROOT, file)).toString("base64")}`;
const ONE = dataUri("Doc_Sup/00_Reference_Customer/New Support/One Team.png", "image/png"), HANG = dataUri("Doc_Sup/10_Brand/final_v2/hangkh-lockup-stacked.svg", "image/svg+xml");
const fontFile = (w) => `data:font/woff2;base64,${readFileSync(join(ROOT, `Source/apps/server/pub/fonts/noto-sans-khmer-${w}.woff2`)).toString("base64")}`;

const ROLES = [
  { title: "ចាប់ផ្ដើម · នាយកប្រតិបត្តិ", items: [
    "ចូល oneteam.hangkh.com/app ដោយគណនី ceo — ចូលលើកដំបូង ត្រូវប្ដូរពាក្យសម្ងាត់",
    "«អ្នកប្រើ» → «អ្នកប្រើថ្មី»៖ បន្ថែមរដ្ឋបាល អ្នកគ្រប់គ្រង ជាង ហិរញ្ញវត្ថុ — ម្នាក់ៗចូល ហើយប្ដូរពាក្យសម្ងាត់",
    "«ការកំណត់» → «លេខទូរស័ព្ទសាកល្បង»៖ វាយលេខអ្នកសាកល្បង — ការកក់ពីលេខនេះ មិនចូលរបាយការណ៍ ហើយបោះបង់ឯង ក្រោយ ២៤ ម៉ោង",
    "«ការកំណត់» → «ទីតាំងការិយាល័យ»៖ នៅការិយាល័យ ចុច «ប្រើទីតាំងខ្ញុំឥឡូវ ជាទីតាំងការិយាល័យ» → រក្សាទុក (សម្រាប់វត្តមាន)",
  ] },
  { title: "អតិថិជន · ទូរស័ព្ទ", items: [
    "បើក oneteam.hangkh.com → ជ្រើសសេវា និងម៉ោង → «កក់ និងភ្ជាប់ Telegram» → ក្នុង Telegram ចុច START",
    "ពាក្យសម្ងាត់ ៤ ខ្ទង់ មកក្នុង Telegram → ចូល «គណនីរបស់ខ្ញុំ» → ប្ដូរជាលេខងាយចាំ",
    "«📍 តាមដានការកក់»៖ ស្នើប្ដូរម៉ោង · បោះបង់ការកក់មួយទៀត",
    "«ស្នើសុំតម្លៃ» ជាមួយរូបថត ២ សន្លឹក",
    "ក្នុង Telegram៖ «🔑 កំណត់ពាក្យសម្ងាត់ថ្មី» · «🔕 ឈប់ទទួលដំណឹង»",
  ] },
  { title: "រដ្ឋបាល · អ្នកគ្រប់គ្រង", items: [
    "«សំណើអតិថិជន»៖ «បញ្ជាក់» (ជ្រើសជាង) · «មិនទទួល» + មូលហេតុ",
    "«ការងារ» → «ការងារថ្មី» សម្រាប់អតិថិជនទូរស័ព្ទមក → ចាត់ជាង",
    "ប្ដូរម៉ោង · «បោះបង់ការងារ» + មូលហេតុ",
    "«ទំនិញ និងសេវាកម្ម»៖ ពិនិត្យតម្លៃ និងរយៈពេល — «កែ» ឬ Excel",
    "«ចេញវិក្កយបត្រ» → «ទទួលប្រាក់» → បោះពុម្ព៖ ឡូហ្គោ និង QR ACLEDA ស្កេនបាន",
    "«អតិថិជន Telegram»៖ ផ្ញើប្រូម៉ូសិនសាកល្បង",
  ] },
  { title: "ជាង · ទូរស័ព្ទ", items: [
    "«ខ្ញុំ» → «ភ្ជាប់ Telegram» → bot «📋 ការងារថ្ងៃនេះ» → «🗺 ផ្លូវទៅ»",
    "៤ ជំហាន + រូបមុន និងក្រោយ + ហត្ថលេខាអតិថិជន → «ផ្ញើរបាយការណ៍»",
    "«ចូលធ្វើការ» ពេលដល់ការិយាល័យ",
  ] },
  { title: "នាយកប្រតិបត្តិ · ហិរញ្ញវត្ថុ", items: [
    "«ផ្ទាំងគ្រប់គ្រង» · «របាយការណ៍» · កំណត់ហេតុសកម្មភាព",
    "«គណនេយ្យ» → សមតុល្យដើម (ពេលលេខរួចរាល់)",
    "«វីដេអូណែនាំ»៖ មើល ហើយចុច «✅ យល់ព្រម» ឬ «✏️ ត្រូវកែ»",
  ] },
];
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
const html = `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>
@font-face{font-family:KH;font-weight:400;src:url(${fontFile(400)}) format("woff2")}@font-face{font-family:KH;font-weight:700;src:url(${fontFile(700)}) format("woff2")}
@page{size:A4;margin:11mm 12mm 10mm}*{box-sizing:border-box}body{margin:0;font:400 10.4pt/1.62 KH,sans-serif;color:#14213D}
.hd{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #0F766E;padding-bottom:6px}.lg{display:flex;align-items:center}.lg img{height:40px}.x{font:600 15pt sans-serif;color:#94A3B8;margin:0 10px}
h1{font:700 16pt/1.5 KH,sans-serif;margin:8px 0 0}.sub{color:#5B6676;margin:0 0 6px;font-size:9.6pt}
.g{display:grid;grid-template-columns:1fr 1fr;gap:8px 12px}.box{border:1px solid #DCEAE8;border-radius:10px;padding:6px 10px 4px;break-inside:avoid}.wide{grid-column:1/-1}
h2{font:700 11.2pt/1.6 KH,sans-serif;color:#0F766E;margin:0 0 2px}ul{list-style:none;margin:0;padding:0}li{position:relative;padding:2px 0 2px 22px}
li::before{content:"";position:absolute;left:0;top:7px;width:13px;height:13px;border:1.6px solid #14213D;border-radius:3px}
.notes .ln{height:22px;border-bottom:1px dashed #C9D6D4}
.ft{margin-top:8px;display:flex;justify-content:space-between;align-items:flex-end;font-size:9.4pt;color:#5B6676;border-top:1px solid #E5EEEC;padding-top:6px}.ft b{color:#14213D}.sig{font-size:9.4pt}
</style></head><body>
<div class="hd"><div class="lg"><img src="${ONE}" alt=""><span class="x">×</span><img src="${HANG}" alt=""></div><div class="sig">ថ្ងៃ ............ · អ្នកសាកល្បង ............</div></div>
<h1>ការសាកល្បងចុងក្រោយ មុនប្រើប្រាស់ពិត</h1>
<p class="sub">ធីក ☑ ពេលធ្វើរួច · មានបញ្ហា? ថតអេក្រង់ ហើយផ្ញើមក HangKH ជាមួយលេខជួរ</p>
<div class="g">${ROLES.map((r, i) => `<div class="box${i === 0 ? " wide" : ""}"><h2>${esc(r.title)}</h2><ul>${r.items.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`).join("")}
<div class="box wide notes"><h2>កំណត់ចំណាំ · បញ្ហាដែលឃើញ</h2><div class="ln"></div><div class="ln"></div><div class="ln"></div></div></div>
<div class="ft"><div>គេហទំព័រ <b>oneteam.hangkh.com</b> · bot <b>t.me/Oneteam_app_bot</b> · វីដេអូ <b>oneteam.hangkh.com/app/all_guide</b></div><div>OneTeam × HangKH</div></div>
</body></html>`;

const browser = await chromium.launch({ channel: "msedge", headless: true });
const p = await browser.newPage();
await p.setContent(html, { waitUntil: "load" });
await p.evaluate(() => document.fonts.ready);
await p.pdf({ path: OUT, format: "A4", printBackground: true, preferCSSPageSize: true });
await p.setViewportSize({ width: 794, height: 1123 }); await p.screenshot({ path: join(tmpdir(), "OneTeam_Final_Test_KH.preview.png"), fullPage: true }); // to look at — not in Doc_Sup
await browser.close();
const pages = (readFileSync(OUT).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
console.log(`${OUT} · ${pages} page(s)`);
if (pages !== 1) throw new Error(`the checklist must be ONE page (${pages})`);
