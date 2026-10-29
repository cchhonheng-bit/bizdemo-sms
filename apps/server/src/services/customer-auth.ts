// Customer account (D-191, owner 29-10 — replaces the passwords sent by Telegram, D-103 … D-190): phone + a 4-digit PIN the
// customer chooses on the website right after a booking (or later on its tracking page).
//  * The account of a phone = the active customer record with that number that holds a PIN (customers.password_hash = its argon2id
//    hash; an older password keeps working until it is changed). The PIN is never sent anywhere, never logged, never in an address.
//  * What an account sees (customer-home.ts `mine`): every booking of its phone once the number is verified — the record was made by
//    this booking, the staff confirmed a booking, Telegram vouched for the number (shared contact / its linked chat got a reset
//    code) or the shop gave a reset code; before that only the bookings made from the account's first booking on
//    (customers.pin_history_from), so a phone number typed by somebody else opens nobody's history.
//  * Wrong PINs: every 5th failure of a phone locks it 15 minutes — whether an account exists or not (the same answer for a known and
//    an unknown number); the same per visitor; and at most 30 sign-in calls a minute per visitor.
//  * Forgot PIN: a 6-digit code into the linked Telegram chat (the bot's «🔑 ភ្លេច PIN» or the website's form), or the shop reads a
//    code from the app to the customer on the phone. The code changes the PIN on the website; every session of the account ends.
//  * Sessions: one per device (httpOnly cookie «otc»), 180 days, renewed while used; «sign out everywhere»; a new PIN ends the others.
import { createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { CUSTOMER_PASSWORD_MAX, CUSTOMER_PIN_LOCK_MIN, CUSTOMER_PIN_TRIES, CUSTOMER_RESETS_PER_HOUR, CUSTOMER_SESSION_DAYS, customerLockFor, customerPinProblem, customerText,
  normalizeKhPhone, PIN_CODE_MINUTES, PIN_CODE_TRIES, pinDigits, SITE_CONSENT_VERSION } from "@sms/shared";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import { DUMMY_HASH_PROMISE, hashPassword, verifyPassword } from "../lib/password.js";
import { checkRate, clearLock, failLock, lockedFor } from "../lib/rate-limit.js";
import { sha256 } from "../lib/secure.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";
import { btn, customerGrid, menuUrl, row, tellSubscriber, type CustomerMsg } from "./customer-bot.js";
import { customerByPhone } from "./requests.js";
import { isTestPhone } from "./test-mode.js";
import { siteCompanyId } from "./site.js";

// ---------- accounts ----------
type Account = { id: string; company_id: string; sub: string | null; hash: string | null; phones: string[]; is_test: boolean };
const ACCOUNT = sql`c.id, c.company_id, c.tg_subscriber_id::text as sub, c.password_hash as hash, c.phones, c.is_test`;
/** the record that answers for a phone: the one with a PIN first (for a test phone the test record first — D-120) */
async function accountByPhone(db: Db, companyId: string, phone: string): Promise<Account | null> {
  const test = await isTestPhone(db, companyId, phone);
  return (await db<Account[]>`select ${ACCOUNT} from customers c where c.company_id = ${companyId} and c.is_active and ${phone} = any(c.phones)
    order by (c.is_test = ${test}) desc, (c.password_hash is not null) desc, (c.tg_subscriber_id is not null) desc, c.created_at limit 1`)[0] ?? null;
}
async function accountBySubscriber(db: Db, companyId: string, subscriberId: number): Promise<Account | null> {
  return (await db<Account[]>`select ${ACCOUNT} from customers c where c.company_id = ${companyId} and c.is_active and c.tg_subscriber_id = ${subscriberId} and cardinality(c.phones) > 0
    order by (c.password_hash is not null) desc, c.created_at limit 1`)[0] ?? null;
}
/** the number is now known to belong to this customer: the account sees its whole history (D-191) */
export async function verifyAccount(db: Db, customerId: string): Promise<void> {
  await db`update customers set pin_history_from = null where id = ${customerId} and pin_history_from is not null`;
}
function pinOf(pin: string, pin2: string | undefined, phones: string[]): string {
  const p = pinDigits(pin);
  if (pin2 !== undefined && p !== pinDigits(pin2)) throw new AppError("PIN_MISMATCH", 400);
  const bad = customerPinProblem(p, phones);
  if (bad) throw new AppError(bad, 400);
  return p;
}

// ---------- sessions (cookie "otc", separate from staff sessions) ----------
export async function newCustomerSession(db: Db, v: { companyId: string; subscriberId: number | null; customerId: string | null; tgUser?: number; name?: string | null; via: "pin" | "telegram" }): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await db`insert into customer_sessions (company_id, subscriber_id, customer_id, tg_user, name, via, token_hash, expires_at)
    values (${v.companyId}, ${v.subscriberId}, ${v.customerId}, ${v.tgUser ?? 0}, ${v.name?.slice(0, 100) ?? null}, ${v.via}, ${sha256(token)}, now() + ${CUSTOMER_SESSION_DAYS}::int * interval '1 day')`;
  return token;
}
/** every session of the account (its PIN sessions and those of its Telegram chat), except `keep` */
const endSessions = (db: Db, a: { id: string; sub: string | null }, keep: string | null) =>
  db`delete from customer_sessions where (customer_id = ${a.id} ${a.sub ? db`or subscriber_id = ${a.sub}::bigint` : db``}) ${keep ? db`and id <> ${keep}` : db``}`;

// ---------- wrong PINs: per phone (table, survives a restart) + per visitor (memory) ----------
const ipKey = (ip: string) => `site:pin-fail:ip:${ip}`;
async function assertNotLocked(companyId: string, phone: string | null, ip: string) {
  const ipLeft = lockedFor(ipKey(ip));
  if (ipLeft) throw new AppError("LOCKED", 423, { minutes: ipLeft });
  if (!phone) return;
  const g = (await sql<{ locked_until: Date | null }[]>`select locked_until from customer_login_guards where company_id = ${companyId} and phone = ${phone}`)[0];
  if (g?.locked_until && g.locked_until.getTime() > Date.now()) throw new AppError("LOCKED", 423, { minutes: Math.max(1, Math.ceil((g.locked_until.getTime() - Date.now()) / 60_000)) });
}
async function failed(companyId: string, phone: string | null, ip: string, accountId: string | null, error: "INVALID_CREDENTIALS" | "CODE_INVALID"): Promise<never> {
  const ipLock = failLock(ipKey(ip), CUSTOMER_PIN_TRIES, CUSTOMER_PIN_LOCK_MIN);
  let lock = ipLock ? { minutes: ipLock } : null;
  if (phone) {
    const n = (await sql<{ failed: number }[]>`insert into customer_login_guards (company_id, phone, failed) values (${companyId}, ${phone}, 1)
      on conflict (company_id, phone) do update set failed = customer_login_guards.failed + 1, updated_at = now() returning failed`)[0]!.failed;
    const l = customerLockFor(n);
    if (l) {
      await sql`update customer_login_guards set locked_until = now() + ${l.minutes}::int * interval '1 minute' where company_id = ${companyId} and phone = ${phone}`;
      await audit(sql, { companyId, userId: null, action: "customer.login_locked", source: "system", table: "customers", rowId: accountId, new: { phone, failed: n, minutes: l.minutes }, ip });
      lock = l;
    }
  }
  throw lock ? new AppError("LOCKED", 423, { minutes: lock.minutes }) : new AppError(error, error === "CODE_INVALID" ? 400 : 401);
}
const cleared = async (db: Db, companyId: string, phones: string[], ip: string | null) => {
  if (phones.length) await db`delete from customer_login_guards where company_id = ${companyId} and phone = any(${db.array(phones)})`;
  if (ip) clearLock(ipKey(ip));
};

// ---------- sign in: phone + PIN ----------
export async function pinLogin(ip: string, phoneRaw: string, pinRaw: string): Promise<{ token: string }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (!checkRate(`site:login:ip:${ip}`, 30, 60)) throw new AppError("RATE_LIMITED", 429);
  const phone = normalizeKhPhone(phoneRaw), pin = pinDigits(pinRaw).slice(0, CUSTOMER_PASSWORD_MAX);
  await assertNotLocked(companyId, phone, ip);
  const acc = phone ? await accountByPhone(sql, companyId, phone) : null;
  // an unknown number costs the same time as a wrong PIN and gets the same answer
  const ok = (await verifyPassword(pin, acc?.hash ?? (await DUMMY_HASH_PROMISE))) && !!acc?.hash && !!pin;
  if (!ok) return failed(companyId, phone, ip, acc?.id ?? null, "INVALID_CREDENTIALS");
  await cleared(sql, companyId, [phone!], ip);
  await audit(sql, { companyId, userId: null, action: "customer.login", source: "system", table: "customers", rowId: acc!.id, new: { via: "pin" }, ip });
  return { token: await newCustomerSession(sql, { companyId, subscriberId: acc!.sub ? Number(acc!.sub) : null, customerId: acc!.id, via: "pin" }) };
}

// ---------- the account right after a booking (the booking's own address is the key — only its maker knows it) ----------
export type AccountInput = { ref: string; name: string; phone: string; address?: string | null; lat?: number | null; lng?: number | null; pin: string; pin2: string };
/** «បង្កើតគណនី ដើម្បីតាមដាន Booking»: the PIN goes on the booking's customer record. A record made by this booking takes the name,
 *  number and address as typed; an older record (a known number) is not touched — its number cannot change here and its history
 *  stays hidden until the number is verified. One account per number: a number that already has a PIN signs in instead. */
export async function createAccountFromBooking(ip: string, v: AccountInput): Promise<{ token: string; booking_id: string }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (!checkRate(`site:account:ip:${ip}`, 10, 3600)) throw new AppError("RATE_LIMITED", 429);
  return tx(null, async (t) => {
    const b = (await t<{ id: string; number: string; customer_id: string; created_at: Date; has: boolean; phones: string[]; is_test: boolean; fresh: boolean }[]>`
      select b.id, b.number, b.customer_id, b.created_at, c.password_hash is not null as has, c.phones, c.is_test,
        not exists (select 1 from bookings o where o.customer_id = b.customer_id and o.id <> b.id) as fresh
      from bookings b join customers c on c.id = b.customer_id
      where b.web_ref = ${v.ref} and b.company_id = ${companyId} and b.created_at > now() - interval '7 days' for update of c`)[0];
    if (!b) throw notFound();
    if (b.has) throw new AppError("ACCOUNT_EXISTS", 409);
    let phones = b.phones;
    const phone = normalizeKhPhone(v.phone);
    if (!phone) throw new AppError("INVALID_PHONE", 400);
    if (!phones.includes(phone)) {
      if (!b.fresh) throw new AppError("PHONE_LOCKED", 400);
      if ((await t`select 1 from customers where company_id = ${companyId} and is_active and is_test = ${b.is_test} and id <> ${b.customer_id} and ${phone} = any(phones)`).length) throw new AppError("PHONE_TAKEN", 409);
      phones = [phone];
    }
    if ((await t`select 1 from customers where company_id = ${companyId} and is_active and is_test = ${b.is_test} and id <> ${b.customer_id} and phones && ${t.array(phones)} and password_hash is not null`).length)
      throw new AppError("ACCOUNT_EXISTS", 409);
    const pin = pinOf(v.pin, v.pin2, phones);
    const name = v.name.trim().replace(/\s+/g, " ");
    if (b.fresh && (name.length < 2 || name.length > 80)) throw new AppError("NAME_REQUIRED", 400);
    const address = (v.address ?? "").trim().replace(/\s+/g, " ").slice(0, 300);
    if (b.fresh) await t`update customers set name = ${name}, phones = ${t.array(phones)}, address = coalesce(${address || null}, address),
      lat = coalesce(${v.lat ?? null}::float8, lat), lng = coalesce(${v.lng ?? null}::float8, lng) where id = ${b.customer_id}`;
    await t`update customers set password_hash = ${await hashPassword(pin)}, password_set_at = now(), pin_history_from = ${b.fresh ? null : b.created_at} where id = ${b.customer_id}`;
    await audit(t, { companyId, userId: null, action: "customer.account_created", source: "system", table: "customers", rowId: b.customer_id, new: { booking: b.number, fresh: b.fresh }, ip });
    return { token: await newCustomerSession(t, { companyId, subscriberId: null, customerId: b.customer_id, via: "pin" }), booking_id: b.id };
  });
}

// ---------- forgot PIN: a one-time code (bot → the linked chat, or the shop reads it to the customer) ----------
const codeHash = (customerId: string, code: string) => createHmac("sha256", config.sessionSecret).update(`pin-code:${customerId}:${code}`).digest("hex");
async function newCode(db: Db, a: { id: string; company_id: string }, via: "bot" | "staff", by: string | null): Promise<string> {
  const code = String(randomInt(1_000_000)).padStart(6, "0");
  await db`update customer_pin_codes set used_at = now() where customer_id = ${a.id} and used_at is null`; // one live code at a time
  await db`insert into customer_pin_codes (company_id, customer_id, code_hash, via, expires_at, created_by)
    values (${a.company_id}, ${a.id}, ${codeHash(a.id, code)}, ${via}, now() + ${PIN_CODE_MINUTES[via]}::int * interval '1 minute', ${by})`;
  return code;
}
const codeMsg = (code: string): CustomerMsg => ({ text: customerText.pinCode(code, PIN_CODE_MINUTES.bot), buttons: row(btn.pin()) });

/** the website's «forgot PIN»: when the number belongs to a record linked to Telegram, the code goes to that chat. The answer is the
 *  same either way (no enumeration); 3 an hour per number. */
export async function sendPinCode(ip: string, phoneRaw: string): Promise<{ ok: true }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  const phone = normalizeKhPhone(phoneRaw);
  if (!phone) throw new AppError("INVALID_PHONE", 400);
  if (!checkRate(`site:pin-code:ip:${ip}`, 10, 3600) || !checkRate(`site:pin-code:phone:${phone}`, CUSTOMER_RESETS_PER_HOUR, 3600)) throw new AppError("RATE_LIMITED", 429);
  const test = await isTestPhone(sql, companyId, phone);
  const a = (await sql<Account[]>`select ${ACCOUNT} from customers c where c.company_id = ${companyId} and c.is_active and c.tg_subscriber_id is not null and ${phone} = any(c.phones)
    order by (c.is_test = ${test}) desc, (c.password_hash is not null) desc, c.created_at limit 1`)[0];
  if (a) {
    const code = await newCode(sql, a, "bot", null);
    await audit(sql, { companyId, userId: null, action: "customer.pin_code", source: "system", table: "customers", rowId: a.id, new: { via: "bot", from: "website" }, ip });
    await tellSubscriber(Number(a.sub), codeMsg(code));
  }
  return { ok: true };
}
/** the bot's «🔑 ភ្លេច PIN» in a linked chat: the code comes as the answer (into this chat only) */
export async function pinCodeFromBot(companyId: string, subscriberId: number): Promise<CustomerMsg> {
  const a = await accountBySubscriber(sql, companyId, subscriberId);
  if (!a) return { text: customerText.pinLater, buttons: row(btn.track()) };
  if (!a.phones.every((p) => checkRate(`site:pin-code:phone:${p}`, CUSTOMER_RESETS_PER_HOUR, 3600))) return { text: customerText.tooManyResets };
  const code = await newCode(sql, a, "bot", null);
  await audit(sql, { companyId, userId: null, action: "customer.pin_code", source: "telegram", table: "customers", rowId: a.id, new: { via: "bot" } });
  return codeMsg(code);
}
/** the shop (customer.manage): a code to read to the customer on the phone — shown once, never stored in plain; the number's
 *  locks are cleared too */
export async function staffPinCode(user: SessionUser, ip: string | null, customerId: string): Promise<{ code: string; minutes: number }> {
  const a = (await sql<Account[]>`select ${ACCOUNT} from customers c where c.id = ${customerId} and c.company_id = ${user.companyId}`)[0];
  if (!a) throw notFound();
  if (!a.phones.length) throw new AppError("NO_PHONE", 400);
  const code = await newCode(sql, a, "staff", user.id);
  await cleared(sql, user.companyId, a.phones, null);
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "customer.pin_code", table: "customers", rowId: customerId, new: { via: "staff" }, ip });
  return { code, minutes: PIN_CODE_MINUTES.staff };
}
/** phone + code + the new PIN twice → the PIN is set (an account is made when the record had none), the number counts as verified,
 *  every session of the account ends and this device is signed in. A wrong code counts like a wrong PIN; a code takes 5 tries. */
export async function resetPinWithCode(ip: string, v: { phone: string; code: string; pin: string; pin2: string }): Promise<{ token: string }> {
  const companyId = await siteCompanyId();
  if (!companyId) throw notFound();
  if (!checkRate(`site:login:ip:${ip}`, 30, 60)) throw new AppError("RATE_LIMITED", 429);
  const phone = normalizeKhPhone(v.phone), code = pinDigits(v.code);
  await assertNotLocked(companyId, phone, ip);
  if (!phone || !/^\d{6}$/.test(code)) return failed(companyId, phone, ip, null, "CODE_INVALID");
  const k = (await sql<{ id: string; customer_id: string; code_hash: string; tries: number; via: string; phones: string[]; sub: string | null }[]>`
    select k.id::text, k.customer_id, k.code_hash, k.tries, k.via, c.phones, c.tg_subscriber_id::text as sub from customer_pin_codes k join customers c on c.id = k.customer_id
    where k.company_id = ${companyId} and c.is_active and ${phone} = any(c.phones) and k.used_at is null and k.expires_at > now() order by k.created_at desc limit 1`)[0];
  const right = !!k && timingSafeEqual(Buffer.from(codeHash(k.customer_id, code)), Buffer.from(k.code_hash));
  if (!right) {
    if (k) await sql`update customer_pin_codes set tries = tries + 1, used_at = case when tries + 1 >= ${PIN_CODE_TRIES} then now() else used_at end where id = ${k.id}::bigint`;
    return failed(companyId, phone, ip, k?.customer_id ?? null, "CODE_INVALID");
  }
  const pin = pinOf(v.pin, v.pin2, k.phones);
  return tx(null, async (t) => {
    if (!(await t`update customer_pin_codes set used_at = now() where id = ${k.id}::bigint and used_at is null returning id`).length) throw new AppError("CODE_INVALID", 400);
    await t`update customers set password_hash = ${await hashPassword(pin)}, password_set_at = now(), pin_history_from = null where id = ${k.customer_id}`;
    await endSessions(t, { id: k.customer_id, sub: k.sub }, null);
    await cleared(t, companyId, k.phones, ip);
    await audit(t, { companyId, userId: null, action: "customer.pin_reset", source: "system", table: "customers", rowId: k.customer_id, new: { via: k.via }, ip });
    return { token: await newCustomerSession(t, { companyId, subscriberId: k.sub ? Number(k.sub) : null, customerId: k.customer_id, via: "pin" }) };
  });
}

// ---------- signed in: change the PIN · sign out everywhere ----------
type Who = { id: string; companyId: string; subscriberId: number | null; customerId: string | null };
async function accountOf(s: Who): Promise<Account | null> {
  return s.customerId
    ? (await sql<Account[]>`select ${ACCOUNT} from customers c where c.id = ${s.customerId} and c.company_id = ${s.companyId} and c.is_active`)[0] ?? null
    : s.subscriberId ? accountBySubscriber(sql, s.companyId, s.subscriberId) : null;
}
/** needs the current PIN — except a record without one opened from its own Telegram chat (Telegram vouches); the other sessions end */
export async function changeCustomerPin(s: Who, ip: string | null, current: string, next: string, next2?: string) {
  if (!checkRate(`site:pin-change:${s.customerId ?? s.subscriberId}`, 10, 3600)) throw new AppError("RATE_LIMITED", 429);
  const acc = await accountOf(s);
  if (!acc) throw new AppError("NOT_LINKED", 409);
  if (acc.hash && !(await verifyPassword(pinDigits(current).slice(0, CUSTOMER_PASSWORD_MAX), acc.hash))) throw new AppError("WRONG_PIN", 400);
  const pin = pinOf(next, next2, acc.phones);
  await sql`update customers set password_hash = ${await hashPassword(pin)}, password_set_at = now(), pin_history_from = case when ${!s.customerId} then null else pin_history_from end where id = ${acc.id}`;
  await endSessions(sql, acc, s.id);
  await audit(sql, { companyId: s.companyId, userId: null, action: "customer.pin_changed", source: "system", table: "customers", rowId: acc.id, ip });
  return { ok: true };
}
export async function logoutEverywhere(s: Who, ip: string | null) {
  const acc = await accountOf(s);
  if (acc) await endSessions(sql, acc, null);
  await sql`delete from customer_sessions where id = ${s.id}`;
  await audit(sql, { companyId: s.companyId, userId: null, action: "customer.logout_all", source: "system", table: "customers", rowId: acc?.id ?? null, ip });
  return { ok: true };
}

// ---------- link by «share my phone» in the bot ----------
/** Telegram vouches that this number belongs to the account (the hub accepts only the sender's OWN contact): the customer with
 *  that number is linked to the chat (an older link to another chat moves — the number moved), else a new customer is made with
 *  the consent just given in the bot. The number counts as verified (D-191); no password, no PIN in any message. */
export async function linkByContact(subscriberId: number, phoneRaw: string, firstName: string | null): Promise<{ ok: boolean } & CustomerMsg> {
  const companyId = await siteCompanyId();
  const phone = normalizeKhPhone(phoneRaw);
  if (!companyId) return { ok: false, text: customerText.unavailable };
  if (!phone) return { ok: false, text: customerText.notKhPhone };
  await tx(null, async (t) => {
    const test = await isTestPhone(t, companyId, phone); // D-120: a test phone links its own test record, never a real customer
    const mine = (await t<{ id: string; phones: string[] }[]>`select id, phones from customers where company_id = ${companyId} and tg_subscriber_id = ${subscriberId} and is_active and is_test = ${test} order by created_at limit 1`)[0];
    let id = mine && mine.phones.includes(phone) ? mine.id : await customerByPhone(t, companyId, phone, test);
    let made = false;
    if (!id) {
      id = (await t<{ id: string }[]>`insert into customers (company_id, name, phones, origin, consent_at, consent_version, consent_source, is_test)
        values (${companyId}, ${(firstName ?? "").trim().slice(0, 80) || phone}, ${t.array([phone])}, 'telegram', now(), ${SITE_CONSENT_VERSION}, 'bot', ${test}) returning id`)[0]!.id;
      made = true;
    }
    const old = (await t<{ sub: string | null }[]>`select tg_subscriber_id::text as sub from customers where id = ${id} for update`)[0]!;
    if (old.sub !== String(subscriberId)) {
      await t`update customers set tg_subscriber_id = ${subscriberId} where id = ${id}`;
      if (old.sub) await t`delete from customer_sessions where customer_id = ${id} or subscriber_id = ${old.sub}::bigint`; // the number moved to another Telegram account
    }
    await verifyAccount(t, id);
    await audit(t, { companyId, userId: null, action: "customer.tg_link", source: "telegram", table: "customers", rowId: id, new: { via: "contact", made, moved: !!old.sub && old.sub !== String(subscriberId) } });
  });
  return { ok: true, text: customerText.linkedKnown, keyboard: customerGrid(), menu_url: menuUrl() };
}

// ---------- staff: lock state + unlock (Admin / GM — customer.manage), audit logged ----------
export async function customerLoginState(companyId: string, phones: string[]): Promise<"none" | "timed" | "permanent"> {
  if (!phones.length) return "none";
  const g = (await sql<{ timed: boolean | null }[]>`select bool_or(locked_until > now()) as timed from customer_login_guards where company_id = ${companyId} and phone = any(${sql.array(phones)})`)[0];
  return g?.timed ? "timed" : "none";
}
export async function unlockCustomerLogin(user: SessionUser, ip: string | null, customerId: string) {
  const c = (await sql<{ phones: string[] }[]>`select phones from customers where id = ${customerId} and company_id = ${user.companyId}`)[0];
  if (!c) throw notFound();
  const r = c.phones.length ? await sql`delete from customer_login_guards where company_id = ${user.companyId} and phone = any(${sql.array(c.phones)})` : { count: 0 };
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "customer.login_unlocked", table: "customers", rowId: customerId, new: { cleared: r.count }, ip });
  return { ok: true, cleared: r.count };
}
