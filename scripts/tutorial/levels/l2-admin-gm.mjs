// Level 2 — Admin / GM in the staff app on a desktop (1920×1080), as built: website requests (confirm with the job length, decline
// with a reason, assign a FREE technician) · a booking for a phone customer · reschedule (who asked) + cancel (why) · today's board ·
// catalog: edit an item, Excel template → upload → preview → apply, «last changed» · unlock a customer's locked login.
// Demo data only, fake names; the two website bookings come from a pretend visitor through the public booking API.
import { readXlsx, writeXlsx } from "../../../apps/server/src/lib/xlsx.ts";

const ADDR = "ផ្ទះលេខ 8 ផ្លូវសាកល្បង ភ្នំពេញ", AT = { lat: 11.56, lng: 104.92 };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

export default {
  name: "L2_Admin_GM_v1",
  layout: "desktop",
  size: { w: 1280, h: 720, scale: 1.5 },
  captionSize: 30,
  tapBefore: 1700, // ~2 s before each click (chained clicks under one caption: 1 s)
  async setup(v) {
    const user = async (username, full_name, role, phone) => { const p = v.password(); const u = await v.api("POST", "/api/users", { username, full_name, role, phone, password: p }); return { id: u.id, username, p }; };
    const gm = await user("gm_demo", "អ្នកគ្រប់គ្រង សាកល្បង", "gm", "012000100");
    const techs = [await user("jang1", "ជាង សាកល្បង ១", "tech", "012000101"), await user("jang2", "ជាង សាកល្បង ២", "tech", "012000102"), await user("jang3", "ជាង សាកល្បង ៣", "tech", "012000103")];
    await v.loginStaff(gm.username, gm.p); // the browser = the manager
    const customer = async (name, phone) => (await v.api("POST", "/api/customers", { name, phones: [phone], address: ADDR, zone: "outside", ...AT })).id;
    // today's jobs: one per technician, two hours apart; two technicians have already pressed their steps
    const t0 = new Date(); t0.setMinutes(0, 0, 0); t0.setHours(t0.getHours() + 1);
    const at = (h) => new Date(t0.getTime() + h * 3_600_000);
    if (at(6).toDateString() !== new Date().toDateString()) throw new Error("record before ~17:00 — today's jobs must fit in the day");
    const jobs = [];
    for (const [i, [name, svc]] of [["អតិថិជន ក", "លាងម៉ាស៊ីនត្រជាក់"], ["អតិថិជន ខ", "ជួសជុលភ្លើង"], ["អតិថិជន គ", "ជួសជុលទុយោទឹក"]].entries()) {
      const b = await v.api("POST", "/api/bookings", { customer_id: await customer(name, `01200001${i}`), type: "A", category: "mep", service_text: svc, scheduled_at: at(i * 2).toISOString(), zone: "outside", ...AT });
      await v.api("POST", `/api/bookings/${b.id}/assign`, { lead: techs[i].id, assistants: [] });
      jobs.push(b);
    }
    const press = async (t, id, steps) => { const s = await v.session(t.username, t.p); for (const step of steps) await s.call("POST", `/api/bookings/${id}/checkpoint`, { step, at: new Date().toISOString(), ...AT, accuracy: 10, no_gps: false, offline: false }); };
    await press(techs[1], jobs[1].id, ["depart"]);
    await press(techs[2], jobs[2].id, ["depart", "arrive", "start"]);
    // two website bookings for tomorrow, from a visitor (consent = the button on the site)
    const list = await v.api("GET", "/api/catalog"), ac = (Array.isArray(list) ? list : list.items).find((x) => x.code === "AC-CLEAN");
    const visitor = await v.session(null);
    const ts = /data-ts="([^"]+)"/.exec(await visitor.text(`/book?items=${ac.id}:1`))[1];
    const free = (await visitor.call("GET", `/api/public/slots?items=${ac.id}:1`)).days.slice(1).flatMap((d) => d.slots).filter((x) => x.free);
    await v.hold(2600);
    for (const [i, [name, phone]] of [["លោក សាកល្បង", "012345678"], ["អ្នកស្រី សាកល្បង", "012345679"]].entries())
      await visitor.call("POST", "/api/public/bookings", { items: `${ac.id}:1`, at: free[i * 2].at, address: "ផ្ទះលេខ 21 ផ្លូវសាកល្បង ភ្នំពេញ", name, phone, consent: true, ts });
    // a customer whose website login is locked (wrong password 30 times)
    await customer("អតិថិជនសាកល្បង", "012999888");
    await v.sql("insert into customer_login_guards (company_id, phone, failed, permanent) select id, '012999888', 30, true from companies limit 1");
    return { ac, start: at(0) };
  },
  async prepare(v) {
    await v.preloadApp("/app/dashboard");
    await v.app.getByRole("link", { name: "សំណើអតិថិជន", exact: true }).waitFor({ timeout: 20_000 });
  },
  async play(v, d) {
    const A = v.app, link = (name) => A.getByRole("link", { name, exact: true }), dlg = () => A.locator('[role="dialog"]').last();
    const card = (name) => A.locator('[data-testid="req-card"]', { hasText: name }).locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " card ")][1]');
    const next = { before: 1000 }; // the next click under the same caption
    const T = (id) => A.locator(`[data-testid="${id}"]`);
    await v.hold(2000); await v.card(false);                                                       // intro

    await v.chapter("១ · សំណើពីគេហទំព័រ");
    await v.caption("មានការកក់ថ្មីពីគេហទំព័រ\nចុច «សំណើអតិថិជន»"); await v.tap(link("សំណើអតិថិជន")); await v.idle(); await v.hold(400);
    const mine = card("លោក សាកល្បង"), other = card("អ្នកស្រី សាកល្បង");
    await v.caption("កែរយៈពេលការងារ បើត្រូវការ\nហើយចុច «បញ្ជាក់»"); await v.scrollTo(mine);
    await v.type(mine.locator('[data-testid="req-minutes"]'), "90", { clear: true });
    await v.tap(mine.locator('[data-testid="req-yes"]'), null, next); await v.idle(); await v.hold(300);
    await v.caption("មិនអាចទទួល? ចុច «មិនទទួល»\nសរសេរមូលហេតុ ហើយផ្ញើ");
    await v.tap(other.locator('[data-testid="req-no"]')); await v.hold(300);
    await v.type(other.locator('[data-testid="req-reason"]'), "ជាងមិនទំនេរ", next);
    await v.tap(other.locator('[data-testid="req-no-go"]'), null, next); await v.idle(); await v.hold(300);
    await v.caption("ចាត់ជាង៖ បើកការងារនេះ\nហើយចុច «ចាត់ជាង»");
    await v.tap(link("ការងារ")); await v.idle();
    await v.tap(A.locator('[data-testid="booking-card"]', { hasText: "លោក សាកល្បង" }), null, next); await v.idle();
    await v.tap(T("assign-btn"), null, next); await v.idle(); await v.hold(300);
    await v.caption("បង្ហាញតែជាងទំនេរ\nជ្រើសជាង ហើយចុចបញ្ជាក់");
    await v.tap(dlg().locator("label", { hasText: "ជាង សាកល្បង ១" }));
    await v.tap(T("assign-submit"), null, next); await v.idle(); await v.hold(700);

    await v.chapter("២ · ការងារសម្រាប់អតិថិជនទូរស័ព្ទ");
    await v.caption("ចុច «ការងារថ្មី»\nហើយ «អតិថិជនថ្មី»");
    await v.tap(link("ការងារ")); await v.idle();
    await v.tap(A.getByRole("button", { name: "ការងារថ្មី" }), null, next); await v.idle();
    await v.tap(A.getByRole("button", { name: "អតិថិជនថ្មី" }), null, next); await v.hold(300);
    await v.caption("វាយឈ្មោះ លេខទូរស័ព្ទ\nហើយចុច «រក្សាទុក»");
    await v.type(dlg().locator('input[name="name"]'), "អតិថិជនទូរស័ព្ទ", { before: 1600 });
    await v.type(dlg().locator('input[name="phones"]'), "012000222", next);
    await v.tap(dlg().getByRole("button", { name: "រក្សាទុក" }), null, next); await v.idle(); await v.hold(400);
    await v.caption("ជ្រើសសេវា ថ្ងៃ និងម៉ោង\nហើយចុច «បង្កើតការងារ»");
    await A.locator('select[name="category"]').selectOption("mep");
    const sel = A.locator('select[name="service_item_id"]'), date = A.locator('input[name="date"]'), time = A.locator('input[name="start"]'), save = A.locator('button[type="submit"]');
    await v.tap(sel, () => sel.selectOption(d.ac.id), { before: 1600 });
    await v.tap(date, () => date.fill(ymd(d.start)), next);
    await v.tap(time, () => time.fill(hm(d.start)), next);
    await v.scrollTo(save); await v.tap(save, null, next); await v.idle(); await v.hold(300);
    await v.caption("ចុច «ចាត់ជាង»\nជាងរវល់ មិនបង្ហាញក្នុងបញ្ជី");
    await v.tap(T("assign-btn")); await v.idle(); await v.hold(300);
    await v.hold(900);
    await v.caption("ជ្រើសជាងទំនេរ ហើយចុចបញ្ជាក់");
    await v.tap(dlg().locator("label", { hasText: "ជាង សាកល្បង ២" }), null, { before: 1600 });
    await v.tap(T("assign-submit"), null, next); await v.idle(); await v.hold(600);

    await v.chapter("៣ · ប្ដូរម៉ោង និងលុបចោល");
    await v.caption("ចុច «ប្ដូរម៉ោង»\nជ្រើសថ្ងៃថ្មី អ្នកស្នើ និងមូលហេតុ");
    await v.tap(T("resched-btn")); await v.hold(300);
    const nd = dlg().locator('input[name="resched_date"]');
    await v.tap(nd, () => nd.fill(ymd(new Date(d.start.getTime() + 86_400_000))), next);
    await v.tap(dlg().getByRole("radio", { name: "អតិថិជន", exact: true }), null, next);
    await v.type(dlg().locator('textarea[name="resched_reason"]'), "សុំប្ដូរថ្ងៃ", next);
    await v.tap(T("resched-submit"), null, next); await v.idle(); await v.hold(600);
    await v.caption("ចុច «លុបចោលការងារ»\nសរសេរមូលហេតុ ហើយបញ្ជាក់");
    await v.tap(T("cancel-btn")); await v.hold(300);
    await v.type(dlg().locator("textarea"), "លែងត្រូវការ", next);
    await v.tap(T("cancel-submit"), null, next); await v.idle(); await v.hold(800);

    await v.chapter("៤ · ការងារថ្ងៃនេះ");
    await v.caption("ចុច «ការងារ» ហើយជ្រើស «ថ្ងៃនេះ»");
    await v.tap(link("ការងារ")); await v.idle();
    await v.tap(T("filters-toggle"), null, next); await v.hold(300);
    const day = A.locator('[data-testid="filters"] select').first();
    await v.tap(day, () => day.selectOption("today"), next); await v.idle(); await v.hold(300);
    await v.caption("ឃើញស្ថានភាពការងារ\nរបស់ជាងម្នាក់ៗ"); await v.hold(3100);

    await v.chapter("៥ · ទំនិញ និងសេវាកម្ម");
    await v.caption("ចុច «ទំនិញ និងសេវាកម្ម»\nហើយ ✏️ ដើម្បីកែ");
    await v.tap(link("ទំនិញ និងសេវាកម្ម")); await v.idle();
    const row = A.locator("tr", { hasText: "AC-CLEAN" });
    await v.scrollTo(row); await v.tap(row.locator('button[title="កែ"]'), null, next); await v.hold(300);
    await v.caption("កែតម្លៃ ហើយចុច «រក្សាទុក»");
    await v.type(dlg().locator('[data-testid="cat-from"]'), "18", { clear: true, before: 1600 });
    await v.tap(dlg().getByRole("button", { name: "រក្សាទុក" }), null, next); await v.idle(); await v.hold(300);
    await v.caption("ចុច «ទាញយកគំរូ Excel»"); const file = await v.download(T("cat-template")); await v.hold(400);
    await v.caption("កែក្នុង Excel ហើយរក្សាទុក"); await v.hold(3000);
    const fs = await import("node:fs"), rows = readXlsx(fs.readFileSync(file)); // the edit a person makes in Excel: two prices
    for (const r of rows) { if (r[0] === "AC-CLEAN") r[5] = "20"; if (r[0] === "EL-REPAIR") r[5] = "12"; }
    const edited = file.replace(/\.xlsx$/, "-edited.xlsx"); fs.writeFileSync(edited, writeXlsx("Catalog", rows));
    await v.caption("ចុច «បញ្ចូល Excel»\nមើលមុន ហើយចុច «អនុវត្ត»");
    await v.tap(T("cat-upload"), () => A.locator('input[type="file"]').setInputFiles(edited)); await v.idle(); await v.hold(1200);
    await v.tap(T("cat-apply"), null, { before: 1500 }); await v.idle(); await v.hold(300);
    await v.caption("ឃើញអ្នកកែចុងក្រោយ"); const last = T("cat-last"); await v.scrollTo(last); await v.tap(last, () => v.hold(10), { zoom: 1.7, before: 700, after: 1300, circle: false });

    await v.chapter("៦ · ដោះសោគណនីអតិថិជន");
    await v.caption("ចុច «អតិថិជន»\nហើយ «ប្រវត្តិ» របស់អតិថិជន");
    await v.tap(link("អតិថិជន")); await v.idle();
    const crow = A.locator("tr", { hasText: "012999888" });
    await v.scrollTo(crow); await v.tap(crow.locator('button[title="ប្រវត្តិ"]'), null, next); await v.idle(); await v.hold(400);
    await v.caption("គណនីជាប់សោ — ចុច «ដោះសោ»"); await v.tap(T("login-unlock")); await v.idle(); await v.hold(600);
    await v.caption("រួចរាល់ — អតិថិជនចូលបានវិញ"); await v.hold(2700);
    await v.caption(null); await v.card(true); await v.hold(2000);                                  // outro
  },
};
