// Server-rendered pages of the hub (no SPA): landing, /privacy, /terms, /platform (owner). Everything escaped.
import { LEGAL_VERSION, PRIVACY, TERMS, fillCompany, type LegalDoc, type LegalLang } from "@sms/shared";

export const esc = (v: unknown): string => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const CSS = `*{box-sizing:border-box}body{margin:0;font-family:'Noto Sans Khmer','Segoe UI',system-ui,sans-serif;color:#1F2433;background:#F4F6FB;line-height:1.6}
main{max-width:980px;margin:0 auto;padding:24px 16px}header{background:#2E3A78;color:#fff;padding:14px 16px}header a{color:#fff;text-decoration:none;font-weight:700}
h1{color:#2E3A78;font-size:24px;margin:8px 0 12px}h2{color:#2F5BD3;font-size:17px;margin:18px 0 6px}.card{background:#fff;border:1px solid #D5DAE8;border-radius:12px;padding:16px;margin:12px 0}
table{border-collapse:collapse;width:100%;font-size:14px}th{background:#2E3A78;color:#fff;text-align:left;padding:8px}td{border-bottom:1px solid #D5DAE8;padding:8px;vertical-align:top}
.muted{color:#6B7280;font-size:13px}.ok{color:#188A54;font-weight:700}.bad{color:#B42318;font-weight:700}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px}
.num{font-size:28px;font-weight:700;color:#2E3A78}input,button{font:inherit;padding:10px 12px;border-radius:8px;border:1px solid #C9CFDF;width:100%}button{background:#2F5BD3;color:#fff;border:0;font-weight:700;cursor:pointer}
form.inline{display:inline}form.inline button{width:auto;padding:6px 12px;background:#6B7280}.tabs a{margin-right:12px}`;

export function layout(title: string, body: string): string {
  return `<!doctype html><html lang="km"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head>
<body><header><a href="/">HangKH</a></header><main>${body}</main></body></html>`;
}

export function legalHtml(doc: LegalDoc, company: string): string {
  return `<h1>${esc(doc.title)}</h1><p>${esc(fillCompany(doc.intro, company))}</p>` +
    doc.sections.map((s) => `<h2>${esc(s.h)}</h2>${s.p.map((p) => `<p>${esc(fillCompany(p, company))}</p>`).join("")}`).join("") +
    `<p class="muted">${esc(LEGAL_VERSION)}</p>`;
}

export function legalPage(which: "terms" | "privacy", lang: LegalLang): string {
  const doc = (which === "terms" ? TERMS : PRIVACY)[lang];
  const company = lang === "km" ? "ហាងដែលអ្នកប្រើ ឬចុះឈ្មោះ" : "the shop you use or subscribe to";
  const tabs = `<p class="tabs"><a href="?lang=km">ខ្មែរ</a><a href="?lang=en">English</a></p>`;
  return layout(doc.title, `<div class="card">${tabs}${legalHtml(doc, company)}</div>`);
}

export function landingPage(bot: string): string {
  return layout("HangKH", `<div class="card"><h1>HangKH</h1><p>ប្រព័ន្ធគ្រប់គ្រងសេវាកម្មសម្រាប់ហាង · Service management for shops in Cambodia.</p>
<p>Telegram: <a href="https://t.me/${esc(bot)}">@${esc(bot)}</a></p><p><a href="/privacy">គោលការណ៍ឯកជនភាព / Privacy</a> · <a href="/terms">លក្ខខណ្ឌ / Terms</a></p></div>`);
}
