/** Error codes are stable strings the web app maps to Khmer messages (same codes as v1). */
export class AppError extends Error {
  constructor(public code: string, public status = 400, public details?: unknown) {
    super(code);
  }
}
export const forbidden = (code = "FORBIDDEN") => new AppError(code, 403);
export const notFound = (code = "NOT_FOUND") => new AppError(code, 404);
export const unauthenticated = () => new AppError("UNAUTHENTICATED", 401);
export const bad = (code: string, details?: unknown) => new AppError(code, 400, details);

/** Map Postgres raise/constraint errors to API codes (mirrors v1 RPC errors). */
export function fromPg(e: unknown): AppError | null {
  const err = e as { code?: string; message?: string; constraint_name?: string };
  if (!err || typeof err !== "object") return null;
  const msg = err.message ?? "";
  if (err.code === "P0001") return new AppError(msg.split(":")[0]?.trim() || "RULE_VIOLATION", 400);
  if (err.code === "23505") {
    const c = err.constraint_name ?? msg;
    if (/username/.test(c)) return new AppError("USERNAME_TAKEN", 409);
    if (/phone/.test(c)) return new AppError("PHONE_TAKEN", 409);
    if (/email/.test(c)) return new AppError("EMAIL_TAKEN", 409);
    if (/telegram_user_id/.test(c)) return new AppError("TELEGRAM_ALREADY_LINKED", 409);
    if (/vehicles_company_id_code/.test(c)) return new AppError("VEHICLE_CODE_TAKEN", 409);
    return new AppError("DUPLICATE", 409);
  }
  // exclusion constraints (Booking Rules R2/R3): the database is the last line against double-booking
  if (err.code === "23P01") {
    const c = err.constraint_name ?? msg;
    if (/vehicle/.test(c)) return new AppError("VEHICLE_UNAVAILABLE", 409);
    if (/technicians/.test(c)) return new AppError("TECH_UNAVAILABLE", 409);
    return new AppError("SCHEDULE_CONFLICT", 409);
  }
  if (err.code === "23514" && /bookings_time_order/.test(err.constraint_name ?? msg)) return new AppError("END_BEFORE_START", 400);
  if (err.code === "23514" || err.code === "23502") return new AppError("INVALID_VALUE", 400);
  if (err.code?.startsWith("22")) return new AppError("INVALID_VALUE", 400); // data exceptions: bad uuid/date/number
  if (err.code === "23503") return new AppError("NOT_FOUND", 404);
  return null;
}
