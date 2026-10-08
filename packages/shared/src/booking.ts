// Booking domain constants shared by web + tests (Architecture §5).
export const BOOKING_STATUSES = [
  "new", "survey", "quoted", "assigned", "en_route", "on_site", "working", "work_done",
  "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed", "cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const SERVICE_CATEGORIES = ["mep", "construction", "decor", "camera"] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number];

export const BOOKING_TYPES = ["A", "B"] as const;
export type BookingType = (typeof BOOKING_TYPES)[number];

export const ZONES = ["inside", "outside"] as const;
export type Zone = (typeof ZONES)[number];

/** Board columns for M2 (later statuses are grouped so the board stays readable) */
export const BOARD_COLUMNS: { key: string; statuses: BookingStatus[] }[] = [
  { key: "new", statuses: ["new"] },
  { key: "survey", statuses: ["survey", "quoted"] },
  { key: "assigned", statuses: ["assigned"] },
  { key: "in_progress", statuses: ["en_route", "on_site", "working"] },
  { key: "done", statuses: ["work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"] },
];

/** statuses in which the booking form may still be edited / (re)assigned */
export const EDITABLE_STATUSES: BookingStatus[] = ["new", "survey", "quoted", "assigned"];
export const ASSIGNABLE_STATUSES: BookingStatus[] = ["new", "quoted", "assigned"];

/** R4: a booking can be cancelled until the work is finished (never once completed / invoiced) */
export const CANCELLABLE_STATUSES: BookingStatus[] = ["new", "survey", "quoted", "assigned", "en_route", "on_site", "working"];
/** R3: default job length when no catalog service is chosen (the staff can change it on the booking) */
export const DEFAULT_DURATION_MIN = 120;
/** R3: all schedule rules use this business time zone */
export const BUSINESS_TZ = "Asia/Phnom_Penh";

/** end = start + minutes (ISO strings) */
export function addMinutesIso(startIso: string, minutes: number): string {
  return new Date(new Date(startIso).getTime() + minutes * 60_000).toISOString();
}
/** [aStart, aEnd) and [bStart, bEnd) overlap? — back-to-back (aEnd === bStart) does NOT overlap */
export function rangesOverlap(aStart: string | Date, aEnd: string | Date, bStart: string | Date, bEnd: string | Date): boolean {
  const t = (x: string | Date) => new Date(x).getTime();
  return t(aStart) < t(bEnd) && t(bStart) < t(aEnd);
}
