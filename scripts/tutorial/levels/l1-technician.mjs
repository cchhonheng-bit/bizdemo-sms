// Level 1 — the technician's day, as built: the bot → «📋 ការងារថ្ងៃនេះ» → the job (customer, address, time, service) → «🗺 ផ្លូវទៅ»
// (map) → «📱 មើលក្នុងកម្មវិធី» → the app's job page: depart → arrive (check-in, GPS) → photo before → start → done → photo after →
// the customer signs → send the report → «រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ». Demo data only, fake names; the bot texts are the demo
// instance's own answers (= the live code). Captions: Khmer, short, at most 2 lines, button names exactly as on screen.
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

export default {
  name: "L1_Technician_v1",
  async setup(v) {
    const pw = v.password();
    const tech = await v.api("POST", "/api/users", { username: "jang_demo", full_name: "ជាង សាកល្បង", role: "tech", phone: "012000111", password: pw });
    await v.loginStaff("jang_demo", pw);
    const cust = await v.api("POST", "/api/customers", { name: "អតិថិជនសាកល្បង", phones: ["012345678"], address: ADDRESS, zone: "outside", ...LOC });
    const at = new Date(), next = new Date(at);
    next.setMinutes(0, 0, 0); next.setHours(next.getHours() + 1);
    if (next - at < 30 * 60_000) next.setHours(next.getHours() + 1);
    if (next.toDateString() !== at.toDateString()) throw new Error("record before 22:00 — the job must be today");
    const bk = await v.api("POST", "/api/bookings", { customer_id: cust.id, type: "A", category: "mep", service_text: "លាងម៉ាស៊ីនត្រជាក់ ×2 · ពិនិត្យហ្គាស", scheduled_at: next.toISOString(), address: ADDRESS, zone: "outside", ...LOC });
    await v.api("POST", `/api/bookings/${bk.id}/assign`, { lead: tech.id, assistants: [] });
    await v.sql(`update users set telegram_chat_id = ${CHAT}, telegram_user_id = ${CHAT} where username = 'jang_demo'`);
    const who = { chat_id: CHAT, tg_user: CHAT, subscriber_id: null };
    const home = await v.internal("/internal/tg-start", who), list = await v.internal("/internal/tg-text", { ...who, text: "📋 ការងារថ្ងៃនេះ" });
    const job = (await v.internal("/internal/tg-menu", { chat_id: CHAT, view: "job", id: bk.id, arg: "today" })).menu;
    // the demo runs on http, where the code leaves out its app links; the live shop (https) shows them — same labels as the code
    const H = home.menu ?? home, Lst = list.menu ?? list, has = (m, t) => m.buttons.flat().some((b) => b.text === t);
    if (!has(H, "📱 បើកកម្មវិធី")) H.buttons.splice(1, 0, [{ text: "📱 បើកកម្មវិធី", url: "app" }]);
    if (!has(job, "📱 មើលក្នុងកម្មវិធី")) job.buttons.splice(job.buttons.length - 1, 0, [{ text: "📱 មើលក្នុងកម្មវិធី", url: "app" }]);
    return { bk, home: H, list: Lst, job, jobLabel: Lst.buttons[0][0].text, before: await v.picture("before.jpg", AC(true)), after: await v.picture("after.jpg", AC(false)),
      map: `https://maps.google.com/maps?q=${LOC.lat},${LOC.lng}&z=16&output=embed`,
      time: new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Phnom_Penh", hour: "2-digit", minute: "2-digit" }).format(at) };
  },
  async prepare(v, d) {
    await v.tgf.evaluate((t) => { window.tg.time = t; }, d.time);
    await v.tg("keyboard", d.home.keyboard);
    await v.tg("bot", d.home.text, d.home.buttons);
    await v.map(false, d.map);
    await v.preloadApp(`/app/tech/job/${d.bk.id}`);
    await v.app.locator('[data-testid="cp-next"]').waitFor({ timeout: 20_000 });
  },
  async play(v, d) {
    await v.hold(2000); await v.card(false);                                        // intro: One Team × HangKH
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
    const next = v.app.locator('[data-testid="cp-next"]');
    const step = async (text) => { await v.caption(text); await v.scrollTo(next); await v.tap(next); await v.idle(); await v.hold(500); };
    const photo = async (kind, text, file) => {
      const input = v.app.locator(`[data-testid="photo-${kind}"]`), label = input.locator("xpath=..");
      await v.caption(text); await v.scrollTo(label); await v.tap(label, () => input.setInputFiles(file)); await v.idle(); await v.hold(900);
    };
    await step("ពេលចេញដំណើរ ចុច\n«🚐 ចេញពីការិយាល័យឥឡូវ»");
    await step("ដល់ផ្ទះអតិថិជន ចុច\n«📍 ខ្ញុំដល់ទីតាំងហើយ»");
    await photo("before", "ថតរូបមុនពេលធ្វើការ", d.before);
    await step("ចុច «🔧 ចាប់ផ្តើមការងារ»");
    await step("ធ្វើការរួច ចុច\n«✅ ការងាររួចរាល់»");
    await photo("after", "ថតរូបក្រោយពេលធ្វើការ", d.after);
    const pad = v.app.locator('[data-testid="signature"]');
    await v.caption("ឲ្យអតិថិជនចុះហត្ថលេខា"); await v.scrollTo(pad); await v.hold(1200); await v.draw(pad, SIGN); await v.hold(1200);
    const send = v.app.locator('[data-testid="report-submit"]');
    await v.caption("ចុច «ផ្ញើរបាយការណ៍»"); await v.scrollTo(send); await v.tap(send); await v.idle(); await v.hold(1200);
    await v.caption("រួចរាល់! អ្នកគ្រប់គ្រងនឹងពិនិត្យ"); await v.scrollTo(v.app.getByText("រង់ចាំអ្នកគ្រប់គ្រងពិនិត្យ").first()); await v.hold(3000);
    await v.caption(null); await v.card(true); await v.hold(2000);                  // outro
  },
};
