import { describe, expect, it } from "vitest";
import { addMinutesIso, CANCELLABLE_STATUSES, rangesOverlap } from "./booking";
import { assignSchema, bookingSchema, cancelSchema } from "./schemas";

describe("booking rules v1.3 (shared)", () => {
  it("overlap is half-open: back-to-back is allowed, one minute into the other is not", () => {
    expect(rangesOverlap("2026-10-10T02:00:00Z", "2026-10-10T04:00:00Z", "2026-10-10T04:00:00Z", "2026-10-10T06:00:00Z")).toBe(false);
    expect(rangesOverlap("2026-10-10T02:00:00Z", "2026-10-10T04:00:00Z", "2026-10-10T03:59:00Z", "2026-10-10T06:00:00Z")).toBe(true);
    expect(rangesOverlap("2026-10-10T02:00:00Z", "2026-10-10T04:00:00Z", "2026-10-10T01:00:00Z", "2026-10-10T07:00:00Z")).toBe(true);
  });
  it("end = start + duration", () => {
    expect(addMinutesIso("2026-10-10T02:00:00.000Z", 120)).toBe("2026-10-10T04:00:00.000Z");
  });
  it("R5: lead optional, at least one technician, lead not twice", () => {
    const u = "11111111-1111-4111-8111-111111111111", v = "22222222-2222-4222-8222-222222222222";
    expect(assignSchema.safeParse({ lead: "", assistants: [u], scheduled_at: "x" }).success).toBe(true);
    expect(assignSchema.safeParse({ lead: u, assistants: [], scheduled_at: "x" }).success).toBe(true);
    const none = assignSchema.safeParse({ lead: "", assistants: [], scheduled_at: "x" });
    expect(none.success).toBe(false); expect(none.error!.issues[0]!.message).toBe("TEAM_REQUIRED");
    expect(assignSchema.safeParse({ lead: u, assistants: [u, v], scheduled_at: "x" }).error!.issues[0]!.message).toBe("LEAD_IN_ASSISTANTS");
  });
  it("R4: reason required; completed / invoiced never cancellable", () => {
    expect(cancelSchema.safeParse({ reason: "  " }).success).toBe(false);
    expect(cancelSchema.safeParse({ reason: "អតិថិជនសុំលុប" }).success).toBe(true);
    for (const s of ["work_done", "invoiced", "closed", "cancelled"]) expect(CANCELLABLE_STATUSES).not.toContain(s);
  });
  it("booking form accepts an end time and a catalog service", () => {
    expect(bookingSchema.safeParse({ customer_id: "11111111-1111-4111-8111-111111111111", type: "A", category: "mep", service_text: "x", zone: "inside", ends_at: "2026-10-10T04:00:00Z", service_item_id: "" }).success).toBe(true);
  });
});
