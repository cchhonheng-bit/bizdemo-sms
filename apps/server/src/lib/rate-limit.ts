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

/** give back one hit (the attempt turned out to be legitimate) */
export function refundRate(key: string): void {
  const b = buckets.get(key);
  if (b && b.count > 0) b.count -= 1;
}

// lockouts (D-191): `tries` failures → refused for `minutes`, counted again from zero afterwards
const locks = new Map<string, { failed: number; until: number }>();
/** minutes left while the key is locked, else 0 */
export function lockedFor(key: string, now = Date.now()): number {
  const l = locks.get(key);
  return l && l.until > now ? Math.ceil((l.until - now) / 60_000) : 0;
}
/** one more failure; returns the minutes of the lock that starts now, else 0 */
export function failLock(key: string, tries: number, minutes: number, now = Date.now()): number {
  const l = locks.get(key) ?? { failed: 0, until: 0 };
  l.failed += 1;
  if (l.failed >= tries) { l.failed = 0; l.until = now + minutes * 60_000; }
  locks.set(key, l);
  if (locks.size > 50_000) for (const [k, v] of locks) if (v.until < now && v.failed === 0) locks.delete(k);
  return l.until > now ? minutes : 0;
}
export const clearLock = (key: string): void => { locks.delete(key); };

/** test helper */
export function resetRateLimits(): void {
  buckets.clear();
  locks.clear();
}

