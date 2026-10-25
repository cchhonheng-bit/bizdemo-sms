// One short PDF per position (D-129, CEO brief «guide per position» 3): the steps of the daily work + a QR code to that position's
// videos page → Doc_Sup/08_Sales_Delivery/Guides/Guide_<Position>.pdf (publish.mjs puts them on the all-guide and «របៀបប្រើ» pages).
// Khmer only (product text for One Team staff / customers); button names exactly as on screen. Rendered by Edge (headless):
//   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node guide-pdf.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../.."), OUT = join(ROOT, "Doc_Sup/08_Sales_Delivery/Guides");
const SITE = "https://oneteam.hangkh.com";
const { chromium } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const dataUri = (file, type) => `data:${type};base64,${readFileSync(join(ROOT, file)).toString("base64")}`;
const ONE = dataUri("Doc_Sup/00_Reference_Customer/One Team Logo.png", "image/png"), HANG = dataUri("Doc_Sup/10_Brand/final_v2/hangkh-lockup-stacked.svg", "image/svg+xml");

const GUIDES = [
  { file: "Guide_Technician.pdf", title: "ជាង", url: `${SITE}/app/guide`, steps: [
    "បើក bot របស់ហាង ចុច «📋 ការងារថ្ងៃនេះ» — ការងារថ្ងៃនេះ តាមលំដាប់ម៉ោង។",
    "ជ្រើសការងារ — អតិថិជន អាសយដ្ឋាន ម៉ោង និងសេវា។ ចុច «🗺 ផ្លូវទៅ» ដើម្បីបើកផែនទី។",
    "ចុច «📱 មើលក្នុងកម្មវិធី»។ ពេលចេញដំណើរ ចុច «🚐 ចេញពីការិយាល័យឥឡូវ»។",
    "ដល់ផ្ទះអតិថិជន ចុច «📍 ខ្ញុំដល់ទីតាំងហើយ» (បើក GPS) ហើយថតរូបមុនពេលធ្វើការ។",
    "ចុច «🔧 ចាប់ផ្តើមការងារ» → ធ្វើរួច ចុច «✅ ការងាររួចរាល់» → ថតរូបក្រោយ។",
    "ឲ្យអតិថិជនចុះហត្ថលេខា → ចុច «ផ្ញើរបាយការណ៍» → រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ។",
    "ត្រឡប់ដល់ការិយាល័យ ចុច «🏁 ត្រឡប់ / រួចរាល់»។",
    "ថ្ងៃស្អែក៖ «📅 ការងារថ្ងៃស្អែក» · សុំច្បាប់៖ «🗓 សុំច្បាប់ឈប់» · វីដេអូ៖ «📘 របៀបប្រើ»។",
  ] },
  { file: "Guide_Admin_GM.pdf", title: "រដ្ឋបាល · អ្នកគ្រប់គ្រង", url: `${SITE}/app/guide`, steps: [
    "«សំណើអតិថិជន»៖ ឆ្លើយក្នុង ៣០ នាទី — «បញ្ជាក់» (ជ្រើសជាងទំនេរ និងរយៈពេល) ឬ «មិនទទួល» + មូលហេតុ។",
    "អតិថិជនទូរស័ព្ទមក៖ «ការងារ» → «ការងារថ្មី» → អតិថិជន សេវា ម៉ោង → ចាត់ជាង។",
    "ប្ដូរម៉ោង៖ បើកការងារ → «កែ»។ បោះបង់៖ «បោះបង់ការងារ» + មូលហេតុ — ការងារមិនត្រូវបានលុបទេ។",
    "«ការងារ» ថ្ងៃនេះ៖ តារាងតាមស្ថានភាព — ផ្លាស់ប្ដូរឯង ពេលជាងចុចជំហាន។",
    "«សេវាកម្ម និងតម្លៃ»៖ «កែ» តម្លៃ ឬ Excel៖ ទាញយកគំរូ → ផ្ទុកឡើង → មើលជាមុន → អនុវត្ត។",
    "«អតិថិជន»៖ «ទាញ Excel» / «នាំចូល Excel» (លេខដូចគ្នា = កែ · ថ្មី = បន្ថែម) · ចូលគណនីមិនបាន៖ ប្រវត្តិ → ដោះសោ។",
    "«ស្តុក»៖ «ទិញចូល» → ជាងមកយក «ដកស្តុក» (ជាង · ការងារ) → «ផ្ទៀងផ្ទាត់សម្ភារៈ» · ចុងខែ «តម្លៃស្តុកចុងខែ» · រាប់ខុស «កែតម្រូវ»។",
    "«អតិថិជន Telegram»៖ ប្រូម៉ូសិន — សរសេរ → មើលជាមុន → ផ្ញើ។",
    "ជំនួយ៖ ប៊ូតុង (?) នៅខាងលើគ្រប់ទំព័រ · វីដេអូទាំងអស់៖ «របៀបប្រើ»។",
  ] },
  { file: "Guide_CEO.pdf", title: "នាយកប្រតិបត្តិ", url: `${SITE}/app/guide`, steps: [
    "«ផ្ទាំងគ្រប់គ្រង»៖ ការងារ ចំណូល និងសាច់ប្រាក់ថ្ងៃនេះ ឃើញភ្លាម។",
    "«របាយការណ៍»៖ ជ្រើស «ថ្ងៃនេះ» ឬ «ខែនេះ» — ទាញយក Excel បាន។",
    "«គេហទំព័រ»៖ ព័ត៌មានហាង រូបភាព ម៉ោងកក់ — ការកែនីមួយៗ បង្ហាញ «កែប្រែចុងក្រោយ»។",
    "«ការកំណត់» → «លេខទូរស័ព្ទសាកល្បង»៖ កក់សាកល្បង ដោយមិនរំខានបុគ្គលិក។",
    "«អ្នកប្រើ»៖ បន្ថែមបុគ្គលិក តួនាទី បិទគណនី ពាក្យសម្ងាត់ថ្មី។",
    "កំណត់ហេតុសកម្មភាព (ក្នុង «របាយការណ៍»)៖ អ្នកណា ធ្វើអ្វី ពី → ទៅ ពេលណា។",
    "«វីដេអូណែនាំ»៖ វីដេអូទាំងអស់ — «✅ យល់ព្រម» ឬ «✏️ ត្រូវកែ»។",
  ] },
  { file: "Guide_CFO.pdf", title: "នាយកហិរញ្ញវត្ថុ", url: `${SITE}/app/guide`, steps: [
    "«របាយការណ៍»៖ សាច់ប្រាក់ និងការផ្ទៀងផ្ទាត់ ប្រចាំថ្ងៃ។",
    "«គណនេយ្យ» → «ការកំណត់»៖ សមតុល្យដើម — រក្សាទុក កែបាន រួចចុច «បញ្ជាក់សមតុល្យដើម»។",
    "វិក្កយបត្រ និងប្រាក់ទទួល កត់ត្រាដោយស្វ័យប្រវត្តិ — ចំណាយ ឬចំណូលផ្សេងៗ៖ «ចំណូល/ចំណាយ»។",
    "«ប្លង់គណនី»៖ គណនីតាមប្រភេទ — បន្ថែមគណនីថ្មី។",
    "តុល្យភាពសាកល្បង និងបញ្ជីទូទៅ៖ ឥណពន្ធ = ឥណទាន ✓ — ទាញយក Excel។",
    "របាយការណ៍លទ្ធផល និងតារាងតុល្យការ៖ ខែនេះ ធៀបខែមុន និងបម្រែបម្រួល។",
    "ចុងខែ៖ «បិទការិយបរិច្ឆេទ» · ចុងឆ្នាំ៖ «បិទឆ្នាំ»។",
  ] },
  { file: "Guide_Customer.pdf", title: "អតិថិជន", url: `${SITE}/guide`, steps: [
    "បើក oneteam.hangkh.com → ជ្រើសសេវា រួចជ្រើសម៉ោងដែលជាងទំនេរ។",
    "វាយឈ្មោះ លេខទូរស័ព្ទ → ចុច «កក់ និងភ្ជាប់ Telegram» → ក្នុង Telegram ចុច START។",
    "ពាក្យសម្ងាត់ ៤ ខ្ទង់ មកក្នុង Telegram — ប្ដូរជាលេខងាយចាំ ក្នុង «គណនីរបស់ខ្ញុំ»។",
    "«📍 តាមដានការកក់»៖ ស្ថានភាព ម៉ោង ជាង — ស្នើប្ដូរម៉ោង ឬបោះបង់។",
    "ការងារធំ ឬមិនច្បាស់តម្លៃ? «ស្នើសុំតម្លៃ» ជាមួយរូបថត។",
    "ភ្លេចពាក្យសម្ងាត់? ក្នុង Telegram ចុច «🔑 កំណត់ពាក្យសម្ងាត់ថ្មី»។",
    "ឈប់ទទួលដំណឹង៖ «🔕 ឈប់ទទួលដំណឹង» ឬនៅក្នុង «គណនីរបស់ខ្ញុំ»។",
  ] },
  // CEO 12-10 (D-140) · 13-10 (D-144): the stock guide for រដ្ឋបាល / នាយកប្រតិបត្តិ / នាយកហិរញ្ញវត្ថុ — no video yet (D-138: L2-10 … L2-13 at the final recording)
  { file: "Stock_Guide_KH.pdf", title: "ស្តុកសម្ភារៈ", url: `${SITE}/app/guide`, compact: true,
    sub: "បញ្ជីតម្លៃ (ជាង · វិក្កយបត្រ) និងស្តុក (រដ្ឋបាល) ដាច់ដោយឡែក — ជាងមិនដកស្តុកទេ", sections: [
    { title: "ក · បញ្ជីតម្លៃ ≠ ស្តុក", steps: [
      "«សេវាកម្ម និងតម្លៃ» = សេវាកម្មញឹកញាប់ និងបន្ទាត់លក់តាមកញ្ចប់ (ឧ. «ទុយោស្ពាន់ (ម៉ែត្រ)» ១៥ ដុល្លារ/ម៉ែត្រ រួមហ្គាស និងខ្សែ) — ជាង និងវិក្កយបត្រប្រើបញ្ជីនេះ។",
      "«ភ្ជាប់កូដស្តុក» លើបន្ទាត់លក់ (ឧ. ទុយោស្ពាន់ → 13400) ប្រើសម្រាប់របាយការណ៍ផ្ទៀងផ្ទាត់តែប៉ុណ្ណោះ · មិនដកស្តុកទេ។",
      "ជាងនៅកន្លែង៖ «ការងារបន្ថែម» → «ពីបញ្ជីតម្លៃ» + ចំនួន ឬ «ការងារ/សម្ភារៈបន្ថែម» (ឈ្មោះ · ចំនួន · ឯកតា · រូប · គ្មានតម្លៃ) → រដ្ឋបាល/អ្នកគ្រប់គ្រង កំណត់តម្លៃ (សេវាកម្ម ឬទំនិញ) មុនចេញវិក្កយបត្រ។",
    ] },
    { title: "ខ · ទិញចូល (រដ្ឋបាល)", steps: [
      "«ស្តុក» → «ទិញចូល» → «ទំនិញថ្មី»៖ ឈ្មោះ/ម៉ូដែល · «គណនីស្តុក» (13110 Panasonic ជាប់ជញ្ជាំង · 13400 ទុយោស្ពាន់ · 14500 សម្ភារៈជាង · …) · ឯកតា · ចំនួន · ថ្លៃឯកតា → សរុបគណនាឯង · កូដបំពេញឯង (1340001 …) · លេខវិក្កយបត្រអ្នកផ្គត់ផ្គង់ · «បង់ឥឡូវ» ខ្លះ ឬទាំងអស់ — នៅសល់ = ជំពាក់។",
      "ឈ្មោះដូចគ្នាក្នុងគណនីដូចគ្នា = ទំនិញដដែល (ជ្រើស «ទំនិញមានស្រាប់») · «បង់ដោយ» សាច់ប្រាក់ · ABA · ACLEDA · ឬ «ជំពាក់» + អ្នកផ្គត់ផ្គង់ · កាលបរិច្ឆេទ។",
      "«ជំពាក់អ្នកផ្គត់ផ្គង់»៖ បញ្ជីជំពាក់តាមហាង (វិក្កយបត្រនៅសល់ · ទិញប៉ុន្មានដង) → «បង់» ជាដុល្លារ ឬរៀល · សាច់ប្រាក់ / ABA / ACLEDA · កាលបរិច្ឆេទ — គណនេយ្យកត់ឯង (20003 ↔ សាច់ប្រាក់/ធនាគារ)។",
      "មានស្តុកស្រាប់មុនកម្មវិធី? រាប់ ហើយ «ទិញចូល» ម្ដងដំបូង (សៀវភៅចាប់យកតម្លៃនេះជាសមតុល្យដើម)។",
    ] },
    { title: "គ · ដកស្តុក (ជាងមកយក)", steps: [
      "«ស្តុក» → «ដកស្តុក» → ទំនិញ · ចំនួន · ជាង · ការងារ (លេខការងារ) ឬ «កន្លែង» (គម្រោង · បុរី · ផ្ទះលេខ) · កាលបរិច្ឆេទ → បង្ហាញ «សល់ …»។",
      "គណនេយ្យកត់ឯង៖ ទំនិញលក់ (ម៉ាស៊ីន 131xx–133xx · 138xx · អេឡិចត្រូនិច 141xx–144xx · មួយទឹក 18xxx) → ថ្លៃដើមទំនិញលក់ 50001 · សម្ភារៈ (ទុយោ 13400 · 13500–13700 · 14500) → សម្ភារៈជាង 50005។",
      "វិក្កយបត្រមិនដកស្តុកទេ — ស្តុកផ្លាស់ប្ដូរតែពី «ទិញចូល» និង «ដកស្តុក» របស់រដ្ឋបាល។",
    ] },
    { title: "ឃ · ផ្ទៀងផ្ទាត់ និងចុងខែ", steps: [
      "«ស្តុក» → «ផ្ទៀងផ្ទាត់សម្ភារៈ»៖ តាមការងារ និងក្រុម — ដកស្តុក ៦ ម៉ែត្រ ធៀបវិក្កយបត្រ ៥ ម៉ែត្រ → ខុស ១ ម៉ែត្រ (បង្ហាញក្រហម) · ច្រោះតាមជាង និងថ្ងៃ។",
      "ចុងខែ៖ «តម្លៃស្តុកចុងខែ» — តម្លៃតាមគណនី ធៀបនឹងសៀវភៅ (✓ ឬខុសគ្នា)។",
    ] },
    { title: "ង · រាប់ស្តុក («កែតម្រូវ»)", steps: [
      "រាប់ទំនិញពិតប្រាកដ ហើយធៀបនឹងចំនួនក្នុង «ស្តុក» · ចុចទំនិញ → «កាតស្តុក» ឃើញចលនាទាំងអស់ (ជាង · ការងារ · កន្លែង)។",
      "ខុសគ្នា? «កែតម្រូវ» → ទំនិញ · «− រាប់បានតិចជាង / ខូច» ឬ «+ រាប់បានច្រើនជាង» · ចំនួន · មូលហេតុ → រក្សាទុក (កត់ក្នុងកំណត់ហេតុ)។",
    ] },
  ] },
];
const font = (w) => `@font-face{font-family:KH;font-weight:${w};src:url(${SITE}/pub/fonts/noto-sans-khmer-${w}.woff2) format("woff2")}`;
const page = (g) => `<!doctype html><html lang="km"><head><meta charset="utf-8"><style>${font(400)}${font(600)}${font(700)}
@page{size:A4;margin:16mm 16mm 14mm}*{box-sizing:border-box}body{margin:0;font:400 13.5pt/1.75 KH,sans-serif;color:#14213D;counter-reset:s}
body.c{font-size:10.5pt;line-height:1.45}body.c .hd{padding-bottom:6px}body.c .hd img{height:40px}body.c li{padding:3px 0 3px 36px}body.c li::before{top:4px;width:24px;height:24px;font-size:10pt;line-height:24px}body.c h1{font-size:17pt;margin:8px 0 0}body.c .sub{margin:0 0 4px}
h2{font:700 13pt/1.5 KH,sans-serif;color:#0F766E;margin:10px 0 2px}body.c h2{font-size:11.5pt;margin:6px 0 0}body.c .qr{margin-top:8px;padding:8px;gap:14px}body.c #q{width:90px;height:90px}body.c .ft{margin-top:4px}
.hd{display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #0F766E;padding-bottom:10px}.hd img{height:54px}.x{font:600 18pt sans-serif;color:#94A3B8;margin:0 14px}
.lg{display:flex;align-items:center}h1{font:700 22pt/1.5 KH,sans-serif;margin:18px 0 2px}.sub{color:#5B6676;margin:0 0 12px}
ol{margin:0;padding:0;list-style:none}li{counter-increment:s;position:relative;padding:7px 0 7px 46px;border-bottom:1px solid #E5EEEC}
li::before{content:counter(s);position:absolute;left:0;top:9px;width:30px;height:30px;border-radius:50%;background:#0F766E;color:#fff;font:700 13pt/30px sans-serif;text-align:center}
.qr{display:flex;align-items:center;gap:22px;margin-top:18px;padding:14px;border:1px solid #DCEAE8;border-radius:14px;background:#F4FAF9}#q{width:150px;height:150px}
.qr b{display:block;font:700 14pt/1.6 KH,sans-serif}.qr .u{font:600 11pt monospace;color:#0F766E}.ft{margin-top:12px;font:600 9pt sans-serif;color:#94A3B8;text-align:right}</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script></head><body class="${g.compact ? "c" : ""}">
<div class="hd"><div class="lg"><img src="${ONE}" alt=""><span class="x">×</span><img src="${HANG}" alt=""></div></div>
<h1>សៀវភៅណែនាំ · ${g.title}</h1><p class="sub">${g.sub ?? "ការងារប្រចាំថ្ងៃ ជាជំហានៗ — វីដេអូលម្អិត៖ ស្កេន QR ខាងក្រោម"}</p>
${(g.sections ?? [{ title: null, steps: g.steps }]).map((sec) => `${sec.title ? `<h2>${sec.title}</h2>` : ""}<ol>${sec.steps.map((s) => `<li>${s.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</li>`).join("")}</ol>`).join("")}
<div class="qr"><div id="q"></div><div><b>${g.sections ? "«របៀបប្រើ» ក្នុងកម្មវិធី" : `វីដេអូណែនាំ · ${g.title}`}</b><div class="u">${g.url.replace("https://", "")}</div>${g.url.includes("/app/") ? '<div class="sub">ចូលប្រព័ន្ធដោយគណនីរបស់អ្នក</div>' : ""}</div></div>
<div class="ft">OneTeam × HangKH</div>
<script>new QRCode(document.getElementById("q"), { text: ${JSON.stringify(g.url)}, width: ${g.compact ? 90 : 150}, height: ${g.compact ? 90 : 150}, correctLevel: QRCode.CorrectLevel.M });</script></body></html>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ channel: "msedge", headless: true });
const p = await browser.newPage();
const only = process.argv.slice(2);
for (const g of GUIDES.filter((x) => !only.length || only.includes(x.file))) {
  await p.setContent(page(g), { waitUntil: "networkidle" });
  await p.evaluate(() => document.fonts.ready);
  await p.locator("#q img").waitFor({ state: "visible", timeout: 15_000 });
  await p.pdf({ path: join(OUT, g.file), format: "A4", printBackground: true, preferCSSPageSize: true });
  const pages = (readFileSync(join(OUT, g.file)).toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`${g.file} · ${pages} page(s)`);
  if (pages > (g.compact ? 1 : 2)) throw new Error(`${g.file}: more than ${g.compact ? 1 : 2} page(s)`);
}
await browser.close();
