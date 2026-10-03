// Messages to the CUSTOMER of a booking on Telegram (D-99 · tracking D-105 · style D-106): confirmation / decline of an online
// booking, the answer to a reschedule request, and the tracking messages (reminder, on the way, done). Khmer, at most 4 lines, a
// button for the next step. They go through the hub to the chat linked to the booking (or to the customer) and only while that
// person's service messages are on — the hub decides (A4). Best effort: never throws, never blocks long.
import { customerText, kmDate, kmWhen } from "@sms/shared";
import { sql } from "../db.js";
import { featureOn } from "../lib/features.js";
import { WARRANTY_DAYS } from "./bookings.js";
import { btn, row, type CustomerMsg } from "./customer-bot.js";
import { hubCall, hubConfigured } from "./hub-client.js";

export type BookingFacts = { number: string; service: string; day: string; time: string; technician: string | null };

export async function tellCustomer(bookingId: string, msg: (b: BookingFacts) => CustomerMsg): Promise<boolean> {
  try {
    if (!hubConfigured()) return false;
    const b = (await sql<{ number: string; service_text: string; scheduled_at: Date | null; tz: string; sub: string | null; technician: string | null }[]>`
      select b.number, b.service_text, b.scheduled_at, co.timezone as tz, coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub,
        (select u.full_name from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id order by (t.role = 'lead') desc, u.full_name limit 1) as technician
      from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id where b.id = ${bookingId}`)[0];
    if (!b?.sub) return false;
    const w = b.scheduled_at ? kmWhen(b.scheduled_at, b.tz || "Asia/Phnom_Penh") : { day: "—", time: "—" };
    const m = msg({ number: b.number, service: b.service_text, day: w.day, time: w.time, technician: b.technician });
    if (!m.text) return false;
    const r = await Promise.race([
      hubCall("POST", "/internal/notify-subscriber", { subscriber_id: Number(b.sub), text: m.text.slice(0, 1000), ...(m.buttons?.length ? { buttons: m.buttons } : {}) }).catch(() => null),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 2500).unref(); }),
    ]);
    return !!r && r.status === 200 && r.json?.ok === true;
  } catch {
    return false;
  }
}

// ---------- tracking: reminder the day before · technician on the way · job done with the warranty end ----------
// One sweep a minute finds what is due and sends each message ONCE per booking (customer_notices). Only events that are fresh
// (a deploy never sends old news), only bookings whose chat is linked. The reminder goes out the day before between 17:00 and
// 20:00 shop time — never at night — and only for bookings made before that window opened. A message the hub refuses for good
// (the person stopped the notices) is marked as done; a hub that is down is tried again on the next sweep.
type Due = { id: string; kind: "reminder" | "on_the_way" | "done"; number: string; service_text: string; scheduled_at: Date | null; tz: string; sub: string; technician: string | null; until: string | null };
export const REMINDER_WINDOW = { from: 17, to: 20 } as const;
/** `now`: the tests move the clock (the reminder window is shop time) */
export async function customerNotices(now: Date = new Date()): Promise<number> {
  if (!hubConfigured() || !featureOn("website")) return 0;
  const cols = (kind: string) => sql`b.id, ${kind}::text as kind, b.number, b.service_text, b.scheduled_at, co.timezone as tz, coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub,
    (select u.full_name from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id order by (t.role = 'lead') desc, u.full_name limit 1) as technician,
    ((b.closed_at at time zone co.timezone)::date + ${WARRANTY_DAYS}::int)::text as until`;
  const base = (kind: string) => sql`from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id
    where coalesce(b.web_subscriber_id, c.tg_subscriber_id) is not null and not exists (select 1 from customer_notices n where n.booking_id = b.id and n.kind = ${kind})`;
  const at = sql`${now}::timestamptz`, localNow = sql`(${now}::timestamptz at time zone co.timezone)`;
  const due = await sql<Due[]>`
    select ${cols("reminder")} ${base("reminder")} and b.status in ('new', 'quoted', 'assigned') and (b.web_status is null or b.web_status = 'confirmed')
      and (b.scheduled_at at time zone co.timezone)::date = ${localNow}::date + 1
      and extract(hour from ${localNow}) >= ${REMINDER_WINDOW.from} and extract(hour from ${localNow}) < ${REMINDER_WINDOW.to}
      and b.created_at < ((${localNow}::date + make_interval(hours => ${REMINDER_WINDOW.from})) at time zone co.timezone)
    union all
    select ${cols("on_the_way")} ${base("on_the_way")} and b.status = 'en_route'
      and exists (select 1 from booking_status_log l where l.booking_id = b.id and l.to_status = 'en_route' and l.at > ${at} - interval '2 hours')
    union all
    select ${cols("done")} ${base("done")} and b.status = 'closed' and b.closed_at > ${at} - interval '2 hours'
    limit 50`;
  let sent = 0;
  for (const d of due) {
    const w = d.scheduled_at ? kmWhen(d.scheduled_at, d.tz || "Asia/Phnom_Penh") : { day: "—", time: "—" };
    const m: CustomerMsg = d.kind === "reminder" ? { text: customerText.reminder(w.time, d.service_text, d.technician), buttons: row(btn.track()) }
      : d.kind === "on_the_way" ? { text: customerText.onTheWay(d.technician), buttons: row(btn.track()) }
      : { text: customerText.done(d.number, d.until ? kmDate(d.until) : null), buttons: row(btn.again()) };
    const r = await hubCall("POST", "/internal/notify-subscriber", { subscriber_id: Number(d.sub), text: m.text, ...(m.buttons ? { buttons: m.buttons } : {}) }).catch(() => null);
    const ok = !!r && r.status === 200 && r.json?.ok === true;
    if (!ok && !(r && r.status === 200 && r.json?.error === "NOT_SUBSCRIBED")) continue; // hub down or a passing error: next sweep
    await sql`insert into customer_notices (booking_id, kind, ok) values (${d.id}, ${d.kind}, ${ok}) on conflict do nothing`;
    if (ok) sent++;
  }
  return sent;
}
