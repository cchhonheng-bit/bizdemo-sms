// Level 3 — CEO / CFO in the staff app on a desktop (1920×1080), as built: the overview + reports · website settings · test phone
// numbers · staff and roles · audit log → Doc_Sup/09_Tutorials/CEO_CFO/L3-<nn>_<feature>_v1.mp4. Demo data only, fake names: three
// jobs finished today (real step times, photos, report, GM approval), invoiced and paid (cash $ · ABA · cash ៛ in part), one
// cancelled job, the day's cash counted by the Admin — so the reports show real numbers. The browser is a demo CEO.
// Not built live (told in the report): a screen to change what each role may do — the roles' rights are fixed in the code.
const ADDR = "ផ្ទះលេខ 8 ផ្លូវសាកល្បង ភ្នំពេញ", AT = { lat: 11.56, lng: 104.92 };
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="; // 1×1 photo / signature
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const WORK_PHOTO = `<body style="margin:0;width:800px;height:600px;display:grid;place-items:center;background:linear-gradient(160deg,#DDEBF5,#B9D3E6)">
<div style="position:relative;width:560px;height:190px;border-radius:28px;background:linear-gradient(#FFFFFF,#ECEEF0);box-shadow:0 22px 44px rgba(20,40,60,.28)">
<div style="position:absolute;left:40px;right:40px;bottom:34px;height:26px;border-radius:13px;background:repeating-linear-gradient(90deg,#BFC5CC 0 12px,#E3E6EA 12px 20px)"></div>
<div style="position:absolute;right:46px;top:32px;width:16px;height:16px;border-radius:50%;background:#22B573"></div>
<div style="position:absolute;right:-26px;top:-44px;font-size:62px">✨</div></div></body>`;

const ui = (v) => {
  const A = v.app;
  return {
    A, next: { before: 1000 },
    nav: (path) => A.locator(`aside nav a[href="/app/${path}"]`), // the sidebar (some words repeat on the pages)
    dlg: () => A.locator('[role="dialog"]').last(),
    T: (id) => A.locator(`[data-testid="${id}"]`),
    tab: (name) => A.getByRole("tab", { name, exact: true }),
    preset: (name) => A.getByRole("button", { name, exact: true }),
    card: (text) => A.locator("section", { hasText: text }).last(),
  };
};
const clip = (name, play) => ({
  name, folder: "CEO_CFO",
  async prepare(v) {
    await v.preloadApp("/app/dashboard");
    await v.app.locator('aside nav a[href="/app/reports"]').waitFor({ timeout: 20_000 });
    await v.idle(3000);
  },
  async play(v, d) {
    await v.hold(2000); await v.card(false);                              // intro
    await play(v, d, ui(v));
    await v.caption(null); await v.card(true); await v.hold(2000);       // outro
  },
});

export default {
  name: "L3_CEO_CFO",
  layout: "desktop",
  size: { w: 1280, h: 720, scale: 1.5 },
  captionSize: 30,
  tapBefore: 1700,
  async setup(v) {
    const user = async (username, full_name, role, phone) => { const p = v.password(); const u = await v.api("POST", "/api/users", { username, full_name, role, phone, password: p }); return { id: u.id, username, p }; };
    const boss = await user("ceo_demo", "នាយកប្រតិបត្តិ សាកល្បង", "ceo", "012000099");
    await user("cfo_demo", "នាយកហិរញ្ញវត្ថុ សាកល្បង", "cfo", "012000098");
    const adm = await user("admin_demo", "រដ្ឋបាល សាកល្បង", "admin", "012000097");
    const gm = await user("gm_demo", "អ្នកគ្រប់គ្រង សាកល្បង", "gm", "012000100");
    const techs = [await user("jang1", "ជាង សាកល្បង ១", "tech", "012000101"), await user("jang2", "ជាង សាកល្បង ២", "tech", "012000102"), await user("jang3", "ជាង សាកល្បង ៣", "tech", "012000103")];
    await user("jang_old", "ជាង ចាស់ សាកល្បង", "tech", "012000104");                 // has left — clip 04 turns the account off
    boss.p = await v.loginStaff(boss.username, boss.p);                                 // the browser = the CEO
    const customer = async (name, phone, zone) => (await v.api("POST", "/api/customers", { name, phones: [phone], address: ADDR, zone, ...AT })).id;
    const gmS = await v.session(gm.username, gm.p), admS = await v.session(adm.username, adm.p);
    // three jobs done today: steps with real times, photos, report, GM approval → invoice issued → paid (cash $ · ABA in part · cash ៛ in part)
    const now = Date.now(), H = 3_600_000, ago = (h) => new Date(now - h * H).toISOString();
    const plan = [
      { name: "អតិថិជន ក", zone: "outside", svc: "លាងម៉ាស៊ីនត្រជាក់", from: 7, price: 4500, pay: { amount: 4500, currency: "usd", method: "cash_usd" } },
      { name: "អតិថិជន ខ", zone: "inside", svc: "ជួសជុលភ្លើង", from: 6, price: 6000, pay: { amount: 2500, currency: "usd", method: "aba" } },
      { name: "អតិថិជន គ", zone: "outside", svc: "ជួសជុលទុយោទឹក", from: 5, price: 3500, pay: { amount: 82000, currency: "khr", method: "cash_khr" } },
    ];
    for (const [i, p] of plan.entries()) {
      const b = await v.api("POST", "/api/bookings", { customer_id: await customer(p.name, `01200001${i}`, p.zone), type: "A", category: "mep", service_text: p.svc, scheduled_at: new Date(now + (i + 1) * H).toISOString(), zone: p.zone, ...AT });
      await v.api("POST", `/api/bookings/${b.id}/assign`, { lead: techs[i].id, assistants: [] });
      const t = await v.session(techs[i].username, techs[i].p);
      const step = (s, h) => t.call("POST", `/api/bookings/${b.id}/checkpoint`, { step: s, at: ago(h), ...AT, accuracy: 10, no_gps: false, offline: false });
      await step("depart", p.from); await step("arrive", p.from - 0.4);
      await t.call("POST", `/api/bookings/${b.id}/photos`, { kind: "before", data: PNG });
      await step("start", p.from - 0.5);
      await t.call("POST", `/api/bookings/${b.id}/photos`, { kind: "after", data: PNG });
      await step("finish", p.from - 2.3);
      await t.call("POST", `/api/bookings/${b.id}/report`, { notes: "រួចរាល់ — អតិថិជនពេញចិត្ត", signature: PNG });
      await gmS.call("POST", `/api/bookings/${b.id}/review`, { decision: "approve", note: "" });
      const inv = await admS.call("POST", "/api/invoices", { booking_id: b.id, lines: [{ description: p.svc, kind: "service", qty: 1, unit: "unit", unit_price: p.price }] });
      await admS.call("POST", `/api/invoices/${inv.id}/issue`);
      await admS.call("POST", `/api/invoices/${inv.id}/payments`, p.pay);
    }
    const c = await v.api("POST", "/api/bookings", { customer_id: await customer("អតិថិជន ឃ", "012000013", "outside"), type: "A", category: "mep", service_text: "លាងម៉ាស៊ីនត្រជាក់", scheduled_at: new Date(now + 5 * H).toISOString(), zone: "outside", ...AT });
    await v.api("POST", `/api/bookings/${c.id}/cancel`, { reason: "អតិថិជនលែងត្រូវការ" });
    // the Admin counted today's cash (2,000 riel short) — the CEO / CFO check it in clip 01
    await admS.call("POST", "/api/reports/cash-close", { day: ymd(new Date()), counted_usd: 4500, counted_khr: 80000, note: "ខ្វះ ២ ០០០ រៀល" });
    // a catalog change by the demo CEO: the catalog says who changed it last (clip 05)
    const bossS = await v.session(boss.username, boss.p);
    await bossS.call("PUT", "/api/settings/test-phones", { phones: [] }); // Settings saved once by the demo CEO → its «last change» line
    await bossS.call("POST", "/api/catalog", { name_km: "ប្រេងម៉ាស៊ីនត្រជាក់", name_en: "AC oil", kind: "product", category: "mep", unit: "ដប", sell_price: 1500 });
    return { photo: await v.picture("work.jpg", WORK_PHOTO) };
  },
  videos: [
    clip("L3-00_overview_v1", async (v, d, { A, nav, T, tab, preset, card }) => {
      await v.chapter("១ · ផ្ទាំងគ្រប់គ្រង");
      await v.caption("ពេលចូល ឃើញលុយថ្ងៃនេះភ្លាម\nចំណូល ប្រាក់ទទួល ប្រាក់ជំពាក់"); await v.look(T("dashboard-panel"), { zoom: 1.25, after: 2200 });
      await v.caption("នាយកហិរញ្ញវត្ថុ ក៏ឃើញផ្ទាំងនេះ\nនិងរបាយការណ៍លុយដូចគ្នា"); await v.hold(1400);
      await v.chapter("២ · របាយការណ៍");
      await v.caption("ចុច «របាយការណ៍»\nហើយជ្រើស «ខែនេះ»"); await v.tap(nav("reports")); await v.idle(); await v.tap(preset("ខែនេះ"), null, { before: 1000 }); await v.idle();
      await v.caption("ចំណូល តាមក្នុង/ក្រៅបុរី\nនិងតាមផ្នែកការងារ"); await v.look(card("ក្រៅបុរី"), { zoom: 1.3, after: 1800 });
      await v.caption("សមិទ្ធផលជាង៖ ការងារ ម៉ោង\nការឲ្យកែ និងការយឺត"); await v.scrollTo(T("tech-perf")); await v.look(T("tech-perf"), { zoom: 1.3, after: 1800 });
      await v.chapter("៣ · កំណត់ហេតុសកម្មភាព");
      await v.caption("អ្នកណា ធ្វើអ្វី ពី → ទៅ ពេលណា\nជាភាសាខ្មែរ មិនអាចលុបបាន"); await v.tap(tab("កំណត់ហេតុសកម្មភាព")); await v.idle(); await v.look(T("audit-row").first(), { zoom: 1.3, after: 1800 });
      await v.chapter("៤ · ការកំណត់");
      await v.caption("ចុច «ការកំណត់»\nឃើញអ្នកកែចុងក្រោយ និងម៉ោង"); await v.tap(nav("settings/company")); await v.idle(); await v.look(T("last-change-settings"), { zoom: 1.6, after: 1200 });
      await v.caption("ចុច «គេហទំព័រ»\nពាក្យ និងរូបរបស់ហាង"); await v.tap(nav("website")); await v.idle(); await v.hold(1400);
      await v.caption("ចុច «អ្នកប្រើ»\nបុគ្គលិក និងតួនាទីរបស់គេ"); await v.tap(nav("settings/users")); await v.idle(); await v.hold(1800);
      await v.caption("វីដេអូខ្លីៗ បង្ហាញការងារនីមួយៗ\nលម្អិត"); await v.hold(2200);
    }),
    clip("L3-01_reports_v1", async (v, d, { A, nav, T, tab, preset, card }) => {
      await v.caption("ចុច «របាយការណ៍»"); await v.tap(nav("reports")); await v.idle();
      await v.caption("ជ្រើស «ខែនេះ»\nឬរើសថ្ងៃ ពី–ដល់"); await v.tap(preset("ខែនេះ")); await v.idle();
      await v.caption("ប្រាក់ទទួល តាមវិធីបង់\nសាច់ប្រាក់ ABA ACLEDA"); await v.look(card("ACLEDA"), { zoom: 1.3, after: 1600 });
      await v.caption("ប្រាក់ជំពាក់ — អតិថិជនមិនទាន់បង់គ្រប់"); await v.look(card("ជំពាក់សរុបឥឡូវ"), { zoom: 1.3, after: 1600 });
      await v.caption("ចុច «ការងារ» ក្នុង «ទាញយក Excel»\nបើកបានក្នុង Excel"); const x = T("export-jobs"); await v.scrollTo(x); await v.download(x); await v.hold(800);
      await v.caption("ផ្ទាំង «សាច់ប្រាក់»៖\nបញ្ជីបិទថ្ងៃ ដែលរដ្ឋបាលរាប់"); await v.tap(tab("សាច់ប្រាក់")); await v.idle(); await v.tap(preset("ថ្ងៃនេះ"), null, { before: 1000 }); await v.idle();
      await v.caption("រាប់បាន ធៀបនឹងប្រព័ន្ធ\nខុសគ្នា បង្ហាញភ្លាម"); await v.look(T("cash-day").first(), { zoom: 1.35, after: 1600 });
      await v.caption("ចុច «បានផ្ទៀងផ្ទាត់»\nថ្ងៃនោះជាប់សោ មិនអាចកែទៀត"); await v.tap(T("cash-verify").first()); await v.idle(); await v.hold(800);
      await v.caption("ផ្ទាំង «ផ្ទៀងផ្ទាត់»៖ ពិនិត្យ\nការទទួលប្រាក់ ម្ដងមួយៗ"); await v.tap(tab("ផ្ទៀងផ្ទាត់")); await v.idle();
      await v.tap(T("verify-btn").first(), null, { before: 1200 }); await v.idle(); await v.hold(1200);
    }),
    clip("L3-02_website-settings_v1", async (v, d, { A, nav, T }) => {
      await v.caption("ចុច «គេហទំព័រ»\nក្នុងម៉ឺនុយខាងឆ្វេង"); await v.tap(nav("website")); await v.idle(); await v.scrollTo(T("web-tagline_km"));
      await v.caption("កែពាក្យស្វាគមន៍\nអតិថិជនឃើញនៅទំព័រដើម"); await v.type(T("web-tagline_km"), "ជួសជុល និងថែទាំ រហ័ស ទុកចិត្តបាន", { clear: true, before: 1200 });
      await v.caption("បន្ថែមរូបការងារ\nរូបពិត ជួយឲ្យអតិថិជនទុកចិត្ត"); const g = T("web-photo-gallery"); await v.scrollTo(g.locator("xpath=.."));
      await v.tap(g.locator("xpath=.."), () => g.setInputFiles(d.photo)); await v.idle(); await v.hold(600);
      await v.caption("រូបរក្សាទុកភ្លាម\nមិនបាច់ចុច «រក្សាទុក»"); await v.hold(1400);
      await v.caption("ម៉ោងទទួលកក់ — ម៉ោងសម្រាកថ្ងៃត្រង់\nអតិថិជនមិនអាចកក់"); const lunch = T("web-hours-lunch_start"); await v.scrollTo(lunch); await v.look(lunch, { zoom: 1.5 });
      const google = T("web-published");
      await v.caption("ធីក «Google» ពេលគេហទំព័ររួចរាល់\nអ្នកស្វែងរកនឹងឃើញហាង"); await v.scrollTo(google);
      if (await google.isChecked()) await v.look(google.locator("xpath=.."), { zoom: 1.5 }); else await v.tap(google.locator("xpath=.."));
      await v.caption("ចុច «រក្សាទុក»"); await v.tap(T("web-save")); await v.idle(); await v.hold(800);
      await v.caption("ឃើញអ្នកកែចុងក្រោយ និងម៉ោង"); const last = T("last-change-website"); await v.scrollTo(last); await v.look(last, { zoom: 1.6, after: 1200 });
      await v.caption("ទំព័រដើម បង្ហាញពាក្យ និងរូបថ្មី"); await v.preloadApp("/"); await v.hold(1500); await v.idle(3000); await v.hold(1600);
    }),
    clip("L3-03_test-phones_v1", async (v, d, { nav, T }) => {
      await v.caption("ចង់សាកកក់ ដោយមិនរំខានបុគ្គលិក?\nប្រើលេខទូរស័ព្ទសាកល្បង"); await v.hold(1400);
      await v.caption("ចុច «ការកំណត់»"); await v.tap(nav("settings/company")); await v.idle();
      await v.caption("ផ្នែក «លេខទូរស័ព្ទសាកល្បង»\nសម្រាប់នាយកប្រតិបត្តិតែប៉ុណ្ណោះ"); await v.scrollTo(T("test-phones")); await v.hold(1200);
      await v.caption("វាយលេខរបស់អ្នក\nម្ដងមួយបន្ទាត់ (យ៉ាងច្រើន ១០)"); await v.type(T("test-phones"), "099 888 777", { before: 1200 });
      await v.caption("ចុច «រក្សាទុក»"); await v.tap(T("test-phones-save")); await v.idle(); await v.hold(800);
      await v.caption("កក់ពីលេខនេះ = សាកល្បង\nមានតែអ្នកទទួលដំណឹង"); await v.hold(2000);
      await v.caption("មិនចូលរបាយការណ៍ទេ\nហើយបោះបង់ឯង ក្រោយ ២៤ ម៉ោង"); await v.hold(2200);
    }),
    clip("L3-04_staff-roles_v1", async (v, d, { A, nav, dlg, T }) => {
      await v.caption("ចុច «អ្នកប្រើ»"); await v.tap(nav("settings/users")); await v.idle();
      await v.caption("គណនី HangKH នៅខាងក្រោម\nសម្រាប់ជំនួយបច្ចេកទេស មិនអាចកែ"); const sup = T("user-platform"); await v.scrollTo(sup); await v.look(sup, { zoom: 1.3, after: 1400 });
      await v.caption("ចុច «អ្នកប្រើថ្មី»"); await v.tap(A.getByRole("button", { name: "អ្នកប្រើថ្មី" })); await v.hold(300);
      await v.caption("វាយឈ្មោះពេញ ឈ្មោះចូល\nនិងលេខទូរស័ព្ទ"); await v.type(dlg().locator('input[name="full_name"]'), "ជាង សាកល្បង ៤", { before: 1200 });
      await v.type(dlg().locator('input[name="username"]'), "jang4", { before: 800 }); await v.type(dlg().locator('input[name="phone"]'), "012000105", { before: 800 });
      await v.caption("ជ្រើសតួនាទី — តួនាទីកំណត់\nអ្វីដែលគេមើល និងធ្វើបាន"); const role = dlg().locator('select[name="role"]'); await v.tap(role, () => role.selectOption("tech"), { before: 1200 });
      await v.caption("ធីក «មេជាង» — អាចពិនិត្យ\nការងាររបស់ជាងផ្សេង"); await v.tap(dlg().getByRole("checkbox", { name: /មេជាង/ }));
      // the system's password is never shown readable in the video: blurred on screen (the app shows it to hand it over)
      await v.app.addStyleTag({ content: '[role="dialog"] code{filter:blur(9px)}' });
      await v.caption("ទុកពាក្យសម្ងាត់ទទេ — ប្រព័ន្ធបង្កើតឲ្យ\nហើយចុច «រក្សាទុក»"); await v.look(dlg().locator('input[name="password"]'), { zoom: 1.5, after: 900 });
      await v.tap(dlg().getByRole("button", { name: "រក្សាទុក" }), null, { before: 1000 }); await v.idle(); await v.hold(500);
      await v.caption("ចុច «ចម្លង» ហើយឲ្យបុគ្គលិក\nចូលលើកដំបូង គាត់ត្រូវប្ដូរថ្មី"); await v.tap(dlg().getByRole("button", { name: "ចម្លង" }));
      await v.tap(dlg().getByRole("button", { name: "បិទ", exact: true }), null, { before: 1200 }); await v.idle();
      await v.caption("បុគ្គលិកឈប់ធ្វើការ? ចុច «បិទ»\nមិនលុប — ប្រវត្តិនៅដដែល"); const row = A.getByRole("row", { name: /jang_old/ }); await v.scrollTo(row);
      await v.tap(row.getByRole("button", { name: "បិទ", exact: true })); await v.tap(dlg().getByRole("button", { name: "បញ្ជាក់" }), null, { before: 1000 }); await v.idle(); await v.hold(1200);
    }),
    clip("L3-05_audit-log_v1", async (v, d, { A, nav, T, tab }) => {
      await v.caption("ចុច «របាយការណ៍»\nហើយ «កំណត់ហេតុសកម្មភាព»"); await v.tap(nav("reports")); await v.idle(); await v.tap(tab("កំណត់ហេតុសកម្មភាព"), null, { before: 1000 }); await v.idle();
      await v.caption("ជួរនីមួយៗ៖ អ្នកណា · ធ្វើអ្វី\nពី → ទៅ · ពេលណា"); await v.look(T("audit-row").first(), { zoom: 1.3, after: 1800 });
      await v.caption("ជ្រើសប្រភេទ — ឧ. «លុយ»"); const type = T("audit-type"); await v.tap(type, () => type.selectOption("money"), { before: 1200 }); await v.idle(); await v.hold(1200);
      await v.caption("ជ្រើសអ្នកធ្វើ\nមើលតែការងាររបស់គាត់"); const who = T("audit-person"); await v.tap(who, () => who.selectOption({ label: "រដ្ឋបាល សាកល្បង" }), { before: 1200 }); await v.idle(); await v.hold(1200);
      await v.caption("ចុច «លម្អិត»\nឃើញទិន្នន័យដើម"); await v.tap(T("audit-row").first().getByRole("button", { name: "លម្អិត" })); await v.hold(1400);
      await v.caption("កំណត់ហេតុ មិនអាចលុប ឬកែបានទេ\nសូម្បីនាយកប្រតិបត្តិ"); await v.hold(1800);
      await v.caption("ការកំណត់ គេហទំព័រ អ្នកប្រើ ទំនិញ\nបង្ហាញ «កែប្រែចុងក្រោយ» ដោយនរណា"); await v.tap(nav("settings/company")); await v.idle(); await v.look(T("last-change-settings"), { zoom: 1.6, after: 2000 });
    }),
  ],
};
