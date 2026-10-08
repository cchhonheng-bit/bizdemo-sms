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
footer{max-width:980px;margin:24px auto 0;padding:12px 16px;font-size:12px;color:${BRAND.muted};border-top:1px solid ${BRAND.line}}
.pwf{position:relative;display:block}.pwf input{padding-right:48px}.pwf .eye{position:absolute;top:50%;right:0;width:44px;height:44px;margin-top:-22px;padding:0;border:0;background:none;color:${BRAND.muted};display:flex;align-items:center;justify-content:center}
.eye svg+svg,.eye.on svg:first-child{display:none}.eye.on svg+svg{display:block}`;

const icon = (d: string) => `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
/** D-136: a password-type field with the eye button — hidden at first; /platform/eye.js (script-src 'self') swaps type, icon and label */
export const pwField = (input: string, what: "password" | "token") => `<span class="pwf">${input}<button type="button" class="eye" data-eye aria-label="Show ${what}" data-show="Show ${what}" data-hide="Hide ${what}">${
  icon('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>')}${
  icon('<path d="M17.9 17.9A10 10 0 0 1 12 20c-7 0-11-8-11-8a18.5 18.5 0 0 1 5.1-5.9M9.9 4.2A9 9 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.2 3.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="m1 1 22 22"/>')}</button></span>`;
export const EYE_JS = `document.querySelectorAll("[data-eye]").forEach(function(b){var i=b.previousElementSibling;b.addEventListener("click",function(){var s=i.type==="password";i.type=s?"text":"password";b.classList.toggle("on",s);b.setAttribute("aria-label",s?b.dataset.hide:b.dataset.show);});});`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${BRAND.navy}">
<link rel="icon" href="/brand/hangkh-favicon.svg" type="image/svg+xml"><link rel="alternate icon" href="/brand/hangkh-favicon.ico" sizes="32x32"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header><div class="bar"><a href="/" aria-label="HangKH"><img src="/brand/hangkh-wordmark-white.svg" alt="HangKH"></a></div></header><main>${body}</main><footer>© HangKH</footer>${body.includes("data-eye") ? '<script src="/platform/eye.js" defer></script>' : ""}</body></html>`;
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
