// Password policy (S-10): length ≥ 8 and not in the common-password list.
// The list is intentionally small here; extend via COMMON_PASSWORDS env (comma separated).
const BASE = [
  "12345678", "123456789", "1234567890", "password", "password1", "qwerty123", "11111111", "00000000",
  "abcd1234", "iloveyou", "admin123", "welcome1", "letmein1", "12341234", "87654321", "passw0rd",
  "1q2w3e4r", "asdfghjk", "qwertyui", "zxcvbnm1", "oneteam1", "oneteam123", "cambodia", "phnompenh",
];
const EXTRA = (Deno.env.get("COMMON_PASSWORDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const COMMON = new Set([...BASE, ...EXTRA]);

export function validatePassword(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "PASSWORD_TOO_SHORT";
  if (pw.length > 72) return "PASSWORD_TOO_LONG";
  if (COMMON.has(pw.toLowerCase())) return "PASSWORD_TOO_COMMON";
  if (/^(.)\1+$/.test(pw)) return "PASSWORD_TOO_COMMON";
  return null;
}

/** Temporary password for admin-created users / resets: 10 chars, unambiguous alphabet. */
export function tempPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}
