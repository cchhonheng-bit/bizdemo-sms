// In-memory fixed-window rate limiter (S-06). One process per box → no shared store needed.
const buckets = new Map<string, { windowStart: number; count: number }>();
let lastSweep = Date.now();

/** Returns true when the call is allowed. key e.g. "login:ip:1.2.3.4". */
export function checkRate(key: string, limit: number, windowSec: number, now = Date.now()): boolean {
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec * 1000;
  const b = buckets.get(key);
  if (!b || b.windowStart !== windowStart) {
    buckets.set(key, { windowStart, count: 1 });
  } else {
    b.count += 1;
  }
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, v] of buckets) if (now - v.windowStart > 2 * 3600_000) buckets.delete(k);
  }
  return (buckets.get(key)?.count ?? 0) <= limit;
}

/** test helper */
export function resetRateLimits(): void {
  buckets.clear();
}

/** true while the key is still under its limit in the current window (does not count a hit) */
export function underLimit(key: string, limit: number, windowSec: number, now = Date.now()): boolean {
  const windowStart = Math.floor(now / 1000 / windowSec) * windowSec * 1000;
  const b = buckets.get(key);
  return !b || b.windowStart !== windowStart || b.count < limit;
}
