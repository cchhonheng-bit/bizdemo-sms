// Work the technician adds on site (CEO 12-10, D-140 F) — between arrive and report: a catalog service (+ quantity, at its catalog
// price; its length makes the job longer) or «ការងារផ្សេងៗ» (a text + an optional photo, never a price from the technician — Admin /
// GM set it). Materials stay as they are (booking_materials). Every added line is «បន្ថែមដោយជាង» (who, when) and Admin / GM review
// it before the invoice: confirm (price as is or edited) or remove (with a reason) — audited old → new. A longer job that would run
// into the technician's (or the vehicle's) next job stops at that job's start; Admin / GM are told at once (move or reassign) and
// the crew gets a warning.
import { tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { extendJob } from "./bookings.js";
import { loadForMaterials, PHOTO_STATUSES, storeFile } from "./jobs.js";
import { fmtLocal, notifyUser } from "./telegram.js";
import { ceoIds, isTestBooking, testTitle } from "./test-mode.js";

export type Extra = { id: string; kind: "service" | "other" | "material"; catalog_item_id: string | null; description: string; qty: number; unit: string | null; minutes: number;
  unit_price: number | null; photo_file: string | null; status: "pending" | "confirmed" | "removed"; added_at: Date; added_by: string | null; added_by_name: string | null;
  reviewed_at: Date | null; reviewed_by_name: string | null; review_note: string | null };

/** the lines added on site (removed ones too, greyed — the review trail); prices only for the office (the route strips them for technicians) */
export async function listExtras(db: Db, bookingId: string): Promise<Extra[]> {
  return db<Extra[]>`select x.id, x.kind, x.catalog_item_id, x.description, x.qty::float as qty, x.unit, x.minutes, x.unit_price, x.photo_file, x.status, x.added_at, x.added_by,
      a.full_name as added_by_name, x.reviewed_at, r.full_name as reviewed_by_name, x.review_note
    from job_extras x left join users a on a.id = x.added_by left join users r on r.id = x.reviewed_by where x.booking_id = ${bookingId} order by x.added_at, x.id`;
}
/** lines still waiting for Admin / GM — the invoice waits for them */
export async function pendingExtras(db: Db, bookingId: string): Promise<number> {
  return (await db<{ n: number }[]>`select count(*)::int as n from job_extras where booking_id = ${bookingId} and status = 'pending'`)[0]!.n;
}

export type AddExtra = { kind: "service"; item_id: string; qty: number } | { kind: "other" | "material"; description: string; qty?: number; unit?: string | null; photo?: string | null };

export async function addExtra(user: SessionUser, perms: string[], ip: string | null, id: string, v: AddExtra) {
  const out = await tx(user.id, async (t) => {
    const b = await loadForMaterials(t, user, id, perms);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError(["pending_review", "reviewed", "invoiced", "partially_paid", "closed"].includes(b.status) ? "REPORT_LOCKED" : "NOT_ON_SITE", 400);
    let row: { catalog_item_id: string | null; description: string; qty: number; unit: string | null; minutes: number; unit_price: number | null; photo: string | null };
    if (v.kind === "service") {
      const i = (await t<{ id: string; name_km: string; unit: string; duration_min: number; price: number | null }[]>`select id, name_km, unit, duration_min, coalesce(sell_price, from_price) as price
        from catalog_items where id = ${v.item_id} and company_id = ${user.companyId} and kind = 'service' and is_active`)[0];
      if (!i) throw new AppError("SERVICE_NOT_FOUND", 404);
      // the job length grows by the service's length once per line (like the booking lines, D-106)
      row = { catalog_item_id: i.id, description: i.name_km, qty: v.qty, unit: i.unit, minutes: i.duration_min, unit_price: i.price, photo: null };
    } else {
      const text = v.description.trim();
      if (text.length < 2) throw new AppError("DESCRIPTION_REQUIRED", 400);
      row = { catalog_item_id: null, description: text.slice(0, 300), qty: v.qty ?? 1, unit: v.kind === "material" ? v.unit?.trim().slice(0, 20) || null : null, minutes: 0, unit_price: null,
        photo: v.photo ? await storeFile(t, user, id, "extra", v.photo) : null };
    }
    const xid = (await t<{ id: string }[]>`insert into job_extras (company_id, booking_id, kind, catalog_item_id, description, qty, unit, minutes, unit_price, photo_file, added_by)
      values (${user.companyId}, ${id}, ${v.kind}, ${row.catalog_item_id}, ${row.description}, ${row.qty}, ${row.unit}, ${row.minutes}, ${row.unit_price}, ${row.photo}, ${user.id}) returning id`)[0]!.id;
    const ext = await extendJob(t, user.companyId, id, row.minutes);
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_add", table: "job_extras", rowId: xid,
      new: { booking_id: id, kind: v.kind, description: row.description, qty: row.qty, minutes: row.minutes, unit_price: row.unit_price, ends_at: ext.ends_at, ...(ext.clash ? { clash: ext.clash.number } : {}) }, ip });
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
    const b = await loadForMaterials(t, user, id, perms);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError("REPORT_LOCKED", 400);
    const x = (await t<{ minutes: number; added_by: string | null; status: string; description: string }[]>`select minutes, added_by, status, description from job_extras where id = ${extraId} and booking_id = ${id} for update`)[0];
    if (!x) throw notFound();
    if (x.status !== "pending" || (x.added_by !== user.id && user.role === "tech")) throw new AppError("EXTRA_LOCKED", 400);
    await t`delete from job_extras where id = ${extraId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_remove", table: "job_extras", rowId: extraId, old: { booking_id: id, description: x.description, minutes: x.minutes }, ip });
    return { ok: true };
  });
}

/** Admin / GM (booking.assign) before the invoice: confirm (a price is needed — the catalog one, or theirs) or remove (a reason) */
export async function reviewExtra(user: SessionUser, ip: string | null, id: string, extraId: string, v: { action: "confirm" | "remove"; unit_price?: number | null; reason?: string | null }) {
  return tx(user.id, async (t) => {
    const b = (await t<{ status: string }[]>`select status::text from bookings where id = ${id} and company_id = ${user.companyId} for update`)[0];
    if (!b) throw notFound();
    if (b.status === "cancelled") throw new AppError("BOOKING_LOCKED", 400);
    if ((await t`select 1 from invoices where booking_id = ${id} and status <> 'void'`).length) throw new AppError("INVOICE_EXISTS", 409); // prices: the invoice now
    const x = (await t<{ status: string; unit_price: number | null; description: string; qty: number }[]>`select status, unit_price, description, qty::float as qty from job_extras where id = ${extraId} and booking_id = ${id} for update`)[0];
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
    await t`update job_extras set status = 'confirmed', unit_price = ${price}, reviewed_by = ${user.id}, reviewed_at = now(), review_note = null where id = ${extraId}`;
    await audit(t, { companyId: user.companyId, userId: user.id, action: "job.extra_review", table: "job_extras", rowId: extraId,
      old: { status: x.status, unit_price: x.unit_price }, new: { status: "confirmed", unit_price: price }, ip });
    return { ok: true, status: "confirmed" as const };
  });
}

/** the confirmed lines as invoice lines (catalog service at its price × qty; other work at the price Admin / GM set) */
export async function extraInvoiceLines(db: Db, bookingId: string) {
  return (await db<{ kind: string; catalog_item_id: string | null; description: string; qty: number; unit: string | null; unit_price: number }[]>`select kind, catalog_item_id, description, qty::float as qty, unit, unit_price
    from job_extras where booking_id = ${bookingId} and status = 'confirmed' order by added_at, id`)
    .map((x) => ({ catalog_item_id: x.catalog_item_id, description: x.description, kind: x.kind === "material" ? "product" as const : "service" as const, qty: x.qty, unit: x.unit ?? (x.kind === "material" ? "unit" : "job"), unit_price: x.unit_price }));
}

/** technicians never see prices (AC-01) */
export const forCrew = (list: Extra[]) => list.map((x) => ({ ...x, unit_price: null }));
