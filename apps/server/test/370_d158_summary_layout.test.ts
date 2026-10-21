// D-158 (owner 21-10, «report very mess»): the Telegram summaries come in clear blocks — a title, then one block per topic
// (revenue · received · debt · jobs · voids and discounts · attendance), one fact per line, dates day-month-year.
import { describe, expect, it } from "vitest";
import { summaryText } from "../src/services/reports.js";

const data = {
  revenue: { total: 86800, invoices: 5, inside: 86800, outside: 0 },
  payments: { total: 8000, by_method: { cash_usd: 4500, cash_khr: 0, aba: 0, acleda: 3500 }, khr_riel: 0 },
  new_debt: 82300, debt_total: 88600,
  jobs: { created: 7, finished: 7, cancelled: 0, pending_review: 1, in_progress: 0 },
  voids: { count: 2, total: 59500 }, discounts: { count: 0, total: 0, over_limit: 0 },
  attendance: { present: 0, people: 3, late: 0, absent: 3, leave: 0, out_of_range: 0 },
} as any;

describe("D-158 summary layout", () => {
  it("daily (km): 7 blocks separated by a blank line, bullets, only the payment methods with money, day-month-year, «បោះបង់» not «លុប»", () => {
    const t = summaryText("daily", "2026-10-21", "2026-10-21", data, "km");
    const blocks = t.split("\n\n");
    expect(blocks[0]).toBe("📊 របាយការណ៍ប្រចាំថ្ងៃ · 21-10-2026");
    expect(blocks.length).toBe(7);
    expect(blocks[1]!.split("\n")).toEqual(["🧾 ចំណូល", "• វិក្កយបត្រ 5 · សរុប $868.00", "• ក្នុងបុរី $868.00 · ក្រៅបុរី $0.00"]);
    expect(blocks[2]!.split("\n")).toEqual(["💵 ទទួលប្រាក់ $80.00", "• សាច់ប្រាក់ $: $45.00", "• ACLEDA: $35.00"]);
    expect(blocks[3]!.split("\n")).toEqual(["📌 ជំពាក់", "• ថ្មី: $823.00", "• សរុបទាំងអស់: $886.00"]);
    expect(blocks[4]!.split("\n")).toEqual(["🔧 ការងារ", "• ថ្មី 7 · បញ្ចប់ 7 · បោះបង់ 0", "• រង់ចាំពិនិត្យ 1"]);
    expect(blocks[5]!.split("\n")).toEqual(["⚠️ មោឃៈ និងបញ្ចុះតម្លៃ", "• មោឃៈ 2 ($595.00)", "• បញ្ចុះតម្លៃ 0 ($0.00)"]);
    expect(blocks[6]!.split("\n")).toEqual(["👷 វត្តមាន (3 នាក់)", "• មក 0 · យឺត 0 · អវត្តមាន 3", "• ច្បាប់ 0 · ក្រៅរង្វង់ 0"]);
    expect(t).not.toContain("លុប");
    expect(t).not.toMatch(/[A-Za-z]{3,}/u.source.replace("ABA|ACLEDA", "") ? /\b(?!ABA|ACLEDA)[A-Za-z]{3,}\b/ : /x^/); // Khmer mode: no English words except the bank names (D-89)
  });
  it("no payment → «គ្មានការទទួលប្រាក់»; weekly / monthly titles; English version", () => {
    const none = { ...data, payments: { total: 0, by_method: { cash_usd: 0, cash_khr: 0, aba: 0, acleda: 0 }, khr_riel: 0 }, attendance: undefined };
    const t = summaryText("weekly", "2026-10-14", "2026-10-20", none, "km");
    expect(t.split("\n\n")[0]).toBe("📊 របាយការណ៍ប្រចាំសប្តាហ៍ · 14-10-2026 → 20-10-2026");
    expect(t).toContain("💵 ទទួលប្រាក់ $0.00\n• គ្មានការទទួលប្រាក់");
    expect(t.split("\n\n").length).toBe(6);
    const en = summaryText("monthly", "2026-09-01", "2026-09-30", data, "en");
    expect(en.split("\n\n")[0]).toBe("📊 Monthly report · 09-2026");
    expect(en).toContain("🧾 Revenue\n• 5 invoices · total $868.00");
    expect(en).toContain("👷 Attendance (3 people)\n• Present 0 · late 0 · absent 3\n• Leave 0 · out of range 0");
    expect(en).not.toMatch(/[ក-៿]/); // English mode: no Khmer (D-89)
  });
});
