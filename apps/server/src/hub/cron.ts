// Hub background jobs (in process): broadcast outbox every 10 s, failed-outbox alert, housekeeping hourly (sessions, 12-month message log).
import type { FastifyBaseLogger } from "fastify";
import { sql } from "../db.js";
import { sendAlert } from "./alerts.js";
import { flushHubOutbox } from "./subscribers.js";

export function startHubCron(log: FastifyBaseLogger): () => void {
  const outbox = setInterval(() => {
    flushHubOutbox().then((r) => { if (r.taken) log.info(r, "hub outbox"); }).catch((e) => log.warn(e, "hub outbox"));
  }, 10_000);
  const housekeeping = setInterval(async () => {
    try {
      await sql`delete from hub_sessions where expires_at < now()`;
      await sql`delete from hub_admin_link_codes where expires_at < now() - interval '1 day'`;
      await sql.begin(async (t) => {
        await t`select set_config('hub.retention', 'on', true)`;
        await t`delete from hub_message_log where at < now() - interval '12 months'`;
      });
      // T4: failed broadcast deliveries in the last hour → one alert to the owner
      const f = (await sql<{ n: number }[]>`select count(*)::int as n from hub_outbox where status = 'failed' and created_at > now() - interval '1 hour'`)[0]!.n;
      if (f) await sendAlert("outbox", `${f} broadcast message(s) failed in the last hour (blocked bot or Telegram error).`);
    } catch (e) { log.warn(e, "hub housekeeping"); }
  }, 3600_000);
  outbox.unref(); housekeeping.unref();
  return () => { clearInterval(outbox); clearInterval(housekeeping); };
}
