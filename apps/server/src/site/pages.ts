// Public shop website (D-95): server-rendered, no script, one language per page (Khmer default, ?lang=en), everything escaped.
// Sections appear only when the shop has the content; prices are never shown.
import { BRAND } from "@sms/shared";
import { config } from "../config.js";
import { esc } from "../hub/pages.js";
import type { SiteView } from "../services/site.js";

export type SiteLang = "km" | "en";
const TXT = {
  km: {
    tagline: "ស្នើសេវាកម្មតាមអនឡាញ — យើងនឹងទូរស័ព្ទទៅអ្នកវិញឆាប់ៗ", services: "សេវាកម្មរបស់យើង", request: "ស្នើសេវាកម្ម", call: "ទូរស័ព្ទ", about: "អំពីយើង", gallery: "រូបភាពការងារ",
    area: "តំបន់សេវាកម្ម", hours: "ម៉ោងធ្វើការ", contact: "ទំនាក់ទំនង", address: "អាសយដ្ឋាន", map: "មើលក្នុង Google Maps", facebook: "ទំព័រហ្វេសប៊ុក", tg: "ទទួលដំណឹងតាម Telegram",
    form_hint: "បំពេញព័ត៌មានខាងក្រោម។ បុគ្គលិករបស់យើងនឹងទូរស័ព្ទទៅអ្នកវិញ ដើម្បីបញ្ជាក់ថ្ងៃ និងម៉ោង។", name: "ឈ្មោះ", phone: "លេខទូរស័ព្ទ", service: "សេវាកម្មដែលត្រូវការ", choose: "— ជ្រើសរើស —", other: "ផ្សេងៗ",
    area_f: "ទីតាំង (បុរី · ផ្លូវ · ផ្ទះ)", date: "ថ្ងៃដែលចង់បាន", message: "ព័ត៌មានបន្ថែម", send: "ផ្ញើសំណើ", consent: "ដោយផ្ញើសំណើ អ្នកយល់ព្រមឲ្យយើងទាក់ទងអ្នកតាមលេខនេះអំពីសំណើនេះ។",
    err_name: "សូមបញ្ចូលឈ្មោះ", err_phone: "សូមបញ្ចូលលេខទូរស័ព្ទឲ្យត្រឹមត្រូវ", err_rate: "សំណើច្រើនពេក — សូមព្យាយាមម្ដងទៀតពេលក្រោយ ឬទូរស័ព្ទមកយើង", err_token: "ទំព័រនេះបើកយូរពេក — សូមផ្ញើម្ដងទៀត",
    thanks_h: "✅ បានទទួលសំណើរបស់អ្នក", thanks_p: "យើងនឹងទូរស័ព្ទទៅអ្នកវិញឆាប់ៗ ដើម្បីបញ្ជាក់ថ្ងៃ និងម៉ោង។", back: "ត្រឡប់ទៅទំព័រដើម", staff: "ចូលប្រព័ន្ធបុគ្គលិក", terms: "លក្ខខណ្ឌប្រើប្រាស់",
    privacy: "គោលការណ៍ឯកជនភាព", powered: "ដំណើរការដោយ", switch: "English",
    cat: { mep: "ប្រព័ន្ធទឹក ភ្លើង ម៉ាស៊ីនត្រជាក់", construction: "សំណង់", decor: "ដេគ័រ", camera: "កាមេរ៉ាសុវត្ថិភាព", direct: "ផ្សេងៗ" } as Record<string, string>,
  },
  en: {
    tagline: "Request a service online — we will call you back shortly", services: "Our services", request: "Request service", call: "Call", about: "About us", gallery: "Our work",
    area: "Service area", hours: "Working hours", contact: "Contact", address: "Address", map: "Open in Google Maps", facebook: "Facebook page", tg: "Get updates on Telegram",
    form_hint: "Fill in the form below. Our staff will call you back to confirm the day and time.", name: "Name", phone: "Phone number", service: "Service needed", choose: "— choose —", other: "Other",
    area_f: "Location (borey · street · house)", date: "Preferred day", message: "More details", send: "Send request", consent: "By sending, you agree that we contact you on this number about this request.",
    err_name: "Please enter your name", err_phone: "Please enter a valid phone number", err_rate: "Too many requests — please try again later or call us", err_token: "This page was open too long — please send again",
    thanks_h: "✅ We received your request", thanks_p: "We will call you back shortly to confirm the day and time.", back: "Back to the home page", staff: "Staff login", terms: "Terms of use",
    privacy: "Privacy policy", powered: "Powered by", switch: "ខ្មែរ",
    cat: { mep: "Plumbing, electrical, air conditioning", construction: "Construction", decor: "Decoration", camera: "Security camera", direct: "Other" } as Record<string, string>,
  },
};

const CSS = `*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;font-family:'Noto Sans Khmer','Khmer OS Battambang','Khmer UI','Segoe UI',system-ui,sans-serif;color:${BRAND.ink};background:#fff;line-height:1.75;font-size:16px}
a{color:${BRAND.tealText}}img{max-width:100%}.wrap{max-width:1040px;margin:0 auto;padding:0 16px}
.top{position:sticky;top:0;z-index:5;background:#fff;border-bottom:1px solid ${BRAND.line}}.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:62px}
.brand{display:flex;align-items:center;gap:10px;text-decoration:none;color:${BRAND.navy};font-weight:700;font-size:17px;min-width:0;line-height:1.4}.brand img{height:42px;width:auto;flex:none}
.top nav{display:flex;align-items:center;gap:6px;flex:none}.lang{font-size:14px;padding:12px 8px;text-decoration:none;color:${BRAND.muted}}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;padding:10px 18px;border-radius:10px;border:1px solid ${BRAND.navy};color:${BRAND.navy};background:#fff;font:inherit;font-weight:700;text-decoration:none;cursor:pointer}
.btn.primary{background:${BRAND.navy};color:#fff}.btn.sm{min-height:44px;padding:8px 12px;font-size:15px}
.hero{background:${BRAND.navy};color:#fff;padding:40px 0 44px;position:relative;overflow:hidden}.hero-bg{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;opacity:.28}.hero .wrap{position:relative}
.hero h1{font-size:30px;line-height:1.45;margin:0 0 8px}.hero p{margin:0 0 22px;font-size:17px;color:#E6EDF7;max-width:640px}
.cta{display:flex;flex-wrap:wrap;gap:10px}.cta .btn{border-color:#fff;color:#fff;background:transparent}.cta .btn.primary{background:${BRAND.teal};border-color:${BRAND.teal};color:${BRAND.navy}}
section{padding:34px 0}section.alt{background:${BRAND.bg}}h2{color:${BRAND.navy};font-size:22px;margin:0 0 16px;line-height:1.5}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px}.card{background:#fff;border:1px solid ${BRAND.line};border-radius:14px;padding:16px}
.card h3{margin:0 0 8px;color:${BRAND.navy};font-size:17px;line-height:1.5}.card ul{margin:0;padding-left:20px}
.pts{list-style:none;padding:0;margin:14px 0 0;display:grid;gap:8px}.pts li::before{content:"✓ ";color:${BRAND.tealText};font-weight:700}.pre{white-space:pre-line;margin:0;max-width:760px}
.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}.gal img{width:100%;aspect-ratio:4/3;object-fit:cover;border-radius:10px;display:block}
form{display:grid;gap:14px;max-width:640px}label{display:block;font-weight:600;font-size:15px;margin-bottom:4px}.req{color:#B42318}
input,select,textarea{width:100%;font:inherit;padding:12px;border:1px solid #C9CEDA;border-radius:10px;background:#fff;min-height:48px;color:inherit}textarea{min-height:110px}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:560px){.row2{grid-template-columns:1fr}.hero h1{font-size:26px}}
.hp{position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden}.alert{border:1px solid #F1B5B0;background:#FDF2F1;color:#9A2A1F;border-radius:10px;padding:12px 14px;max-width:640px;margin-bottom:14px}
.muted{color:${BRAND.muted};font-size:14px;margin:0}.contact{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:18px}.contact p{margin:0 0 10px}
iframe{width:100%;height:260px;border:0;border-radius:12px;display:block}.tel{font-size:19px;font-weight:700;text-decoration:none;white-space:nowrap}
footer{background:${BRAND.navy};color:#C9D2E3;padding:22px 0;font-size:14px}footer a{color:#fff}footer .wrap{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;justify-content:space-between}
.pw{display:inline-flex;align-items:center;gap:6px}.pw img{height:16px;width:auto}.center{text-align:center;padding:64px 0}`;

const nameOf = (d: SiteView, lang: SiteLang) => (lang === "en" ? d.info.name_en : d.info.name_km) || d.name;
const phonesOf = (d: SiteView) => (d.info.phone ?? "").split(/[/,;]+/).map((p) => p.trim()).filter((p) => p.replace(/\D/g, "").length >= 8).slice(0, 4);
const tel = (p: string) => `tel:${p.replace(/[^0-9+]/g, "")}`;
const q = (lang: SiteLang) => (lang === "en" ? "?lang=en" : "");

function shell(d: SiteView, lang: SiteLang, o: { title: string; description: string; path: string; body: string }): string {
  const t = TXT[lang], name = nameOf(d, lang), phones = phonesOf(d), base = config.publicUrl;
  const other = lang === "en" ? o.path : `${o.path}?lang=en`;
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="${BRAND.navy}">
<title>${esc(o.title)}</title><meta name="description" content="${esc(o.description)}">${d.website.published ? "" : '<meta name="robots" content="noindex,nofollow">'}
<link rel="canonical" href="${esc(base)}/${lang === "en" ? "?lang=en" : ""}"><link rel="alternate" hreflang="km" href="${esc(base)}/"><link rel="alternate" hreflang="en" href="${esc(base)}/?lang=en">
<meta property="og:type" content="website"><meta property="og:title" content="${esc(o.title)}"><meta property="og:description" content="${esc(o.description)}"><meta property="og:image" content="${esc(base)}${d.hasLogo ? "/site/logo" : "/icons/icon-512.png"}">
<link rel="icon" href="/favicon.png"><style>${CSS}</style></head><body>
<header class="top"><div class="wrap"><a class="brand" href="${o.path}${q(lang)}">${d.hasLogo ? `<img src="/site/logo" alt="">` : ""}<span>${esc(name)}</span></a>
<nav><a class="lang" href="${other}" hreflang="${lang === "en" ? "km" : "en"}">${t.switch}</a>${phones[0] ? `<a class="btn sm primary" href="${esc(tel(phones[0]))}">📞 ${t.call}</a>` : ""}</nav></div></header>
${o.body}
<footer><div class="wrap"><span>© ${esc(name)}</span><span><a href="/terms">${t.terms}</a> · <a href="/privacy">${t.privacy}</a> · <a href="/app" rel="nofollow">${t.staff}</a></span>
<span class="pw">${t.powered} <img src="/brand/hangkh-wordmark-white.svg" alt="HangKH"></span></div></footer></body></html>`;
}

export function homePage(d: SiteView, lang: SiteLang, o: { token: string; path: "/" | "/site"; errors?: string[]; values?: Record<string, string> }): string {
  const t = TXT[lang], w = d.website, name = nameOf(d, lang), phones = phonesOf(d), v = o.values ?? {};
  const pick = (km?: string, en?: string) => ((lang === "en" ? en : km) ?? "").trim();
  const tagline = pick(w.tagline_km, w.tagline_en) || t.tagline;
  const about = pick(w.about_km, w.about_en), area = pick(w.area_km, w.area_en), hours = pick(w.hours_km, w.hours_en);
  const points = ((lang === "en" ? w.highlights_en : w.highlights_km) ?? []).map((x) => x.trim()).filter(Boolean);
  const cats = [...new Set(d.services.map((s) => s.category))];
  const svcName = (s: { name_km: string; name_en: string | null }) => (lang === "en" && s.name_en ? s.name_en : s.name_km);
  const messages: Record<string, string> = { name: t.err_name, phone: t.err_phone, rate: t.err_rate, token: t.err_token };
  const err = (o.errors ?? []).map((e) => messages[e]).filter((x): x is string => !!x);
  const bad = (k: string) => (o.errors ?? []).includes(k);
  const first = bad("name") ? "name" : bad("phone") ? "phone" : "";
  const hero = `<section class="hero">${w.hero ? `<img class="hero-bg" src="/site/img/${esc(w.hero)}" alt="">` : ""}<div class="wrap"><h1>${esc(name)}</h1><p>${esc(tagline)}</p><div class="cta">
<a class="btn primary" href="#request">${t.request}</a>${phones[0] ? `<a class="btn" href="${esc(tel(phones[0]))}">📞 ${esc(phones[0])}</a>` : ""}${d.bot ? `<a class="btn" href="https://t.me/${esc(d.bot)}?start=s" rel="noopener">Telegram</a>` : ""}</div></div></section>`;
  const services = cats.length ? `<section id="services"><div class="wrap"><h2>${t.services}</h2><div class="cards">${cats.map((c) => `<div class="card"><h3>${esc(t.cat[c] ?? c)}</h3><ul>${d.services.filter((s) => s.category === c).map((s) => `<li>${esc(svcName(s))}</li>`).join("")}</ul></div>`).join("")}</div></div></section>` : "";
  const aboutS = about || points.length ? `<section class="alt" id="about"><div class="wrap"><h2>${t.about}</h2>${about ? `<p class="pre">${esc(about)}</p>` : ""}${points.length ? `<ul class="pts">${points.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</div></section>` : "";
  const gallery = (w.gallery ?? []).length ? `<section id="gallery"><div class="wrap"><h2>${t.gallery}</h2><div class="gal">${w.gallery!.map((g) => `<img src="/site/img/${esc(g)}" alt="" loading="lazy">`).join("")}</div></div></section>` : "";
  const form = `<section class="alt" id="request"><div class="wrap"><h2>${t.request}</h2>${err.length ? `<div class="alert" role="alert">${err.map((e) => esc(e)).join("<br>")}</div>` : ""}
<form method="post" action="/site/request${q(lang)}" autocomplete="on"><p class="muted">${t.form_hint}</p>
<div class="row2"><div><label for="f-name">${t.name} <span class="req">*</span></label><input id="f-name" name="name" required maxlength="80" autocomplete="name" value="${esc(v.name ?? "")}"${first === "name" ? " autofocus" : ""}></div>
<div><label for="f-phone">${t.phone} <span class="req">*</span></label><input id="f-phone" name="phone" type="tel" inputmode="tel" required maxlength="20" autocomplete="tel" value="${esc(v.phone ?? "")}"${first === "phone" ? " autofocus" : ""}></div></div>
<div class="row2"><div><label for="f-service">${t.service}</label><select id="f-service" name="service"><option value="">${t.choose}</option>${cats.map((c) => `<optgroup label="${esc(t.cat[c] ?? c)}">${d.services.filter((s) => s.category === c).map((s) => `<option value="${esc(s.id)}"${v.service === s.id ? " selected" : ""}>${esc(svcName(s))}</option>`).join("")}</optgroup>`).join("")}<option value="other"${v.service === "other" ? " selected" : ""}>${t.other}</option></select></div>
<div><label for="f-date">${t.date}</label><input id="f-date" name="date" type="date" min="${esc(d.today)}" value="${esc(v.date ?? "")}"></div></div>
<div><label for="f-area">${t.area_f}</label><input id="f-area" name="area" maxlength="120" autocomplete="street-address" value="${esc(v.area ?? "")}"></div>
<div><label for="f-msg">${t.message}</label><textarea id="f-msg" name="message" maxlength="500">${esc(v.message ?? "")}</textarea></div>
<div class="hp" aria-hidden="true"><label for="f-url">URL</label><input id="f-url" name="company_url" tabindex="-1" autocomplete="off"></div><input type="hidden" name="ts" value="${esc(o.token)}">
<button class="btn primary" type="submit">${t.send}</button><p class="muted">${t.consent}</p></form></div></section>`;
  const map = d.office ? `<div><iframe title="map" loading="lazy" referrerpolicy="no-referrer" src="https://maps.google.com/maps?q=${d.office.lat},${d.office.lng}&amp;z=15&amp;output=embed"></iframe>
<p><a href="https://www.google.com/maps/search/?api=1&amp;query=${d.office.lat},${d.office.lng}" rel="noopener">${t.map}</a></p></div>` : "";
  const lines = [phones.length ? `<p>${phones.map((p) => `<a class="tel" href="${esc(tel(p))}">📞 ${esc(p)}</a>`).join("<br>")}</p>` : "",
    d.info.address ? `<p><b>${t.address}</b><br>${esc(d.info.address)}</p>` : "", area ? `<p><b>${t.area}</b><br>${esc(area)}</p>` : "", hours ? `<p><b>${t.hours}</b><br>${esc(hours)}</p>` : "",
    d.bot ? `<p><a href="https://t.me/${esc(d.bot)}?start=s" rel="noopener">${t.tg}</a></p>` : "", w.facebook ? `<p><a href="${esc(w.facebook)}" rel="noopener">${t.facebook}</a></p>` : ""].join("");
  const contact = lines || map ? `<section id="contact"><div class="wrap"><h2>${t.contact}</h2><div class="contact"><div>${lines}</div>${map}</div></div></section>` : "";
  return shell(d, lang, { title: `${name} — ${t.request}`, description: tagline, path: o.path, body: hero + services + aboutS + gallery + form + contact });
}

export function thanksPage(d: SiteView, lang: SiteLang): string {
  const t = TXT[lang];
  return shell(d, lang, { title: `${nameOf(d, lang)} — ${t.request}`, description: t.thanks_p, path: "/site",
    body: `<section class="center"><div class="wrap"><h2>${t.thanks_h}</h2><p>${t.thanks_p}</p>${d.bot ? `<p><a class="btn" href="https://t.me/${esc(d.bot)}?start=s" rel="noopener">${t.tg}</a></p>` : ""}<p><a href="/site${q(lang)}">${t.back}</a></p></div></section>` });
}

export function robotsTxt(published: boolean): string {
  return ["User-agent: *", "Disallow: /api/", "Disallow: /app", "Disallow: /login", "Disallow: /site/request", published ? "Allow: /" : "Disallow: /", ""].join("\n");
}
