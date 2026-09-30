// Date ranges for reports and attendance (local dates, YYYY-MM-DD).
export type Range = readonly [string, string];
export const shiftDay = (d: string, days: number) => new Date(Date.parse(`${d}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
export const PRESETS = ["today", "week", "month", "last"] as const;
export type Preset = (typeof PRESETS)[number];
export function presetRange(p: Preset, today: string): Range {
  const dow = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const month = today.slice(0, 8) + "01";
  const lastEnd = shiftDay(month, -1);
  return p === "today" ? [today, today] : p === "week" ? [shiftDay(today, -dow), today] : p === "month" ? [month, today] : [lastEnd.slice(0, 8) + "01", lastEnd];
}
