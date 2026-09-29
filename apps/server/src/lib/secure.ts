import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { codeFromBytes } from "@sms/shared";

/** constant-time string comparison (secret headers, keys) */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest(), hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}
export const randomCode = (n = 6) => codeFromBytes(randomBytes(n), n);
export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
