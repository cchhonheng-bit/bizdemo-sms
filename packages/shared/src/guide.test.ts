import { describe, expect, it } from "vitest";
import { GUIDE_ROLE_TAB, GUIDE_TABS, GUIDE_VIDEOS, guideHelpVideo } from "./guide";

describe("the video guide (D-128 / D-129)", () => {
  it("35 videos, each in a tab; every staff role has its own tab; every video has a Khmer and an English title", () => {
    expect(GUIDE_VIDEOS).toHaveLength(35);
    const inTabs = new Set(GUIDE_TABS.flatMap((t) => t.videos));
    expect(inTabs.size).toBe(35);
    for (const t of GUIDE_TABS) for (const id of t.videos) expect(GUIDE_VIDEOS.some((v) => v.id === id)).toBe(true);
    for (const role of ["tech", "admin", "gm", "ceo", "cfo"]) expect(GUIDE_TABS.some((t) => t.key === GUIDE_ROLE_TAB[role])).toBe(true);
    for (const v of GUIDE_VIDEOS) { expect(v.title).toMatch(/[ក-៿]/); expect(v.title_en).toMatch(/^[A-Z][A-Za-z ,'-]+$/); }
  });
  it("the help (?) button: the page's own clip (the longest match), else the position's overview", () => {
    expect(guideHelpVideo("admin", "/requests")).toBe("L2-01");
    expect(guideHelpVideo("admin", "/bookings")).toBe("L2-05");
    expect(guideHelpVideo("admin", "/bookings/new")).toBe("L2-03");
    expect(guideHelpVideo("admin", "/bookings/5f0c")).toBe("L2-04");
    expect(guideHelpVideo("admin", "/catalog")).toBe("L2-06");
    expect(guideHelpVideo("engineer", "/tech")).toBe("L1-01");
    expect(guideHelpVideo("engineer", "/tech/job/5f0c")).toBe("L1-03");
    expect(guideHelpVideo("ceo", "/settings/users")).toBe("L3-04");
    expect(guideHelpVideo("cfo", "/accounting")).toBe("L4-00");
    expect(guideHelpVideo("ceo", "/dashboard")).toBe("L3-00");
    expect(guideHelpVideo("engineer", "/me")).toBe("L1-00");
    expect(guideHelpVideo("admin", "/requestsX")).toBe("L2-00"); // a different page that only starts the same
  });
});
