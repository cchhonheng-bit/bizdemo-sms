// A2 service reminders (D-86 · flag "reminders"): a service with an interval (e.g. AC cleaning every 3 months) is due again
// interval months after the last finished job of that service — per unit when the job named units, per customer otherwise.
// A future open booking of the same service hides it; «contacted» keeps it listed; snooze hides it until a date; dismiss ends it.
// Optional Telegram reminder to customers who subscribed through their own link (service consent) — once per due date, daily limit.
import { sql, tx, type Db } from "../db.js";
import { AppError, notFound } from "../lib/errors.js";
import type { SessionUser } from "./auth.js";
import { audit } from "./audit.js";
import { hubCall, shopBotUsername } from "./hub-client.js";
import { randomCode } from "../lib/secure.js";
import { customerText } from "@sms/shared";
import { issueInitialPassword } from "./customer-auth.js";
import { customerGrid, menuUrl } from "./customer-bot.js";

const FINISHED = ["work_done", "pending_review", "revision", "reviewed", "invoiced", "partially_paid", "closed"];
const OPEN = ["new", "survey", "quoted", "assigned", "en_route", "on_site", "working"];

export type Reminder = { customer_id: string; customer_name: string; phones: string[]; unit_id: string | null; unit_label: string | null;
  service_item_id: string; service_name: string; last_on: string; due_on: string; status: "overdue" | "due"; days_overdue: number; days_left: number;
  last_action: string | null; last_note: string | null; last_action_at: Date | null; telegram: boolean };

export async function listReminders(user: SessionUser, days = 14): Promise<Reminder[]> {
  const c = user.companyId;
  const rows = await sql<(Reminder & { snoozed: boolean; dismissed: boolean; booked: boolean })[]>`
    with last as (
      select b.customer_id, b.service_item_id, bu.unit_id,
        max((coalesce((select max(k.at) from booking_checkpoints k where k.booking_id = b.id and k.step = 'finish'), b.closed_at, b.scheduled_at) at time zone co.timezone)::date) as last_on
      from bookings b join companies co on co.id = b.company_id left join booking_units bu on bu.booking_id = b.id
      where b.company_id = ${c} and b.status = any(${sql.array(FINISHED)}::booking_status[])
        and b.service_item_id in (select id from catalog_items where company_id = ${c} and reminder_months is not null and is_active)
      group by b.customer_id, b.service_item_id, bu.unit_id
    ), due as (
      select l.*, i.name_km as service_name, (l.last_on + make_interval(months => i.reminder_months))::date as due_on,
        (now() at time zone co.timezone)::date as today
      from last l join catalog_items i on i.id = l.service_item_id join companies co on co.id = ${c}
    )
    select d.customer_id, cu.name as customer_name, cu.phones, d.unit_id, un.label as unit_label, d.service_item_id, d.service_name,
      d.last_on::text, d.due_on::text, case when d.due_on < d.today then 'overdue' else 'due' end as status,
      greatest(0, d.today - d.due_on) as days_overdue, greatest(0, d.due_on - d.today) as days_left,
      cu.tg_subscriber_id is not null as telegram,
      a.action::text as last_action, a.note as last_note, a.at as last_action_at,
      coalesce(a.action = 'snoozed' and a.until > d.today, false) as snoozed, coalesce(a.action = 'dismissed', false) as dismissed,
      exists (select 1 from bookings o where o.customer_id = d.customer_id and o.service_item_id = d.service_item_id and o.status = any(${sql.array(OPEN)}::booking_status[])) as booked
    from due d join customers cu on cu.id = d.customer_id and cu.is_active and not cu.is_test
      left join customer_units un on un.id = d.unit_id
      left join lateral (select action, note, at, until from reminder_actions r where r.company_id = ${c} and r.customer_id = d.customer_id and r.service_item_id = d.service_item_id
        and r.due_on = d.due_on and r.unit_id is not distinct from d.unit_id order by r.at desc, r.id desc limit 1) a on true
    where d.due_on <= d.today + ${days}::int and (d.unit_id is null or un.is_active)
    order by d.due_on, cu.name`;
  return rows.filter((r) => !r.snoozed && !r.dismissed && !r.booked).map((r) => {
    const out: Record<string, unknown> = { ...r };
    for (const k of ["snoozed", "dismissed", "booked"]) delete out[k];
    return out as Reminder;
  });
}

async function check(db: Db, c: string, customerId: string, serviceItemId: string, unitId: string | null | undefined) {
  if (!(await db`select 1 from customers where id = ${customerId} and company_id = ${c}`).length) throw notFound();
  if (!(await db`select 1 from catalog_items where id = ${serviceItemId} and company_id = ${c}`).length) throw notFound();
  if (unitId && !(await db`select 1 from customer_units where id = ${unitId} and customer_id = ${customerId}`).length) throw new AppError("UNIT_NOT_FOUND", 404);
}

export async function reminderAction(user: SessionUser, ip: string | null, v: { customer_id: string; unit_id?: string | null; service_item_id: string; due_on: string; action: "contacted" | "snoozed" | "dismissed"; until?: string | null; note?: string | null }) {
  if (v.action === "snoozed" && !v.until) throw new AppError("UNTIL_REQUIRED", 400);
  return tx(user.id, async (t) => {
    await check(t, user.companyId, v.customer_id, v.service_item_id, v.unit_id);
    const id = (await t<{ id: number }[]>`insert into reminder_actions (company_id, customer_id, unit_id, service_item_id, due_on, action, until, note, by_user)
      values (${user.companyId}, ${v.customer_id}, ${v.unit_id ?? null}, ${v.service_item_id}, ${v.due_on}::date, ${v.action}::reminder_action, ${v.until ?? null}, ${v.note?.trim() || null}, ${user.id}) returning id`)[0]!.id;
    await audit(t, { companyId: user.companyId, userId: user.id, action: `reminder.${v.action}`, table: "reminder_actions", rowId: String(id), new: v, ip });
    return { ok: true };
  });
}

/** optional Telegram reminders: linked customers only (service consent), once per (customer, unit, service, due date), daily limit */
export async function sendReminderTelegram(user: SessionUser, ip: string | null, items: { customer_id: string; unit_id?: string | null; service_item_id: string; due_on: string }[]) {
  const out = { sent: 0, skipped: 0, not_linked: 0, limit: 0, failed: 0 };
  const co = (await sql<{ name: string; info: Record<string, string>; limit: number; tz: string }[]>`select c.name, s.company_info as info, s.reminder_daily_limit as limit, c.timezone as tz
    from companies c join company_settings s on s.company_id = c.id where c.id = ${user.companyId}`)[0]!;
  for (const it of items) {
    await check(sql, user.companyId, it.customer_id, it.service_item_id, it.unit_id);
    const row = (await sql<{ sub: string | null; service: string; unit: string | null; last_on: string | null }[]>`select cu.tg_subscriber_id::text as sub, i.name_km as service,
        (select label from customer_units where id = ${it.unit_id ?? null}) as unit, null::text as last_on
      from customers cu, catalog_items i where cu.id = ${it.customer_id} and i.id = ${it.service_item_id}`)[0]!;
    if (!row.sub) { out.not_linked++; continue; }
    const unitKey = it.unit_id ?? "-";
    if ((await sql`select 1 from reminder_sends where company_id = ${user.companyId} and customer_id = ${it.customer_id} and unit_key = ${unitKey}
        and service_item_id = ${it.service_item_id} and due_on = ${it.due_on}::date`).length) { out.skipped++; continue; }
    const today = (await sql<{ n: number }[]>`select count(*)::int as n from reminder_sends where company_id = ${user.companyId} and (sent_at at time zone ${co.tz})::date = (now() at time zone ${co.tz})::date`)[0]!.n;
    if (today >= co.limit) { out.limit++; continue; }
    const text = [`🔔 ${co.info?.name_km || co.name}`, `ដល់ពេល «${row.service}»${row.unit ? ` · ${row.unit}` : ""} ហើយ (${it.due_on})។`,
      co.info?.phone ? `📞 ${co.info.phone} — ទាក់ទងដើម្បីកក់ពេល។` : "សូមឆ្លើយតបមកកាន់យើង ដើម្បីកក់ពេល។"].join("\n");
    const r = await hubCall("POST", "/internal/notify-subscriber", { subscriber_id: Number(row.sub), text }).catch(() => null);
    if (!r || r.status !== 200 || !r.json?.ok) { out.failed++; continue; }
    await sql`insert into reminder_sends (company_id, customer_id, unit_key, service_item_id, due_on) values (${user.companyId}, ${it.customer_id}, ${unitKey}, ${it.service_item_id}, ${it.due_on}::date) on conflict do nothing`;
    out.sent++;
  }
  if (out.sent) await audit(sql, { companyId: user.companyId, userId: user.id, action: "reminder.telegram", table: "reminder_sends", rowId: user.companyId, new: out, ip });
  return out;
}

// ---------- customer units + per-customer Telegram link ----------
export async function listUnits(user: SessionUser, customerId: string) {
  if (!(await sql`select 1 from customers where id = ${customerId} and company_id = ${user.companyId}`).length) throw notFound();
  return sql`select id, label, kind, brand, model, location_note, installed_on::text, is_active from customer_units where customer_id = ${customerId} order by is_active desc, label`;
}
export async function saveUnit(user: SessionUser, ip: string | null, customerId: string, v: { id?: string; label: string; kind?: string; brand?: string | null; model?: string | null; location_note?: string | null; installed_on?: string | null; is_active?: boolean }) {
  return tx(user.id, async (t) => {
    if (!(await t`select 1 from customers where id = ${customerId} and company_id = ${user.companyId}`).length) throw notFound();
    let id = v.id;
    if (!id) id = (await t<{ id: string }[]>`insert into customer_units (company_id, customer_id, label, kind, brand, model, location_note, installed_on)
      values (${user.companyId}, ${customerId}, ${v.label.trim()}, ${v.kind ?? "ac"}, ${v.brand || null}, ${v.model || null}, ${v.location_note || null}, ${v.installed_on || null}) returning id`)[0]!.id;
    else if (!(await t`update customer_units set label = ${v.label.trim()}, kind = coalesce(${v.kind ?? null}, kind), brand = ${v.brand || null}, model = ${v.model || null},
        location_note = ${v.location_note || null}, installed_on = ${v.installed_on || null}, is_active = coalesce(${v.is_active ?? null}, is_active)
      where id = ${id} and customer_id = ${customerId} returning id`).length) throw notFound();
    await audit(t, { companyId: user.companyId, userId: user.id, action: "customer.unit", table: "customer_units", rowId: id, new: v, ip });
    return { id };
  });
}

export async function customerTgLink(user: SessionUser, ip: string | null, customerId: string) {
  if (!(await sql`select 1 from customers where id = ${customerId} and company_id = ${user.companyId}`).length) throw notFound();
  const bot = await shopBotUsername();
  if (!bot) throw new AppError("NO_SHOP_BOT", 503);
  const code = randomCode(8);
  await sql`insert into customer_tg_codes (code, company_id, customer_id, expires_at, created_by) values (${code}, ${user.companyId}, ${customerId}, now() + interval '7 days', ${user.id})`;
  await audit(sql, { companyId: user.companyId, userId: user.id, action: "customer.tg_link", table: "customer_tg_codes", rowId: customerId, ip });
  return { link: `https://t.me/${bot}?start=s_${code}`, expires_days: 7 };
}

/** hub → shop after the customer ticked the consent from their own link (the staff gave it to this customer): linked, and the
 *  first password comes with the bot's answer (D-106) */
export async function customerSubscribed(code: string, subscriberId: number) {
  const r = await tx(null, async (t) => {
    const k = (await t<{ customer_id: string; company_id: string; used_at: Date | null; expired: boolean; name: string }[]>`select k.customer_id, k.company_id, k.used_at, k.expires_at < now() as expired, c.name
      from customer_tg_codes k join customers c on c.id = k.customer_id where k.code = ${code} for update of k`)[0];
    if (!k || k.expired) return { ok: false as const, error: "CODE_INVALID" };
    if (k.used_at) return { ok: false as const, error: "CODE_USED" };
    await t`update customer_tg_codes set used_at = now() where code = ${code}`;
    await t`update customers set tg_subscriber_id = ${subscriberId} where id = ${k.customer_id}`;
    await audit(t, { companyId: k.company_id, userId: null, action: "customer.tg_link", source: "telegram", table: "customers", rowId: k.customer_id, new: { via: "code" } });
    return { ok: true as const, customer: k.name, password: await issueInitialPassword(t, k.customer_id) };
  });
  if (!r.ok) return { ok: false, error: r.error, text: customerText.linkUsed };
  return { ok: true, customer: r.customer, text: r.password ? customerText.linked(null, r.password) : customerText.linkedKnown, hint: r.password ? customerText.hint : null,
    keyboard: customerGrid(), menu_url: menuUrl() };
}
