// Level 1 — the technician's day, as built (vertical): overview (approved) + clips · today's jobs · directions + check-in at the
// customer · the 4 job steps + photos · finish the job (signature, report, the manager's check, back at the office)
// → Doc_Sup/09_Tutorials/Technician/. The bot → «📋 ការងារថ្ងៃនេះ» → the job → «🗺 ផ្លូវទៅ» (map) → «📱 មើលក្នុងកម្មវិធី» → the
// app's job page. Demo data only, fake names; the bot texts are the demo instance's own answers (= the live code). Each clip has
// its own demo job, so any clip can be re-recorded alone. Captions: Khmer, short, at most 2 lines, button names exactly as on screen.
import { readFileSync } from "node:fs";

const LOC = { lat: 11.5564, lng: 104.9282 }, ADDRESS = "ផ្ទះលេខ 12 ផ្លូវសាកល្បង ភ្នំពេញ", CHAT = 700100;
const SIGN = [[[0.13, 0.4], [0.17, 0.27], [0.25, 0.25], [0.27, 0.36], [0.2, 0.48], [0.14, 0.58], [0.15, 0.69], [0.23, 0.72], [0.31, 0.63]],
  [[0.35, 0.56], [0.39, 0.47], [0.45, 0.49], [0.45, 0.6], [0.39, 0.64], [0.36, 0.57], [0.43, 0.55], [0.5, 0.53], [0.54, 0.27], [0.56, 0.68], [0.58, 0.52], [0.65, 0.45], [0.61, 0.58], [0.7, 0.66], [0.8, 0.57], [0.86, 0.5]],
  [[0.15, 0.82], [0.5, 0.78], [0.84, 0.74]]];
/** a demo «photo»: an air conditioner on a wall — dusty before, clean after (drawn, not a customer's photo) */
const AC = (dusty) => `<body style="margin:0;width:800px;height:600px;display:grid;place-items:center;background:linear-gradient(160deg,#EFE8DC,#D8CDBB)">
<div style="position:relative;width:580px;height:200px;border-radius:28px;background:linear-gradient(#FFFFFF,#ECEEF0);box-shadow:0 22px 44px rgba(60,40,20,.28)">
<div style="position:absolute;left:40px;right:40px;bottom:36px;height:26px;border-radius:13px;background:repeating-linear-gradient(90deg,#BFC5CC 0 12px,#E3E6EA 12px 20px)"></div>
<div style="position:absolute;right:46px;top:34px;width:16px;height:16px;border-radius:50%;background:${dusty ? "#E0A11B" : "#22B573"}"></div>
${dusty ? '<div style="position:absolute;inset:0;border-radius:28px;background:radial-gradient(circle at 20% 70%,rgba(120,90,50,.45) 0 60px,transparent 61px),radial-gradient(circle at 62% 80%,rgba(110,85,50,.4) 0 80px,transparent 81px),radial-gradient(circle at 85% 30%,rgba(120,95,60,.35) 0 50px,transparent 51px);filter:blur(6px)"></div>' : '<div style="position:absolute;right:-30px;top:-46px;font-size:64px">✨</div>'}
</div></body>`;

const clip = (name, prepare, play) => ({
  name, folder: "Technician", prepare,
  async play(v, d) {
    await v.hold(2000); await v.card(false);                                        // intro: One Team × HangKH
    await play(v, d);
    await v.caption(null); await v.card(true); await v.hold(2000);                  // outro
  },
});
/** the chat as the technician sees it when the clip starts: the time, the role keyboard, the bot's home message */
async function chat(v, d) {
  await v.tgf.evaluate((t) => { window.tg.time = t; }, d.time);
  await v.tg("keyboard", d.home.keyboard);
  return v.tg("bot", d.home.text, d.home.buttons);
}
/** the app's job page: press the next step (one caption), add a photo */
const steps = (v) => {
  const next = v.app.locator('[data-testid="cp-next"]');
  return {
    next,
    step: async (text) => { await v.caption(text); await v.scrollTo(next); await v.tap(next); await v.idle(); await v.hold(500); },
    photo: async (kind, text, file) => {
      const input = v.app.locator(`[data-testid="photo-${kind}"]`), label = input.locator("xpath=..");
      await v.caption(text); await v.scrollTo(label); await v.tap(label, () => input.setInputFiles(file)); await v.idle(); await v.hold(900);
    },
  };
};

export default {
  name: "L1_Technician",
  async setup(v) {
    const pw = v.password();
    const tech = await v.api("POST", "/api/users", { username: "jang_demo", full_name: "ជាង សាកល្បង", role: "tech", phone: "012000111", password: pw });
    const techPw = await v.loginStaff("jang_demo", pw);
    const at = new Date(), next = new Date(at);
    next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    if (next - at < 30 * 60_000) next.setHours(next.getHours() + 1);
    const hour = (h) => new Date(next.getTime() + h * 3_600_000);
    if (hour(6.75).toDateString() !== at.toDateString()) throw new Error("record before ~15:00 — today's four jobs (2¼ h apart, 2 h each) must fit in the day");
    // today's jobs: the overview's (and «today's jobs»), one for directions + check-in, one for the 4 steps, one ready to finish
    const job = async (name, phone, h, service) => {
      const c = await v.api("POST", "/api/customers", { name, phones: [phone], address: ADDRESS, zone: "outside", ...LOC });
      const b = await v.api("POST", "/api/bookings", { customer_id: c.id, type: "A", category: "mep", service_text: service, scheduled_at: hour(h).toISOString(), address: ADDRESS, zone: "outside", ...LOC });
      await v.api("POST", `/api/bookings/${b.id}/assign`, { lead: tech.id, assistants: [] });
      return b;
    };
    const bk = await job("អតិថិជនសាកល្បង", "012345678", 0, "លាងម៉ាស៊ីនត្រជាក់ ×2 · ពិនិត្យហ្គាស");
    const bk2 = await job("អតិថិជនសាកល្បង ២", "012345679", 2.25, "ជួសជុលភ្លើង");
    const bk3 = await job("អតិថិជនសាកល្បង ៣", "012345680", 4.5, "លាងម៉ាស៊ីនត្រជាក់");
    const bk4 = await job("អតិថិជនសាកល្បង ៤", "012345681", 6.75, "ជួសជុលម៉ាស៊ីនត្រជាក់");
    const before = await v.picture("before.jpg", AC(true)), after = await v.picture("after.jpg", AC(false));
    // the job to finish: its four steps pressed and its photos added by the technician already
    const t = await v.session("jang_demo", techPw);
    const press = (step) => t.call("POST", `/api/bookings/${bk4.id}/checkpoint`, { step, at: new Date().toISOString(), ...LOC, accuracy: 10, no_gps: false, offline: false });
    const photo = (kind, file) => t.call("POST", `/api/bookings/${bk4.id}/photos`, { kind, data: readFileSync(file).toString("base64") });
    await press("depart"); await press("arrive"); await photo("before", before); await press("start"); await press("finish"); await photo("after", after);
    await v.sql(`update users set telegram_chat_id = ${CHAT}, telegram_user_id = ${CHAT} where username = 'jang_demo'`);
    const who = { chat_id: CHAT, tg_user: CHAT, subscriber_id: null };
    const home = await v.internal("/internal/tg-start", who), list = await v.internal("/internal/tg-text", { ...who, text: "📋 ការងារថ្ងៃនេះ" });
    const menu = async (id) => (await v.internal("/internal/tg-menu", { chat_id: CHAT, view: "job", id, arg: "today" })).menu;
    const jobMenu = await menu(bk.id), job2 = await menu(bk2.id);
    // the demo runs on http, where the code leaves out its app links; the live shop (https) shows them — same labels as the code
    const H = home.menu ?? home, Lst = list.menu ?? list, has = (m, x) => m.buttons.flat().some((b) => b.text === x);
    if (!has(H, "📱 បើកកម្មវិធី")) H.buttons.splice(1, 0, [{ text: "📱 បើកកម្មវិធី", url: "app" }]);
    for (const m of [jobMenu, job2]) if (!has(m, "📱 មើលក្នុងកម្មវិធី")) m.buttons.splice(m.buttons.length - 1, 0, [{ text: "📱 មើលក្នុងកម្មវិធី", url: "app" }]);
    return { bk, bk2, bk3, bk4, home: H, list: Lst, job: jobMenu, job2, jobLabel: Lst.buttons[0][0].text, before, after,
      map: `https://maps.google.com/maps?q=${LOC.lat},${LOC.lng}&z=16&output=embed`,
      time: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit" }).format(at) };
  },
  videos: [
    // approved 03-10 — kept as it was
    clip("L1-00_overview_v1", async (v, d) => {
      await chat(v, d);
      await v.map(false, d.map);
      await v.preloadApp(`/app/tech/job/${d.bk.id}`);
      await v.app.locator('[data-testid="cp-next"]').waitFor({ timeout: 20_000 });
    }, async (v, d) => {
      await v.caption("បើក bot របស់ហាង", "tg"); await v.hold(3000);
      await v.caption("ចុច «📋 ការងារថ្ងៃនេះ»", "tg");
      let listId;
      await v.tap(v.tgButton("📋 ការងារថ្ងៃនេះ", "kb"), async () => { await v.tg("me", "📋 ការងារថ្ងៃនេះ"); await v.hold(800); listId = await v.tg("bot", d.list.text, d.list.buttons); });
      await v.hold(900);
      await v.caption("ជ្រើសការងាររបស់អ្នក", "tg");
      await v.tap(v.tgButton(d.jobLabel), async () => { await v.hold(350); await v.tg("edit", listId, d.job.text, d.job.buttons); });
      await v.hold(700);
      await v.caption("មើលអតិថិជន អាសយដ្ឋាន\nម៉ោង និងសេវា", "tg"); await v.hold(3600);
      await v.caption("ចុច «🗺 ផ្លូវទៅ»", "tg");
      await v.tap(v.tgButton("🗺 ផ្លូវទៅ"), () => v.map(true));
      await v.caption("ផែនទីបង្ហាញផ្លូវ\nទៅផ្ទះអតិថិជន"); await v.hold(3200);
      await v.caption(null); await v.map(false);
      await v.caption("ចុច «📱 មើលក្នុងកម្មវិធី»", "tg");
      await v.tap(v.tgButton("📱 មើលក្នុងកម្មវិធី"), () => v.openApp());
      await v.hold(800);
      // the app's job page — the 4 steps (the 5th, «🏁 ត្រឡប់ / រួចរាល់», is left out like in the bot), photos, signature, report
      const { next, step, photo } = steps(v);
      await step("ពេលចេញដំណើរ ចុច\n«🚐 ចេញពីការិយាល័យឥឡូវ»");
      await step("ដល់ផ្ទះអតិថិជន ចុច\n«📍 ខ្ញុំដល់ទីតាំងហើយ»");
      await photo("before", "ថតរូបមុនពេលធ្វើការ", d.before);
      await step("ចុច «🔧 ចាប់ផ្តើមការងារ»");
      await step("ធ្វើការរួច ចុច\n«✅ ការងាររួចរាល់»");
      await photo("after", "ថតរូបក្រោយពេលធ្វើការ", d.after);
      void next;
      const pad = v.app.locator('[data-testid="signature"]');
      await v.caption("ឲ្យអតិថិជនចុះហត្ថលេខា"); await v.scrollTo(pad); await v.hold(1200); await v.draw(pad, SIGN); await v.hold(1200);
      const send = v.app.locator('[data-testid="report-submit"]');
      await v.caption("ចុច «ផ្ញើរបាយការណ៍»"); await v.scrollTo(send); await v.tap(send); await v.idle(); await v.hold(1200);
      await v.caption("រួចរាល់! អ្នកគ្រប់គ្រងនឹងពិនិត្យ"); await v.scrollTo(v.app.getByText("រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ").first()); await v.hold(3000);
    }),
    clip("L1-01_todays-jobs_v1", async (v, d) => {
      await chat(v, d);
      await v.preloadApp("/app/tech");
      await v.app.locator('[data-testid="job-card"]').first().waitFor({ timeout: 20_000 });
    }, async (v, d) => {
      await v.caption("បើក bot របស់ហាង", "tg"); await v.hold(2600);
      await v.caption("ចុច «📋 ការងារថ្ងៃនេះ»", "tg");
      let listId;
      await v.tap(v.tgButton("📋 ការងារថ្ងៃនេះ", "kb"), async () => { await v.tg("me", "📋 ការងារថ្ងៃនេះ"); await v.hold(700); listId = await v.tg("bot", d.list.text, d.list.buttons); });
      await v.hold(600);
      await v.caption("ការងារថ្ងៃនេះ\nតាមលំដាប់ម៉ោង", "tg"); await v.look(v.tgf.locator(`#${listId}k`), { zoom: 1.3, after: 1400 });
      await v.caption("ជ្រើសការងារមួយ", "tg");
      await v.tap(v.tgButton(d.jobLabel), async () => { await v.hold(300); await v.tg("edit", listId, d.job.text, d.job.buttons); });
      await v.hold(500);
      await v.caption("អតិថិជន អាសយដ្ឋាន\nម៉ោង និងសេវា", "tg"); await v.look(v.tgf.locator(`#${listId}`), { zoom: 1.3, after: 1800 });
      await v.caption("ឬក្នុងកម្មវិធី៖\nចុច «📱 បើកកម្មវិធី»", "tg");
      await v.tap(v.tgButton("📱 បើកកម្មវិធី"), () => v.openApp());
      await v.caption("«ថ្ងៃនេះ»៖ ការងារទាំងអស់\nចុចការងារ ដើម្បីបើក"); await v.look(v.app.locator('[data-testid="job-card"]').first(), { zoom: 1.4, after: 1800 });
      await v.caption(null); await v.closeApp();
      await v.caption("ថ្ងៃស្អែក៖ ចុច\n«📅 ការងារថ្ងៃស្អែក»", "tg"); await v.look(v.tgButton("📅 ការងារថ្ងៃស្អែក", "kb"), { zoom: 1.6, after: 1600 });
    }),
    clip("L1-02_directions-check-in_v1", async (v, d) => {
      await chat(v, d);
      await v.tg("bot", d.job2.text, d.job2.buttons);
      await v.map(false, d.map);
      await v.preloadApp(`/app/tech/job/${d.bk2.id}`);
      await v.app.locator('[data-testid="cp-next"]').waitFor({ timeout: 20_000 });
    }, async (v) => {
      await v.caption("ក្នុងការងារ ចុច «🗺 ផ្លូវទៅ»", "tg");
      await v.tap(v.tgButton("🗺 ផ្លូវទៅ"), () => v.map(true));
      await v.caption("ផែនទីបង្ហាញផ្លូវ\nទៅផ្ទះអតិថិជន"); await v.hold(3400);
      await v.caption(null); await v.map(false);
      await v.caption("ចុច «📱 មើលក្នុងកម្មវិធី»", "tg");
      await v.tap(v.tgButton("📱 មើលក្នុងកម្មវិធី"), () => v.openApp());
      await v.hold(600);
      const { step } = steps(v);
      await step("ពេលចេញដំណើរ ចុច\n«🚐 ចេញពីការិយាល័យឥឡូវ»");
      await step("ដល់ផ្ទះអតិថិជន ចុច\n«📍 ខ្ញុំដល់ទីតាំងហើយ»");
      const list = v.app.locator('[data-testid="cp-list"]');
      await v.caption("ម៉ោង និងទីតាំង GPS\nកត់ទុកដោយស្វ័យប្រវត្តិ"); await v.scrollTo(list); await v.look(list, { zoom: 1.4, after: 1800 });
      await v.caption("បើក GPS នៅលើទូរស័ព្ទ\nពេលចុចប៊ូតុង"); await v.hold(2600);
    }),
    clip("L1-03_job-steps-photos_v1", async (v, d) => {
      await v.tgf.evaluate((t) => { window.tg.time = t; }, d.time);
      await v.preloadApp(`/app/tech/job/${d.bk3.id}`); await v.openApp();
      await v.app.locator('[data-testid="cp-next"]').waitFor({ timeout: 20_000 });
      // a phone with a GPS fix: the position at once (headless, the browser's own location timed out — 12 s on every step)
      await v.app.evaluate((p) => { navigator.geolocation.getCurrentPosition = (ok) => setTimeout(() => ok({ coords: { latitude: p.lat, longitude: p.lng, accuracy: 8 }, timestamp: Date.now() }), 300); }, LOC);
    }, async (v, d) => {
      const { step, photo } = steps(v);
      await v.caption("ការងារមាន ៤ ជំហាន\nចុចតាមលំដាប់"); await v.look(v.app.locator('[data-testid="cp-list"]'), { zoom: 1.3, after: 1400 });
      await step("១ · ចេញដំណើរ៖\n«🚐 ចេញពីការិយាល័យឥឡូវ»");
      await step("២ · ដល់ហើយ៖\n«📍 ខ្ញុំដល់ទីតាំងហើយ»");
      await photo("before", "ថតរូបមុនពេលធ្វើការ\nបង្ហាញស្ថានភាពដើម", d.before);
      await step("៣ · «🔧 ចាប់ផ្តើមការងារ»");
      await step("៤ · ធ្វើរួច៖\n«✅ ការងាររួចរាល់»");
      await photo("after", "ថតរូបក្រោយពេលធ្វើការ", d.after);
      await v.caption("រូបមុន និងក្រោយ\nអ្នកគ្រប់គ្រងនឹងមើល"); await v.hold(2600);
    }),
    clip("L1-04_finish-job_v1", async (v, d) => {
      await v.tgf.evaluate((t) => { window.tg.time = t; }, d.time);
      await v.preloadApp(`/app/tech/job/${d.bk4.id}`); await v.openApp();
      await v.app.locator('[data-testid="signature"]').waitFor({ timeout: 20_000 });
    }, async (v, d) => {
      const pad = v.app.locator('[data-testid="signature"]');
      await v.caption("ការងាររួច រូបថតរួច\nនៅសល់តែហត្ថលេខា"); await v.hold(2600);
      await v.caption("ឲ្យអតិថិជនចុះហត្ថលេខា\nលើអេក្រង់"); await v.scrollTo(pad); await v.hold(1000); await v.draw(pad, SIGN); await v.hold(1000);
      const send = v.app.locator('[data-testid="report-submit"]');
      await v.caption("ចុច «ផ្ញើរបាយការណ៍»"); await v.scrollTo(send); await v.tap(send); await v.idle(); await v.hold(1000);
      await v.caption("រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ"); await v.scrollTo(v.app.getByText("រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ").first()); await v.hold(2600);
      const { step } = steps(v);
      await step("ត្រឡប់ដល់ការិយាល័យ ចុច\n«🏁 ត្រឡប់ / រួចរាល់»");
      // the manager checks the report (staff side) — the page shows it
      await v.api("POST", `/api/bookings/${d.bk4.id}/review`, { decision: "approve", note: "" });
      await v.app.goto(`${v.base}/app/tech/job/${d.bk4.id}`); await v.app.getByText("អ្នកគ្រប់គ្រងពិនិត្យ៖ ត្រឹមត្រូវ").first().waitFor({ timeout: 20_000 }); await v.hold(400);
      await v.caption("អ្នកគ្រប់គ្រងពិនិត្យ៖ ត្រឹមត្រូវ\nការងារបានបញ្ចប់"); await v.scrollTo(v.app.getByText("អ្នកគ្រប់គ្រងពិនិត្យ៖ ត្រឹមត្រូវ").first()); await v.hold(2800);
    }),
  ],
};
