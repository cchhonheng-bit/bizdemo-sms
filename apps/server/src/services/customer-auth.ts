// Customer login (owner brief «WEBSITE v2 + CUSTOMER LOGIN — final», D-103/D-104): phone + password — no Telegram Login Widget.
//  * The account of a phone number = the customer record with that phone that is linked to a Telegram chat. The password is
//    made by the server (4 random digits), sent ONCE to that chat by the shop bot, and only its argon2id hash is stored;
//    it is never logged, never shown in the app, never put into the outbox table or the audit log.
//  * Wrong passwords are counted PER PHONE in customer_login_guards — whether an account exists or not, so every answer is
//    the same for a known and an unknown number (no enumeration): 10 → 3 min, 15 → 5 min, 20 → 30 min, 30 → locked until a
//    reset through Telegram or an unlock by Admin / GM. A success clears the counter. Per visitor: 50 failures an hour.
//  * Forgot password: a new random password goes ONLY to the Telegram chat linked to that phone; the screen says the same
//    thing whatever the number; 3 resets an hour per phone; every session ends.
import { randomBytes, randomInt } from "node:crypto";
import { CUSTOMER_PASSWORD_HINT, CUSTOMER_PASSWORD_MAX, CUSTOMER_PASSWORD_MIN, customerLockFor, normalizeKhPhone, weakCustomerPassword } from "@sms/shared";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../lib/password.js";
import { checkRate, refundRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { hubCall, hubConfigured } from "./hub-client.js";
import { siteCompanyId } from "./site.js";

// ---------- passwords ----------
const weakFor = (pw: string, phones: string[]) => (phones.length ? phones.some((p) => weakCustomerPassword(pw, p)) : weakCustomerPassword(pw, ""));
/** 4 random digits that pass the same rules a customer's own choice must pass */
export function randomCustomerPassword(phones: string[]): string {
  for (;;) {
    const pw = String(randomInt(10_000)).padStart(4, "0");
    if (!weakFor(pw, phones)) return pw;
  }
}
/** the bot message that carries a password (customers get Khmer): the password, how to use it, the advice to change it, the hint */
export const passwordMessage = (pw: string, kind: "initial" | "reset"): string => [
  kind === "initial" ? "🔑 ពាក្យសម្ងាត់សម្រាប់ចូលគណនីរបស់អ្នក៖" : "🔑 ពាក្យសម្ងាត់ថ្មីរបស់អ្នក៖", pw, "",
  "ចូលគណនីដោយ លេខទូរស័ព្ទរបស់អ្នក និងពាក្យសម្ងាត់នេះ។ សូមប្ដូរវាជាលេខដែលអ្នកចងចាំ នៅក្នុង «ការកក់របស់ខ្ញុំ»។", "", CUSTOMER_PASSWORD_HINT.km,
].join("\n");

/** one message to one subscriber of this shop through the hub (never the outbox table: the text may carry a password) */
export async function tellSubscriber(subscriberId: number, text: string): Promise<boolean> {
  if (!hubConfigured()) return false;
  const r = await Promise.race([
    hubCall("POST", "/internal/notify-subscriber", { subscriber_id: subscriberId, text: text.slice(0, 1000) }).catch(() => null),
    new Promise<null>((resolve) => { setTimeout(() => resolve(null), 4000).unref(); }),
  ]);
  return !!r && r.status === 200 && r.json?.ok === true;
}

// ---------- accounts ----------
type Account = { id: string; company_id: string; sub: string; hash: string | null; phones: string[] };
const ACCOUNT = sql`c.id, c.company_id, c.tg_subscriber_id::text as sub, c.password_hash as hash, c.phones`;
/** the customer record of this phone that is linked to a Telegram chat (the one with a password first) */
async function accountByPhone(companyId: string, phone: string): Promise<Account | null> {
  return (await sql<Account[]>`select ${ACCOUNT} from customers c where c.company_id = ${companyId} and c.is_active and c.tg_subscriber_id is not null and ${phone} = any(c.phones)
    order by (c.password_hash is not null) desc, c.created_at limit 1`)[0] ?? null;
}
async function accountBySubscriber(companyId: string, subscriberId: number): Promise<Account | null> {
  return (await sql<Account[]>`select ${ACCOUNT} from customers c where c.company_id = ${companyId} and c.is_active and c.tg_subscriber_id = ${subscriberId} and cardinality(c.phones) > 0
    order by (c.password_hash is not null) desc, c.created_at limit 1`)[0] ?? null;
}

/** a customer record has just been linked to a Telegram chat: its first password, once. Returns the password for the ONE
 *  message that carries it (null when the record already has one). Runs inside the caller's transaction. */
export async function issueInitialPassword(t: Db, customerId: string): Promise<string | null> {
  const c = (await t<{ company_id: string; phones: string[]; has: boolean }[]>`select company_id, phones, password_hash is not null as has from customers where id = ${customerId} for update`)[0];
  if (!c || c.has || !c.phones.length) return null;
  const pw = randomCustomerPassword(c.phones);
  await t`update customers set password_hash = ${await hashPassword(pw)}, password_set_at = now() where id = ${customerId}`;
  await audit(t, { companyId: c.company_id, userId: null, action: "customer.password_sent", source: "system", table: "customers", rowId: customerId, new: { kind: "initial" } });
  return pw;
}

// ---------- sessions (cookie "otc", separate from staff sessions) ----------
export async function newCustomerSession(v: { companyId: string; subscriberId: number; customerId: string | null; tgUser: number; name: string | null; via: "password" | "telegram" }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await sql`insert into customer_sessions (company_id, subscriber_id, customer_id, tg_user, name, via, token_hash, expires_at)
    values (${v.companyId}, ${v.subscriberId}, ${v.customerId}, ${v.tgUser}, ${v.name?.slice(0, 100) ?? null}, ${v.via}, ${sha256(token)}, now() + ${config.sessionDays}::int * interval '1 day')`;
  return token;
}
const endSessions = (db: Db, a: { id: string; sub: string }, exceptSession: string | null) =>
  db`delete from customer_sessions where (customer_id = ${a.id} or subscriber_id = ${a.sub}::bigint) ${exceptSession ? db`and id <> ${exceptSession}` : db``}`;

// ---------- login ----------
export async function passwordLogin(ip: string, phoneRaw: string, password: string): Promise<{ token: string }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  const ipKey = `site:login-fail:ip:${ip}`;
  if (!checkRate(ipKey, 50, 3600)) throw new AppError("RATE_LIMITED", 429); // a success gives the hit back: only failures count
  const phone = normalizeKhPhone(phoneRaw);
  if (!phone || !password || password.length > CUSTOMER_PASSWORD_MAX) {
    await verifyPassword(password.slice(0, CUSTOMER_PASSWORD_MAX), await DUMMY_HASH_PROMISE);
    throw new AppError("INVALID_CREDENTIALS", 401);
  }
  const g = (await sql<{ locked_until: Date | null; permanent: boolean }[]>`select locked_until, permanent from customer_login_guards where company_id = ${companyId} and phone = ${phone}`)[0];
  if (g?.permanent) throw new AppError("LOCKED_PERMANENT", 423);
  if (g?.locked_until && g.locked_until.getTime() > Date.now()) throw new AppError("LOCKED", 423, { minutes: Math.max(1, Math.ceil((g.locked_until.getTime() - Date.now()) / 60_000)) });
  const acc = await accountByPhone(companyId, phone);
  // an unknown number costs the same time as a wrong password and gets the same answer
  const ok = (await verifyPassword(password, acc?.hash ?? (await DUMMY_HASH_PROMISE))) && !!acc?.hash;
  if (!ok) {
    const failed = (await sql<{ failed: number }[]>`insert into customer_login_guards (company_id, phone, failed) values (${companyId}, ${phone}, 1)
      on conflict (company_id, phone) do update set failed = customer_login_guards.failed + 1, updated_at = now() returning failed`)[0]!.failed;
    const lock = customerLockFor(failed);
    if (!lock) throw new AppError("INVALID_CREDENTIALS", 401);
    await sql`update customer_login_guards set permanent = ${lock.minutes === null}, locked_until = case when ${lock.minutes === null} then null else now() + ${lock.minutes ?? 0}::int * interval '1 minute' end
      where company_id = ${companyId} and phone = ${phone}`;
    await audit(sql, { companyId, userId: null, action: "customer.login_locked", source: "system", table: "customers", rowId: acc?.id ?? null, new: { phone, failed, minutes: lock.minutes }, ip });
    throw lock.minutes === null ? new AppError("LOCKED_PERMANENT", 423) : new AppError("LOCKED", 423, { minutes: lock.minutes });
  }
  refundRate(ipKey);
  await sql`delete from customer_login_guards where company_id = ${companyId} and phone = ${phone}`; // the counter starts again after a success
  return { token: await newCustomerSession({ companyId, subscriberId: Number(acc!.sub), customerId: acc!.id, tgUser: 0, name: null, via: "password" }) };
}

// ---------- change (needs the current password; other sessions end) ----------
export async function changeCustomerPassword(s: { id: string; companyId: string; subscriberId: number; customerId: string | null }, ip: string | null, current: string, next: string) {
  if (!checkRate(`site:pw-change:${s.subscriberId}`, 10, 3600)) throw new AppError("RATE_LIMITED", 429);
  const acc = s.customerId
    ? (await sql<Account[]>`select ${ACCOUNT} from customers c where c.id = ${s.customerId} and c.company_id = ${s.companyId} and c.is_active and c.tg_subscriber_id is not null`)[0] ?? null
    : await accountBySubscriber(s.companyId, s.subscriberId);
  if (!acc) throw new AppError("NOT_LINKED", 409);
  if (!(await verifyPassword(current, acc.hash ?? (await DUMMY_HASH_PROMISE))) || !acc.hash) throw new AppError("WRONG_PASSWORD", 400);
  if (next.length < CUSTOMER_PASSWORD_MIN) throw new AppError("PASSWORD_TOO_SHORT", 400);
  if (next.length > CUSTOMER_PASSWORD_MAX) throw new AppError("PASSWORD_TOO_LONG", 400);
  if (weakFor(next, acc.phones)) throw new AppError("WEAK_PASSWORD", 400);
  await sql`update customers set password_hash = ${await hashPassword(next)}, password_set_at = now() where id = ${acc.id}`;
  await endSessions(sql, acc, s.id);
  await audit(sql, { companyId: s.companyId, userId: null, action: "customer.password_changed", source: "system", table: "customers", rowId: acc.id, ip });
  return { ok: true };
}

// ---------- reset (forgot password): a new password to the linked Telegram chat only ----------
const resetAllowed = (phones: string[]) => phones.every((p) => checkRate(`site:reset:phone:${p}`, 3, 3600));
/** store the new password, end every session, clear the locks of the account's phones. `deliver`: send it first — when the
 *  message cannot be delivered nothing changes. Returns the password for the message, or null. */
async function resetPassword(acc: Account, via: "web" | "bot", ip: string | null, deliver: boolean): Promise<string | null> {
  const pw = randomCustomerPassword(acc.phones);
  if (deliver && !(await tellSubscriber(Number(acc.sub), passwordMessage(pw, "reset")))) return null;
  await sql`update customers set password_hash = ${await hashPassword(pw)}, password_set_at = now() where id = ${acc.id}`;
  await endSessions(sql, acc, null);
  await sql`delete from customer_login_guards where company_id = ${acc.company_id} and phone = any(${sql.array(acc.phones)})`;
  await audit(sql, { companyId: acc.company_id, userId: null, action: "customer.password_reset", source: via === "bot" ? "telegram" : "system", table: "customers", rowId: acc.id, new: { via }, ip });
  return pw;
}
let lastReset: Promise<void> = Promise.resolve();
/** tests wait for the work behind the last «forgot password» request */
export const resetSettled = () => lastReset;
/** the login page's «forgot password»: the answer is ALWAYS the same and comes at once — the work runs behind it, so neither
 *  the text nor the time tells whether the number has an account */
export function requestPasswordReset(ip: string, phoneRaw: string): { ok: true } {
  lastReset = (async () => {
    const companyId = await siteCompanyId(), phone = normalizeKhPhone(phoneRaw);
    if (!companyId || !phone) return;
    if (!checkRate(`site:reset:ip:${ip}`, 10, 3600) || !resetAllowed([phone])) return;
    const acc = await accountByPhone(companyId, phone);
    if (acc) await resetPassword(acc, "web", ip, true);
  })().catch(() => undefined);
  return { ok: true };
}
/** «ភ្លេចពាក្យសម្ងាត់» in the bot: the chat itself is the linked one — the answer in that chat carries the new password */
export async function resetPasswordFromBot(companyId: string, subscriberId: number): Promise<string> {
  const acc = await accountBySubscriber(companyId, subscriberId);
  if (!acc) return "សូមភ្ជាប់ Telegram ជាមុនសិន៖ កក់សេវា រួចចុច «ភ្ជាប់ Telegram (១ ចុច)»។";
  if (!resetAllowed(acc.phones)) return "⏳ អ្នកបានស្នើពាក្យសម្ងាត់ថ្មីច្រើនដងពេក។ សូមព្យាយាមម្ដងទៀតក្រោយមួយម៉ោង។";
  return passwordMessage((await resetPassword(acc, "bot", null, false))!, "reset");
}

// ---------- staff: lock state + unlock (Admin / GM — customer.manage), audit logged ----------
export async function customerLoginState(companyId: string, phones: string[]): Promise<"none" | "timed" | "permanent"> {
  if (!phones.length) return "none";
  const g = (await sql<{ permanent: boolean | null; timed: boolean | null }[]>`select bool_or(permanent) as permanent, bool_or(locked_until > now()) as timed
    from customer_login_guards where company_id = ${companyId} and phone = any(${sql.array(phones)})`)[0];
  return g?.permanent ? "permanent" : g?.timed ? "timed" : "none";
}
export async function unlockCustomerLogin(user: SessionUser, ip: string | null, customerId: string) {
  const c = (await sql<{ phones: string[] }[]>`select phones from customers where id = ${customerId} and company_id = ${user.companyId}`)[0];
  if (!c) throw notFound();
  const r = c.phones.length ? await sql`delete from customer_login_guards where company_id = ${user.companyId} and phone = any(${sql.array(c.phones)})` : { count: 0 };
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "customer.login_unlocked", table: "customers", rowId: customerId, new: { cleared: r.count }, ip });
  return { ok: true, cleared: r.count };
}
