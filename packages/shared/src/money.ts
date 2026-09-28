// Money helpers: USD stored as integer cents, KHR as integer riel (Architecture §4.1).
export type Cents = number;

export function toCents(usd: number | string): Cents {
  const n = typeof usd === "string" ? Number(usd.replace(/[^0-9.-]/g, "")) : usd;
  if (!Number.isFinite(n)) throw new Error("INVALID_AMOUNT");
  return Math.round(n * 100);
}

export function fromCents(cents: Cents): number {
  return cents / 100;
}

export function formatUsd(cents: Cents, locale: "km" | "en" = "km"): string {
  const v = fromCents(cents);
  const s = v.toLocaleString(locale === "km" ? "en-US" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `$${s}`;
}

export function formatKhr(riel: number): string {
  return `${Math.round(riel).toLocaleString("en-US")}៛`;
}

/** USD cents → KHR riel at rate (KHR per USD). Rounded to nearest 100 riel (common practice). */
export function usdToKhr(cents: Cents, rate: number, roundTo = 100): number {
  const riel = (cents / 100) * rate;
  return Math.round(riel / roundTo) * roundTo;
}

/** KHR riel → USD cents at rate. */
export function khrToCents(riel: number, rate: number): Cents {
  return Math.round((riel / rate) * 100);
}
