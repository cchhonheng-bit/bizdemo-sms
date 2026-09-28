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
