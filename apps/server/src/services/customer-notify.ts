// Messages to the CUSTOMER of a booking on Telegram (D-99 · tracking D-105): confirmation / decline of an online booking, the
// answer to a reschedule request, and the tracking messages (reminder, on the way, done). They go through the hub to the chat linked to the booking (or to the customer) and only
// while that person's service subscription is active — the hub decides (A4). Best effort: never throws, never blocks long.
import { sql } from "../db.js";
import { featureOn } from "../lib/features.js";
import { WARRANTY_DAYS } from "./bookings.js";
import { hubCall, hubConfigured } from "./hub-client.js";
import { fmtLocal } from "./telegram.js";

export type CustomerMsg = { number: string; service: string; when: string; technician: string | null };

export async function tellCustomer(bookingId: string, text: (b: CustomerMsg) => string): Promise<boolean> {
  try {
    if (!hubConfigured()) return false;
    const b = (await sql<{ number: string; service_text: string; scheduled_at: Date | null; tz: string; sub: string | null; technician: string | null }[]>`
      select b.number, b.service_text, b.scheduled_at, co.timezone as tz, coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub,
        (select u.full_name from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id order by (t.role = 'lead') desc, u.full_name limit 1) as technician
      from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id where b.id = ${bookingId}`)[0];
    if (!b?.sub) return false;
    const msg = text({ number: b.number, service: b.service_text, when: b.scheduled_at ? fmtLocal(b.scheduled_at, b.tz || "Asia/Phnom_Penh") : "—", technician: b.technician }).slice(0, 1000);
    if (!msg) return false;
    const r = await Promise.race([
      hubCall("POST", "/internal/notify-subscriber", { subscriber_id: Number(b.sub), text: msg }).catch(() => null),
      new Promise<null>((resolve) => { setTimeout(() => resolve(null), 2500).unref(); }),
    ]);
    return !!r && r.status === 200 && r.json?.ok === true;
  } catch {
    return false;
  }
}

// ---------- tracking (final brief E3): reminder 1 day before · technician on the way · job done with the warranty end ----------
// One sweep a minute finds what is due and sends each message ONCE per booking (customer_notices). Only events that are fresh
// (so a deploy never sends old news), only bookings whose chat is linked. A message the hub refuses for good (the person
// stopped the bot) is marked as done; a hub that is down is tried again on the next sweep.
type Due = { id: string; kind: "reminder" | "on_the_way" | "done"; number: string; service_text: string; scheduled_at: Date | null; tz: string; sub: string; technician: string | null; until: string | null };
const dmy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
export async function customerNotices(): Promise<number> {
  if (!hubConfigured() || !featureOn("website")) return 0;
  const cols = (kind: string) => sql`b.id, ${kind}::text as kind, b.number, b.service_text, b.scheduled_at, co.timezone as tz, coalesce(b.web_subscriber_id, c.tg_subscriber_id)::text as sub,
    (select u.full_name from booking_technicians t join users u on u.id = t.user_id where t.booking_id = b.id order by (t.role = 'lead') desc, u.full_name limit 1) as technician,
    ((b.closed_at at time zone co.timezone)::date + ${WARRANTY_DAYS}::int)::text as until`;
  const base = (kind: string) => sql`from bookings b join customers c on c.id = b.customer_id join companies co on co.id = b.company_id
    where coalesce(b.web_subscriber_id, c.tg_subscriber_id) is not null and not exists (select 1 from customer_notices n where n.booking_id = b.id and n.kind = ${kind})`;
  const due = await sql<Due[]>`
    select ${cols("reminder")} ${base("reminder")} and b.status in ('new', 'quoted', 'assigned') and (b.web_status is null or b.web_status = 'confirmed')
      and b.scheduled_at > now() + interval '2 hours' and b.scheduled_at <= now() + interval '24 hours' and b.created_at < b.scheduled_at - interval '24 hours'
    union all
    select ${cols("on_the_way")} ${base("on_the_way")} and b.status = 'en_route'
      and exists (select 1 from booking_status_log l where l.booking_id = b.id and l.to_status = 'en_route' and l.at > now() - interval '2 hours')
    union all
    select ${cols("done")} ${base("done")} and b.status = 'closed' and b.closed_at > now() - interval '2 hours'
    limit 50`;
  let sent = 0;
  for (const d of due) {
    const when = d.scheduled_at ? fmtLocal(d.scheduled_at, d.tz || "Asia/Phnom_Penh") : "—";
    const text = d.kind === "reminder" ? `🔔 រំលឹក៖ ការកក់ ${d.number} ជិតដល់ពេលហើយ\n🕒 ${when}\n🛠 ${d.service_text}${d.technician ? `\n👷 ជាង ${d.technician}` : ""}`
      : d.kind === "on_the_way" ? `🚗 ជាង${d.technician ? ` ${d.technician}` : ""} កំពុងធ្វើដំណើរមកកាន់អ្នក\n🛠 ${d.service_text} (${d.number})`
      : `✅ ការងារ ${d.number} រួចរាល់ — សូមអរគុណ!\n🛠 ${d.service_text}${d.until ? `\n🛡 ធានាដល់ថ្ងៃ ${dmy(d.until)}` : ""}`;
    const r = await hubCall("POST", "/internal/notify-subscriber", { subscriber_id: Number(d.sub), text }).catch(() => null);
    const ok = !!r && r.status === 200 && r.json?.ok === true;
    if (!ok && !(r && r.status === 200 && r.json?.error === "NOT_SUBSCRIBED")) continue; // hub down or a passing error: next sweep
    await sql`insert into customer_notices (booking_id, kind, ok) values (${d.id}, ${d.kind}, ${ok}) on conflict do nothing`;
    if (ok) sent++;
  }
  return sent;
}
