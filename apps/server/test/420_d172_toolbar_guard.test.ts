// D-172 guard: every route of the staff app (App.tsx) and every tab of the tabbed pages is either a list / table / report screen whose
// component carries <ReportToolbar> (or <ReportScreen>), or on the explicit exempt list (forms, details, prints, help). A new route or a new
// tab without a decision fails here. Plus a smoke test of the list exports (same rows as the screen's API, permission, technicians 403).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { filterList, LIST_REPORTS, LIST_SPECS } from "@sms/shared";
import { loginAs, makeApp, resetDb, seed, type Client } from "./helpers.js";
import { config } from "../src/config.js";
import { readWorkbook } from "../src/lib/xlsx.js";

const WEB = join(__dirname, "../../web/src");
const read = (f: string) => readFileSync(join(WEB, f), "utf8").replace(/\r\n/g, "\n");
const HAS = /<ReportToolbar\b|<ReportScreen\b/;
/** the source of one component: from its declaration to the next top-level component */
function component(file: string, name?: string): string {
  const s = read(file);
  if (!name) return s;
  const i = s.search(new RegExp(`\\n(?:export default |export )?function ${name}\\b`));
  if (i < 0) throw new Error(`${file}: no component ${name}`);
  const j = s.slice(i + 1).search(/\n(?:export default |export )?function [A-Z]/);
  return j < 0 ? s.slice(i) : s.slice(i, i + 1 + j);
}
type Target = [file: string, component?: string];

/** forms, details, prints, help — no list, so no toolbar (the reason is the decision) */
const EXEMPT: Record<string, string> = {
  "/login": "form", "/terms": "legal text", "/privacy": "legal text", "/tg": "Telegram entry", "/first-login": "form",
  "/quotes/:id/print": "print", "/invoices/:id/print": "print", "/subscribe/print": "print poster",
  "/bookings/new": "form", "/bookings/:id/edit": "form", "/bookings/:id": "detail",
  "/tech": "the technician's day — technicians never export (D-171)", "/tech/job/:id": "the technician's job — detail",
  "/quotes/new": "form", "/quotes/:id/edit": "form", "/invoices/:id": "detail", "/invoices/new": "form", "/invoices/:id/edit": "form",
  "/me": "own profile form", "/all_guide": "help videos", "/guide": "help videos", "/settings/company": "form", "/website": "form", "*": "redirect",
};
/** list / table / report screens → the component that must carry the toolbar (tabbed pages: see TABS) */
const SCREENS: Record<string, Target[] | "tabs"> = {
  "/dashboard": [["features/dashboard/DashboardPage.tsx", "DashboardPage"]], "/bookings": [["features/bookings/BookingsPage.tsx", "BookingsPage"]],
  "/customers": [["features/customers/CustomersPage.tsx", "CustomersPage"]], "/customers/boreys": [["features/customers/BoreysPage.tsx", "BoreysPage"]],
  "/requests": [["features/requests/RequestsPage.tsx", "RequestsPage"]], "/catalog": [["features/catalog/CatalogPage.tsx", "CatalogPage"]],
  "/subscribe": [["features/subscribe/SubscribePage.tsx", "SubscribePage"]], "/notifications": [["features/notifications/NotificationsPage.tsx", "NotificationsPage"]],
  "/leave": [["features/leave/LeavePage.tsx", "LeavePage"]], "/attendance": [["features/attendance/AttendancePage.tsx", "AttendancePage"]],
  "/reminders": [["features/reminders/RemindersPage.tsx", "RemindersPage"]], "/quotes": [["features/quotes/QuotesPage.tsx", "QuotesPage"]],
  "/settings/users": [["features/users/UsersPage.tsx", "UsersPage"]],
  "/inventory": "tabs", "/accounting": "tabs", "/reports": "tabs", "/invoices": "tabs",
};
const INV = "features/inventory/InventoryPage.tsx", REP = "features/accounting/Reports.tsx", INVO = "features/invoices/InvoicesPage.tsx", RPT = "features/reports/ReportsPage.tsx";
/** every tab of the tabbed pages (the union in the page's source) → its component, or "exempt" */
const TABS: Record<string, { file: string; union: RegExp; tabs: Record<string, Target | "exempt"> }> = {
  "/inventory": { file: INV, union: /type Tab = ([^;]+);/, tabs: { stock: [INV, "Stock"], withdrawals: [INV, "InventoryPage"], moves: [INV, "InventoryPage"], monthend: ["features/inventory/MonthEnd.tsx"],
    reconcile: [INV, "Reconcile"], payables: ["features/inventory/Payables.tsx", "Payables"], bybooking: ["features/inventory/ByBooking.tsx", "ByBooking"] } }, // D-189
  "/accounting": { file: "features/accounting/AccountingPage.tsx", union: /type Tab = ([^;]+);/, tabs: { reports: [REP, "Reports"], money: ["features/accounting/Money.tsx"],
    journal: ["features/accounting/Journal.tsx"], accounts: ["features/accounting/Accounts.tsx"], payroll: ["features/accounting/Payroll.tsx", "Payroll"], setup: "exempt" } },
  "/accounting · reports": { file: REP, union: /type View = ([^;]+);/, tabs: { pl: [REP, "Reports"], bs: [REP, "Reports"], tb: [REP, "Reports"], gl: [REP, "GL"], coa: [REP, "Reports"], acc: [REP, "Reports"] } },
  "/invoices": { file: INVO, union: /type Tab = ([^;]+);/, tabs: { approval: [INVO, "List"], todo: ["features/invoices/UninvoicedList.tsx"], draft: [INVO, "List"], unpaid: [INVO, "List"],
    paid: [INVO, "List"], void: [INVO, "List"], debts: [INVO, "Debts"] } },
  "/reports": { file: RPT, union: /type Tab = ([^;]+);/, tabs: { summary: [RPT, "ReportsPage"], cash: [RPT, "ReportsPage"], verify: [RPT, "ReportsPage"], audit: ["features/reports/AuditLog.tsx", "AuditLog"] } },
};

describe("D-172 every list screen carries the toolbar", () => {
  const routes = [...read("App.tsx").matchAll(/<Route path="([^"]+)"/g)].map((m) => m[1]!);
  it("every route of App.tsx is either a list screen or explicitly exempt — and no stale entries", () => {
    expect(routes.length).toBeGreaterThan(30);
    expect(routes.filter((r) => !(r in SCREENS) && !(r in EXEMPT)), "routes without a decision").toEqual([]);
    expect(Object.keys({ ...SCREENS, ...EXEMPT }).filter((r) => !routes.includes(r)), "decisions for routes that no longer exist").toEqual([]);
    expect(Object.keys(SCREENS).filter((r) => r in EXEMPT)).toEqual([]);
  });
  it("every list screen's component has <ReportToolbar>", () => {
    for (const [route, targets] of Object.entries(SCREENS)) {
      if (targets === "tabs") { expect(TABS[route], `${route}: tabs listed`).toBeTruthy(); continue; }
      for (const [file, name] of targets) expect(HAS.test(component(file, name)), `${route} → ${file}${name ? `#${name}` : ""}`).toBe(true);
    }
  });
  it("every tab (and sub-tab) of the tabbed pages is covered and carries the toolbar", () => {
    for (const [page, def] of Object.entries(TABS)) {
      const union = def.union.exec(read(def.file))?.[1]; expect(union, `${page}: tab union`).toBeTruthy();
      const tabs = [...union!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
      expect(tabs.filter((t) => !(t in def.tabs)), `${page}: tabs without a decision`).toEqual([]);
      expect(Object.keys(def.tabs).filter((t) => !tabs.includes(t)), `${page}: stale tabs`).toEqual([]);
      for (const [tab, target] of Object.entries(def.tabs)) if (target !== "exempt") expect(HAS.test(component(target[0], target[1])), `${page} · ${tab} → ${target[0]}#${target[1] ?? ""}`).toBe(true);
    }
  });
});

describe("D-172 list exports (the screen's own API, filtered like the screen)", () => {
  let app: FastifyInstance; let ceo: Client, gm: Client, kim: Client;
  beforeAll(async () => {
    config.shop.features = "website,subscribe,reminders,inventory,accounting";
    await resetDb(); await seed(); app = await makeApp();
    ceo = await loginAs(app, "ceo"); gm = await loginAs(app, "gm01"); kim = await loginAs(app, "kim");
  });
  afterAll(async () => { config.shop.features = ""; await app.close(); });
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Phnom_Penh" });
  const get = (c: Client, url: string) => app.inject({ method: "GET", url, headers: { cookie: c.cookie! } });
  it("CEO: every list report answers the D-169 standard file (header block, header row)", async () => {
    for (const r of LIST_REPORTS) {
      const res = await get(ceo, `/api/export/${r}.xlsx?from=${today}&to=${today}`);
      if ((r === "broadcasts" || r === "subscribers") && res.statusCode === 503) { expect(res.json().error).toBe("HUB_NOT_CONFIGURED"); continue; } // the screen reads the hub — not running in tests: the export passes the screen's answer through
      expect(res.statusCode, `${r}: ${res.body.slice(0, 120)}`).toBe(200);
      const rows = readWorkbook(res.rawPayload)[0]!.rows;
      expect(rows[0]![0], r).toBe("One Team Engineering"); expect(rows[4]![0], r).toMatch(/^Generated by /); expect(rows[6]!.length, r).toBeGreaterThan(0);
    }
  });
  it("users by role: the file's rows = the screen's API rows through the same filter; the preview too", async () => {
    const api = (await get(ceo, "/api/users")).json() as Record<string, unknown>[];
    const want = filterList(api, LIST_SPECS.users, { role: "tech" }).length;
    expect(want).toBeGreaterThan(0);
    const res = await get(ceo, "/api/export/users.xlsx?role=tech");
    expect(Number(res.headers["x-rows"])).toBe(want);
    expect(readWorkbook(res.rawPayload)[0]!.rows.filter((x) => x[2] === "tech").length).toBe(want);
    expect((await get(ceo, "/api/export/users.json?role=tech")).json().rows).toBe(want);
  });
  it("permission is the screen's (GM may not read users → 403); technicians never export (403)", async () => {
    expect((await get(gm, "/api/export/users.xlsx")).statusCode).toBe(403);
    expect((await get(kim, "/api/export/notifications.xlsx")).statusCode).toBe(403);
    expect((await get(kim, "/api/export/leave-mine.json")).statusCode).toBe(403);
  });
});
