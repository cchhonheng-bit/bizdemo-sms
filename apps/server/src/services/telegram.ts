// Telegram: Bot API client, outbox (queue in DB, retry ≤ 5, blocked chat → failed at once — D-15),
// "Booking Confirmed" message text (Architecture §8.1), link codes (S-11), group registration.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { sql, type Db } from "../db.js";
import { audit } from "./audit.js";

// ---------- Bot API ------------------------------------------------------------
export type SendResult = { ok: true } | { ok: false; error: string; permanent: boolean; retryAfter?: number };

export async function sendMessage(chatId: number | string, text: string, replyMarkup?: unknown, token = config.telegram.botToken): Promise<SendResult> {
  if (!token) return { ok: false, error: "NO_BOT_TOKEN", permanent: false };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctrl.signal,
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup ?? undefined, disable_web_page_preview: true }),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; parameters?: { retry_after?: number } };
    if (res.ok && json.ok) return { ok: true };
    // 400 (chat not found / bot was blocked) and 403 (forbidden) never succeed on retry
    return { ok: false, error: `${res.status} ${json.description ?? ""}`.trim(), permanent: res.status === 400 || res.status === 403, retryAfter: json.parameters?.retry_after };
  } catch (e) {
    return { ok: false, error: (e as Error).message, permanent: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function setWebhook(publicUrl: string, secret: string, token = config.telegram.botToken): Promise<{ ok: boolean; description?: string }> {
  if (!token || !secret) return { ok: false, description: "missing token/secret" };
  const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: `${publicUrl}/api/telegram/webhook`, secret_token: secret, allowed_updates: ["message"], drop_pending_updates: false }),
  });
  return (await res.json().catch(() => ({ ok: false }))) as { ok: boolean; description?: string };
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---------- outbox --------------------------------------------------------------
export async function enqueue(db: Db, companyId: string, chatId: number | string, text: string, replyMarkup: unknown, dedupeKey: string): Promise<void> {
  await db`insert into telegram_outbox (company_id, chat_id, text, reply_markup, dedupe_key)
           values (${companyId}, ${String(chatId)}::bigint, ${text}, ${replyMarkup ? db.json(replyMarkup as never) : null}, ${dedupeKey})
           on conflict (dedupe_key) do nothing`;
}

let flushing = false;
/** Deliver pending outbox rows (called after assign and by the cron every 30 s). Returns counts. */
export async function flushOutbox(limit = 20, send: typeof sendMessage = sendMessage): Promise<{ taken: number; sent: number; failed: number; retry: number }> {
  if (flushing) return { taken: 0, sent: 0, failed: 0, retry: 0 };
  if (send === sendMessage && !config.telegram.botToken) return { taken: 0, sent: 0, failed: 0, retry: 0 }; // no bot configured → keep rows pending
  flushing = true;
  const out = { taken: 0, sent: 0, failed: 0, retry: 0 };
  try {
    const rows = await sql<{ id: number; chat_id: string; text: string; reply_markup: unknown; attempts: number }[]>`
      update telegram_outbox o set attempts = attempts + 1
      where o.id in (select id from telegram_outbox where status = 'pending' and attempts < 5 order by created_at limit ${Math.max(1, Math.min(limit, 50))} for update skip locked)
      returning o.id, o.chat_id, o.text, o.reply_markup, o.attempts`;
    out.taken = rows.length;
    for (const r of rows) {
      const res = await send(r.chat_id, r.text, r.reply_markup ?? undefined);
      if (res.ok) {
        out.sent++;
        await sql`update telegram_outbox set status = 'sent', sent_at = now(), last_error = null where id = ${r.id}`;
      } else {
        const failed = res.permanent || r.attempts >= 5;
        if (failed) out.failed++; else out.retry++;
        await sql`update telegram_outbox set status = ${failed ? "failed" : "pending"}::outbox_status, last_error = ${res.error} where id = ${r.id}`;
        if (res.retryAfter) await new Promise((r) => setTimeout(r, Math.min(res.retryAfter! * 1000, 5000)));
      }
    }
  } finally {
    flushing = false;
  }
  return out;
}

// ---------- Booking Confirmed text -----------------------------------------------------
export async function bookingConfirmedText(db: Db, bookingId: string): Promise<{ text: string; markup: unknown | null; companyId: string; number: string }> {
  const b = (await db<{
    number: string; service_text: string; scheduled_at: Date | null; address: string | null; zone: string; notes: string | null; lat: number | null; lng: number | null;
    cname: string; phones: string[]; vcode: string | null; timezone: string; company_id: string;
  }[]>`select bk.number, bk.service_text, bk.scheduled_at, bk.address, bk.zone, bk.notes, bk.lat, bk.lng, bk.company_id,
              c.name as cname, c.phones, v.code as vcode, co.timezone
       from bookings bk join customers c on c.id = bk.customer_id left join vehicles v on v.id = bk.vehicle_id join companies co on co.id = bk.company_id
       where bk.id = ${bookingId}`)[0]!;
  const techs = await db<{ full_name: string; role: string }[]>`select u.full_name, t.role from booking_technicians t join users u on u.id = t.user_id
       where t.booking_id = ${bookingId} order by t.role, u.full_name`;
  const dt = b.scheduled_at ? fmtLocal(b.scheduled_at, b.timezone || "Asia/Phnom_Penh") : "—";
  const techLine = techs.length ? techs.map((t, i) => `${i + 1}. ${t.full_name}${t.role === "lead" ? " (មេជាង)" : ""}`).join("  ") : "—";
  const text = [
    `✅ Booking Confirmed (${b.number})`,
    `📅 ${dt}`,
    `👤 អតិថិជន: ${b.cname}${b.phones?.[0] ? ` · 📞 ${b.phones[0]}` : ""}`,
    `📍 ${b.address ?? "—"} (${b.zone === "inside" ? "ក្នុងបុរី" : "ក្រៅបុរី"})`,
    `🔧 សេវាកម្ម: ${b.service_text}`,
    `👷 ជាង: ${techLine}${b.vcode ? ` · 🚐 ${b.vcode}` : ""}`,
    `📝 ចំណាំ: ${b.notes ?? "—"}`,
  ].join("\n");
  const markup = b.lat != null && b.lng != null
    ? { inline_keyboard: [[{ text: "🗺 Direction", url: `https://www.google.com/maps/dir/?api=1&destination=${b.lat},${b.lng}&travelmode=driving` }]] }
    : null;
  return { text, markup, companyId: b.company_id, number: b.number };
}

export function fmtLocal(d: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("day")}-${g("month")}-${g("year")} · ${g("hour")}:${g("minute")}`;
}

/** Group + every linked technician of the team get the message; every technician gets an in-app notification. */
export async function enqueueBookingConfirmed(db: Db, bookingId: string, reason: string): Promise<void> {
  const { text, markup, companyId, number } = await bookingConfirmedText(db, bookingId);
  const group = (await db<{ telegram_group_chat_id: string | null }[]>`select telegram_group_chat_id from company_settings where company_id = ${companyId}`)[0]?.telegram_group_chat_id;
  if (group) await enqueue(db, companyId, group, text, markup, `booking:${bookingId}:${reason}:group`);
  const team = await db<{ id: string; telegram_chat_id: string | null }[]>`select u.id, u.telegram_chat_id from booking_technicians t join users u on u.id = t.user_id where t.booking_id = ${bookingId}`;
  for (const m of team) {
    await db`insert into notifications (company_id, user_id, kind, title, body, link)
             values (${companyId}, ${m.id}, 'booking.assigned', ${number + " · ការងារថ្មី"}, ${text.slice(0, 200)}, ${"/tech/job/" + bookingId})`;
    if (m.telegram_chat_id) await enqueue(db, companyId, m.telegram_chat_id, text, markup, `booking:${bookingId}:${reason}:${m.id}`);
  }
}

// ---------- link codes (S-11) ---------------------------------------------------------------
export async function createLinkCode(userId: string): Promise<string> {
  const code = randomBytes(16).toString("hex");
  await sql`delete from telegram_link_codes where user_id = ${userId} or expires_at < now()`;
  await sql`insert into telegram_link_codes (code, user_id, expires_at) values (${code}, ${userId}, now() + interval '10 minutes')`;
  return code;
}

/** /start <code> in a private chat → link. A Telegram account can be linked to one user only (F-M2-03). */
export async function consumeLinkCode(code: string, tgUser: number, chatId: number): Promise<{ ok: true; fullName: string } | { ok: false; error: string }> {
  return sql.begin(async (t) => {
    const row = (await t<{ user_id: string }[]>`select user_id from telegram_link_codes where code = ${code} and used_at is null and expires_at > now() for update`)[0];
    if (!row) return { ok: false as const, error: "INVALID_CODE" };
    await t`update telegram_link_codes set used_at = now() where code = ${code}`;
    const prev = await t<{ id: string; company_id: string }[]>`update users set telegram_user_id = null, telegram_chat_id = null where telegram_user_id = ${tgUser} and id <> ${row.user_id} returning id, company_id`;
    for (const p of prev) await audit(t, { companyId: p.company_id, userId: p.id, action: "telegram.unlink", source: "telegram", table: "users", rowId: p.id, new: { reason: "relinked_to_other_user" } });
    const u = (await t<{ full_name: string; company_id: string }[]>`update users set telegram_user_id = ${tgUser}, telegram_chat_id = ${chatId} where id = ${row.user_id} returning full_name, company_id`)[0]!;
    await audit(t, { companyId: u.company_id, userId: row.user_id, action: "telegram.link", source: "telegram", table: "users", rowId: row.user_id, new: { telegram_user_id: tgUser } });
    await t`insert into notifications (company_id, user_id, kind, title) values (${u.company_id}, ${row.user_id}, 'telegram.linked', 'Telegram ភ្ជាប់រួច')`;
    return { ok: true as const, fullName: u.full_name };
  }) as Promise<{ ok: true; fullName: string } | { ok: false; error: string }>;
}

/** /register in a group by a linked user with settings.manage → company group. */
export async function registerGroup(tgUser: number, chatId: number, title: string): Promise<{ ok: boolean; error?: string }> {
  const u = (await sql<{ id: string; company_id: string; role: string }[]>`select id, company_id, role from users where telegram_user_id = ${tgUser} and is_active`)[0];
  if (!u) return { ok: false, error: "NOT_LINKED" };
  const allowed = await sql`select 1 from role_permissions where company_id = ${u.company_id} and role = ${u.role}::user_role and permission_key = 'settings.manage' and allowed`;
  if (allowed.length === 0) return { ok: false, error: "FORBIDDEN" };
  await sql`update company_settings set telegram_group_chat_id = ${chatId}, updated_by = ${u.id} where company_id = ${u.company_id}`;
  await audit(sql, { companyId: u.company_id, userId: u.id, action: "telegram.group_registered", source: "telegram", table: "company_settings", rowId: u.company_id, new: { chat_id: chatId, title } });
  return { ok: true };
}
