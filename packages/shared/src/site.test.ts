import { describe, expect, it } from "vitest";
import { consentText, CONSENT_VERSION } from "./legal";
import { customerText, NIGHT_CONFIRM } from "./customer-text";
import { customerLockFor, fromPriceText, isNight, kmDigits, normalizeKhPhone, parseWebLines, SITE_CONSENT_VERSION, siteConsentLines, weakCustomerPassword, webHours, webLinesParam, webSlotStarts, WEB_HOURS_DEFAULT,
  workingMinutes } from "./site";

describe("public website helpers (D-96…)", () => {
  it("phone: national, with 0, with +855 → one form; garbage → null", () => {
    expect(normalizeKhPhone("12 345 678")).toBe("012345678");
    expect(normalizeKhPhone("012345678")).toBe("012345678");
    expect(normalizeKhPhone("+855 12 345 678")).toBe("012345678");
    expect(normalizeKhPhone("85 512 345")).toBe("085512345"); // a national number that happens to start with 855
    expect(normalizeKhPhone("12 34")).toBeNull();
    expect(normalizeKhPhone("abc")).toBeNull();
  });
  it("«from» price and Khmer numerals", () => {
    expect(fromPriceText(1500)).toBe("$15"); expect(fromPriceText(1550)).toBe("$15.50"); expect(fromPriceText(120000)).toBe("$1,200");
    expect(kmDigits(30)).toBe("៣០");
  });
  it("customer password: last 4 digits of the own phone, one repeated digit and straight runs are refused; 1212-style is fine", () => {
    for (const pw of ["1111", "0000", "1234", "4321", "0123", "6789", "7890", "9876", "5678", "aaaa"]) expect(weakCustomerPassword(pw, "012345999")).toBe(true);
    expect(weakCustomerPassword("5999", "012345999")).toBe(true);  // last 4 of the phone
    for (const pw of ["1212", "2580", "4827", "1357", "9070", "1122"]) expect(weakCustomerPassword(pw, "012345999")).toBe(false);
  });
  it("lock steps: 10 → 3 min, 15 → 5 min, 20 → 30 min, 30 → until reset; nothing in between", () => {
    expect(customerLockFor(9)).toBeNull(); expect(customerLockFor(10)).toEqual({ minutes: 3 }); expect(customerLockFor(11)).toBeNull();
    expect(customerLockFor(15)).toEqual({ minutes: 5 }); expect(customerLockFor(20)).toEqual({ minutes: 30 }); expect(customerLockFor(29)).toBeNull();
    expect(customerLockFor(30)).toEqual({ minutes: null }); expect(customerLockFor(31)).toEqual({ minutes: null });
  });
});

describe("final combined brief (D-106…): consent, booking hours, service lines", () => {
  const hm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  it("the bot's consent is the owner's exact text; the website shows the same three purposes under the button's name", () => {
    expect(consentText("One Team Engineering", "https://hub.hangkh.com/privacy")).toBe([
      "👋 សូមស្វាគមន៍! ចុះឈ្មោះទទួលដំណឹងពី «One Team Engineering»", "",
      "ពេលចុច «☑ យល់ព្រម» អ្នកយល់ព្រមលើ:",
      "1) ដំណឹងសេវាកម្មពី One Team Engineering",
      "2) ប្រូម៉ូសិនពី One Team Engineering",
      "3) HangKH រក្សាប្រវត្តិការចុះឈ្មោះ និងផ្ញើដំណឹងពីវេទិកា",
      " https://hub.hangkh.com/privacy"].join("\n"));
    expect(siteConsentLines("One Team Engineering", "កក់ និងភ្ជាប់ Telegram")).toEqual([
      "ពេលចុច «កក់ និងភ្ជាប់ Telegram» អ្នកយល់ព្រមលើ៖",
      "1) ដំណឹងសេវាកម្មពី One Team Engineering",
      "2) ប្រូម៉ូសិនពី One Team Engineering",
      "3) HangKH រក្សាប្រវត្តិការចុះឈ្មោះ និងផ្ញើដំណឹងពីវេទិកា"]);
    expect(siteConsentLines("One Team", "Book and connect Telegram", "en").join(" ")).not.toMatch(/[ក-៿]/);
    expect(SITE_CONSENT_VERSION).toBe(CONSENT_VERSION);
  });
  it("slots: 08:00–17:00, lunch 12:00–13:00 blocked, last start = close − duration, never across lunch", () => {
    expect(webSlotStarts(WEB_HOURS_DEFAULT, 120).map(hm)).toEqual(["08:00", "09:00", "10:00", "13:00", "14:00", "15:00"]);
    expect(webSlotStarts(WEB_HOURS_DEFAULT, 60).map(hm)).toEqual(["08:00", "09:00", "10:00", "11:00", "13:00", "14:00", "15:00", "16:00"]);
    expect(webSlotStarts(WEB_HOURS_DEFAULT, 240).map(hm)).toEqual(["08:00", "13:00"]);
    expect(webSlotStarts(WEB_HOURS_DEFAULT, 360)).toEqual([]); // longer than a half day: no online slot (the page offers a quote / a call)
    expect(webSlotStarts(webHours({ open: "07:30", close: "18:00", lunch_start: "11:30", lunch_end: "12:30" }), 120).map(hm)).toEqual(["08:00", "09:00", "13:00", "14:00", "15:00", "16:00"]);
    expect(webHours({ open: "25:00", close: "x" } as never)).toEqual(WEB_HOURS_DEFAULT); // nonsense falls back to the default
  });
  it("service lines in an address: id:qty pairs, 1–20 each, at most 8 lines, the same service twice is added up; anything else is refused", () => {
    const a = "11111111-1111-4111-8111-111111111111", b = "22222222-2222-4222-8222-222222222222";
    expect(parseWebLines(`${a}:2,${b}`)).toEqual([{ id: a, qty: 2 }, { id: b, qty: 1 }]);
    expect(parseWebLines(`${a}:2,${a}:3`)).toEqual([{ id: a, qty: 5 }]);
    expect(webLinesParam([{ id: a, qty: 2 }, { id: b, qty: 1 }])).toBe(`${a}:2,${b}:1`);
    for (const bad of ["", "x", `${a}:0`, `${a}:21`, `${a}:1.5`, `${a}:-1`, `not-a-uuid:1`, Array.from({ length: 9 }, (_, i) => `${a.slice(0, -1)}${i}:1`).join(",")]) expect(parseWebLines(bad)).toBeNull();
  });
});

describe("D-119 night rule: the pending-booking clock runs only 08:00–20:00 shop time", () => {
  const PP = "Asia/Phnom_Penh", at = (s: string) => new Date(`${s}+07:00`), add = (d: Date, min: number) => new Date(d.getTime() + min * 60_000);
  it("20:00–08:00 is night, 08:00–19:59 is day", () => {
    for (const s of ["2026-10-05T20:00:00", "2026-10-05T23:30:00", "2026-10-06T00:00:00", "2026-10-06T07:59:00"]) expect(isNight(at(s), PP)).toBe(true);
    for (const s of ["2026-10-06T08:00:00", "2026-10-06T12:00:00", "2026-10-06T19:59:00"]) expect(isNight(at(s), PP)).toBe(false);
  });
  it("made at night: 30 minutes are reached at 08:30, 60 at 09:00 (CEO)", () => {
    const made = at("2026-10-05T21:00:00");
    expect(workingMinutes(made, at("2026-10-06T07:59:00"), PP)).toBe(0);
    expect(workingMinutes(made, at("2026-10-06T08:29:00"), PP)).toBe(29);
    expect(workingMinutes(made, at("2026-10-06T08:30:00"), PP)).toBe(30);
    expect(workingMinutes(made, at("2026-10-06T09:00:00"), PP)).toBe(60);
    expect(workingMinutes(at("2026-10-06T02:15:00"), at("2026-10-06T08:30:00"), PP)).toBe(30); // after midnight: the same morning
  });
  it("made before 20:00: the minutes before closing count, the rest runs from 08:00", () => {
    const made = at("2026-10-05T19:45:00");
    expect(workingMinutes(made, at("2026-10-05T23:00:00"), PP)).toBe(15);
    expect(workingMinutes(made, at("2026-10-06T08:15:00"), PP)).toBe(30);
    expect(workingMinutes(made, at("2026-10-06T08:45:00"), PP)).toBe(60);
  });
  it("in the day the clock is the wall clock; across two nights both are skipped; nothing before the start", () => {
    const made = at("2026-10-06T10:00:00");
    expect(workingMinutes(made, add(made, 30), PP)).toBe(30);
    expect(workingMinutes(made, at("2026-10-07T09:00:00"), PP)).toBe(10 * 60 + 60);
    expect(workingMinutes(made, at("2026-10-08T09:00:00"), PP)).toBe(10 * 60 + 12 * 60 + 60);
    expect(workingMinutes(add(made, 5), made, PP)).toBe(0);
  });
  it("customer texts: «we confirm at 8 am» instead of «≤30 minutes» at night — the owner's exact words", () => {
    expect(NIGHT_CONFIRM.km).toBe("យើងនឹងបញ្ជាក់ ម៉ោង ៨ ព្រឹក");
    expect(customerText.received("BK-0007")).toContain("(≤៣០ នាទី)");
    expect(customerText.received("BK-0007", true)).toBe(`✅ បានទទួលការកក់ #BK-0007\n${NIGHT_CONFIRM.km}`);
    expect(customerText.linked("BK-0007", "4827", true).split("\n")).toEqual(["✅ ភ្ជាប់រួចរាល់", `ការកក់ #BK-0007 · ${NIGHT_CONFIRM.km}`, "🔑 ពាក្យសម្ងាត់៖ 4827", "ចូលដោយលេខទូរស័ព្ទ + ពាក្យសម្ងាត់នេះ"]);
    expect(customerText.linked("BK-0007", null)).not.toContain(NIGHT_CONFIRM.km);
  });
});
