import { describe, expect, it } from "vitest";
import { BRAND, BRAND_PAIRS, contrast } from "./brand";

describe("brand tokens (D-90)", () => {
  it("contrast() matches the WCAG reference values", () => {
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 1);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBeCloseTo(1, 3);
    expect(contrast("#777777", "#FFFFFF")).toBeCloseTo(4.48, 1);
  });
  it("every text pair the UI uses meets WCAG AA", () => {
    for (const p of BRAND_PAIRS) expect(contrast(p.fg, p.bg), p.use).toBeGreaterThanOrEqual(p.min);
  });
  it("gold and bright teal are not small-text colours on white (so the tokens must not be used that way)", () => {
    expect(contrast(BRAND.gold, BRAND.white)).toBeLessThan(4.5);
    expect(contrast(BRAND.teal, BRAND.white)).toBeLessThan(4.5);
    expect(contrast(BRAND.tealText, BRAND.white)).toBeGreaterThanOrEqual(4.5); // the text-safe teal
  });
  it("tokens are the owner's values", () => {
    expect(BRAND).toMatchObject({ navy: "#14213D", teal: "#14B8A6", gold: "#C9A227" });
  });
});
