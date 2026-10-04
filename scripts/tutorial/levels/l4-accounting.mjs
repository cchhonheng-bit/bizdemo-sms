// Level 4 — Accounting in the staff app on a desktop (1920×1080), as built, the browser a demo CFO: overview · chart of accounts
// (Balance Sheet / Income Statement by type) · opening balances · record a transaction · General Ledger + Trial Balance (3 pairs) ·
// Income Statement + Balance Sheet (previous month, change) · year-end close + the period lock → Doc_Sup/09_Tutorials/Accounting/.
// Demo data only. The opening-balances clip records FIRST on books not started yet; the overview's prepare then posts the demo
// year: last year (so the year-end close can be shown), last month (for the Balance Sheet's previous month) and today's invoices.
// Not built live (told in the report): a month-end close apart from the period lock; a previous-period column on the Income Statement.
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const now = new Date(), Y = now.getFullYear(), M = now.getMonth();
const lastYear = (m, d) => ymd(new Date(Y - 1, m - 1, d)), lastMonth = (d) => ymd(new Date(Y, M - 1, d)), thisMonth = (d) => ymd(new Date(Y, M, Math.min(d, now.getDate())));
const lastMonthEnd = ymd(new Date(Y, M, 0));

const ui = (v) => {
  const A = v.app;
  return {
    A, next: { before: 1000 },
    nav: (path) => A.locator(`aside nav a[href="/app/${path}"]`),
    dlg: () => A.locator('[role="dialog"]').last(),
    T: (id) => A.locator(`[data-testid="${id}"]`),
    preset: (name) => A.getByRole("button", { name, exact: true }),
  };
};
const clip = (name, play, seed) => ({
  name, folder: "Accounting",
  async prepare(v, d) {
    if (seed) await seed(v, d);
    await v.preloadApp("/app/dashboard");
    await v.app.locator('aside nav a[href="/app/accounting"]').waitFor({ timeout: 20_000 });
    await v.idle(3000);
  },
  async play(v, d) {
    await v.hold(2000); await v.card(false);                              // intro
    await play(v, d, ui(v));
    await v.caption(null); await v.card(true); await v.hold(2000);       // outro
  },
});
async function openAccounting(v, { nav, T }, tab) { await v.tap(nav("accounting")); await v.idle(); if (tab) { await v.tap(T(`tab-${tab}`), null, { before: 1000 }); await v.idle(); } }

/** the demo year, posted once the books are started (after the opening-balances clip) */
async function seedYear(v, d) {
  if (d.seeded) return; d.seeded = true;
  const cfo = await v.session(d.cfo.username, d.cfo.p);
  const tx = (date, type, account_code, dollars, pay, memo) => cfo.call("POST", "/api/accounting/transactions", { date, type, account_code, amount: Math.round(dollars * 100), pay, memo });
  await tx(lastYear(3, 10), "other_income", "4090", 1500, "aba", "ចំណូលផ្សេងៗ");
  await tx(lastYear(6, 30), "expense", "6040", 600, "cash_usd", "ថ្លៃឈ្នួលការិយាល័យ");
  await tx(lastYear(8, 15), "expense", "6030", 120, "cash_usd", "សាំងឡាន");
  await tx(lastMonth(10), "other_income", "4090", 1200, "aba", "ចំណូលផ្សេងៗ");
  await tx(lastMonth(25), "expense", "6050", 85, "cash_usd", "ទឹក ភ្លើង");
  await tx(lastMonth(28), "expense", "6040", 600, "cash_usd", "ថ្លៃឈ្នួលការិយាល័យ");
  await tx(thisMonth(2), "expense", "6060", 25, "aba", "ទូរស័ព្ទ និងអ៊ីនធឺណិត");
  // today's work posts by itself: invoices issued (inside / outside the borey) and paid (in full / in part)
  for (const [name, zone, price, pay] of [["អតិថិជន ក", "inside", 15000, { amount: 15000, currency: "usd", method: "aba" }], ["អតិថិជន ខ", "outside", 9000, { amount: 5000, currency: "usd", method: "cash_usd" }]]) {
    const c = await v.api("POST", "/api/customers", { name, phones: [`0120001${zone === "inside" ? "11" : "12"}`], address: "ផ្ទះលេខ 8 ផ្លូវសាកល្បង ភ្នំពេញ", zone });
    const inv = await v.api("POST", "/api/invoices", { customer_id: c.id, lines: [{ description: "ជួសជុល និងថែទាំ", kind: "service", qty: 1, unit: "unit", unit_price: price }] });
    await v.api("POST", `/api/invoices/${inv.id}/issue`);
    await v.api("POST", `/api/invoices/${inv.id}/payments`, pay);
  }
}

export default {
  name: "L4_Accounting",
  layout: "desktop",
  size: { w: 1280, h: 720, scale: 1.5 },
  captionSize: 30,
  tapBefore: 1700,
  features: "website,subscribe,reminders,inventory,accounting",
  async setup(v) {
    const p = v.password();
    const u = await v.api("POST", "/api/users", { username: "cfo_demo", full_name: "នាយកហិរញ្ញវត្ថុ សាកល្បង", role: "cfo", phone: "012000098", password: p });
    const cfo = { id: u.id, username: "cfo_demo", p };
    cfo.p = await v.loginStaff(cfo.username, cfo.p);                    // the browser = the CFO
    return { cfo, openDate: lastYear(1, 1), seeded: false };
  },
  videos: [
    // recorded first: the books are not started yet
    clip("L4-02_opening-balances_v1", async (v, d, u) => {
      const { nav, T, dlg } = u;
      await v.caption("ចុច «គណនេយ្យ»"); await v.tap(nav("accounting")); await v.idle();
      await v.caption("សៀវភៅមិនទាន់ចាប់ផ្ដើម\nមុននេះ មិនទាន់កត់ត្រាអ្វីទេ"); await v.look(T("go-setup").locator("xpath=.."), { zoom: 1.3, after: 1600 });
      await v.caption("ចុច «ចាប់ផ្តើមសៀវភៅបញ្ជី»"); await v.tap(T("go-setup")); await v.idle();
      await v.caption("ជ្រើសថ្ងៃចាប់ផ្ដើមសៀវភៅ"); const date = T("op-date"); await v.scrollTo(date); await v.tap(date, () => date.fill(d.openDate), { before: 1200 });
      await v.caption("វាយលុយដែលមាន នៅថ្ងៃនោះ\nសាច់ប្រាក់ ABA ACLEDA"); await v.type(T("op-cash-usd"), "2500", { before: 1200 });
      await v.type(T("op-cash-khr"), "2050000", { before: 800 }); await v.type(T("op-aba"), "12000", { before: 800 }); await v.type(T("op-acleda"), "4000", { before: 800 });
      await v.caption("ប្រាក់ចំណេញរក្សាទុក\nពីមុនពេលចាប់ផ្ដើមសៀវភៅ"); await v.type(T("op-retained"), "9000", { before: 1200 });
      await v.caption("ចុច «ចាប់ផ្តើមសៀវភៅបញ្ជី»\nធ្វើបានតែម្ដង"); const save = T("op-save"); await v.scrollTo(save); await v.tap(save);
      await v.tap(dlg().getByRole("button", { name: "បញ្ជាក់" }), null, { before: 1200 }); await v.idle(); await v.hold(800);
      await v.caption("ពីពេលនេះ វិក្កយបត្រ និងប្រាក់ទទួល\nកត់ត្រាដោយស្វ័យប្រវត្តិ"); await v.hold(2000);
    }),
    clip("L4-00_overview_v1", async (v, d, u) => {
      const { T } = u;
      await v.chapter("១ · របាយការណ៍");
      await v.caption("ចុច «គណនេយ្យ»\nចំណេញ ឬខាត ខែនេះ ឃើញភ្លាម"); await openAccounting(v, u); await v.look(T("pl-net"), { zoom: 1.4, after: 1800 });
      await v.chapter("២ · ចំណូល / ចំណាយ");
      await v.caption("កត់ចំណាយ ឬចំណូលផ្សេងៗ\nដោយចុចប៊ូតុងតែមួយ"); await v.tap(T("tab-money")); await v.idle(); await v.look(T("tx-expense"), { zoom: 1.4, after: 1800 });
      await v.chapter("៣ · ទិនានុប្បវត្តិ");
      await v.caption("វិក្កយបត្រ និងប្រាក់ទទួល ចូលឯង\nមិនបាច់វាយម្ដងទៀត"); await v.tap(T("tab-journal")); await v.idle(); await v.look(T("je-list"), { zoom: 1.25, after: 1800 });
      await v.chapter("៤ · ប្លង់គណនី");
      await v.caption("គណនីទាំងអស់ តាមប្រភេទ\nនីមួយៗមានសមតុល្យ"); await v.tap(T("tab-accounts")); await v.idle(); await v.hold(2200);
      await v.chapter("៥ · ការកំណត់");
      await v.caption("សមតុល្យដើម និងការបិទបញ្ជី\nសម្រាប់នាយកហិរញ្ញវត្ថុ"); await v.tap(T("tab-setup")); await v.idle(); await v.hold(2200);
      await v.caption("វីដេអូខ្លីៗ បង្ហាញការងារនីមួយៗ\nលម្អិត"); await v.hold(2200);
    }, seedYear),
    clip("L4-01_chart-of-accounts_v1", async (v, d, u) => {
      const { A, T, dlg } = u;
      await v.caption("ចុច «គណនេយ្យ» ហើយ «ប្លង់គណនី»"); await openAccounting(v, u, "accounts");
      await v.caption("ទ្រព្យសកម្ម បំណុល មូលធន\nនៅ «តារាងតុល្យការ»"); await v.look(A.getByText("តារាងតុល្យការ", { exact: true }).first(), { zoom: 1.6, after: 1400 });
      await v.caption("ចំណូល និងចំណាយ\nនៅ «របាយការណ៍លទ្ធផល»"); const pl = A.getByText("របាយការណ៍លទ្ធផល", { exact: true }).first(); await v.scrollTo(pl); await v.look(pl, { zoom: 1.6, after: 1400 });
      await v.caption("ប្រភេទគណនី កំណត់កន្លែងនេះឯង\nមិនបាច់ជ្រើសដោយដៃ"); await v.hold(1600);
      await v.caption("ចុច «គណនីថ្មី»"); const add = T("acc-new"); await v.scrollTo(add); await v.tap(add); await v.hold(300);
      await v.caption("វាយលេខកូដ និងជ្រើសប្រភេទ"); await v.type(T("acc-code"), "6065", { before: 1200 });
      const type = dlg().locator("select").first(); await v.tap(type, () => type.selectOption("expense"), { before: 1000 });
      await v.caption("វាយឈ្មោះគណនី ហើយរក្សាទុក"); await v.type(T("acc-name"), "ថ្លៃគេហទំព័រ", { before: 1200 }); await v.tap(T("acc-save"), null, { before: 1000 }); await v.idle(); await v.hold(600);
      await v.caption("គណនីប្រព័ន្ធ ប្ដូរបានតែឈ្មោះ\nគណនីប្រើហើយ មិនអាចលុប"); await v.hold(2000);
    }),
    clip("L4-03_record-transaction_v1", async (v, d, u) => {
      const { A, T, dlg } = u;
      await v.caption("ចុច «គណនេយ្យ»\nហើយ «ចំណូល/ចំណាយ»"); await openAccounting(v, u, "money");
      await v.caption("ចុច «ចំណាយ»"); await v.tap(T("tx-expense")); await v.hold(300);
      await v.caption("វាយចំនួនទឹកប្រាក់"); await v.type(T("tx-amount"), "45", { before: 1200 });
      await v.caption("ជ្រើសគណនីចំណាយ"); const acc = T("tx-account"); await v.tap(acc, () => acc.selectOption("6030"), { before: 1200 });
      await v.caption("ជ្រើសរបៀបបង់\nឬ «ជំពាក់» បើមិនទាន់បង់"); await v.tap(T("tx-pay").getByRole("radio", { name: "សាច់ប្រាក់ $" }), null, { before: 1200 });
      await v.caption("សរសេរពិពណ៌នា ហើយរក្សាទុក"); await v.type(T("tx-memo"), "សាំងឡាន ទៅការងារ", { before: 1200 }); await v.tap(T("tx-save"), null, { before: 1000 }); await v.idle(); await v.hold(600);
      await v.caption("ទិនានុប្បវត្តិ៖ ឥណពន្ធ = ឥណទាន\nប្រព័ន្ធធ្វើឲ្យ"); await v.tap(T("tab-journal")); await v.idle();
      await v.tap(T("je-list").getByText("សាំងឡាន ទៅការងារ").first(), null, { before: 1200 }); await v.idle(); await v.look(T("je-lines"), { zoom: 1.4, after: 1600 });
      await v.caption("គណនេយ្យករ៖ «កត់ត្រាថ្មី»\nសម្រាប់កត់ត្រាដោយដៃ");
      if (await A.locator('[role="dialog"]').count()) await v.tap(dlg().getByRole("button", { name: "close" }), null, { before: 900 }); // the entry's window
      await v.look(T("je-new"), { zoom: 1.6, after: 1600 });
    }),
    clip("L4-04_ledger-trial-balance_v1", async (v, d, u) => {
      const { T } = u;
      await v.caption("ចុច «គណនេយ្យ»\nហើយ «តុល្យភាពសាកល្បង»"); await openAccounting(v, u); await v.tap(T("rep-tb"), null, { before: 1000 }); await v.idle();
      await v.caption("៣ គូ៖ ខែនេះ · ដើមឆ្នាំដល់ខែមុន\n· ដើមឆ្នាំដល់ខែនេះ"); await v.look(T("tb-table"), { zoom: 1.25, after: 2000 });
      await v.caption("ឥណពន្ធ = ឥណទាន ✓\nបញ្ជីត្រឹមត្រូវ"); const ok = T("tb-balanced"); await v.scrollTo(ok); await v.look(ok, { zoom: 1.6, after: 1200 });
      await v.caption("បញ្ជីទូទៅ៖ វាយលេខកូដគណនី"); await v.tap(T("rep-gl")); await v.idle(); await v.type(T("gl-code"), "6040", { before: 1200 }); await v.idle();
      await v.caption("សមតុល្យដើម · ចលនានីមួយៗ\n· សមតុល្យចុង"); await v.look(T("gl"), { zoom: 1.25, after: 2000 });
      await v.caption("ចុច «ទាញយក Excel»"); const x = T("acct-csv").first(); await v.scrollTo(x); await v.download(x); await v.hold(1400);
    }),
    clip("L4-05_income-statement-balance-sheet_v1", async (v, d, u) => {
      const { A, T, preset } = u;
      await v.caption("ចុច «គណនេយ្យ»\nហើយ «របាយការណ៍លទ្ធផល»"); await openAccounting(v, u); await v.tap(T("rep-pl"), null, { before: 1000 }); await v.idle();
      await v.caption("ជ្រើស «ខែនេះ» ឬ «ខែមុន»"); await v.tap(preset("ខែនេះ"), null, { before: 1200 }); await v.idle();
      await v.caption("ចំណូល ក្នុងបុរី / ក្រៅបុរី"); await v.look(T("is-zones"), { zoom: 1.6, after: 1400 });
      await v.caption("ចំណេញសុទ្ធ ខែនេះ"); const net = T("pl-net"); await v.scrollTo(net); await v.look(net, { zoom: 1.6, after: 1400 });
      await v.caption("តារាងតុល្យការ៖ ខែមុន\nនិងបម្រែបម្រួល"); await v.tap(T("rep-bs")); await v.idle(); await v.look(T("bs-assets").locator("xpath=.."), { zoom: 1.25, after: 2000 });
      await v.caption("ទ្រព្យសកម្ម = បំណុល + មូលធន ✓"); const chk = A.getByText(/ទ្រព្យសកម្ម = បំណុល \+ មូលធន/).first(); await v.scrollTo(chk); await v.look(chk, { zoom: 1.6, after: 1600 });
    }),
    clip("L4-06_closing_v1", async (v, d, u) => {
      const { T, dlg } = u;
      await v.caption("ចុច «គណនេយ្យ» ហើយ «ការកំណត់»"); await openAccounting(v, u, "setup");
      await v.caption("ឆ្នាំមុនបញ្ចប់ហើយ?\nចុច «បិទឆ្នាំ»"); const close = T("close-year"); await v.scrollTo(close); await v.tap(close);
      await v.caption("ចំណេញឆ្នាំនោះ ចូល\nប្រាក់ចំណេញរក្សាទុក"); await v.tap(dlg().getByRole("button", { name: "បញ្ជាក់" }), null, { before: 1400 }); await v.idle(); await v.hold(600);
      await v.caption("ឆ្នាំបិទហើយ មិនអាចកត់ត្រាបន្ថែម"); await v.look(T("close-next"), { zoom: 1.5, after: 1400 });
      await v.caption("ចុងខែ៖ «បិទការិយបរិច្ឆេទ»\nដល់ថ្ងៃចុងខែ"); const lock = T("lock-input"); await v.scrollTo(lock); await v.tap(lock, () => lock.fill(lastMonthEnd), { before: 1200 });
      await v.tap(T("lock-save"), null, { before: 1000 }); await v.idle(); await v.hold(600);
      await v.caption("ថ្ងៃមុននោះ មិនអាចកែ ឬកត់ត្រាបន្ថែម\nសៀវភៅខែមុន នៅដដែល"); await v.hold(2200);
    }),
  ],
};
