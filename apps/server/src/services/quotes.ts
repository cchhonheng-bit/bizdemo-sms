// Quotes for type B jobs (Flow 3, D-76 · M5 · BR-02 · BR-10 · BR-11). Prices are set by GM / Admin only (quote.manage);
// technicians never receive them. Money = US cents; KHR shown as a reference with the rate frozen on the quote.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { cancelBooking } from "./bookings.js";
import { storeFile } from "./jobs.js";

export type QuoteLineInput = { catalog_item_id?: string | null; description: string; kind: "service" | "product"; qty: number; unit: string; unit_price: number };

async function bookingForQuote(t: Db, user: SessionUser, bookingId: string) {
  const b = (await t<{ id: string; type: string; status: string; company_id: string }[]>`select id, type, status, company_id from bookings
    where id = ${bookingId} and company_id = ${user.companyId} for update`)[0];
  if (!b) throw notFound();
  if (b.type !== "B") throw new AppError("NOT_TYPE_B", 400);
  return b;
}

async function checkItems(t: Db, user: SessionUser, lines: QuoteLineInput[]) {
  const ids = [...new Set(lines.map((l) => l.catalog_item_id).filter((x): x is string => !!x))];
  if (ids.length && (await t`select id from catalog_items where id = any(${t.array(ids)}::uuid[]) and company_id = ${user.companyId}`).length !== ids.length) throw new AppError("ITEM_NOT_FOUND", 404);
}
async function writeLines(t: Db, quoteId: string, lines: QuoteLineInput[]) {
  await t`delete from quote_lines where quote_id = ${quoteId}`;
  let i = 0;
  for (const l of lines) await t`insert into quote_lines (quote_id, sort, catalog_item_id, description, kind, qty, unit, unit_price)
    values (${quoteId}, ${i++}, ${l.catalog_item_id ?? null}, ${l.description.trim()}, ${l.kind}::item_kind, ${l.qty}, ${l.unit.trim() || "unit"}, ${l.unit_price})`;
}

export async function createQuote(user: SessionUser, ip: string | null, v: { booking_id: string; lines: QuoteLineInput[]; notes?: string | null; valid_days?: number | null }) {
  return tx(user.id, async (t) => {
    const b = await bookingForQuote(t, user, v.booking_id);
    if (!["new", "survey", "quoted"].includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    if ((await t`select 1 from quotes where booking_id = ${b.id} and status in ('sent', 'accepted')`).length) throw new AppError("QUOTE_EXISTS", 409);
    await checkItems(t, user, v.lines);
    const fx = (await t<{ fx: string }[]>`select fx_rate_khr::text as fx from company_settings where company_id = ${user.companyId}`)[0]?.fx ?? "4100";
    // Q-#### per company: the counter row is locked by the upsert → concurrent quotes never share a number
    const no = (await t<{ last_no: number }[]>`insert into quote_counters (company_id, last_no) values (${user.companyId}, 1)
      on conflict (company_id) do update set last_no = quote_counters.last_no + 1 returning last_no`)[0]!.last_no;
    const number = `Q-${String(no).padStart(4, "0")}`;
    const id = (await t<{ id: string }[]>`insert into quotes (company_id, booking_id, number, notes, valid_until, fx_rate_khr, created_by)
      values (${user.companyId}, ${b.id}, ${number}, ${v.notes?.trim() || null}, ${v.valid_days ? t`current_date + ${v.valid_days}::int` : null}, ${fx}, ${user.id}) returning id`)[0]!.id;
    await writeLines(t, id, v.lines);
    // new → survey → quoted (the status guard only allows these steps; a type B booking normally starts in survey)
    if (b.status === "new") await t`update bookings set status = 'survey' where id = ${b.id}`;
    if (b.status !== "quoted") await t`update bookings set status = 'quoted' where id = ${b.id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "quote.create", table: "quotes", rowId: id, new: { number, booking_id: b.id, lines: v.lines.length }, ip });
    return { id, number };
  });
}

async function quoteForUpdate(t: Db, user: SessionUser, id: string) {
  const q = (await t<{ id: string; status: string; booking_id: string; number: string }[]>`select id, status, booking_id, number from quotes where id = ${id} and company_id = ${user.companyId} for update`)[0];
  if (!q) throw notFound();
  if (q.status !== "sent") throw new AppError("QUOTE_DECIDED", 400);
  return q;
}

export async function updateQuote(user: SessionUser, ip: string | null, id: string, v: { lines: QuoteLineInput[]; notes?: string | null }) {
  return tx(user.id, async (t) => {
    const q = await quoteForUpdate(t, user, id);
    await checkItems(t, user, v.lines);
    await writeLines(t, id, v.lines);
    await t`update quotes set notes = ${v.notes?.trim() || null} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "quote.update", table: "quotes", rowId: id, new: { lines: v.lines.length }, ip });
    return { id: q.id };
  });
}

export async function acceptQuote(user: SessionUser, ip: string | null, id: string) {
  return tx(user.id, async (t) => {
    await quoteForUpdate(t, user, id);
    await t`update quotes set status = 'accepted', decided_at = now(), decided_by = ${user.id} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "quote.accept", table: "quotes", rowId: id, ip });
    return { id, status: "accepted" as const };
  });
}

/** customer said no → quote rejected + booking cancelled with the reason (BR-02, BR-18) */
export async function rejectQuote(user: SessionUser, ip: string | null, id: string, reason: string) {
  if (reason.trim().length < 3) throw new AppError("REASON_REQUIRED", 400);
  const q = await tx(user.id, async (t) => {
    const q = await quoteForUpdate(t, user, id);
    await t`update quotes set status = 'rejected', decided_at = now(), decided_by = ${user.id}, reject_reason = ${reason.trim()} where id = ${id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "quote.reject", table: "quotes", rowId: id, new: { reason: reason.trim() }, ip });
    return q;
  });
  await cancelBooking(user, ip, q.booking_id, `Quote ${q.number} មិនយល់ព្រម: ${reason.trim()}`);
  return { id, status: "rejected" as const };
}

export async function getQuote(user: SessionUser, id: string) {
  const q = (await sql`select q.id, q.number, q.status, q.notes, q.valid_until::text, q.fx_rate_khr::float as fx_rate_khr, q.created_at, q.decided_at, q.reject_reason, q.booking_id,
      b.number as booking_number, b.address, b.service_text, c.name as customer_name, c.phones as customer_phones, u.full_name as created_by_name
    from quotes q join bookings b on b.id = q.booking_id join customers c on c.id = b.customer_id left join users u on u.id = q.created_by
    where q.id = ${id} and q.company_id = ${user.companyId}`)[0];
  if (!q) throw notFound();
  const lines = (await sql<{ id: number; catalog_item_id: string | null; description: string; kind: string; qty: number; unit: string; unit_price: number }[]>`
    select id, catalog_item_id, description, kind, qty::float as qty, unit, unit_price from quote_lines where quote_id = ${id} order by sort, id`)
    .map((l) => ({ ...l, line_total: Math.round(l.qty * l.unit_price) }));
  const subtotal = lines.reduce((s, l) => s + l.line_total, 0);
  const company = (await sql`select c.name, s.company_info from companies c join company_settings s on s.company_id = c.id where c.id = ${user.companyId}`)[0];
  return { ...q, lines, subtotal, total: subtotal, total_khr: Math.round((subtotal / 100) * Number(q.fx_rate_khr)), company };
}

export async function listQuotes(user: SessionUser, status?: string, bookingId?: string) {
  return sql`select q.id, q.number, q.status, q.created_at, q.booking_id, b.number as booking_number, c.name as customer_name,
      (select coalesce(sum(round(l.qty * l.unit_price)), 0)::int from quote_lines l where l.quote_id = q.id) as total,
      greatest(0, (current_date - q.created_at::date))::int as days_waiting
    from quotes q join bookings b on b.id = q.booking_id join customers c on c.id = b.customer_id
    where q.company_id = ${user.companyId} ${status ? sql`and q.status = ${status}::quote_status` : sql``} ${bookingId ? sql`and q.booking_id = ${bookingId}` : sql``}
    order by q.created_at desc limit 300`;
}

/** BR-02: a type B booking is assigned only after its quote was accepted */
export async function assertQuoteAccepted(t: Db, bookingId: string, type: string): Promise<void> {
  if (type !== "B") return;
  if (!(await t`select 1 from quotes where booking_id = ${bookingId} and status = 'accepted'`).length) throw new AppError("QUOTE_NOT_ACCEPTED", 400);
}

// ---------- survey (FR-501) ----------
export async function saveSurvey(user: SessionUser, ip: string | null, bookingId: string, notes: string) {
  return tx(user.id, async (t) => {
    const b = await bookingForQuote(t, user, bookingId);
    if (!["new", "survey", "quoted"].includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    await t`update bookings set survey_notes = ${notes.trim() || null}, surveyed_at = now(), surveyed_by = ${user.id} where id = ${b.id}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.survey", table: "bookings", rowId: b.id, new: { notes: notes.trim() }, ip });
    return { ok: true };
  });
}
export async function addSurveyPhoto(user: SessionUser, ip: string | null, bookingId: string, data: string) {
  return tx(user.id, async (t) => {
    const b = await bookingForQuote(t, user, bookingId);
    if (!["new", "survey", "quoted"].includes(b.status)) throw new AppError("BOOKING_LOCKED", 400);
    const id = await storeFile(t, user, b.id, "survey", data);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "booking.survey_photo", table: "job_files", rowId: id, ip });
    return { id };
  });
}
