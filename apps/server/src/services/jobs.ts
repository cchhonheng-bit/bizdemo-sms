// Job execution (Flow 1+2, D-75): checkpoints (M6 · BR-07 · FR-601…606 · FR-1001) and the job report + GM review (M7 · BR-08/09 · OQ-08).
// Crew members (and a GM with job.checkpoint) record the job; technicians never receive prices (AC-01).
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { config } from "../config.js";
import { sql, tx, type Db } from "../db.js";
import { AppError, forbidden, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { enqueue, fmtLocal, notifyUser } from "./telegram.js";

export const STEPS = ["depart", "arrive", "start", "finish", "return"] as const;
export type Step = (typeof STEPS)[number];
/** status reached by each step (return keeps work_done / later) */
const STATUS_AFTER: Partial<Record<Step, string>> = { depart: "en_route", arrive: "on_site", start: "working", finish: "work_done" };
const WORKING = ["assigned", "en_route", "on_site", "working", "work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];

type Booking = { id: string; company_id: string; number: string; status: string; scheduled_at: Date | null; timezone: string };

/** the booking + may this user act on it? crew member, or a GM holding job.checkpoint (matrix 2.2) */
async function loadForCrew(t: Db, user: SessionUser, id: string, perms: string[]): Promise<Booking> {
  const b = (await t<Booking[]>`select b.id, b.company_id, b.number, b.status, b.scheduled_at, c.timezone from bookings b join companies c on c.id = b.company_id
    where b.id = ${id} and b.company_id = ${user.companyId} and b.status <> 'cancelled' for update of b`)[0];
  if (!b) throw notFound();
  const crew = (await t`select 1 from booking_technicians where booking_id = ${id} and user_id = ${user.id}`).length > 0;
  if (!perms.includes("job.checkpoint")) throw forbidden(); // CEO can switch it off per role (FR-105)
  if (!crew && user.role !== "gm") throw forbidden();          // technicians: own jobs only
  return b;
}

// ---------- checkpoints ----------
export async function recordCheckpoint(user: SessionUser, perms: string[], ip: string | null, id: string,
  v: { step: Step; at?: string | null; lat?: number | null; lng?: number | null; accuracy?: number | null; no_gps?: boolean; offline?: boolean }) {
  return tx(user.id, async (t) => {
    const b = await loadForCrew(t, user, id, perms);
    if (!WORKING.includes(b.status)) throw new AppError("BOOKING_NOT_ASSIGNED", 400);
    const done = await t<{ step: Step; at: Date }[]>`select step, at from booking_checkpoints where booking_id = ${id} order by at`;
    const existing = done.find((d) => d.step === v.step);
    if (existing) return { step: v.step, at: existing.at, duplicate: true }; // pressing twice = one checkpoint
    const idx = STEPS.indexOf(v.step);
    const prev = idx > 0 ? done.find((d) => d.step === STEPS[idx - 1]) : null;
    if (idx > 0 && !prev) throw new AppError("CHECKPOINT_ORDER", 400);
    // the time it was pressed (offline queue): not in the future, not older than 48 h, not before the previous step
    const when = v.at ? new Date(v.at) : new Date();
    if (Number.isNaN(when.getTime()) || when.getTime() > Date.now() + 5 * 60_000 || when.getTime() < Date.now() - 48 * 3600_000 || (prev && when < prev.at))
      throw new AppError("CHECKPOINT_TIME", 400);
    const noGps = v.no_gps === true || v.lat == null || v.lng == null;
    await t`insert into booking_checkpoints (booking_id, company_id, step, at, lat, lng, accuracy_m, no_gps, offline, by_user)
      values (${id}, ${b.company_id}, ${v.step}::checkpoint_step, ${when}, ${noGps ? null : (v.lat ?? null)}, ${noGps ? null : (v.lng ?? null)}, ${noGps ? null : (v.accuracy ?? null)}, ${noGps}, ${v.offline === true}, ${user.id})`;
    const next = STATUS_AFTER[v.step];
    if (next && b.status !== next) await t`update bookings set status = ${next}::booking_status where id = ${id}`;
    await audit(t, { companyId: b.company_id, userId: user.id, action: "job.checkpoint", table: "bookings", rowId: id, new: { step: v.step, at: when, no_gps: noGps, offline: v.offline === true }, ip });
    // FR-1001: the work group sees departed / arrived / finished
    const icon = { depart: "🚐 ចេញដំណើរ", arrive: "📍 ដល់ទីតាំង", finish: "✅ បញ្ចប់ការងារ" } as Partial<Record<Step, string>>;
    if (icon[v.step]) {
      const group = (await t<{ g: string | null }[]>`select telegram_group_chat_id as g from company_settings where company_id = ${b.company_id}`)[0]?.g;
      if (group) await enqueue(t, b.company_id, group, `${icon[v.step]} · ${b.number}\n👷 ${user.fullName} · ${fmtLocal(when, b.timezone || "Asia/Phnom_Penh").slice(-5)}${noGps ? " · ⚠️ គ្មាន GPS" : ""}`, null, `cp:${id}:${v.step}`);
    }
    return { step: v.step, at: when, duplicate: false };
  });
}

/** FR-602: travel / waiting / work / return in minutes (null until both ends exist) */
function durations(cps: { step: string; at: Date }[]) {
  const at = (s: string) => cps.find((c) => c.step === s)?.at;
  const m = (a?: Date, b?: Date) => (a && b ? Math.round((b.getTime() - a.getTime()) / 60_000) : null);
  return { travel: m(at("depart"), at("arrive")), wait: m(at("arrive"), at("start")), work: m(at("start"), at("finish")), return: m(at("finish"), at("return")) };
}

/** everything about the job's execution; technicians only on their jobs (visibility like getBooking) */
export async function jobInfo(user: SessionUser, id: string) {
  const own = user.role === "tech" ? sql`and exists (select 1 from booking_technicians t where t.booking_id = b.id and t.user_id = ${user.id})` : sql``;
  const b = (await sql`select b.id from bookings b where b.id = ${id} and b.company_id = ${user.companyId} ${own}`)[0];
  if (!b) throw notFound();
  const checkpoints = await sql<{ step: string; at: Date; lat: number | null; lng: number | null; accuracy: number | null; no_gps: boolean; offline: boolean; by_name: string | null }[]>`
    select c.step, c.at, c.lat, c.lng, c.accuracy_m as accuracy, c.no_gps, c.offline, u.full_name as by_name
    from booking_checkpoints c left join users u on u.id = c.by_user where c.booking_id = ${id} order by c.at, c.id`;
  const photos = await sql`select id, kind, created_at from job_files where booking_id = ${id} and deleted_at is null and kind in ('before', 'after', 'survey') order by created_at`;
  const materials = await sql`select m.catalog_item_id, i.name_km, i.name_en, i.unit, m.qty::float as qty from booking_materials m join catalog_items i on i.id = m.catalog_item_id where m.booking_id = ${id} order by i.name_km`;
  const report = (await sql`select r.notes, r.status, r.version, r.submitted_at, r.review_note, r.reviewed_at, r.signature_file, s.full_name as submitted_by_name, v.full_name as reviewed_by_name
    from booking_reports r left join users s on s.id = r.submitted_by left join users v on v.id = r.reviewed_by where r.booking_id = ${id}`)[0] ?? null;
  return { checkpoints, durations: durations(checkpoints), photos, materials, report };
}

// ---------- files (photos, signature) ----------
const MAX_BYTES = 2_000_000;
function sniff(buf: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}
/** checked image (magic bytes, 2 MB) written under uploads/<company>/<yyyy-mm>/ → relative path + mime */
export async function saveImage(companyId: string, data: string, only?: "image/png", badCode = "BAD_IMAGE"): Promise<{ id: string; rel: string; mime: string; bytes: number }> {
  const buf = Buffer.from(data, "base64");
  if (buf.length > MAX_BYTES) throw new AppError("IMAGE_TOO_LARGE", 413);
  const mime = sniff(buf);
  if (!mime || (only && mime !== only)) throw new AppError(badCode, 400);
  const id = randomUUID();
  const rel = join(companyId, new Date().toISOString().slice(0, 7), `${id}.${mime.split("/")[1]}`);
  const abs = join(config.uploadsDir, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, buf, { mode: 0o640 });
  return { id, rel, mime, bytes: buf.length };
}
export const MIME_BY_EXT: Record<string, string> = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

export async function storeFile(t: Db, user: SessionUser, bookingId: string, kind: "before" | "after" | "signature" | "survey", data: string, only?: "image/png"): Promise<string> {
  const { id, rel, mime, bytes } = await saveImage(user.companyId, data, only, kind === "signature" ? "SIGNATURE_REQUIRED" : "BAD_IMAGE");
  await t`insert into job_files (id, company_id, booking_id, kind, path, mime, bytes, created_by) values (${id}, ${user.companyId}, ${bookingId}, ${kind}::job_file_kind, ${rel}, ${mime}, ${bytes}, ${user.id})`;
  return id;
}

const PHOTO_STATUSES = ["on_site", "working", "work_done", "revision"];
export async function addPhoto(user: SessionUser, perms: string[], ip: string | null, id: string, kind: "before" | "after", data: string) {
  return tx(user.id, async (t) => {
    const b = await loadForCrew(t, user, id, perms);
    if (["pending_review", "reviewed", "invoiced", "partially_paid", "closed"].includes(b.status)) throw new AppError("REPORT_LOCKED", 400);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError("NOT_ON_SITE", 400);
    const fid = await storeFile(t, user, id, kind, data);
    await audit(t, { companyId: b.company_id, userId: user.id, action: "job.photo", table: "job_files", rowId: fid, new: { booking_id: id, kind }, ip });
    return { id: fid };
  });
}
export async function removePhoto(user: SessionUser, perms: string[], id: string, fileId: string) {
  return tx(user.id, async (t) => {
    const b = await loadForCrew(t, user, id, perms);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError("REPORT_LOCKED", 400);
    const r = await t`update job_files set deleted_at = now() where id = ${fileId} and booking_id = ${id} and kind in ('before', 'after') and deleted_at is null returning id`;
    if (!r.length) throw notFound();
    return { ok: true };
  });
}
/** authenticated download: same company; technicians only files of their jobs */
export async function readJobFile(user: SessionUser, fileId: string): Promise<{ mime: string; data: Buffer }> {
  const f = (await sql<{ path: string; mime: string; booking_id: string | null }[]>`select path, mime, booking_id from job_files where id = ${fileId} and company_id = ${user.companyId} and deleted_at is null and kind <> 'receipt'`)[0]; // receipts: accounting only
  if (!f) throw notFound();
  if (user.role === "tech" && !(await sql`select 1 from booking_technicians where booking_id = ${f.booking_id} and user_id = ${user.id}`).length) throw notFound();
  return { mime: f.mime, data: await readFile(join(config.uploadsDir, f.path)) };
}

// ---------- materials ----------
export async function setMaterials(user: SessionUser, perms: string[], ip: string | null, id: string, items: { catalog_item_id: string; qty: number }[]) {
  return tx(user.id, async (t) => {
    const b = await loadForCrew(t, user, id, perms);
    if (!PHOTO_STATUSES.includes(b.status)) throw new AppError("REPORT_LOCKED", 400);
    if ((await t`select 1 from bookings where id = ${id} and materials_confirmed_at is not null`).length) throw new AppError("MATERIALS_CONFIRMED", 400); // D-87: stock already taken
    const ids = [...new Set(items.map((i) => i.catalog_item_id))];
    if (ids.length) {
      const okIds = (await t<{ id: string }[]>`select id from catalog_items where id = any(${t.array(ids)}::uuid[]) and company_id = ${user.companyId} and is_active`).map((r) => r.id);
      if (okIds.length !== ids.length) throw new AppError("ITEM_NOT_FOUND", 404);
    }
    await t`delete from booking_materials where booking_id = ${id}`;
    for (const i of items) await t`insert into booking_materials (booking_id, catalog_item_id, qty) values (${id}, ${i.catalog_item_id}, ${i.qty})
      on conflict (booking_id, catalog_item_id) do update set qty = excluded.qty`;
    await audit(t, { companyId: b.company_id, userId: user.id, action: "job.materials", table: "booking_materials", rowId: id, new: { items }, ip });
    return { ok: true };
  });
}

// ---------- report + review ----------
export async function submitReport(user: SessionUser, perms: string[], ip: string | null, id: string, v: { notes: string; signature?: string | null }) {
  return tx(user.id, async (t) => {
    const b = await loadForCrew(t, user, id, perms);
    if (!["work_done", "revision"].includes(b.status)) throw new AppError(b.status === "pending_review" ? "REPORT_LOCKED" : "WORK_NOT_FINISHED", 400);
    const counts = (await t<{ before: number; after: number }[]>`select count(*) filter (where kind = 'before')::int as before, count(*) filter (where kind = 'after')::int as after
      from job_files where booking_id = ${id} and deleted_at is null`)[0]!;
    if (counts.before < 1 || counts.after < 1) throw new AppError("PHOTOS_REQUIRED", 400); // OQ-08: 1 before + 1 after minimum
    if (!v.signature) throw new AppError("SIGNATURE_REQUIRED", 400); // BR-08 / AC-09
    const sig = await storeFile(t, user, id, "signature", v.signature, "image/png");
    await t`insert into booking_reports (booking_id, company_id, notes, signature_file, status, version, submitted_by, submitted_at)
      values (${id}, ${b.company_id}, ${v.notes.trim() || null}, ${sig}, 'submitted', 1, ${user.id}, now())
      on conflict (booking_id) do update set notes = excluded.notes, signature_file = excluded.signature_file, status = 'submitted', version = booking_reports.version + 1,
        submitted_by = excluded.submitted_by, submitted_at = now(), review_note = null, reviewed_by = null, reviewed_at = null`;
    await t`update bookings set status = 'pending_review' where id = ${id}`;
    await audit(t, { companyId: b.company_id, userId: user.id, action: "job.report", table: "booking_reports", rowId: id, new: { notes: v.notes.trim() }, ip });
    // FR-1002: GM receives the job waiting for review
    const reviewers = await t<{ id: string }[]>`select distinct u.id from users u join role_permissions rp on rp.company_id = u.company_id and rp.role = u.role
      where u.company_id = ${b.company_id} and u.is_active and ((rp.permission_key = 'job.review' and rp.allowed and u.role = 'gm') or (u.role = 'tech' and u.is_lead and u.id <> ${user.id}))`;
    for (const r of reviewers) await notifyUser(t, b.company_id, r.id, "job.review", { km: `🔎 រង់ចាំពិនិត្យ · ${b.number}`, en: `🔎 Waiting for review · ${b.number}` }, { km: `របាយការណ៍ការងារពី ${user.fullName}`, en: `Job report from ${user.fullName}` }, `/bookings/${id}`, `review-req:${id}:${Date.now()}:${r.id}`);
    return { ok: true, status: "pending_review" as const };
  });
}

export async function reviewReport(user: SessionUser, ip: string | null, id: string, decision: "approve" | "revision", note: string) {
  return tx(user.id, async (t) => {
    const b = (await t<Booking[]>`select b.id, b.company_id, b.number, b.status, b.scheduled_at, c.timezone from bookings b join companies c on c.id = b.company_id
      where b.id = ${id} and b.company_id = ${user.companyId} for update of b`)[0];
    if (!b) throw notFound();
    if (b.status !== "pending_review") throw new AppError("NOT_PENDING_REVIEW", 400);
    if (decision === "revision" && note.trim().length < 3) throw new AppError("NOTE_REQUIRED", 400);
    const status = decision === "approve" ? "reviewed" : "revision";
    await t`update booking_reports set status = ${status}::report_status, review_note = ${note.trim() || null}, reviewed_by = ${user.id}, reviewed_at = now() where booking_id = ${id}`;
    await t`update bookings set status = ${status}::booking_status where id = ${id}`;
    await audit(t, { companyId: b.company_id, userId: user.id, action: "job.review", table: "booking_reports", rowId: id, new: { decision, note: note.trim() }, ip });
    const crew = await t<{ user_id: string }[]>`select user_id from booking_technicians where booking_id = ${id}`;
    for (const c of crew) await notifyUser(t, b.company_id, c.user_id, decision === "approve" ? "job.reviewed" : "job.revision",
      decision === "approve" ? { km: `✅ ការងារត្រឹមត្រូវ · ${b.number}`, en: `✅ Job approved · ${b.number}` } : { km: `✏️ សូមកែរបាយការណ៍ · ${b.number}`, en: `✏️ Please fix the report · ${b.number}` },
      decision === "approve" ? { km: `ពិនិត្យដោយ ${user.fullName}`, en: `Reviewed by ${user.fullName}` } : `📝 ${note.trim()}`,
      `/tech/job/${id}`, `review:${id}:${Date.now()}:${c.user_id}`);
    return { ok: true, status };
  });
}

// ---------- late alert (BR-07 · FR-603 · AC-08): once per job ----------
export async function lateAlerts(): Promise<number> {
  const late = await sql<{ id: string; company_id: string; number: string; scheduled_at: Date; timezone: string; crew: string | null }[]>`
    update bookings b set late_alerted_at = now()
    from company_settings s, companies c
    where s.company_id = b.company_id and c.id = b.company_id and b.late_alerted_at is null
      and b.status in ('assigned', 'en_route') and b.scheduled_at is not null
      and now() > b.scheduled_at + make_interval(mins => s.late_alert_min)
      and b.scheduled_at > now() - interval '1 day'
      and not exists (select 1 from booking_checkpoints k where k.booking_id = b.id and k.step = 'arrive')
    returning b.id, b.company_id, b.number, b.scheduled_at, c.timezone,
      (select string_agg(u.full_name, ', ') from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id) as crew`;
  for (const b of late) {
    const to = await sql<{ id: string }[]>`select id from users where company_id = ${b.company_id} and is_active and role in ('admin', 'gm')`;
    for (const u of to) await notifyUser(sql, b.company_id, u.id, "booking.late", { km: `⏰ ជាងយឺត · ${b.number}`, en: `⏰ Technician late · ${b.number}` },
      { km: `ណាត់ ${fmtLocal(b.scheduled_at, b.timezone || "Asia/Phnom_Penh").slice(-5)} · មិនទាន់ចុច «ដល់ទីតាំង»\n👷 ${b.crew ?? "—"}`, en: `Due ${fmtLocal(b.scheduled_at, b.timezone || "Asia/Phnom_Penh").slice(-5)} · «Arrived on site» not pressed yet\n👷 ${b.crew ?? "—"}` }, `/bookings/${b.id}`, `late:${b.id}:${u.id}`);
  }
  return late.length;
}
