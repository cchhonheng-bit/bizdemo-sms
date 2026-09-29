// AES-256-GCM for bot tokens + webhook secrets at rest (T2). Key: HUB_TOKEN_KEY (32 bytes, base64) in /opt/hangkh/.env.
// Format "v1.<iv>.<tag>.<ciphertext>" (base64url). Wrong key / tampered value → throws, never returns garbage.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "../config.js";

function key(): Buffer {
  const k = Buffer.from(config.hub.tokenKey, "base64");
  if (k.length !== 32) throw new Error("HUB_TOKEN_KEY must be 32 bytes (base64) — generated on the server into .env");
  return k;
}
export function hasTokenKey(): boolean {
  try { key(); return true; } catch { return false; }
}
export function seal(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function open(sealed: string): string {
  const [v, iv, tag, data] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || !data) throw new Error("bad sealed value");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(data, "base64url")), d.final()]).toString("utf8");
}
