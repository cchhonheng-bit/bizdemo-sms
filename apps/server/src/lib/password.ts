// Password hashing (argon2id, rule 6.2) + temporary password generation (same policy as v1 admin-users).
import { hash, verify } from "@node-rs/argon2";
import { randomInt } from "node:crypto";

const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const; // OWASP 2024 minimum for argon2id
const COMMON = new Set(["12345678", "password", "password1", "qwerty123", "11111111", "abcd1234", "iloveyou", "admin123", "oneteam123"]);

export const hashPassword = (pw: string) => hash(pw, OPTS);
export async function verifyPassword(pw: string, hashed: string | null | undefined): Promise<boolean> {
  try {
    return hashed ? await verify(hashed, pw, OPTS) : false;
  } catch {
    return false;
  }
}
/** dummy hash so a wrong username costs the same time as a wrong password */
export const DUMMY_HASH_PROMISE = hashPassword("dummy-password-for-timing-only");

export function validatePassword(pw: string): string | null {
  if (typeof pw !== "string" || pw.length < 8) return "PASSWORD_TOO_SHORT";
  if (pw.length > 72) return "PASSWORD_TOO_LONG";
  if (COMMON.has(pw.toLowerCase()) || /^(.)\1+$/.test(pw)) return "PASSWORD_TOO_COMMON";
  return null;
}

/** 10 chars, unambiguous alphabet (no 0/O/1/l/I), always letters + digits */
export function tempPassword(): string {
  const letters = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
  const digits = "23456789";
  const all = letters + digits;
  const out = [letters[randomInt(letters.length)]!, digits[randomInt(digits.length)]!];
  while (out.length < 10) out.push(all[randomInt(all.length)]!);
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out.join("");
}
