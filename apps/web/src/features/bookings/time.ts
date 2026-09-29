// Date/time helpers for the booking screens. Phones in Cambodia run on Asia/Phnom_Penh, so the browser's local
// clock is the business clock (R3); the server re-checks every rule with absolute instants.
const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of today (min for the date picker — no past days offered) */
export function todayLocal(): string {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** ISO → { date: "YYYY-MM-DD", time: "HH:MM" } in local time */
export function splitLocal(iso: string | null | undefined): { date: string; time: string } {
  if (!iso) return { date: "", time: "" };
  const d = new Date(iso);
  return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}
/** local date + "HH:MM" → ISO (UTC) */
export function joinLocal(date: string, time: string): string {
  return new Date(`${date}T${time}`).toISOString();
}
/** "HH:MM" of date+time + minutes (same day, capped at 23:55 — longer jobs: set the end by hand) */
export function addMinutesLocal(date: string, time: string, minutes: number): string {
  const d = new Date(new Date(`${date}T${time}`).getTime() + minutes * 60_000);
  const sameDay = splitLocal(d.toISOString()).date === date;
  return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "23:55";
}
export const isPastLocal = (iso: string) => new Date(iso).getTime() < Date.now();
/** "09:00–11:00" */
export function timeRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "—";
  const s = splitLocal(startIso), e = splitLocal(endIso);
  return e.time ? `${s.time}–${e.time}` : s.time;
}
