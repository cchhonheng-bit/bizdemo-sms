// Messages to the CUSTOMER of a booking on Telegram (D-96): confirmation / decline of an online booking, who is coming, the
// answer to a reschedule request. They go through the hub to the chat linked to the booking (or to the customer) and only
// while that person's service subscription is active — the hub decides (A4). Best effort: never throws, never blocks long.
import { sql } from "../db.js";
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

/** a technician was assigned to a website booking → the customer hears who is coming and when */
export const tellCustomerTechnician = (bookingId: string) =>
  tellCustomer(bookingId, (b) => (b.technician ? `👷 ការកក់ ${b.number}\nជាង ${b.technician} នឹងទៅដល់៖ ${b.when}\n🛠 ${b.service}` : ""));
