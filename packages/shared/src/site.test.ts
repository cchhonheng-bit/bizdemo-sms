import { describe, expect, it } from "vitest";
import { customerLockFor, fromPriceText, kmDigits, normalizeKhPhone, weakCustomerPassword } from "./site";

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
