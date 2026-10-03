// Server-rendered pages of the hub (no SPA): landing, /privacy, /terms, /platform (owner). Everything escaped.
import { BRAND, LEGAL_VERSION, PRIVACY, TERMS, fillCompany, type LegalDoc, type LegalLang } from "@sms/shared";

export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// Brand tokens (D-90): navy primary, teal accent (text-safe teal for text), gold for small highlights only
const CSS = `*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans Khmer','Segoe UI',system-ui,sans-serif;color:${BRAND.ink};background:${BRAND.bg};line-height:1.6}
main{max-width:980px;margin:0 auto;padding:24px 16px}header{background:${BRAND.navy};color:#fff;padding:12px 16px;border-bottom:3px solid ${BRAND.gold}}
header .bar{max-width:980px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:12px}header a{color:#fff;text-decoration:none;font-weight:700;display:inline-flex;align-items:center}
header img{height:28px;width:auto;display:block}
h1{color:${BRAND.navy};font-size:24px;margin:8px 0 12px}h2{color:${BRAND.tealText};font-size:17px;margin:18px 0 6px}.card{background:#fff;border:1px solid ${BRAND.line};border-radius:12px;padding:16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th{background:${BRAND.navy};color:#fff;text-align:left;padding:8px}td{border-bottom:1px solid ${BRAND.line};padding:8px;vertical-align:top}
.muted{color:${BRAND.muted};font-size:13px}.ok{color:#188A54;font-weight:700}.bad{color:#B42318;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.num{font-size:28px;font-weight:700;color:${BRAND.navy}}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid ${BRAND.line};width:100%}button{background:${BRAND.navy};color:#fff;border:0;font-weight:700;cursor:pointer}
form.inline{display:inline}form.inline button{width:auto;padding:6px 12px;background:${BRAND.muted}}.tabs a{margin-right:12px}a{color:${BRAND.tealText}}
footer{max-width:980px;margin:24px auto 0;padding:12px 16px;font-size:12px;color:${BRAND.muted};border-top:1px solid ${BRAND.line}}`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${BRAND.navy}">
<link rel="icon" href="/brand/hangkh-favicon.svg" type="image/svg+xml"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header><div class="bar"><a href="/" aria-label="HangKH"><img src="/brand/hangkh-wordmark-white.svg" alt="HangKH"></a></div></header><main>${body}</main><footer>© HangKH</footer></body></html>`;
}

export function legalHtml(doc: LegalDoc, company: string): string {
  return `<h1>${esc(doc.title)}</h1><p>${esc(fillCompany(doc.intro, company))}</p>` +
    doc.sections.map((s) => `<h2>${esc(s.h)}</h2>${s.p.map((p) => `<p>${esc(fillCompany(p, company))}</p>`).join("")}`).join("") +
    `<p class="muted">${esc(LEGAL_VERSION)}</p>`;
}

/** owner I2: one page — Khmer first, English below, no language switch */
export function legalPage(which: "terms" | "privacy"): string {
  const docs = which === "terms" ? TERMS : PRIVACY;
  const part = (lang: LegalLang) => `<div class="card" lang="${lang}">${legalHtml(docs[lang], lang === "km" ? "ហាងដែលអ្នកប្រើ ឬចុះឈ្មោះ" : "the shop you use or subscribe to")}</div>`;
  return layout(`${docs.km.title} · ${docs.en.title}`, part("km") + part("en"));
}

/** one language per page (D-89): Khmer by default, English with ?lang=en */
export function landingPage(bot: string, lang: "km" | "en" = "km"): string {
  const en = lang === "en";
  return layout("HangKH", `<div class="card"><h1>HangKH</h1><p>${en ? "Service management for shops in Cambodia." : "ប្រព័ន្ធគ្រប់គ្រងសេវាកម្មសម្រាប់ហាងនៅកម្ពុជា។"}</p>
<p>Telegram: <a href="https://t.me/${esc(bot)}">@${esc(bot)}</a></p><p><a href="/privacy">${en ? "Privacy" : "គោលការណ៍ឯកជនភាព"}</a> · <a href="/terms">${en ? "Terms" : "លក្ខខណ្ឌ"}</a></p>
<p class="muted"><a href="${en ? "/" : "/?lang=en"}">${en ? "ខ្មែរ" : "English"}</a></p></div>`);
}
