// The clock of the night rule (D-119): the time, and the day window in which the pending-booking timers run (08:00–20:00 shop
// time). An object so the tests can set both — the hour a test suite happens to run at must never change its result.
import { WEB_TIMER_HOURS } from "@sms/shared";

export const clock: { now: () => Date; day: { from: number; to: number } } = { now: () => new Date(), day: { ...WEB_TIMER_HOURS } };
