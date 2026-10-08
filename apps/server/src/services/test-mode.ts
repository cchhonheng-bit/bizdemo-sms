// D-120 (CEO): test phones — Settings → «លេខទូរស័ព្ទសាកល្បង» (CEO only). A booking or quote request from one of these phones is a
// test: it gets its own customer record (is_test — a real customer with the same number is never touched), only the CEO hears
// about it (staff messages start with 🧪), reports and customer lists leave it out, a waiting test does not hold a technician,
// and whatever is still open after 24 h is cancelled without a message to anybody (audit only).
import { CANCELLABLE_STATUSES, kmDigits, normalizeKhPhone, TEST_MARK, TEST_PHONES_MAX, TEST_TTL_HOURS } from "@sms/shared";
import { sql, tx, type Db } from "../db.js";
import { AppError } from "../lib/errors.js";
import type { Tx } from "../lib/i18n.js";
import { audit } from "./audit.js";
import type { SessionUser } from "./auth.js";

export async function testPhones(db: Db, companyId: string): Promise<string[]> {
  return (await db<{ p: string[] | null }[]>`select test_phones as p from company_settings where company_id = ${companyId}`)[0]?.p ?? [];
}
export async function isTestPhone(db: Db, companyId: string, phone: string | null | undefined): Promise<boolean> {
  const p = phone ? normalizeKhPhone(phone) : null;
  return !!p && (await testPhones(db, companyId)).includes(p);
}
export async function isTestBooking(db: Db, bookingId: string): Promise<boolean> {
  return (await db<{ t: boolean }[]>`select is_test as t from bookings where id = ${bookingId}`)[0]?.t === true;
}
/** the active CEO accounts: the only staff a test reaches */
export async function ceoIds(db: Db, companyId: string): Promise<string[]> {
  return (await db<{ id: string }[]>`select id from users where company_id = ${companyId} and is_active and role = 'ceo' order by created_at`).map((u) => u.id);
}
export const testTitle = (title: Tx): Tx => ({ km: `${TEST_MARK} ${title.km}`, en: `${TEST_MARK} ${title.en}` });
/** lists: test rows are seen by the CEO only (with the 🧪 mark); everybody else never sees them */
export const seesTests = (user: { role: string }) => user.role === "ceo";

// ---------- Settings (CEO only) ----------
function assertCeo(user: SessionUser): void { if (user.role !== "ceo") throw new AppError("FORBIDDEN", 403); }
export async function getTestPhones(user: SessionUser) {
  assertCeo(user);
  return { phones: await testPhones(sql, user.companyId), max: TEST_PHONES_MAX };
}
export async function saveTestPhones(user: SessionUser, ip: string | null, raw: string[]) {
  assertCeo(user);
  const phones: string[] = [];
  for (const r of raw) {
    if (!r.trim()) continue;
    const p = normalizeKhPhone(r);
    if (!p) throw new AppError("INVALID_PHONE", 400);
    if (!phones.includes(p)) phones.push(p);
  }
  if (phones.length > TEST_PHONES_MAX) throw new AppError("TOO_MANY_PHONES", 400);
  return tx(user.id, async (t) => {
    const old = await testPhones(t, user.companyId);
    await t`update company_settings set test_phones = ${t.array(phones)}, updated_by = ${user.id} where company_id = ${user.companyId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "settings.test_phones", table: "company_settings", rowId: user.companyId, old: { phones: old }, new: { phones }, ip });
    return { ok: true, phones };
  });
}

// ---------- D-132 (shop-setup): existing rows that are tests — demo data hidden like any test; the 24 h rule cancels what is open ----------
export async function markAsTest(user: SessionUser, ip: string | null, o: { customers: string[]; bookings: string[] }) {
  return tx(user.id, async (t) => {
    for (const id of o.customers) {
      const r = await t`update customers set is_test = true where id = ${id} and company_id = ${user.companyId} and not is_test returning id`;
      if (r.length) await audit(t, { companyId: user.companyId, userId: user.id, action: "customer.test", table: "customers", rowId: id, old: { is_test: false }, new: { is_test: true }, ip });
    }
    for (const id of o.bookings) {
      const r = await t`update bookings set is_test = true where id = ${id} and company_id = ${user.companyId} and not is_test returning id`;
      if (r.length) await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.test", table: "bookings", rowId: id, old: { is_test: false }, new: { is_test: true }, ip });
      // its customer requests (booking, reschedule) are tests with it — hidden the same way (D-133)
      const reqs = await t<{ id: string }[]>`update service_requests set is_test = true where booking_id = ${id} and company_id = ${user.companyId} and not is_test returning id`;
      for (const q of reqs) await audit(t, { companyId: user.companyId, userId: user.id, action: "service.request_test", table: "service_requests", rowId: q.id, old: { is_test: false }, new: { is_test: true }, ip });
    }
    return { ok: true };
  });
}

// ---------- 24 h later: cancelled by itself ----------
const REASON = `${TEST_MARK} សាកល្បង — បោះបង់ដោយស្វ័យប្រវត្តិក្រោយ ${kmDigits(TEST_TTL_HOURS)} ម៉ោង`;
export async function cancelOldTests(now: Date = new Date()): Promise<{ bookings: number; requests: number }> {
  const cutoff = new Date(now.getTime() - TEST_TTL_HOURS * 3_600_000);
  return tx(null, async (t) => {
    const gone = await t<{ id: string; company_id: string; old: string }[]>`with x as (
        select id, status from bookings where is_test and created_at <= ${cutoff} and status = any(${t.array([...CANCELLABLE_STATUSES])}::booking_status[]) for update)
      update bookings b set status = 'cancelled', cancel_reason = ${REASON}, cancelled_at = ${now} from x where b.id = x.id returning b.id, b.company_id, x.status::text as old`;
    for (const b of gone) {
      await t`update booking_status_log set note = ${REASON} where id = (select max(id) from booking_status_log where booking_id = ${b.id} and to_status = 'cancelled')`;
      await audit(t, { companyId: b.company_id, userId: null, action: "booking.test_expired", source: "system", table: "bookings", rowId: b.id, old: { status: b.old }, new: { status: "cancelled", reason: REASON } });
    }
    const reqs = await t<{ id: string; company_id: string }[]>`update service_requests set status = 'done', outcome = 'expired', note = coalesce(note, ${REASON}), handled_at = ${now}
      where is_test and status = 'new' and (created_at <= ${cutoff} or booking_id = any(${t.array(gone.map((b) => b.id))}::uuid[])) returning id, company_id`;
    for (const r of reqs) await audit(t, { companyId: r.company_id, userId: null, action: "service.request_test_expired", source: "system", table: "service_requests", rowId: r.id, new: { outcome: "expired" } });
    return { bookings: gone.length, requests: reqs.length };
  });
}
