// Level 2 — Admin / GM in the staff app on a desktop (1920×1080), as built (CEO feedback 04-10: confirm = length + crew in one dialog,
// busy technicians greyed with their time, «បោះបង់ការងារ», the board moves within 15 s, table buttons with words): overview + clips →
// Doc_Sup/09_Tutorials/Admin_GM/L2-<nn>_<feature>_v1.mp4. Demo data only, fake names: website bookings come from a pretend visitor
// through the public booking API; promotions go to fake subscribers of a throwaway hub (no bot token, no sending job → nothing leaves).
import { readXlsx, writeXlsx } from "../../../apps/server/src/lib/xlsx.ts";

const ADDR = "ផ្ទះលេខ 8 ផ្លូវសាកល្បង ភ្នំពេញ", AT = { lat: 11.56, lng: 104.92 };
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const dayAt = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; };
const WEB = [["លោក សាកល្បង ក", "012345670"], ["លោក សាកល្បង ខ", "012345671"], ["អ្នកស្រី សាកល្បង គ", "012345672"], ["អ្នកស្រី សាកល្បង ឃ", "012345673"]];

// what every clip uses (called after the stage is loaded: the app frame is new for each video)
const ui = (v) => {
  const A = v.app;
  return {
    A, next: { before: 1000 }, // the next click under the same caption
    link: (name) => A.getByRole("link", { name, exact: true }),
    dlg: () => A.locator('[role="dialog"]').last(),
    T: (id) => A.locator(`[data-testid="${id}"]`),
    req: (name) => A.locator('[data-testid="req-card"]', { hasText: name }).locator('xpath=ancestor::*[contains(concat(" ", @class, " "), " card ")][1]'),
    job: (name) => A.locator('[data-testid="booking-card"]', { hasText: name }).first(),
  };
};
const clip = (name, play) => ({
  name, folder: "Admin_GM",
  async prepare(v) {
    await v.preloadApp("/app/dashboard");
    await v.app.getByRole("link", { name: "សំណើអតិថិជន", exact: true }).waitFor({ timeout: 20_000 });
    await v.idle(3000);
  },
  async play(v, d) {
    await v.hold(2000); await v.card(false);                              // intro
    await play(v, d, ui(v));
    await v.caption(null); await v.card(true); await v.hold(2000);       // outro
  },
});
async function openJob(v, { link, job, next }, name) { await v.tap(link("ការងារ")); await v.idle(); await v.scrollTo(job(name)); await v.tap(job(name), null, next); await v.idle(); }
async function pickService(v, { A, next }, d, time) {
  await A.locator('select[name="category"]').selectOption("mep");
  const sel = A.locator('select[name="service_item_id"]'), date = A.locator('input[name="date"]'), start = A.locator('input[name="start"]');
  await v.tap(sel, () => sel.selectOption(d.ac.id), { before: 1200 });
  await v.tap(date, () => date.fill(d.phoneDay), next);
  await v.tap(start, () => start.fill(time), next);
}
async function create(v, { A }) { const save = A.locator('button[type="submit"]'); await v.scrollTo(save); await v.tap(save); await v.idle(); await v.hold(700); }
/** an Excel look-alike of the downloaded template: the two prices change while the viewer watches */
function sheetHtml(before, after) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const rows = before.slice(0, 11), cols = Math.min(7, Math.max(...rows.map((r) => r.length)));
  const body = rows.map((r, i) => `<tr><th>${i + 1}</th>${Array.from({ length: cols }, (_, j) => {
    const nv = after[i]?.[j], ch = i > 0 && nv !== r[j];
    return `<td class="${i === 0 ? "hd" : ""}${ch ? " ch" : ""}"${ch ? ` data-new="${esc(nv)}"` : ""}>${esc(r[j])}</td>`;
  }).join("")}</tr>`).join("");
  const font = (w) => `@font-face{font-family:KH;font-weight:${w};src:url(/pub/fonts/noto-sans-khmer-${w}.woff2) format("woff2")}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${font(400)}${font(600)}
html,body{margin:0;height:100%;background:#fff;font:15px KH,"Segoe UI",sans-serif;color:#222}
.top{height:46px;background:#217346;color:#fff;display:flex;align-items:center;padding:0 20px;font:600 16px "Segoe UI",sans-serif}
.rib{height:58px;background:#F3F2F1;border-bottom:1px solid #D6D6D6}.fx{height:32px;border-bottom:1px solid #D6D6D6;display:flex;align-items:center;padding:0 12px;color:#777;font:italic 14px "Segoe UI"}
table{border-collapse:collapse}th{background:#F3F2F1;color:#555;font:13px "Segoe UI";border:1px solid #D6D6D6;min-width:40px;height:30px;padding:0 6px}
td{border:1px solid #E1E1E1;height:38px;padding:0 12px;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
td.hd{font-weight:600;background:#F8F8F8}td.on{background:#FFF2A8;outline:3px solid #217346;outline-offset:-3px;font-weight:600}</style></head><body>
<div class="top">Catalog.xlsx — Excel</div><div class="rib"></div><div class="fx">fx</div>
<table><tr><th></th>${Array.from({ length: cols }, (_, j) => `<th>${"ABCDEFGHIJ"[j]}</th>`).join("")}</tr>${body}</table>
<script>setTimeout(() => document.querySelectorAll("td.ch").forEach((td, i) => setTimeout(() => { td.textContent = td.dataset.new; td.classList.add("on"); }, i * 800)), 900);</script>
</body></html>`;
}

export default {
  name: "L2_Admin_GM",
  layout: "desktop",
  size: { w: 1280, h: 720, scale: 1.5 },
  captionSize: 30,
  tapBefore: 1700, // ~2 s before each click (chained clicks under one caption: 1 s)
  hub: true,       // the promotions clip needs a hub (a throwaway one with fake subscribers)
  async setup(v) {
    const user = async (username, full_name, role, phone) => { const p = v.password(); const u = await v.api("POST", "/api/users", { username, full_name, role, phone, password: p }); return { id: u.id, username, p }; };
    const gm = await user("gm_demo", "អ្នកគ្រប់គ្រង សាកល្បង", "gm", "012000100");
    const techs = [await user("jang1", "ជាង សាកល្បង ១", "tech", "012000101"), await user("jang2", "ជាង សាកល្បង ២", "tech", "012000102"), await user("jang3", "ជាង សាកល្បង ៣", "tech", "012000103")];
    await v.loginStaff(gm.username, gm.p); // the browser = the manager
    const customer = async (name, phone) => (await v.api("POST", "/api/customers", { name, phones: [phone], address: ADDR, zone: "outside", ...AT })).id;
    const book = async (name, phone, when, svc, tech) => {
      const b = await v.api("POST", "/api/bookings", { customer_id: await customer(name, phone), type: "A", category: "mep", service_text: svc, scheduled_at: when.toISOString(), zone: "outside", ...AT });
      if (tech) await v.api("POST", `/api/bookings/${b.id}/assign`, { lead: tech.id, assistants: [] });
      return b;
    };
    // today's board: one job per technician, an hour apart; two technicians have already pressed their steps
    const t0 = new Date(); t0.setMinutes(0, 0, 0); t0.setHours(t0.getHours() + 1);
    const today = (h) => new Date(t0.getTime() + h * 3_600_000);
    if (today(4).toDateString() !== new Date().toDateString()) throw new Error("record before ~19:00 — today's jobs must fit in the day");
    const TODAY = [["អតិថិជន ក", "លាងម៉ាស៊ីនត្រជាក់"], ["អតិថិជន ខ", "ជួសជុលភ្លើង"], ["អតិថិជន គ", "ជួសជុលទុយោទឹក"]];
    const jobs = [];
    for (const [i, [name, svc]] of TODAY.entries()) jobs.push(await book(name, `01200001${i}`, today(i), svc, techs[i]));
    const press = async (t, id, steps) => { const s = await v.session(t.username, t.p); for (const step of steps) await s.call("POST", `/api/bookings/${id}/checkpoint`, { step, at: new Date().toISOString(), ...AT, accuracy: 10, no_gps: false, offline: false }); };
    await press(techs[1], jobs[1].id, ["depart"]);
    await press(techs[2], jobs[2].id, ["depart", "arrive", "start"]);
    // clip 04: one job to move, one to cancel (both already assigned)
    await book("អតិថិជនសាកល្បង ង", "012000013", dayAt(2, 9), "លាងម៉ាស៊ីនត្រជាក់", techs[2]);
    await book("អតិថិជនសាកល្បង ច", "012000014", dayAt(2, 13), "ជួសជុលភ្លើង", techs[1]);
    await customer("អតិថិជនចាស់ សាកល្បង", "012000555");                     // an existing customer who phones (overview)
    // a customer whose website login is locked (wrong password 30 times) — clip 08
    await customer("អតិថិជនសាកល្បង", "012999888");
    await v.sql("insert into customer_login_guards (company_id, phone, failed, permanent) select id, '012999888', 30, true from companies limit 1");
    // four website bookings from a visitor (consent = the button on the site), free slots at least 3 h apart
    const list = await v.api("GET", "/api/catalog"), ac = (Array.isArray(list) ? list : list.items).find((x) => x.code === "AC-CLEAN");
    const visitor = await v.session(null);
    const ts = /data-ts="([^"]+)"/.exec(await visitor.text(`/book?items=${ac.id}:1`))[1];
    const free = (await visitor.call("GET", `/api/public/slots?items=${ac.id}:1`)).days.slice(1).flatMap((x) => x.slots).filter((x) => x.free);
    const picks = [];
    for (const s of free) if (picks.every((p) => Math.abs(new Date(p.at) - new Date(s.at)) >= 3 * 3_600_000)) picks.push(s);
    if (picks.length < WEB.length) throw new Error(`only ${picks.length} free website slots`);
    await v.hold(2600);
    for (const [i, [name, phone]] of WEB.entries())
      await visitor.call("POST", "/api/public/bookings", { items: `${ac.id}:1`, at: picks[i].at, address: "ផ្ទះលេខ 21 ផ្លូវសាកល្បង ភ្នំពេញ", name, phone, consent: true, ts });
    // each confirm dialog shows one technician busy (greyed, with his time): another job at the same time as R0 / R1 / R3
    for (const [n, i] of [0, 1, 3].entries()) {
      const from = new Date(picks[i].at), to = new Date(from.getTime() + 2 * 3_600_000);
      const avail = await v.api("GET", `/api/bookings/availability?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}`);
      const tech = avail.people.filter((p) => p.available && p.role === "tech").at(-1);
      await book(`អតិថិជនសាកល្បង ${["ជ", "ឈ", "ញ"][n]}`, `01200002${n}`, from, "ជួសជុលម៉ាស៊ីនត្រជាក់", { id: tech.user_id });
    }
    // the demo hub: the shop's bot row (a dummy token nobody can decrypt) + 24 fake subscribers (some without promotions, some stopped)
    await v.sqlhub(`insert into hub_bots (code, kind, shop_code, username, path, token_enc, secret_enc) values ('DEMO', 'shop', 'DEMO', 'Oneteam_app_bot', 'demo', 'demo-no-token', 'demo-no-token');
insert into hub_subscribers (telegram_user_id, chat_id, first_name) select 900000000 + g, 900000000 + g, 'អតិថិជនសាកល្បង ' || translate(g::text, '0123456789', '០១២៣៤៥៦៧៨៩') from generate_series(1, 24) g;
insert into hub_subscriptions (shop_code, subscriber_id, promo, stopped_at, subscribed_at) select 'DEMO', id, telegram_user_id % 7 <> 0, case when telegram_user_id % 11 = 0 then now() end, now() - (telegram_user_id % 40) * interval '1 day' from hub_subscribers;`);
    return { ac, depart: () => press(techs[0], jobs[0].id, ["depart"]), web: WEB.map((w) => w[0]), today: TODAY.map((x) => x[0]), move: "អតិថិជនសាកល្បង ង", moveTo: ymd(dayAt(3, 9)), drop: "អតិថិជនសាកល្បង ច", phoneDay: ymd(dayAt(1, 0)) };
  },
  videos: [
    clip("L2-00_overview_v1", async (v, d, u) => {
      const { A, link, dlg, T, req, next } = u;
      await v.chapter("១ · សំណើអតិថិជន");
      await v.caption("ការកក់ពីគេហទំព័រ\nនៅក្នុង «សំណើអតិថិជន»"); await v.tap(link("សំណើអតិថិជន")); await v.idle();
      await v.caption("ឆ្លើយក្នុង ៣០ នាទី\nអតិថិជនកំពុងរង់ចាំ"); await v.scrollTo(req(d.web[0])); await v.hold(1000);
      await v.caption("ចុច «បញ្ជាក់»"); await v.tap(req(d.web[0]).locator('[data-testid="req-yes"]')); await v.idle();
      await v.caption("ជ្រើសជាងទំនេរ\nអ្នករវល់ មិនអាចជ្រើស"); await v.tap(dlg().locator('[data-testid="crew-free"] label').first());
      await v.caption("ចុច «បញ្ជាក់ និងចាត់ជាង»\nអតិថិជន និងជាងទទួលដំណឹង"); await v.tap(T("req-confirm-go")); await v.idle(); await v.hold(800);
      await v.chapter("២ · ការងារថ្ងៃនេះ");
      await v.caption("ចុច «ការងារ» ហើយ «តម្រង»\nជ្រើស «ថ្ងៃនេះ»"); await v.tap(link("ការងារ")); await v.idle(); await v.tap(T("filters-toggle"), null, next);
      const day = A.locator('[data-testid="filters"] select').first(); await v.tap(day, () => day.selectOption("today"), next); await v.idle();
      await v.caption("ការងារផ្លាស់ជួរឯង\nពេលជាងចុចជំហាននីមួយៗ"); await v.hold(2400);
      await v.chapter("៣ · អតិថិជនទូរស័ព្ទមក");
      await v.caption("ចុច «ការងារថ្មី»"); await v.tap(A.getByRole("button", { name: "ការងារថ្មី" })); await v.idle();
      await v.caption("វាយលេខទូរស័ព្ទ\nហើយជ្រើសអតិថិជន"); await v.type(A.locator('input[name="customer_search"]'), "012000555", { before: 1200 }); await v.idle();
      await v.tap(A.locator('[role="listbox"] button').first(), null, next); await v.idle();
      await v.caption("ជ្រើសសេវា ថ្ងៃ និងម៉ោង"); await pickService(v, u, d, "10:00");
      await v.caption("ចុច «បង្កើតការងារ»"); await create(v, u);
      await v.caption("វីដេអូខ្លីៗ បង្ហាញការងារនីមួយៗ\nលម្អិត"); await v.hold(2200);
    }),
    clip("L2-01_confirm-decline-request_v1", async (v, d, { link, req, dlg, T }) => {
      const yes = req(d.web[1]), no = req(d.web[2]);
      await v.caption("ចុច «សំណើអតិថិជន»"); await v.tap(link("សំណើអតិថិជន")); await v.idle();
      await v.caption("ឆ្លើយក្នុង ៣០ នាទី\nអតិថិជនកំពុងរង់ចាំ"); await v.scrollTo(yes); await v.hold(1000);
      await v.caption("ពិនិត្យសេវា ថ្ងៃ និងម៉ោង\nហើយចុច «បញ្ជាក់»"); await v.tap(yes.locator('[data-testid="req-yes"]')); await v.idle();
      await v.caption("ជ្រើសជាងទំនេរ\nអ្នករវល់ មិនអាចជ្រើស"); await v.tap(dlg().locator('[data-testid="crew-free"] label').first());
      await v.caption("ចុច «បញ្ជាក់ និងចាត់ជាង»\nអតិថិជន និងជាងទទួលដំណឹងភ្លាម"); await v.tap(T("req-confirm-go")); await v.idle(); await v.hold(600);
      await v.caption("មិនអាចទទួល? ចុច «មិនទទួល»"); await v.scrollTo(no); await v.tap(no.locator('[data-testid="req-no"]'));
      await v.caption("សរសេរមូលហេតុ\nអតិថិជននឹងឃើញ"); await v.type(no.locator('[data-testid="req-reason"]'), "ថ្ងៃនោះជាងពេញ", { before: 1200 });
      await v.caption("ចុច «មិនទទួល» ម្ដងទៀត\nម៉ោងនោះទំនេរវិញ"); await v.tap(no.locator('[data-testid="req-no-go"]')); await v.idle(); await v.hold(1400);
    }),
    clip("L2-02_assign-technician-job-length_v1", async (v, d, { link, dlg, T, req }) => {
      const r = req(d.web[3]), freeRows = dlg().locator('[data-testid="crew-free"]');
      await v.caption("ចុច «សំណើអតិថិជន»"); await v.tap(link("សំណើអតិថិជន")); await v.idle(); await v.scrollTo(r);
      await v.caption("ចុច «បញ្ជាក់»\nរយៈពេល និងជាង នៅផ្ទាំងតែមួយ"); await v.tap(r.locator('[data-testid="req-yes"]')); await v.idle();
      await v.caption("ការងារវែង ឬខ្លីជាងធម្មតា?\nកែរយៈពេល (នាទី)"); await v.type(dlg().locator('[data-testid="req-minutes"]'), "90", { clear: true, before: 1200 }); await v.idle();
      await v.caption("ម៉ោងបញ្ចប់ និងជាងទំនេរ\nគិតពីរយៈពេលនេះ"); await v.look(T("req-confirm-when"), { zoom: 1.5 });
      await v.caption("ជាងរវល់ ពណ៌ប្រផេះ\nបង្ហាញម៉ោងដែលគាត់រវល់"); await v.look(dlg().locator('[data-testid="crew-busy"]').first(), { zoom: 1.5 });
      await v.caption("ធីកជាងទំនេរ\nហើយចុច «មេជាង» (ស្រេចចិត្ត)"); await v.tap(freeRows.nth(0).locator("label"));
      await v.tap(freeRows.nth(0).getByRole("button", { name: "មេជាង" }), null, { before: 1000 });
      await v.caption("ចុច «បញ្ជាក់ និងចាត់ជាង»\nជាងទទួលការងារតាម Telegram"); await v.tap(T("req-confirm-go")); await v.idle(); await v.hold(1400);
    }),
    clip("L2-03_booking-by-phone_v1", async (v, d, u) => {
      const { A, link, dlg, next } = u;
      await v.caption("អតិថិជនទូរស័ព្ទមក?\nចុច «ការងារ» ហើយ «ការងារថ្មី»"); await v.tap(link("ការងារ")); await v.idle();
      await v.tap(A.getByRole("button", { name: "ការងារថ្មី" }), null, next); await v.idle();
      await v.caption("វាយលេខទូរស័ព្ទសិន\nអតិថិជនចាស់ នឹងលោតមក"); await v.type(A.locator('input[name="customer_search"]'), "012000222", { before: 1200 }); await v.idle();
      await v.caption("រកមិនឃើញ? ចុច «អតិថិជនថ្មី»"); await v.tap(A.getByRole("button", { name: "អតិថិជនថ្មី" }));
      await v.caption("វាយឈ្មោះ និងលេខទូរស័ព្ទ\nហើយចុច «រក្សាទុក»"); await v.type(dlg().locator('input[name="name"]'), "អតិថិជនសាកល្បង ឆ", { before: 1200 });
      await v.type(dlg().locator('input[name="phones"]'), "012000222", { ...next, clear: true });
      await v.tap(dlg().getByRole("button", { name: "រក្សាទុក" }), null, next); await v.idle();
      await v.caption("ជ្រើសសេវា ថ្ងៃ និងម៉ោងចាប់ផ្ដើម"); await pickService(v, u, d, "14:00");
      await v.caption("ម៉ោងបញ្ចប់ គិតឯង\nតាមរយៈពេលសេវា"); await v.look(A.locator('input[name="end"]'));
      await v.caption("ចុច «បង្កើតការងារ»"); await create(v, u);
      await v.caption("រួចរាល់ — បន្ទាប់មក ចាត់ជាងទំនេរ"); await v.hold(2000);
    }),
    clip("L2-04_reschedule-cancel_v1", async (v, d, u) => {
      const { dlg, T, next } = u;
      await v.caption("បើកការងារ ហើយចុច «ប្ដូរម៉ោង»"); await openJob(v, u, d.move); await v.tap(T("resched-btn"), null, next);
      await v.caption("ជ្រើសថ្ងៃ ឬម៉ោងថ្មី"); const nd = dlg().locator('input[name="resched_date"]'); await v.tap(nd, () => nd.fill(d.moveTo), { before: 1200 });
      await v.caption("ជ្រើសអ្នកស្នើ\nប្រវត្តិកត់ទុកថា នរណាសុំ"); await v.tap(dlg().getByRole("radio", { name: "អតិថិជន", exact: true }));
      await v.caption("សរសេរមូលហេតុ\nហើយចុច «រក្សាម៉ោងថ្មី»"); await v.type(dlg().locator('textarea[name="resched_reason"]'), "អតិថិជនមិននៅផ្ទះ", { before: 1200 });
      await v.tap(T("resched-submit"), null, next); await v.idle();
      await v.caption("ជាងទទួលម៉ោងថ្មី តាម Telegram"); await v.hold(1200);
      await v.caption("ប្រវត្តិ៖ នរណាស្នើ និងមូលហេតុ"); const hist = T("resched-history"); await v.scrollTo(hist); await v.look(hist, { zoom: 1.4 });
      await v.caption("បោះបង់៖ បើកការងារ\nហើយចុច «បោះបង់ការងារ»"); await openJob(v, u, d.drop); await v.tap(T("cancel-btn"), null, next);
      await v.caption("មូលហេតុត្រូវតែមាន\nការងារមិនត្រូវលុបទេ"); await v.type(dlg().locator("textarea"), "អតិថិជនលែងត្រូវការ", { before: 1200 });
      await v.caption("ចុច «បោះបង់ការងារនេះ»\nជាងទំនេរវិញ ហើយទទួលដំណឹង"); await v.tap(T("cancel-submit")); await v.idle(); await v.hold(1400);
    }),
    clip("L2-05_todays-jobs-board_v1", async (v, d, u) => {
      const { A, link, T, job, next } = u, f = A.locator('[data-testid="filters"] select');
      const inCol = (col) => A.locator(`[data-testid="col-${col}"] [data-testid="booking-card"]`, { hasText: d.today[0] });
      await v.caption("ចុច «ការងារ» ហើយ «តម្រង»"); await v.tap(link("ការងារ")); await v.idle(); await v.tap(T("filters-toggle"), null, next);
      await v.caption("ជ្រើស «ថ្ងៃនេះ»"); await v.tap(f.first(), () => f.first().selectOption("today"), { before: 1200 }); await v.idle();
      await v.caption("ជួរនីមួយៗ ជាស្ថានភាពការងារ"); await v.hold(1600);
      await v.caption("មើល៖ ជាងម្នាក់ទើបចុច «ចេញដំណើរ»"); await v.look(inCol("assigned"), { zoom: 1.4, after: 900 });
      await d.depart();                                                        // the technician's phone, right now
      await inCol("in_progress").waitFor({ timeout: 25_000 });                 // the board refreshes every 15 s
      await v.caption("ការងារផ្លាស់ជួរឯង ក្នុង ១៥ វិនាទី\nមិនបាច់ទូរស័ព្ទសួរ"); await v.look(inCol("in_progress"), { zoom: 1.4 });
      await v.caption("ជ្រើសជាង\nឃើញតែការងាររបស់គាត់"); await v.tap(f.nth(3), () => f.nth(3).selectOption({ label: "ជាង សាកល្បង ៣" }), { before: 1200 }); await v.idle();
      await v.caption("ចុចការងារ — ឃើញម៉ោង\nដែលជាងចុចជំហាននីមួយៗ"); await v.tap(job(d.today[2]), null, next); await v.idle();
      await v.scrollTo(A.getByText("ដំណើរការការងារ", { exact: true }).first()); await v.hold(3200);
    }),
    clip("L2-06_catalog-edit_v1", async (v, d, { A, link, dlg, T }) => {
      await v.caption("ចុច «ទំនិញ និងសេវាកម្ម»"); await v.tap(link("ទំនិញ និងសេវាកម្ម")); await v.idle();
      await v.caption("ចុច «កែ» នៅជួរសេវា"); const row = A.locator("tr", { hasText: "AC-CLEAN" }); await v.scrollTo(row); await v.tap(row.getByRole("button", { name: "កែ", exact: true }));
      await v.caption("រយៈពេលការងារ\nម៉ោងបញ្ចប់ និងម៉ោងទំនេរ គិតពីនេះ"); await v.type(dlg().locator('input[name="duration_min"]'), "90", { clear: true, before: 1200 });
      await v.caption("តម្លៃចាប់ពី\nអតិថិជនឃើញលើគេហទំព័រ"); await v.type(T("cat-from"), "18", { clear: true, before: 1200 });
      await v.caption("ទុកទទេ = «តម្លៃបញ្ជាក់ពេលទាក់ទង»\nនៅតែកក់បាន"); await v.hold(1400);
      await v.caption("សេវាត្រូវមើលកន្លែងសិន?\nធីក «ស្នើសុំតម្លៃប៉ុណ្ណោះ»"); await v.look(T("cat-quote").locator("xpath=.."));
      await v.caption("ចុច «រក្សាទុក»"); await v.tap(dlg().getByRole("button", { name: "រក្សាទុក" })); await v.idle(); await v.hold(500);
      await v.caption("ឃើញអ្នកកែចុងក្រោយ និងម៉ោង"); const last = T("cat-last"); await v.scrollTo(last); await v.look(last);
    }),
    clip("L2-07_catalog-excel_v1", async (v, d, { A, link, T }) => {
      await v.caption("ចុច «ទំនិញ និងសេវាកម្ម»"); await v.tap(link("ទំនិញ និងសេវាកម្ម")); await v.idle();
      await v.caption("ចុច «ទាញយកគំរូ Excel»\nមានទំនិញទាំងអស់ស្រាប់"); const file = await v.download(T("cat-template")); await v.hold(500);
      const fs = await import("node:fs"), before = readXlsx(fs.readFileSync(file)), rows = before.map((r) => [...r]); // the edit a person makes in Excel: two prices
      for (const r of rows) { if (r[0] === "AC-CLEAN") r[5] = "20"; if (r[0] === "EL-REPAIR") r[5] = "12"; }
      const edited = file.replace(/\.xlsx$/, "-edited.xlsx"); fs.writeFileSync(edited, writeXlsx("Catalog", rows));
      v.write("excel.html", sheetHtml(before, rows));
      await v.caption("កែតម្លៃក្នុង Excel — កុំប្ដូរកូដ\nប្រព័ន្ធផ្គូផ្គងតាមកូដ"); await v.map(true, "/__asset/excel.html"); await v.hold(3400); await v.map(false);
      await v.caption("ចុច «បញ្ចូល Excel»\nហើយជ្រើសឯកសារ"); await v.tap(T("cat-upload"), () => A.locator('input[type="file"]').setInputFiles(edited)); await v.idle();
      await v.caption("មើលមុន៖ ថ្មី · កែប្រែ · កំហុស\nមិនទាន់រក្សាទុកទេ"); await v.look(T("cat-counts"), { zoom: 1.5 });
      await v.caption("មិនលុបអ្វីទេ\nចង់បិទ៖ «សកម្ម» = ទេ"); await v.hold(1400);
      await v.caption("ចុច «អនុវត្ត»"); await v.tap(T("cat-apply")); await v.idle(); await v.hold(500);
      await v.caption("ឃើញអ្នកកែចុងក្រោយ និងម៉ោង"); const last = T("cat-last"); await v.scrollTo(last); await v.look(last);
    }),
    clip("L2-08_unlock-customer_v1", async (v, d, { A, link, T }) => {
      await v.caption("អតិថិជនចូលគេហទំព័រមិនបាន?\nមើលថាគណនីជាប់សោឬទេ"); await v.hold(1200);
      await v.caption("ចុច «អតិថិជន»"); await v.tap(link("អតិថិជន")); await v.idle();
      await v.caption("ចុច «ប្រវត្តិ» របស់អតិថិជន"); const row = A.locator("tr", { hasText: "012999888" }); await v.scrollTo(row); await v.tap(row.getByRole("button", { name: "ប្រវត្តិ", exact: true })); await v.idle();
      await v.caption("វាយពាក្យសម្ងាត់ខុសច្រើនដង\nគណនីជាប់សោ"); await v.look(T("login-unlock").locator("xpath=.."), { zoom: 1.5 });
      await v.caption("ទូរស័ព្ទបញ្ជាក់សិន\nថាជាម្ចាស់គណនីពិត"); await v.hold(1600);
      await v.caption("ចុច «ដោះសោ»"); await v.tap(T("login-unlock")); await v.idle(); await v.hold(500);
      await v.caption("ភ្លេចពាក្យសម្ងាត់?\nអតិថិជនសុំថ្មីក្នុង bot"); await v.hold(1800);
    }),
    clip("L2-09_promotions_v1", async (v, d, { A, link, dlg, T, next }) => {
      await v.caption("ចុច «អតិថិជន Telegram»"); await v.tap(link("អតិថិជន Telegram")); await v.idle();
      await v.caption("មានតែនាយកប្រតិបត្តិ និងអ្នកគ្រប់គ្រង\nផ្ញើប្រូម៉ូសិនបាន"); await v.scrollTo(T("bc-text")); await v.hold(1400);
      await v.caption("សរសេរប្រូម៉ូសិន\nយ៉ាងច្រើន ៤ បន្ទាត់"); await v.type(T("bc-text"), "បញ្ចុះតម្លៃ 10% លាងម៉ាស៊ីនត្រជាក់\nពេញខែតុលា — កក់តាមគេហទំព័រ", { before: 1200, delay: 35 });
      await v.caption("ចុច «មើលមុន»\nឃើញសារ និងចំនួនអ្នកទទួល"); await v.tap(T("bc-preview")); await v.idle(); await v.scrollTo(T("bc-shown"));
      await v.caption("ម្នាក់ទទួលម្ដង ក្នុង ៧ ថ្ងៃ\nកុំឲ្យរំខានអតិថិជន"); await v.look(T("bc-shown"), { zoom: 1.4 });
      await v.caption("ចុច «ផ្ញើ» ហើយ «បញ្ជាក់»"); await v.tap(T("bc-send")); await v.tap(dlg().getByRole("button", { name: "បញ្ជាក់", exact: true }), null, next); await v.idle(); await v.hold(500);
      await v.caption("⏳ = កំពុងផ្ញើ · ✅ = បានផ្ញើ"); await v.scrollTo(A.locator("table").first()); await v.hold(1400);
      await v.caption("ម៉ោង ២០:០០–០៨:០០\nសាររង់ចាំដល់ព្រឹក"); await v.hold(1800);
    }),
  ],
};
