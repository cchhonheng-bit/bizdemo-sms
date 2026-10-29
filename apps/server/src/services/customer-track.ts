// D-191 the customer's tracking timeline (Grab-style): បានទទួល → បានចាត់ជាង → ជាងកំពុងមក → ដល់ហើយ → កំពុងធ្វើ → រួចរាល់ → វិក្កយបត្រ →
// បានបង់. Each step is done once the booking reached it (the time = its first entry in booking_status_log); the next one is «now».
// A job closes when its invoice is paid in full, so «paid» = closed. Shared by the guest page (/book/done/<ref>) and the account's
// booking page (/my/b/<id>); the staff's own statuses stay inside.
import type { Db } from "../db.js";

export const TRACK_STEPS = ["received", "assigned", "on_the_way", "arrived", "working", "done", "invoice", "paid"] as const;
export type TrackStep = (typeof TRACK_STEPS)[number];
export type TrackLine = { key: TrackStep; done: boolean; now: boolean; at: string | null };
export type Track = { steps: TrackLine[]; waiting: boolean; ended: "cancelled" | "declined" | "expired" | null };

/** how far a booking status reached (index of its last done step) */
const REACHED: Record<string, number> = {
  new: 0, survey: 0, quoted: 0, assigned: 1, en_route: 2, on_site: 3, working: 4,
  work_done: 5, pending_review: 5, revision: 5, reviewed: 5, invoiced: 6, partially_paid: 6, closed: 7,
};
/** the log status that marks each step */
const MARK: Partial<Record<TrackStep, string[]>> = { assigned: ["assigned"], on_the_way: ["en_route"], arrived: ["on_site"], working: ["working"],
  done: ["work_done"], invoice: ["invoiced", "partially_paid"], paid: ["closed"] };

export async function trackOf(db: Db, bookingId: string): Promise<Track> {
  const b = (await db<{ status: string; web_status: string | null; created_at: Date; finished_at: Date | null }[]>`select status, web_status, created_at, finished_at from bookings where id = ${bookingId}`)[0];
  if (!b) return { steps: [], waiting: false, ended: null };
  if (b.status === "cancelled") return { steps: [], waiting: false, ended: b.web_status === "declined" ? "declined" : b.web_status === "expired" ? "expired" : "cancelled" };
  const log = await db<{ to_status: string; at: Date }[]>`select to_status::text, min(at) as at from booking_status_log where booking_id = ${bookingId} group by to_status`;
  const when = (k: TrackStep): Date | null => {
    if (k === "received") return b.created_at;
    const hit = log.filter((x) => MARK[k]?.includes(x.to_status)).map((x) => x.at).sort((p, q) => p.getTime() - q.getTime())[0];
    return hit ?? (k === "done" ? b.finished_at : null);
  };
  const reached = REACHED[b.status] ?? 0, waiting = b.web_status === "pending";
  return {
    waiting, ended: null,
    steps: TRACK_STEPS.map((key, i) => ({ key, done: i <= reached, now: waiting ? i === 0 : i === reached + 1, at: i <= reached ? when(key)?.toISOString() ?? null : null })),
  };
}
