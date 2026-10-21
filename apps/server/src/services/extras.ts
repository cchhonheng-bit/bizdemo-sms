// Work the technician adds on site (CEO 12-10 D-140 F · 13-10 D-144): between arrive and report — a line of the service / price list
// (a service or a package-priced sale line, + quantity, at its list price; a service's length makes the job longer) or
// «ការងារ/សម្ភារៈបន្ថែម» (a text + quantity + unit + an optional photo, never a price from the technician — Admin / GM price it and
// say whether it is a service or goods). Every line is «បន្ថែមដោយជាង» (who, when) and reaches the job page (technician, Admin / GM, the
// GM's review), the draft invoice (once reviewed) and the customer's «ការងាររួចរាល់» message. Technician work never moves stock (D-144).
// A longer job that would run into the technician's (or the vehicle's) next job stops at that job's start; Admin / GM are told at once.
import { tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { extendJob } from "./bookings.js";
import { loadForOffice, loadForWork, PHOTO_STATUSES, storeFile } from "./jobs.js";
import { fmtLocal, notifyUser } from "./telegram.js";
import { ceoIds, isTestBooking, testTitle } from "./test-mode.js";

export type Extra = { id: string; kind: "service" | "other" | "material"; catalog_item_id: string | null; description: string; qty: number; unit: string | null; minutes: number;
  unit_price: number | null; photo_file: string | null; status: "pending" | "confirmed" | "removed"; added_at: Date; added_by: string | null; added_by_name: string | null;
  reviewed_at: Date | null; reviewed_by_name: string | null; review_note: string | null; item_kind: "service" | "product" | null;
  /** D-151: «បន្ថែមដោយការិយាល័យ» when the Admin / GM added the line (confirmed at once) */
  added_by_role: string | null };

/** the lines added on site (removed ones too, greyed — the review trail); prices only for the office (the route strips them for technicians) */
export async function listExtras(db: Db, bookingId: string): Promise<Extra[]> {
  return db<Extra[]>`select x.id, x.kind, x.catalog_item_id, x.description, x.qty::float as qty, x.unit, x.minutes, x.unit_price, x.photo_file, x.status, x.added_at, x.added_by,
      a.full_name as added_by_name, a.role::text as added_by_role, x.reviewed_at, r.full_name as reviewed_by_name, x.review_note, ci.kind::text as item_kind
    from job_extras x left join users a on a.id = x.added_by left join users r on r.id = x.reviewed_by left join catalog_items ci on ci.id = x.catalog_item_id
    where x.booking_id = ${bookingId} order by x.added_at, x.id`;
}
/** lines still waiting for Admin / GM — the invoice waits for them */
export async function pendingExtras(db: Db, bookingId: string): Promise<{ id: string; description: string }[]> {
  return db<{ id: string; description: string }[]>`select id, description from job_extras where booking_id = ${bookingId} and status = 'pending' order by added_at`;
}

export type AddExtra = { kind: "service"; item_id: string; qty: number; unit_price?: number | null }
  | { kind: "other"; description: string; qty?: number; unit?: string | null; photo?: string | null; unit_price?: number | null; item_kind?: "service" | "product" | null };
/** D-151: the office = the Admin, or anyone with job.review (GM, CEO) who is not on the job's crew — its lines need no review */
const OFFICE_STATUSES = [...PHOTO_STATUSES, "pending_review", "reviewed"];
const isOffice = async (t: Db, user: SessionUser, perms: string[], id: string) =>
  (user.role === "admin" || perms.includes("job.review")) && !(await t`select 1 from booking_technicians where booking_id = ${id} and user_id = ${user.id}`).length;

export async function addExtra(user: SessionUser, perms: string[], ip: string | null, id: string, v: AddExtra) {
  const out = await tx(user.id, async (t) => {
    const office = await isOffice(t, user, perms, id);
    const b = office ? await loadForOffice(t, user, id) : await loadForWork(t, user, id, perms);
    const allowed = office ? OFFICE_STATUSES : PHOTO_STATUSES;
    if (!allowed.includes(b.status)) throw new AppError(["pending_review", "reviewed", "invoiced", "partially_paid", "closed"].includes(b.status) ? "REPORT_LOCKED" : "NOT_ON_SITE", 400);
    if (office && (await t`select 1 from invoices where booking_id = ${id} and status <> 'void'`).length) throw new AppError("INVOICE_EXISTS", 409);
    let row: { catalog_item_id: string | null; description: string; qty: number; unit: string | null; minutes: number; unit_price: number | null; photo: string | null };
    if (v.kind === "service") {
      // D-144: any line of the service / price list — a service (its length extends the job) or a package-priced sale line; never a stock item
      const i = (await t<{ id: string; name_km: string; unit: string; kind: string; duration_min: number; price: number | null }[]>`select id, name_km, unit, kind::text as kind, duration_min, coalesce(sell_price, from_price) as price
        from catalog_items where id = ${v.item_id} and company_id = ${user.companyId} and is_active and not is_stock`)[0];
      if (!i) throw new AppError("SERVICE_NOT_FOUND", 404);
      row = { catalog_item_id: i.id, description: i.name_km, qty: v.qty, unit: i.unit, minutes: i.kind === "service" ? i.duration_min : 0,
        unit_price: office && v.unit_price != null ? v.unit_price : i.price, photo: null }; // the office may price its own line
    } else {
      const text = v.description.trim();
      if (text.length < 2) throw new AppError("DESCRIPTION_REQUIRED", 400);
      if (office && v.unit_price == null) throw new AppError("PRICE_REQUIRED", 400); // an office line is confirmed at once → it carries its price
      row = { catalog_item_id: null, description: text.slice(0, 300), qty: v.qty ?? 1, unit: v.unit?.trim().slice(0, 20) || null, minutes: 0, unit_price: office ? v.unit_price! : null,
        photo: v.photo ? await storeFile(t, user, id, "extra", v.photo) : null };
    }
    // D-151: a line the office adds is confirmed at once (no review); a free line says goods or work (the invoice's kind)
    const kind = v.kind === "other" && office && v.item_kind === "product" ? "material" : v.kind;
    const xid = (await t<{ id: string }[]>`insert into job_extras (company_id, booking_id, kind, catalog_item_id, description, qty, unit, minutes, unit_price, photo_file, added_by, status, reviewed_by, reviewed_at)
      values (${user.companyId}, ${id}, ${kind}, ${row.catalog_item_id}, ${row.description}, ${row.qty}, ${row.unit}, ${row.minutes}, ${row.unit_price}, ${row.photo}, ${user.id},
        ${office ? "confirmed" : "pending"}, ${office ? user.id : null}, ${office ? new Date() : null}) returning id`)[0]!.id;
    // a job still running gets longer by a service's length; a finished one keeps its end (the line is only for the invoice)
    const ext = PHOTO_STATUSES.includes(b.status) ? await extendJob(t, user.companyId, id, row.minutes) : { ends_at: null, wanted: null, clash: null };
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_add", table: "job_extras", rowId: xid,
      new: { booking_id: id, kind, description: row.description, qty: row.qty, unit: row.unit, minutes: row.minutes, unit_price: row.unit_price, office, ends_at: ext.ends_at, ...(ext.clash ? { clash: ext.clash.number } : {}) }, ip });
    if (ext.clash) await tellClash(t, user, { id, number: b.number, timezone: b.timezone }, row.description, row.minutes, ext.clash, xid);
    return { id: xid, ends_at: ext.ends_at, overlap: ext.clash ? { number: ext.clash.number, scheduled_at: ext.clash.scheduled_at, who: ext.clash.who } : null };
  });
  return out;
}

/** Admin + GM at once (move or reassign the next job), the crew a warning; a test job → the CEO only (D-120) */
async function tellClash(t: Db, user: SessionUser, b: { id: string; number: string; timezone: string }, what: string, minutes: number,
  c: { booking_id: string; number: string; scheduled_at: Date; who: string }, key: string): Promise<void> {
  const at = fmtLocal(c.scheduled_at, b.timezone || "Asia/Phnom_Penh").slice(-5);
  const test = await isTestBooking(t, b.id);
  const office = test ? (await ceoIds(t, user.companyId)).map((x) => ({ id: x }))
    : await t<{ id: string }[]>`select id from users where company_id = ${user.companyId} and is_active and role in ('admin', 'gm')`;
  const title = { km: `⚠️ ការងារបន្ថែម ប៉ះការងារបន្ទាប់ · ${b.number}`, en: `⚠️ Added work runs into the next job · ${b.number}` };
  const body = { km: `🛠 ${what} · +${minutes} នាទី\n⏭ ${c.number} (${c.who}) ម៉ោង ${at}\nសូមប្ដូរម៉ោង ឬចាត់ជាងផ្សេង`, en: `🛠 ${what} · +${minutes} min\n⏭ ${c.number} (${c.who}) at ${at}\nPlease move it or send another technician` };
  for (const u of office) await notifyUser(t, user.companyId, u.id, "job.extra_clash", test ? testTitle(title) : title, body, `/bookings/${c.booking_id}`, `extra-clash:${key}:${u.id}`);
  const crew = await t<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${b.id}`;
  for (const m of crew) await notifyUser(t, user.companyId, m.user_id, "job.extra_clash",
    { km: `⚠️ ការងារបន្ទាប់ ${c.number} ម៉ោង ${at}`, en: `⚠️ Next job ${c.number} at ${at}` },
    { km: `ការងារបន្ថែមនេះអាចយឺតដល់ការងារបន្ទាប់ · រដ្ឋបាល និងអ្នកគ្រប់គ្រង បានទទួលដំណឹង`, en: `This added work may run into your next job · Admin / GM have been told` }, `/tech/job/${b.id}`, `extra-clash-crew:${key}:${m.user_id}`);
}

/** the one who added a line takes it back while it still waits and the report is not sent */
export async function removeOwnExtra(user: SessionUser, perms: string[], ip: string | null, id: string, extraId: string) {
  return tx(user.id, async (t) => {
    const b = await loadForWork(t, user, id, perms);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError("REPORT_LOCKED", 400);
    const x = (await t<{ minutes: number; added_by: string | null; status: string; description: string }[]>`select minutes, added_by, status, description from job_extras where id = ${extraId} and booking_id = ${id} for update`)[0];
    if (!x) throw notFound();
    if (x.status !== "pending" || (x.added_by !== user.id && user.role === "tech")) throw new AppError("EXTRA_LOCKED", 400);
    await t`delete from job_extras where id = ${extraId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_remove", table: "job_extras", rowId: extraId, old: { booking_id: id, description: x.description, minutes: x.minutes }, ip });
    return { ok: true };
  });
}

/** Admin / GM (booking.assign) before the invoice: confirm (a price is needed — the list one, or theirs; a free line also says service or
 *  goods, for the revenue account) or remove (a reason) */
export async function reviewExtra(user: SessionUser, ip: string | null, id: string, extraId: string, v: { action: "confirm" | "remove"; unit_price?: number | null; reason?: string | null; kind?: "service" | "product" | null }) {
  return tx(user.id, async (t) => {
    const b = (await t<{ status: string }[]>`select status::text from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (b.status === "cancelled") throw new AppError("BOOKING_LOCKED", 400);
    if ((await t`select 1 from invoices where booking_id = ${id} and status <> 'void'`).length) throw new AppError("INVOICE_EXISTS", 409); // prices: the invoice now
    const x = (await t<{ status: string; unit_price: number | null; description: string; qty: number; kind: string; catalog_item_id: string | null }[]>`select status, unit_price, description, qty::float as qty, kind, catalog_item_id
      from job_extras where id = ${extraId} and booking_id = ${id} for update`)[0];
    if (!x) throw notFound();
    if (v.action === "remove") {
      const reason = (v.reason ?? "").trim();
      if (reason.length < 3) throw new AppError("REASON_REQUIRED", 400);
      await t`update job_extras set status = 'removed', reviewed_by = ${user.id}, reviewed_at = now(), review_note = ${reason.slice(0, 300)} where id = ${extraId}`;
      await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_review", table: "job_extras", rowId: extraId, old: { status: x.status }, new: { status: "removed", reason }, ip });
      return { ok: true, status: "removed" as const };
    }
    const price = v.unit_price === undefined ? x.unit_price : v.unit_price;
    if (price == null) throw new AppError("PRICE_REQUIRED", 400);
    // a free line's kind on the invoice: goods («material») or work («other») — the price-list lines keep their item's kind
    const kind = x.catalog_item_id ? x.kind : v.kind === "product" ? "material" : v.kind === "service" ? "other" : x.kind;
    await t`update job_extras set status = 'confirmed', unit_price = ${price}, kind = ${kind}, reviewed_by = ${user.id}, reviewed_at = now(), review_note = null where id = ${extraId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_review", table: "job_extras", rowId: extraId,
      old: { status: x.status, unit_price: x.unit_price }, new: { status: "confirmed", unit_price: price, kind: kind === "material" ? "product" : "service" }, ip });
    return { ok: true, status: "confirmed" as const };
  });
}

/** the confirmed lines as invoice lines (a list line at its price × qty, its item's kind; a free line at the price Admin / GM set) */
export async function extraInvoiceLines(db: Db, bookingId: string) {
  return (await db<{ kind: string; item_kind: string | null; catalog_item_id: string | null; description: string; qty: number; unit: string | null; unit_price: number }[]>`
    select x.kind, ci.kind::text as item_kind, x.catalog_item_id, x.description, x.qty::float as qty, x.unit, x.unit_price
    from job_extras x left join catalog_items ci on ci.id = x.catalog_item_id where x.booking_id = ${bookingId} and x.status = 'confirmed' order by x.added_at, x.id`)
    .map((x) => ({ catalog_item_id: x.catalog_item_id, description: x.description, kind: (x.item_kind ?? (x.kind === "material" ? "product" : "service")) as "service" | "product",
      qty: x.qty, unit: x.unit ?? (x.kind === "material" ? "unit" : "job"), unit_price: x.unit_price }));
}

/** technicians never see prices (AC-01) */
export const forCrew = (list: Extra[]) => list.map((x) => ({ ...x, unit_price: null }));
