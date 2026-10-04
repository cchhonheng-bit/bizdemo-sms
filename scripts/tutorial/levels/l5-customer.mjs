// Level 5 — the customer, on a phone (1080×1920), as built: the website in the phone's browser (address bar) or inside Telegram
// (Mini App), the shop bot in a Telegram look-alike. Overview · book on the website · link Telegram + the password · track a booking
// (ask for another time, cancel, then the job's messages: new time, reminder, on the way, done) · ask for a price with photos · a new
// password from the bot, then changed on the website · notifications (stop / resume, the switches on the website)
// → Doc_Sup/09_Tutorials/Customer/. Demo data only: fake names and phone numbers on a throwaway demo shop
// with a demo hub whose bot can never reach Telegram; the catalog has no prices (as the live shop). The bot's texts: the demo shop's
// own answers where it gives them (the link message with the password, the hint); the messages the shop pushes through the hub
// (confirmed, new time, new password) and the hub's own 🔕 choices are built here from the same templates, word for word
// (packages/shared/src/customer-text.ts · hub/menus.ts · hub/router.ts). Passwords are blurred on screen.
const ADDR = "ផ្ទះលេខ 21 ផ្លូវសាកល្បង ភ្នំពេញ";
const MENU = { book: "📅 កក់សេវា", track: "📍 តាមដានការកក់", promo: "🎁 ប្រូម៉ូសិន", password: "🔑 កំណត់ពាក្យសម្ងាត់ថ្មី", stop: "🔕 ឈប់ទទួលដំណឹង" };
const GRID = [[{ text: MENU.book }, { text: MENU.track }], [{ text: MENU.promo }, { text: MENU.password }], [{ text: MENU.stop }]];
const BTN = { track: "📍 តាមដានការកក់", again: "កក់ម្ដងទៀត", login: "ចូលគណនី", resume: "🔔 បើកវិញ", stopPromo: "ឈប់ទទួលប្រូម៉ូសិន", stopAll: "ឈប់ទាំងអស់", cancel: "បោះបង់", resumePromo: "🎁 បើកប្រូម៉ូសិនវិញ" };
const WD = ["ច័ន្ទ", "អង្គារ", "ពុធ", "ព្រហស្បតិ៍", "សុក្រ", "សៅរ៍", "អាទិត្យ"], MON = ["មករា", "កុម្ភៈ", "មីនា", "មេសា", "ឧសភា", "មិថុនា", "កក្កដា", "សីហា", "កញ្ញា", "តុលា", "វិច្ឆិកា", "ធ្នូ"];
/** customer-text.ts kmWhen: «ច័ន្ទ 6 តុលា» + «09:00» in the shop's time zone */
function kmWhen(at, tz) {
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(at));
  const g = (k) => p.find((x) => x.type === k)?.value ?? "";
  return { day: `${WD[["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday"))]} ${Number(g("day"))} ${MON[Number(g("month")) - 1]}`, time: `${g("hour")}:${g("minute")}` };
}
/** customerText (packages/shared/src/customer-text.ts) — the pushed messages the demo cannot hand over */
const TXT = {
  confirmed: (no, w, tech) => `✅ បានបញ្ជាក់ #${no}\n${w.day} ម៉ោង ${w.time}${tech ? ` · ជាង ${tech}` : ""}`,
  rescheduled: (no, w) => `🔁 បានប្ដូរម៉ោង #${no}\n${w.day} ម៉ោង ${w.time}`,
  reminder: (time, service, tech) => `⏰ ស្អែក ម៉ោង ${time}\n${service}${tech ? ` · ជាង ${tech}` : ""}`,
  onTheWay: (tech) => (tech ? `🚗 ជាង ${tech} កំពុងមក` : "🚗 ជាងកំពុងមក"),
  done: (no, until) => `✅ ការងាររួចរាល់ #${no}${until ? `\nធានាដល់ ${until}` : ""}`,
  newPassword: (pw) => `🔑 ពាក្យសម្ងាត់ថ្មី៖ ${pw}`,
  promo: (text) => `🎁 ${text}`,
  unsubscribedPromo: "🔕 បានឈប់ តែប្រូម៉ូសិន\nបើកវិញបានគ្រប់ពេល",
  stopAskPromoOff: "🔕 ប្រូម៉ូសិនបានឈប់រួចហើយ\nឈប់ដំណឹងទាំងអស់ ឬបើកប្រូម៉ូសិនវិញ?",
  resumedPromo: "🔔 បានបើកប្រូម៉ូសិនវិញ",
};
/** HH:MM of a moment (+ minutes) in the shop's time zone; the warranty end (closed day + 30, customer-text.ts kmDate) */
const hhmm = (at, plusMin, tz) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(new Date(at).getTime() + plusMin * 60_000));
function warrantyEnd(at, tz, days = 30) {
  const [y, m, dd] = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(at)).split("-").map(Number);
  const e = new Date(Date.UTC(y, m - 1, dd + days));
  return `${e.getUTCDate()} ${MON[e.getUTCMonth()]} ${e.getUTCFullYear()}`;
}
const PW = /(ពាក្យសម្ងាត់(?:ថ្មី)?៖ )(\d{4})/;
const blur = (text) => text.replace(PW, "$1⟦$2⟧");
const pwOf = (text) => { const m = PW.exec(text); if (!m) throw new Error(`no password in «${text}»`); return m[2]; };
const tokenOf = (link) => { const m = /[?&]start=(b-[A-Za-z0-9_-]{20})/.exec(link ?? ""); if (!m) throw new Error(`no link token in ${link}`); return m[1]; };
/** demo «photos» for the price request: a bathroom wall with a damp stain, a dripping pipe (drawn, not anybody's photo) */
const WALL = `<body style="margin:0;width:800px;height:600px;background:repeating-linear-gradient(0deg,#E9E4DA 0 58px,#D9D2C4 58px 61px),#E9E4DA">
<div style="position:absolute;left:0;right:0;top:0;height:600px;background:repeating-linear-gradient(90deg,transparent 0 118px,#D9D2C4 118px 121px)"></div>
<div style="position:absolute;left:250px;top:120px;width:330px;height:380px;border-radius:46% 54% 40% 60%;background:radial-gradient(circle at 45% 40%,rgba(120,105,70,.55),rgba(140,120,80,.25) 60%,transparent 72%);filter:blur(6px)"></div>
<div style="position:absolute;left:340px;top:250px;width:150px;height:110px;border-radius:50%;background:rgba(70,90,60,.35);filter:blur(10px)"></div></body>`;
const PIPE = `<body style="margin:0;width:800px;height:600px;background:linear-gradient(#EDEAE4,#D8D3CA)">
<div style="position:absolute;left:0;right:0;top:230px;height:70px;background:linear-gradient(#C9CED3,#9DA4AB 55%,#BFC5CB)"></div>
<div style="position:absolute;left:380px;top:210px;width:90px;height:110px;border-radius:12px;background:linear-gradient(90deg,#8E959C,#C7CCD1,#8E959C)"></div>
<div style="position:absolute;left:418px;top:330px;width:16px;height:26px;border-radius:50% 50% 50% 50% / 60% 60% 40% 40%;background:#6FA8DC"></div>
<div style="position:absolute;left:421px;top:390px;width:12px;height:18px;border-radius:50% 50% 50% 50% / 60% 60% 40% 40%;background:#6FA8DC;opacity:.8"></div>
<div style="position:absolute;left:330px;top:520px;width:200px;height:30px;border-radius:50%;background:rgba(111,168,220,.45)"></div></body>`;

/** a day clock for the demo shop: recorded in the evening, the screens would show the night wording (D-119) — the normal case is the day */
const hourIn = (tz) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(new Date()));
const DAY_TZ = ["Asia/Phnom_Penh", "Asia/Dubai", "Europe/London", "America/New_York", "America/Los_Angeles", "Pacific/Honolulu", "Australia/Sydney", "Asia/Tokyo"].find((z) => hourIn(z) >= 9 && hourIn(z) <= 14);

const ui = (v) => {
  const A = v.app;
  return {
    A, T: (s) => A.locator(s),
    card: (no) => A.locator("section[data-booking]", { hasText: `#${no}` }),
    msg: (id) => v.tgf.locator(`#${id}`),
  };
};
/** the customer's chat so far (linked, confirmed) + the keyboard — shown before the clip starts */
async function chatSoFar(v, d) {
  await v.tg("bot", blur(d.A.linkText));
  const id = await v.tg("bot", TXT.confirmed(d.A1.number, d.A1.when, d.tech), [[{ text: BTN.track, web_app: "track" }]]);
  await v.tg("keyboard", GRID);
  return id;
}
const clip = (name, prepare, play) => ({
  name, folder: "Customer",
  async prepare(v, d) {
    await v.tgf.evaluate((t) => { window.tg.time = t; }, d.time);
    await v.signOut();
    await prepare(v, d);
  },
  async play(v, d) {
    await v.hold(2000); await v.card(false);                              // intro
    await play(v, d, ui(v));
    await v.caption(null); await v.card(true); await v.hold(2000);       // outro
  },
});
/** the browser on a page of the site (address bar), already open before the clip starts */
async function browser(v, path, ready) {
  await v.bar("web"); await v.preloadApp(path); await v.openApp();
  await v.app.locator(ready).first().waitFor({ timeout: 20_000 }); await v.idle(2000);
}
/** a page of the site as the Mini App over the chat (the customer is signed in) */
async function miniApp(v, path, ready) {
  await v.bar("mini"); await v.preloadApp(path);
  await v.app.locator(ready).first().waitFor({ timeout: 20_000 }); await v.idle(1500); await v.openApp();
}

export default {
  name: "L5_Customer",
  hub: true,            // the notification switches and the subscriptions need a hub (a throwaway one, its bot cannot reach Telegram)
  prices: false,        // the catalog without prices, as the live shop
  appWidth: 430,        // the site at a phone's width, scaled to the frame
  capPos: "top",        // the site keeps its booking bar at the bottom
  async setup(v) {
    if (!DAY_TZ) throw new Error("no day-time zone found");
    // the demo hub: the shop's bot row (a dummy token nobody can decrypt) — first, the site's Telegram links take the bot's name from the hub
    await v.sqlhub(`insert into hub_bots (code, kind, shop_code, username, path, token_enc, secret_enc) values ('DEMO', 'shop', 'DEMO', 'Oneteam_app_bot', 'demo', 'demo-no-token', 'demo-no-token');`);
    if (DAY_TZ !== "Asia/Phnom_Penh") await v.sql(`update companies set timezone = '${DAY_TZ}'`);
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: DAY_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date());
    const user = async (username, full_name, role, phone) => { const p = v.password(); const u = await v.api("POST", "/api/users", { username, full_name, role, phone, password: p }); return { id: u.id, username, p }; };
    const t1 = await user("jang1", "សាកល្បង", "tech", "012000301");
    await user("jang2", "សាកល្បង ២", "tech", "012000302");
    // one hub subscriber per demo customer chat
    const sub = async (n) => {
      const out = await v.sqlhub(`with s as (insert into hub_subscribers (telegram_user_id, chat_id, first_name) values (${700300 + n}, ${700300 + n}, 'អតិថិជនសាកល្បង') returning id)
insert into hub_subscriptions (shop_code, subscriber_id) select 'DEMO', id from s returning subscriber_id;`);
      const m = /^(\d+)$/m.exec(out); if (!m) throw new Error(`hub subscriber: ${out}`); return Number(m[1]);
    };
    const list = await v.api("GET", "/api/catalog"), items = Array.isArray(list) ? list : list.items;
    const item = (code) => { const x = items.find((i) => i.code === code); if (!x) throw new Error(`no ${code}`); return x; };
    const ac = item("AC-CLEAN"), el = item("EL-REPAIR");
    const visitor = await v.session(null);
    // the hub and the shop keep «no bot» for a while (30 s / 60 s caches) after the start: wait until the site links to the bot
    for (let i = 0; !(await visitor.text("/")).includes("t.me/Oneteam_app_bot"); i++) { if (i >= 30) throw new Error("the demo site never linked to the bot"); await v.hold(5000); }
    const ts = /data-ts="([^"]+)"/.exec(await visitor.text(`/book?items=${ac.id}:1`))[1];
    const days = (await visitor.call("GET", `/api/public/slots?items=${ac.id}:2`)).days.filter((x) => x.slots.some((s) => s.free)).slice(1); // from tomorrow
    if (days.length < 4) throw new Error("not enough free days");
    const at = (day, hhmm) => (day.slots.find((s) => s.free && s.time === hhmm) ?? day.slots.find((s) => s.free)).at;
    await v.hold(2600); // the form's anti-bot clock: at least 2 s after the page
    const book = (rc, its, when, name, phone) => rc.call("POST", "/api/public/bookings", { items: its, at: when, address: ADDR, name, phone, consent: true, ts });
    // customer A: booked on the website, linked in Telegram (new customer = the password), confirmed with a technician; a second booking waits
    const A = { name: "អតិថិជន សាកល្បង", phone: "012000201", typed: "12 000 201", sub: await sub(1) };
    const a1 = await book(visitor, `${ac.id}:2`, at(days[0], "09:00"), A.name, A.phone);
    const link = await v.internal("/internal/customer-subscribed", { code: tokenOf(a1.link), subscriber_id: A.sub });
    A.linkText = link.text; A.pw = pwOf(link.text);
    const signed = await v.session(null);
    await signed.call("POST", "/api/public/login", { phone: A.phone, password: A.pw });
    const a2 = await book(signed, `${el.id}:1`, at(days[1], "10:00"), A.name, A.phone);
    const reqs = await v.api("GET", "/api/requests"), rows = Array.isArray(reqs) ? reqs : reqs.items ?? reqs.requests ?? [];
    const r1 = rows.find((r) => r.booking_number === a1.number);
    if (!r1) throw new Error(`no request for ${a1.number}`);
    await v.api("POST", `/api/requests/${r1.id}/confirm`, { lead: t1.id, assistants: [] });
    const jobs = await v.api("GET", "/api/bookings?limit=100"), j1 = (Array.isArray(jobs) ? jobs : jobs.items ?? []).find((b) => b.number === a1.number);
    // customer B: booked on the website, not linked yet (clip 02 links it)
    const B = { name: "អតិថិជន ថ្មី", phone: "012000202", sub: await sub(2) };
    const b1 = await book(visitor, `${el.id}:1`, at(days[0], "14:00"), B.name, B.phone);
    return {
      tz: DAY_TZ, time, tech: "សាកល្បង", hint: link.hint ?? link.after ?? null, freeDay: days[2].date, bookDay: days[3].date,
      A: { ...A, pw: A.pw }, A1: { number: a1.number, when: kmWhen(at(days[0], "09:00"), DAY_TZ), service: j1?.service_text ?? "លាងម៉ាស៊ីនត្រជាក់ ×2" }, A2: { number: a2.number },
      B: { ...B, ref: b1.ref }, Q: { sub: await sub(4) },
      wall: await v.picture("wall.jpg", WALL), pipe: await v.picture("pipe.jpg", PIPE),
    };
  },
  videos: [
    clip("L5-00_overview_v1", async (v, d) => {
      await chatSoFar(v, d);
      await v.loginCustomer(d.A.phone, d.A.pw);
      await browser(v, "/", "#cats");
    }, async (v, d, u) => {
      const { A, T } = u;
      await v.chapter("១ · កក់តាមគេហទំព័រ");
      await v.caption("ជ្រើសសេវា\nរួចជ្រើសម៉ោងដែលជាងទំនេរ"); await v.tap(T('#cats .cat[data-cat="ac"]')); await v.hold(600);
      await v.tap(T("#go")); await v.idle(); await A.locator("#days").waitFor();
      await v.caption("ថ្ងៃ និងម៉ោងទំនេរ\nបង្ហាញភ្លាម"); await v.look(T("#picker"), { zoom: 1.25, after: 1600 });
      await v.caption("ចុងក្រោយ ចុច\n«កក់ និងភ្ជាប់ Telegram»"); await v.hold(2600);
      await v.chapter("២ · Telegram");
      await v.closeApp();
      await v.caption("ក្នុង Telegram៖ ពាក្យសម្ងាត់\nនិងការបញ្ជាក់ពីហាង", "tg"); await v.hold(3600);
      await v.caption("ប៊ូតុងខាងក្រោម\nសម្រាប់ការងារទាំងអស់", "tg"); await v.look(v.tgf.locator("#kb"), { zoom: 1.4, after: 1600 });
      await v.chapter("៣ · តាមដានការកក់");
      await v.caption("ចុច «📍 តាមដានការកក់»", "tg");
      await v.tap(v.tgButton(MENU.track, "kb"), () => miniApp(v, "/my/bookings", "section[data-booking]"));
      await v.caption("ស្ថានភាព ម៉ោង\nនិងឈ្មោះជាង"); await v.look(u.card(d.A1.number).locator(":scope > .hr .pl"), { zoom: 1.6, after: 900 });
      await v.look(u.card(d.A1.number).locator(".bk"), { zoom: 1.5, after: 1200 });
      await v.caption("ស្នើប្ដូរម៉ោង ឬបោះបង់\nបានដោយខ្លួនឯង"); await v.look(u.card(d.A1.number).locator(":scope > .row2"), { zoom: 1.5, after: 1400 });
      await v.chapter("៤ · ស្នើសុំតម្លៃ");
      await v.caption("ការងារធំ? ស្នើសុំតម្លៃ\nជាមួយរូបថត"); await v.tap(T('a.ob[href="/quote"]')); await v.idle(); await A.locator("#add").waitFor();
      await v.look(T("#add"), { zoom: 1.6, after: 1600 });
      await v.chapter("៥ · ដំណឹង");
      await v.closeApp();
      await v.caption("ឈប់ ឬបើកដំណឹងវិញ\nចុច «🔕 ឈប់ទទួលដំណឹង»", "tg"); await v.look(v.tgButton(MENU.stop, "kb"), { zoom: 1.5, after: 1600 });
      await v.caption("វីដេអូខ្លីៗ បង្ហាញការងារនីមួយៗ\nលម្អិត", "tg"); await v.hold(2400);
    }),
    clip("L5-01_book-on-website_v1", async (v) => {
      await browser(v, "/", "#cats");
    }, async (v, d, u) => {
      const { A, T } = u;
      await v.caption("បើកគេហទំព័ររបស់ហាង\nក្នុងទូរស័ព្ទ"); await v.hold(3000);
      await v.caption("ជ្រើសប្រភេទសេវា"); await v.tap(T('#cats .cat[data-cat="ac"]')); await v.hold(500);
      await v.caption("ជ្រើសសេវា និងចំនួន"); await v.look(T("#lines .line").first(), { zoom: 1.4, after: 800 }); await v.tap(T('#lines [data-q="1"]').first(), null, { before: 1200 }); await v.hold(500);
      await v.caption("ចុច «កក់សេវា»"); await v.tap(T("#go")); await v.idle(); await A.locator("#days").waitFor();
      await v.caption("ជ្រើសថ្ងៃ និងម៉ោង\nបង្ហាញតែម៉ោងជាងទំនេរ"); await v.tap(T(`#days .day[data-day="${d.bookDay}"]`), null, { before: 1600 }); await v.hold(400);
      await v.tap(T(".slots:not([hidden]) .slot:not([disabled])").first(), null, { before: 1000 }); await v.hold(500);
      await v.caption("ចុច «ប្រើទីតាំងបច្ចុប្បន្ន»"); await v.tap(T("#gps")); await A.locator("#loc-ok:not([hidden])").waitFor({ timeout: 12_000 }); await v.hold(700);
      await v.caption("អាសយដ្ឋាន — មិនចាំបាច់\nតែជួយជាងរកផ្ទះ"); await v.type(T("#addr"), "ផ្ទះលេខ 15 ផ្លូវសាកល្បង", { before: 1200 });
      await v.caption("ចុច «បន្ត»"); await v.tap(T("#next")); await A.locator("#s3:not([hidden])").waitFor(); await v.hold(500);
      await v.caption("វាយឈ្មោះ\nនិងលេខទូរស័ព្ទ"); await v.type(T("#name"), "ដារ៉ា សាកល្បង", { before: 1200 }); await v.type(T("#phone"), "12 000 203", { before: 700 });
      await v.caption("ពេលចុចប៊ូតុង អ្នកយល់ព្រម\nទទួលដំណឹងពីហាង"); const consent = T("#consent-text"); await v.scrollTo(consent); await v.look(consent, { zoom: 1.4, after: 1800 });
      await v.caption("ចុច «កក់ និងភ្ជាប់ Telegram»"); await v.tap(T("#send"), async () => { await T("#send").click({ noWaitAfter: true }); await v.caption("ទូរស័ព្ទភាគច្រើន បើក Telegram ឯង"); });
      await A.locator('body[data-page="done"]').waitFor({ timeout: 15_000 }); await v.idle(); await v.hold(1200);
      await v.caption("បានផ្ញើ! ម៉ោងនេះរក្សាទុកសម្រាប់អ្នក\nហាងបញ្ជាក់ក្នុង ៣០ នាទី"); await v.look(T(".sum"), { zoom: 1.25, after: 1800 });
      await v.caption("បន្ទាប់៖ ភ្ជាប់ Telegram\nមើលវីដេអូបន្ទាប់"); await v.hold(2600);
    }),
    clip("L5-02_link-telegram-password_v1", async (v, d) => {
      await v.tg("start", true);
      await browser(v, `/book/done/${d.B.ref}`, ".sum");
    }, async (v, d, u) => {
      const { T } = u;
      await v.caption("ការកក់បានផ្ញើ\nរង់ចាំហាងបញ្ជាក់"); await v.look(T(".sum .pl"), { zoom: 1.6, after: 1400 });
      await v.caption("ចុច «បើក Telegram»"); await v.tap(T("#tg-open")); await v.hold(300); await v.closeApp();
      await v.caption("ចុចប៊ូតុង START ខាងក្រោម\nដើម្បីភ្ជាប់", "tg");
      let linkId, hintId;
      await v.tap(v.tgf.locator("#sb button"), async () => {
        const link = await v.internal("/internal/customer-subscribed", { code: tokenOf(v.tme), subscriber_id: d.B.sub });
        d.B.pw = pwOf(link.text);
        await v.tg("start", false); await v.tg("me", "/start"); await v.caption(null); await v.hold(500);
        linkId = await v.tg("bot", blur(link.text)); await v.tg("keyboard", GRID);
        if (link.hint ?? link.after) { await v.hold(500); hintId = await v.tg("bot", link.hint ?? link.after); }
      });
      await v.hold(600);
      await v.caption("✅ ភ្ជាប់រួចរាល់\nពាក្យសម្ងាត់ ៤ ខ្ទង់ នៅទីនេះ", "tg"); await v.look(u.msg(linkId), { zoom: 1.4, after: 1600 });
      await v.caption("ចូលគណនីលើគេហទំព័រ ដោយ\nលេខទូរស័ព្ទ + ពាក្យសម្ងាត់នេះ", "tg"); await v.hold(2600);
      if (hintId) { await v.caption("ប្ដូរជាលេខដែលងាយចាំបាន\nក្នុង «គណនីរបស់ខ្ញុំ»", "tg"); await v.look(u.msg(hintId), { zoom: 1.4, after: 1200 }); }
      await v.caption("ប៊ូតុងខាងក្រោម៖ កក់ · តាមដាន\nប្រូម៉ូសិន · ពាក្យសម្ងាត់ · ដំណឹង", "tg"); await v.look(v.tgf.locator("#kb"), { zoom: 1.4, after: 1800 });
      await v.caption("ចុច «📍 តាមដានការកក់»", "tg");
      await v.tap(v.tgButton(MENU.track, "kb"), async () => { await v.loginCustomer(d.B.phone, d.B.pw); await miniApp(v, "/my/bookings", "section[data-booking]"); });
      await v.caption("ការកក់របស់អ្នក\nនិងស្ថានភាព"); await v.look(T("section[data-booking]").first(), { zoom: 1.3, after: 1800 });
    }),
    clip("L5-03_track-booking_v1", async (v, d) => {
      d.confirmId = await chatSoFar(v, d);
      await v.loginCustomer(d.A.phone, d.A.pw);
    }, async (v, d, u) => {
      const { A } = u;
      await v.caption("ហាងបញ្ជាក់ — ម៉ោង\nនិងឈ្មោះជាង", "tg"); await v.look(u.msg(d.confirmId), { zoom: 1.4, after: 1400 });
      await v.caption("ចុច «📍 តាមដានការកក់»", "tg");
      await v.tap(v.tgf.locator(`#${d.confirmId}k button`), () => miniApp(v, "/my/bookings", "section[data-booking]"));
      const c1 = u.card(d.A1.number);
      await v.caption("ចង់ប្ដូរម៉ោង?\nចុច «ស្នើប្ដូរម៉ោង»"); await v.tap(c1.locator("[data-move]")); await c1.locator(".pk .day").first().waitFor(); await v.hold(400);
      await v.caption("ជ្រើសថ្ងៃ និងម៉ោងថ្មី"); await v.tap(c1.locator(`.pk .day[data-day="${d.freeDay}"]`), null, { before: 1200 }); await v.hold(300);
      const slot = c1.locator(`.pk .slots[data-for="${d.freeDay}"] .slot:not([disabled])`).first();
      d.newAt = await slot.getAttribute("data-at"); await v.tap(slot, null, { before: 900 }); await v.hold(300);
      await v.caption("ចុច «ផ្ញើសំណើប្ដូរម៉ោង»"); await v.tap(c1.locator("[data-move-go]")); await v.idle(); await A.locator(".note").first().waitFor(); await v.hold(400);
      await v.caption("សំណើបានផ្ញើ\nរង់ចាំហាងឆ្លើយ"); await v.look(u.card(d.A1.number).locator(".note"), { zoom: 1.5, after: 1200 });
      const c2 = u.card(d.A2.number);
      await v.caption("មិនត្រូវការទៀត? ចុច «បោះបង់»\nហើយសរសេរមូលហេតុ"); await v.tap(c2.locator("[data-cancel]")); await v.type(c2.locator("textarea"), "មិនទំនេរថ្ងៃនោះ", { before: 800 });
      await v.caption("ចុច «បញ្ជាក់ការបោះបង់»"); await v.tap(c2.locator("[data-cancel-go]")); await v.idle(); await A.locator("section[data-booking]").first().waitFor(); await v.hold(500);
      // the shop agrees to the new time (staff side): the customer is told in Telegram — then the job's own messages, as the bot sends them
      const reqs = await v.api("GET", "/api/requests"), rows = Array.isArray(reqs) ? reqs : reqs.items ?? reqs.requests ?? [];
      const rq = rows.find((r) => r.booking_number === d.A1.number && r.kind !== "booking" && !r.handled_at);
      if (!rq) throw new Error("no reschedule request");
      await v.api("POST", `/api/requests/${rq.id}/approve`, {});
      await v.closeApp();
      const w = kmWhen(d.newAt, d.tz), track = [[{ text: BTN.track, web_app: "track" }]];
      const msg = async (time, text, buttons) => { await v.tgf.evaluate((t) => { window.tg.time = t; }, time); return v.tg("bot", text, buttons); };
      let id = await msg(d.time, TXT.rescheduled(d.A1.number, w), track);
      await v.caption("ហាងយល់ព្រម — ម៉ោងថ្មី\nមកក្នុង Telegram", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1200 });
      id = await msg("17:00", TXT.reminder(w.time, d.A1.service, d.tech), track);
      await v.caption("មួយថ្ងៃមុន៖ ការរំលឹក", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1000 });
      id = await msg(hhmm(d.newAt, -40, d.tz), TXT.onTheWay(d.tech), track);
      await v.caption("ថ្ងៃធ្វើការ៖ ជាងកំពុងមក", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1000 });
      id = await msg(hhmm(d.newAt, 135, d.tz), TXT.done(d.A1.number, warrantyEnd(d.newAt, d.tz)), [[{ text: BTN.again }]]);
      await v.caption("ការងាររួចរាល់\nនិងការធានា ៣០ ថ្ងៃ", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1400 });
    }),
    clip("L5-04_quote-with-photos_v1", async (v) => {
      await v.tg("start", true);
      await browser(v, "/", "#cats");
    }, async (v, d, u) => {
      const { A, T } = u;
      await v.caption("ការងារធំ ឬមិនច្បាស់តម្លៃ?\nស្នើសុំតម្លៃ"); await v.tap(T('#cats .cat[data-cat="construction"]')); await v.hold(500);
      await v.caption("ចុច «ស្នើសុំតម្លៃ»"); await v.tap(T("#go")); await v.idle(); await A.locator("#add").waitFor();
      await v.caption("ពិពណ៌នាការងារ"); await v.type(T("#desc"), "ជញ្ជាំងបន្ទប់ទឹកសើម ទុយោលេចទឹក", { before: 1200 });
      await v.caption("ចុច «បន្ថែម» ដាក់រូបថត\nបានដល់ ៥ សន្លឹក");
      await v.tap(T("#add"), () => A.locator("#file").setInputFiles([d.wall, d.pipe])); await A.locator("#photos .pt").nth(1).waitFor({ timeout: 10_000 }); await v.hold(900);
      await v.caption("វាយឈ្មោះ\nនិងលេខទូរស័ព្ទ"); await v.type(T("#name"), "ចាន់ថា សាកល្បង", { before: 1200 }); await v.type(T("#phone"), "012 000 204", { before: 700 });
      await v.caption("ទីតាំង៖ ចុច 📍\nឬសរសេរអាសយដ្ឋាន"); await v.tap(T("#gps")); await A.locator("#loc-ok:not([hidden])").waitFor({ timeout: 12_000 }); await v.hold(700);
      await v.caption("ចុច «ផ្ញើ និងភ្ជាប់ Telegram»"); await v.tap(T("#send"));
      await A.locator('body[data-page="done"]').waitFor({ timeout: 20_000 }); await v.idle(); await v.hold(400);
      await v.caption("បានផ្ញើ! ហាងនឹងមើលរូបថត\nហើយទាក់ទងអ្នកវិញ"); await v.look(T(".ok"), { zoom: 1.3, after: 1600 });
      await v.closeApp();
      await v.caption("ក្នុង Telegram\nចុចប៊ូតុង START ខាងក្រោម", "tg");
      let id;
      await v.tap(v.tgf.locator("#sb button"), async () => {
        const link = await v.internal("/internal/customer-subscribed", { code: tokenOf(v.tme), subscriber_id: d.Q.sub });
        await v.tg("start", false); await v.tg("me", "/start"); await v.caption(null); await v.hold(500);
        id = await v.tg("bot", blur(link.text)); await v.tg("keyboard", GRID);
        if (link.hint ?? link.after) { await v.hold(500); await v.tg("bot", link.hint ?? link.after); }
      });
      await v.hold(600);
      await v.caption("✅ សំណើតម្លៃបានទទួល\nនិងពាក្យសម្ងាត់ចូលគណនី", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1800 });
    }),
    clip("L5-05_forgot-change-password_v1", async (v, d) => {
      await chatSoFar(v, d);
      await browser(v, "/my/login", "#login");
    }, async (v, d, u) => {
      const { A, T } = u;
      await v.caption("ភ្លេចពាក្យសម្ងាត់? ចុចទីនេះ\nពាក្យថ្មី មកពី Telegram"); await v.tap(T("#forgot")); await v.hold(300); await v.closeApp();
      await v.caption("ចុច «🔑 កំណត់ពាក្យសម្ងាត់ថ្មី»", "tg");
      let id, hintId;
      await v.tap(v.tgButton(MENU.password, "kb"), async () => {
        // the bot gives a new 4-digit password (here a fixed one, set through the customer's own account — the screen blurs it)
        const next = "4739", s = await v.session(null);
        await s.call("POST", "/api/public/login", { phone: d.A.phone, password: d.A.pw });
        await s.call("POST", "/api/my/password", { current: d.A.pw, next }); d.A.pw = next;
        await v.tg("me", MENU.password); await v.hold(700);
        id = await v.tg("bot", blur(TXT.newPassword(next)), [[{ text: BTN.login, url: "login" }]]);
        if (d.hint) { await v.hold(500); hintId = await v.tg("bot", d.hint); }
      });
      await v.hold(500);
      await v.caption("ពាក្យសម្ងាត់ថ្មី ៤ ខ្ទង់\nពាក្យចាស់លែងប្រើបាន", "tg"); await v.look(u.msg(id), { zoom: 1.4, after: 1200 });
      if (hintId) { await v.caption("ប្ដូរជាលេខដែលងាយចាំបាន\nក្នុង «គណនីរបស់ខ្ញុំ»", "tg"); await v.look(u.msg(hintId), { zoom: 1.4, after: 1000 }); }
      await v.caption("ចុច «ចូលគណនី»", "tg");
      await v.tap(v.tgf.locator(`#${id}k button`), () => browser(v, "/my/login?next=%2Fmy", "#login"));
      await v.caption("វាយលេខទូរស័ព្ទ + ពាក្យថ្មី\nហើយចុច «ចូល»"); await v.type(T("#phone"), d.A.typed, { before: 1000 }); await v.type(T("#pw"), d.A.pw, { before: 600 });
      await v.tap(T("#login"), null, { before: 800 }); await A.locator('body[data-page="my"]').waitFor({ timeout: 15_000 }); await v.idle(); await v.hold(300);
      // «គណនីរបស់ខ្ញុំ» → «ប្ដូរពាក្យសម្ងាត់»: a number easy to remember (the birthday / phone hint is on this form)
      const open = T("#pw-open"), easy = "2580";
      await v.caption("ចូលរួចរាល់! ចង់បានលេខងាយចាំ?\nចុច «ប្ដូរពាក្យសម្ងាត់»"); await v.scrollTo(open); await v.tap(open); await A.locator("#pw-card:not([hidden])").waitFor(); await v.hold(300);
      await v.caption("វាយពាក្យបច្ចុប្បន្ន\nនិងលេខថ្មីដែលងាយចាំ"); await v.type(T("#pw-cur"), d.A.pw, { before: 1000 }); await v.type(T("#pw-new"), easy, { before: 600 });
      await v.caption("កុំប្រើថ្ងៃកំណើត\nឬលេខ៤ខ្ទង់ចុងទូរស័ព្ទ"); await v.look(T("#pw-card .hint"), { zoom: 1.5, after: 1000 });
      await v.caption("ចុច «រក្សាទុក»"); await v.tap(T("#pw-save")); await A.locator("#pw-ok:not([hidden])").waitFor({ timeout: 10_000 }); d.A.pw = easy; await v.hold(400);
      await v.caption("បានប្ដូរពាក្យសម្ងាត់ ✓"); await v.look(T("#pw-ok"), { zoom: 1.3, after: 1400 });
    }),
    clip("L5-06_notifications_v1", async (v, d) => {
      await chatSoFar(v, d);
      await v.loginCustomer(d.A.phone, d.A.pw);
      await v.bar("web"); await v.preloadApp("/my"); await v.app.locator("#settings").waitFor({ timeout: 20_000 });
    }, async (v, d, u) => {
      const { A, T } = u;
      const prefs = async (promo) => { const s = await v.session(null); await s.call("POST", "/api/public/login", { phone: d.A.phone, password: d.A.pw }); await s.call("POST", "/api/my/prefs", { service: true, promo }); };
      const promoId = await v.tg("bot", TXT.promo("ឧទាហរណ៍៖ ប្រូម៉ូសិនពីហាង មកដល់ទីនេះ"), [[{ text: BTN.stopPromo }]]);
      await v.caption("ប្រូម៉ូសិនពីហាង\nមកក្នុង Telegram", "tg"); await v.look(u.msg(promoId), { zoom: 1.4, after: 1400 });
      await v.caption("មិនចង់បាន?\nចុច «ឈប់ទទួលប្រូម៉ូសិន»", "tg");
      await v.tap(v.tgf.locator(`#${promoId}k button`), async () => {
        await prefs(false);
        await v.tg("edit", promoId, TXT.promo("ឧទាហរណ៍៖ ប្រូម៉ូសិនពីហាង មកដល់ទីនេះ"), []); await v.hold(400);
        await v.tg("bot", TXT.unsubscribedPromo, [[{ text: BTN.resume }]]);
      });
      await v.caption("ដំណឹងការកក់\nនៅតែមកដល់ដដែល", "tg"); await v.hold(3000);
      await v.caption("ឬចុច «🔕 ឈប់ទទួលដំណឹង»", "tg");
      let menuId;
      await v.tap(v.tgButton(MENU.stop, "kb"), async () => { await v.tg("me", MENU.stop); await v.hold(600); menuId = await v.tg("bot", TXT.stopAskPromoOff, [[{ text: BTN.stopAll }], [{ text: BTN.resumePromo }], [{ text: BTN.cancel }]]); });
      await v.caption("ឈប់ទាំងអស់\nឬបើកប្រូម៉ូសិនវិញ", "tg");
      await v.tap(v.tgf.locator(`#${menuId}k button`, { hasText: BTN.resumePromo }), async () => { await prefs(true); await v.tg("edit", menuId, TXT.resumedPromo, []); });
      await v.caption("បើកវិញ បានគ្រប់ពេល", "tg"); await v.hold(3000);
      await v.caption("ឬនៅលើគេហទំព័រ\n«គណនីរបស់ខ្ញុំ»"); await v.app.locator("#settings").evaluate((el) => el.scrollIntoView({ block: "center" })); await v.openApp(); await v.hold(800);
      await v.caption("បិទ ឬបើក ដំណឹង\nនិងប្រូម៉ូសិន"); await v.hold(1600);
      await v.tap(A.locator("label.sw", { has: A.locator("#n-promo") }).locator("i"), null, { before: 1000 }); await A.locator("#n-ok:not([hidden])").waitFor({ timeout: 10_000 }); await v.hold(500);
      await v.caption("បានរក្សាទុក ✓\nប្រូម៉ូសិនបិទ · ដំណឹងការកក់នៅបើក"); await v.hold(2600);
    }),
  ],
};
