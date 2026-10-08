// Login / sessions (rule 6.2, 6.3): argon2id, session cookie backed by the `sessions` table,
// rate limit 5/min/IP + 10/h/identifier, identical error for every failure (no enumeration).
import { createHash, randomBytes } from "node:crypto";
import { sql } from "../db.js";
import { config } from "../config.js";
import { AppError } from "../lib/errors.js";
import { checkRate } from "../lib/rate-limit.js";
import { DUMMY_HASH_PROMISE, verifyPassword } from "../lib/password.js";
import { audit } from "./audit.js";

export type SessionUser = {
  id: string; companyId: string; role: string; username: string; fullName: string;
  mustChangePassword: boolean; language: "km" | "en"; sessionId: string;
};

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function login(identifier: string, password: string, companySlug: string | undefined, ip: string, userAgent: string | undefined) {
  const id = identifier.trim();
  if (!checkRate(`login:ip:${ip}`, 5, 60) || !checkRate(`login:id:${id.toLowerCase()}`, 10, 3600)) {
    throw new AppError("RATE_LIMITED", 429);
  }
  // up to 2 candidates (same username in two companies) — the password decides
  const rows = await sql<{ id: string; company_id: string; password_hash: string; is_active: boolean; company_active: boolean; must_change_password: boolean; temp_password_expires_at: Date | null; test_password_hash: string | null }[]>`
    select u.id, u.company_id, u.password_hash, u.is_active, c.is_active as company_active, u.must_change_password, u.temp_password_expires_at, u.test_password_hash
    from users u join companies c on c.id = u.company_id
    where (u.phone = ${id} or lower(u.email) = ${id.toLowerCase()}
           or (u.username = ${id.toLowerCase()} and (${companySlug ?? null}::text is null or c.slug = ${companySlug ?? null})))
    limit 2`;
  let hit: (typeof rows)[number] | null = null;
  for (const r of rows) {
    if (!r.is_active || !r.company_active) continue;
    if (await verifyPassword(password, r.password_hash)) { hit = r; break; }
  }
  if (!hit) {
    await verifyPassword(password, await DUMMY_HASH_PROMISE); // constant-ish timing
    throw new AppError("INVALID_CREDENTIALS", 401);
  }
  const ended = !!hit.temp_password_expires_at && hit.temp_password_expires_at.getTime() <= Date.now();
  // D-136: still on a test password past its end → in, but the person sets their own before anything else (never locked out)
  if (ended && onTestPassword(hit)) await testPasswordEnded(hit, ip);
  // D-135: a temporary password past its deadline (the person never set their own) — told only after the right password
  else if (ended && hit.must_change_password) {
    await audit(sql, { companyId: hit.company_id, userId: hit.id, action: "auth.password_expired", table: "users", rowId: hit.id, ip });
    throw new AppError("PASSWORD_EXPIRED", 403);
  }
  return createSession(hit.id, ip, userAgent, "password");
}

/** D-136: still on the test password HangKH set (the hash it was set with is the current one) */
const onTestPassword = (u: { password_hash: string; test_password_hash: string | null }) => !!u.test_password_hash && u.test_password_hash === u.password_hash;
/** D-136: the test password's end has passed — from now on the account must set its own password (once, audited) */
async function testPasswordEnded(u: { id: string; company_id: string; must_change_password: boolean }, ip: string | null): Promise<void> {
  if (u.must_change_password) return;
  const r = await sql`update users set must_change_password = true where id = ${u.id} and not must_change_password returning id`;
  if (r.length) await audit(sql, { companyId: u.company_id, userId: u.id, action: "auth.test_password_ended", table: "users", rowId: u.id, ip });
}

/** a new session for a known user (password login, or a Telegram Mini App opened by a linked staff member — D-91) */
export async function createSession(userId: string, ip: string, userAgent: string | undefined, via: "password" | "telegram") {
  const token = randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + config.sessionDays * 86400_000);
  await sql`insert into sessions (user_id, token_hash, expires_at, ip, user_agent)
            values (${userId}, ${hashToken(token)}, ${expires}, ${ip}, ${(userAgent ?? "").slice(0, 200)})`;
  const u = (await sql<{ company_id: string; must_change_password: boolean }[]>`select company_id, must_change_password from users where id = ${userId}`)[0]!;
  await audit(sql, { companyId: u.company_id, userId, action: "auth.login", table: "users", rowId: userId, new: { via }, ip });
  return { token, expires, userId, mustChangePassword: u.must_change_password };
}

export async function logout(token: string): Promise<void> {
  await sql`delete from sessions where token_hash = ${hashToken(token)}`;
}

/** Resolve a session token → user (null when invalid/expired/inactive). Sliding expiry, touched at most every 10 min. */
export async function resolveSession(token: string): Promise<SessionUser | null> {
  const rows = await sql<{
    sid: string; id: string; company_id: string; role: string; username: string; full_name: string;
    must_change_password: boolean; language: "km" | "en"; last_seen_at: Date; password_hash: string; test_password_hash: string | null; temp_password_expires_at: Date | null;
  }[]>`
    select s.id as sid, u.id, u.company_id, u.role, u.username, u.full_name, u.must_change_password, u.language, s.last_seen_at,
      u.password_hash, u.test_password_hash, u.temp_password_expires_at
    from sessions s join users u on u.id = s.user_id join companies c on c.id = u.company_id
    where s.token_hash = ${hashToken(token)} and s.expires_at > now() and u.is_active and c.is_active`;
  const r = rows[0];
  if (!r) return null;
  if (Date.now() - new Date(r.last_seen_at).getTime() > 10 * 60_000) {
    await sql`update sessions set last_seen_at = now(), expires_at = now() + make_interval(days => ${config.sessionDays}) where id = ${r.sid}`;
  }
  // D-136: a session opened during the test phase meets the end too — the next click asks for the person's own password
  let mustChange = r.must_change_password;
  if (!mustChange && r.temp_password_expires_at && r.temp_password_expires_at.getTime() <= Date.now() && onTestPassword(r)) { await testPasswordEnded(r, null); mustChange = true; }
  return { id: r.id, companyId: r.company_id, role: r.role, username: r.username, fullName: r.full_name, mustChangePassword: mustChange, language: r.language, sessionId: r.sid };
}

export async function revokeUserSessions(userId: string, exceptSession?: string): Promise<void> {
  await sql`delete from sessions where user_id = ${userId} and (${exceptSession ?? null}::uuid is null or id <> ${exceptSession ?? null})`;
}

export async function userById(id: string) {
  const r = await sql<{ id: string; company_id: string; role: string; username: string; full_name: string; is_active: boolean }[]>`
    select id, company_id, role, username, full_name, is_active from users where id = ${id}`;
  return r[0] ?? null;
}

export async function cleanupSessions(): Promise<number> {
  const r = await sql`delete from sessions where expires_at < now()`;
  return r.count;
}
