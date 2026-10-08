// Users administration (permission user.manage): the edit of one account — PATCH /api/users/:id and shop-setup (D-132) share it.
import type { z } from "zod";
import type { updateUserSchema } from "@sms/shared";
import { sql, tx } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { hashPassword } from "../lib/password.js";
import { audit } from "./audit.js";
import { revokeUserSessions, type SessionUser } from "./auth.js";
import { hubForgetChat } from "./telegram.js";

export const USER_COLS = sql`id, company_id, username, phone, email, full_name, role, language, is_active, must_change_password, tracks_attendance, is_lead,
  is_platform, telegram_user_id is not null as telegram_linked, created_at, updated_at`;
/** CEO 04-10: the HangKH support account belongs to the platform — the shop sees it but never changes it */
export const PLATFORM_LOCKED = () => new AppError("PLATFORM_USER", 403);
export type UserPatch = z.infer<typeof updateUserSchema> & { is_active?: boolean };

/** a new staff account (the Users page and shop-setup): the password checks and the one-time password stay with the caller */
export async function insertUser(actor: SessionUser, ip: string | null, b: { username: string; full_name: string; role: string; phone?: string | null; email?: string | null }, passwordHash: string): Promise<string> {
  return tx(actor.id, async (t) => {
    const id = (await t<{ id: string }[]>`insert into users (company_id, username, phone, email, full_name, role, password_hash)
      values (${actor.companyId}, ${b.username}, ${b.phone || null}, ${b.email || null}, ${b.full_name}, ${b.role}::user_role, ${passwordHash}) returning id`)[0]!.id;
    await audit(t, { companyId: actor.companyId, userId: actor.id, action: "user.create", table: "users", rowId: id, new: { username: b.username, role: b.role, full_name: b.full_name }, ip });
    return id;
  });
}

/** D-136 (shop-setup, HangKH, test phase): a simple shared test password — the strength rules waived — that ends at `until` (in the
 *  future); no new password at sign-in until then; afterwards the account must set its own before anything else (auth.ts). The
 *  password itself is never written anywhere but as its hash. Never the platform account. */
export async function setTestPassword(actor: SessionUser, ip: string | null, id: string, password: string, until: Date) {
  if (until.getTime() <= Date.now()) throw new AppError("TEST_PASSWORD_NEEDS_END", 400);
  const hash = await hashPassword(password);
  await tx(actor.id, async (t) => {
    const u = (await t<{ is_platform: boolean }[]>`select is_platform from users where id = ${id} and company_id = ${actor.companyId} for update`)[0];
    if (!u) throw notFound();
    if (u.is_platform) throw PLATFORM_LOCKED();
    await t`update users set password_hash = ${hash}, must_change_password = false where id = ${id}`; // the trigger clears the old end + test mark
    await t`update users set test_password_hash = password_hash, temp_password_expires_at = ${until} where id = ${id}`;
    await audit(t, { companyId: actor.companyId, userId: actor.id, action: "password.test_set", table: "users", rowId: id, new: { until }, ip });
  });
  await revokeUserSessions(id);
}

/** D-135 (shop-setup, HangKH): a new password at the next sign-in, and a deadline for the temporary password (null = none) — any
 *  new password clears the deadline (DB trigger). Never the platform account; the CEO account too (as the server's reset-password). */
export async function setPasswordRules(actor: SessionUser, ip: string | null, id: string, o: { mustChange?: boolean; tempExpires?: Date | null }) {
  return tx(actor.id, async (t) => {
    const old = (await t<{ must_change_password: boolean; temp_password_expires_at: Date | null; is_platform: boolean }[]>`
      select must_change_password, temp_password_expires_at, is_platform from users where id = ${id} and company_id = ${actor.companyId} for update`)[0];
    if (!old) throw notFound();
    if (old.is_platform) throw PLATFORM_LOCKED();
    const r = (await t<{ must_change_password: boolean; temp_password_expires_at: Date | null }[]>`update users set
        must_change_password = ${o.mustChange === true ? true : old.must_change_password},
        temp_password_expires_at = ${o.tempExpires !== undefined ? o.tempExpires : old.temp_password_expires_at}
      where id = ${id} returning must_change_password, temp_password_expires_at`)[0]!;
    await audit(t, { companyId: actor.companyId, userId: actor.id, action: "user.update", table: "users", rowId: id,
      old: { must_change_password: old.must_change_password, temp_password_expires_at: old.temp_password_expires_at }, new: r, ip });
    return r;
  });
}

/** never your own role or «active», never the platform account, a CEO account only by a CEO; turning someone off ends their
 *  sessions at once (S-05) and unlinks their Telegram here and at the hub — they stop receiving job messages (R6) */
export async function updateUser(actor: SessionUser, ip: string | null, id: string, patch: UserPatch) {
  if (id === actor.id && (patch.role !== undefined || patch.is_active !== undefined)) throw new AppError("CANNOT_CHANGE_SELF_ROLE", 400);
  if (patch.role === "ceo" && actor.role !== "ceo") throw new AppError("FORBIDDEN", 403);
  const result = await tx(actor.id, async (t) => {
    const old = (await t<Record<string, unknown>[]>`select ${USER_COLS} from users where id = ${id} and company_id = ${actor.companyId} for update`)[0];
    if (!old) throw notFound();
    if (old.is_platform) throw PLATFORM_LOCKED();
    if (old.role === "ceo" && actor.role !== "ceo") throw new AppError("FORBIDDEN", 403); // no one below the CEO may touch a CEO account
    const r = await t<Record<string, unknown>[]>`update users set
        full_name = coalesce(${patch.full_name ?? null}, full_name),
        username = coalesce(${patch.username ?? null}, username),
        phone = case when ${patch.phone !== undefined} then ${patch.phone || null} else phone end,
        email = case when ${patch.email !== undefined} then ${patch.email || null} else email end,
        role = coalesce(${patch.role ?? null}::user_role, role),
        is_active = coalesce(${patch.is_active ?? null}, is_active),
        is_lead = coalesce(${patch.is_lead ?? null}, is_lead),
        tracks_attendance = coalesce(${patch.tracks_attendance ?? null}, tracks_attendance),
        language = coalesce(${patch.language ?? null}, language)
      where id = ${id} returning ${USER_COLS}`;
    await audit(t, { companyId: actor.companyId, userId: actor.id, action: "user.update", table: "users", rowId: id, old, new: r[0], ip });
    return r[0]!;
  });
  if (patch.is_active === false || patch.role !== undefined) await revokeUserSessions(id);
  if (patch.is_active === false) {
    const tgRow = (await sql<{ telegram_chat_id: string | null }[]>`update users u set telegram_user_id = null, telegram_chat_id = null from users old
      where u.id = ${id} and old.id = u.id returning old.telegram_chat_id`)[0];
    if (tgRow?.telegram_chat_id) {
      await audit(sql, { companyId: actor.companyId, userId: actor.id, action: "telegram.unlink", table: "users", rowId: id, new: { reason: "deactivated" }, ip });
      await hubForgetChat(tgRow.telegram_chat_id);
    }
  }
  return { ok: true, user: { id: result.id, role: result.role, is_active: result.is_active } };
}
