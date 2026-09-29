import { describe, expect, it } from "vitest";
import { codeFromBytes, parseFeatures, parseLinkCode, parseSubscribe } from "./codes";

describe("telegram codes", () => {
  it("parses staff and group codes, case-insensitive, canonical upper-case", () => {
    expect(parseLinkCode("ONETEAM-S-7KQ2MX")).toEqual({ shop: "ONETEAM", kind: "staff", code: "ONETEAM-S-7KQ2MX" });
    expect(parseLinkCode(" oneteam-g-p4w9td ")).toEqual({ shop: "ONETEAM", kind: "group", code: "ONETEAM-G-P4W9TD" });
  });
  it("rejects ambiguous characters, wrong kinds and lengths", () => {
    for (const bad of ["ONETEAM-S-7KQ2M0", "ONETEAM-S-7KQ2MI", "ONETEAM-X-7KQ2MX", "ONETEAM-S-7KQ2M", "O-S-7KQ2MX", "ONE TEAM-S-7KQ2MX", "ONETEAM-S-7KQ2MXX", ""]) expect(parseLinkCode(bad)).toBeNull();
  });
  it("subscribe payload", () => {
    expect(parseSubscribe("s-ONETEAM")).toBe("ONETEAM");
    expect(parseSubscribe("s-oneteam")).toBe("ONETEAM");
    expect(parseSubscribe("ONETEAM-S-7KQ2MX")).toBeNull();
  });
  it("code alphabet is uniform and 6 long", () => {
    const c = codeFromBytes(new Uint8Array([0, 31, 32, 63, 255, 128]));
    expect(c).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
    expect(c[0]).toBe(c[2]);
  });
  it("feature flags", () => {
    expect(parseFeatures("subscribe, Quote,unknown")).toEqual(["subscribe", "quote"]);
    expect(parseFeatures(undefined)).toEqual([]);
  });
});

describe("per-shop bot codes (T3)", () => {
  it("plain codes: 8 for staff, 6 for group; legacy prefixed codes only for the same shop and kind", async () => {
    const { shopBotCode } = await import("./codes");
    expect(shopBotCode("7kq2mxab", "ONETEAM", "staff")).toBe("7KQ2MXAB");
    expect(shopBotCode("P4W9TD", "ONETEAM", "group")).toBe("P4W9TD");
    expect(shopBotCode("P4W9TD", "ONETEAM", "staff")).toBeNull();
    expect(shopBotCode("ONETEAM-G-P4W9TD", "ONETEAM", "group")).toBe("ONETEAM-G-P4W9TD");
    expect(shopBotCode("SHOPB-G-P4W9TD", "ONETEAM", "group")).toBeNull();
    expect(shopBotCode("ONETEAM-S-P4W9TD", "ONETEAM", "group")).toBeNull();
    for (const bad of ["P4W9T0", "P4W9TDX", "", "s", "hello"]) expect(shopBotCode(bad, "ONETEAM", "group")).toBeNull();
  });
});
