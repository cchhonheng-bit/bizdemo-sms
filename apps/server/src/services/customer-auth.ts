// Customer login (D-103/D-104 · final combined brief D-106…): phone + password — no Telegram Login Widget.
//  * The account of a phone number = the customer record with that phone that is linked to a Telegram chat. The password is
//    made by the server (4 random digits), sent ONCE to that chat by the shop bot, and only its argon2id hash is stored;
//    it is never logged, never shown in the app, never put into the outbox table or the audit log.
//  * Wrong passwords are counted PER PHONE in customer_login_guards — whether an account exists or not, so every answer is
//    the same for a known and an unknown number (no enumeration): 10 → 3 min, 15 → 5 min, 20 → 30 min, 30 → locked until a
//    new password through Telegram or an unlock by Admin / GM. A success clears the counter. Per visitor: 50 failures an hour.
//  * New password: ONLY from the bot, in the linked chat itself (CEO: no reset from the website — its «forgot password» opens
//    the bot); 3 an hour; every session ends.
//  * Linking by the bot's «share my phone» (Telegram tells the number the account really has): the customer of that number is
//    linked — or made — and gets its first password.
import { randomBytes, randomInt } from "node:crypto";
import { CUSTOMER_PASSWORD_MAX, CUSTOMER_PASSWORD_MIN, CUSTOMER_RESETS_PER_HOUR, customerLockFor, customerText, normalizeKhPhone, SITE_CONSENT_VERSION, weakCustomerPassword } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../lib/password.js";
import { checkRate, refundRate } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { btn, customerGrid, menuUrl, row, type CustomerMsg } from "./customer-bot.js";
import { customerByPhone } from "./requests.js";
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

// ---------- new password: from the bot only, into the linked chat itself ----------
/** «🔑 កំណត់ពាក្យសម្ងាត់ថ្មី»: the answer in that chat carries the new password (never logged); every session ends, the locks of
 *  the account's phones are cleared. A chat that holds only a booking link (not the customer record yet) waits for the staff. */
export async function resetPasswordFromBot(companyId: string, subscriberId: number): Promise<CustomerMsg> {
  const acc = await accountBySubscriber(companyId, subscriberId);
  if (!acc) return { text: customerText.passwordLater, buttons: row(btn.track()) };
  if (!acc.phones.every((p) => checkRate(`site:reset:phone:${p}`, CUSTOMER_RESETS_PER_HOUR, 3600))) return { text: customerText.tooManyResets };
  const pw = randomCustomerPassword(acc.phones);
  await sql`update customers set password_hash = ${await hashPassword(pw)}, password_set_at = now() where id = ${acc.id}`;
  await endSessions(sql, acc, null);
  await sql`delete from customer_login_guards where company_id = ${acc.company_id} and phone = any(${sql.array(acc.phones)})`;
  await audit(sql, { companyId: acc.company_id, userId: null, action: "customer.password_reset", source: "telegram", table: "customers", rowId: acc.id, new: { via: "bot" } });
  return { text: customerText.newPassword(pw), hint: customerText.hint, buttons: row(btn.login()) };
}

// ---------- link by «share my phone» in the bot ----------
/** Telegram vouches that this number belongs to the account (the hub accepts only the sender's OWN contact): the customer with
 *  that number is linked to the chat (an older link to another chat moves — the number moved), else a new customer is made with
 *  the consent just given in the bot. The first password comes with the answer. */
export async function linkByContact(subscriberId: number, phoneRaw: string, firstName: string | null): Promise<{ ok: boolean } & CustomerMsg> {
  const companyId = await siteCompanyId();
  const phone = normalizeKhPhone(phoneRaw);
  if (!companyId) return { ok: false, text: customerText.unavailable };
  if (!phone) return { ok: false, text: customerText.notKhPhone };
  const r = await tx(null, async (t) => {
    const mine = (await t<{ id: string; phones: string[] }[]>`select id, phones from customers where company_id = ${companyId} and tg_subscriber_id = ${subscriberId} and is_active order by created_at limit 1`)[0];
    let id = mine && mine.phones.includes(phone) ? mine.id : await customerByPhone(t, companyId, phone);
    let made = false;
    if (!id) {
      id = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, origin, consent_at, consent_version, consent_source)
        values (${companyId}, ${(firstName ?? "").trim().slice(0, 80) || phone}, ${t.array([phone])}, 'telegram', now(), ${SITE_CONSENT_VERSION}, 'bot') returning id`)[0]!.id;
      made = true;
    }
    const old = (await t<{ sub: string | null }[]>`select tg_subscriber_id::text as sub from customers where id = ${id} for update`)[0]!;
    if (old.sub !== String(subscriberId)) {
      await t`update customers set tg_subscriber_id = ${subscriberId} where id = ${id}`;
      if (old.sub) await t`delete from customer_sessions where customer_id = ${id}`; // the number moved to another Telegram account
    }
    await audit(t, { companyId, userId: null, action: "customer.tg_link", source: "telegram", table: "customers", rowId: id, new: { via: "contact", made, moved: !!old.sub && old.sub !== String(subscriberId) } });
    return { password: await issueInitialPassword(t, id) };
  });
  const keyboard = customerGrid();
  return r.password
    ? { ok: true, text: customerText.linked(null, r.password), hint: customerText.hint, keyboard, menu_url: menuUrl() }
    : { ok: true, text: customerText.linkedKnown, keyboard, menu_url: menuUrl() };
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
