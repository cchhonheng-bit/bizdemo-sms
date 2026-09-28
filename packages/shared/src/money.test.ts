import { describe, expect, it } from "vitest";
import { formatKhr, formatUsd, khrToCents, toCents, usdToKhr } from "./money";
import { can, DEFAULT_PERMISSIONS, FIXED_DENY_TECH } from "./permissions";
import { createUserSchema, loginSchema } from "./schemas";

describe("money", () => {
  it("converts to cents without float drift", () => {
    expect(toCents(18.5)).toBe(1850);
    expect(toCents("1,864.50")).toBe(186450);
    expect(toCents(0.1 + 0.2)).toBe(30);
  });
  it("formats", () => {
    expect(formatUsd(186450)).toBe("$1,864.50");
    expect(formatKhr(410000)).toBe("410,000៛");
  });
  it("AC-10: $640 invoice, paid $300 + 410,000៛ at 4,100 → balance $240", () => {
    const total = toCents(640);
    const paid = toCents(300) + khrToCents(410000, 4100);
    expect(khrToCents(410000, 4100)).toBe(10000);
    expect(total - paid).toBe(24000);
  });
  it("usd→khr rounds to 100 riel", () => {
    expect(usdToKhr(2150, 4100)).toBe(88200); // 88,150 → 88,200
  });
});

describe("permissions", () => {
  it("tech never has finance/cost", () => {
    for (const k of FIXED_DENY_TECH) expect(DEFAULT_PERMISSIONS.tech.includes(k)).toBe(false);
  });
  it("can()", () => {
    expect(can(["booking.create"], "booking.create")).toBe(true);
    expect(can(undefined, "booking.create")).toBe(false);
  });
});

describe("schemas", () => {
  it("login requires identifier + password", () => {
    expect(loginSchema.safeParse({ identifier: " kim ", password: "x" }).success).toBe(true);
    expect(loginSchema.safeParse({ identifier: "", password: "x" }).success).toBe(false);
  });
  it("create user validates username/phone", () => {
    expect(createUserSchema.safeParse({ username: "Kim.01", full_name: "Kim", role: "tech", phone: "012345678" }).success).toBe(true);
    expect(createUserSchema.safeParse({ username: "k", full_name: "Kim", role: "tech" }).success).toBe(false);
    expect(createUserSchema.safeParse({ username: "kim", full_name: "Kim", role: "tech", phone: "12345" }).success).toBe(false);
  });
});
