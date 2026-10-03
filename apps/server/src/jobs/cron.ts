// In-process cron (rule 2: no separate worker). Outbox every 30 s (backstop for app-triggered flush, D-15),
// housekeeping hourly (expired sessions / link codes).
import type { FastifyBaseLogger } from "fastify";
import { sql } from "../db.js";
import { cleanupSessions } from "../services/auth.js";
import { flushOutbox } from "../services/telegram.js";
import { hubAlert } from "../services/hub-client.js";
import { lateAlerts } from "../services/jobs.js";
import { customerNotices } from "../services/customer-notify.js";
import { sendSummaries } from "../services/reports.js";

export function startCron(log: FastifyBaseLogger): () => void {
  const outbox = setInterval(() => {
    flushOutbox().then((r) => { if (r.taken) log.info(r, "outbox"); }).catch((e) => log.warn(e, "outbox"));
  }, 30_000);
  // BR-07: technician not «arrived» 10 min after the appointment → Admin + GM, once per job
  const late = setInterval(() => { lateAlerts().then((n) => { if (n) { log.info({ late: n }, "late alerts"); void flushOutbox(); } }).catch((e) => log.warn(e, "late alerts")); }, 60_000);
  // FR-1004: CEO + CFO summaries — daily 20:00, Monday 08:00 (last week), 1st 08:00 (last month); report_runs stops repeats
  const summaries = setInterval(() => { sendSummaries().then((n) => { if (n) { log.info({ summaries: n }, "summaries"); void flushOutbox(); } }).catch((e) => log.warn(e, "summaries")); }, 5 * 60_000);
  const housekeeping = setInterval(async () => {
    try {
      const n = await cleanupSessions();
      await sql`delete from telegram_link_codes where expires_at < now() - interval '1 day'`;
      await sql`delete from customer_sessions where expires_at < now()`; // D-96: customer home logins
      if (n) log.info({ sessions: n }, "housekeeping");
      // T4: Telegram messages that finally failed in the last hour → one alert to the owner (hub throttles)
      const f = (await sql<{ n: number }[]>`select count(*)::int as n from telegram_outbox where status = 'failed' and created_at > now() - interval '1 hour'`)[0]!.n;
      if (f) hubAlert("outbox", `${f} Telegram message(s) failed in the last hour (chat blocked, bot removed from the group, or no shop bot).`);
    } catch (e) { log.warn(e, "housekeeping"); }
  }, 3600_000);
  // D-105: customers who linked Telegram hear about their booking — reminder a day before, technician on the way, job done
  const notices = setInterval(() => { customerNotices().then((n) => { if (n) log.info({ notices: n }, "customer notices"); }).catch((e) => log.warn(e, "customer notices")); }, 60_000);
  outbox.unref(); housekeeping.unref(); late.unref(); summaries.unref(); notices.unref();
  return () => { clearInterval(outbox); clearInterval(housekeeping); clearInterval(late); clearInterval(summaries); clearInterval(notices); };
}
