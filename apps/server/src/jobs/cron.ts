// In-process cron (rule 2: no separate worker). Outbox every 30 s (backstop for app-triggered flush, D-15),
// housekeeping hourly (expired sessions / link codes).
import type { FastifyBaseLogger } from "fastify";
import { sql } from "../db.js";
import { cleanupSessions } from "../services/auth.js";
import { flushOutbox } from "../services/telegram.js";
import { hubAlert } from "../services/hub-client.js";

export function startCron(log: FastifyBaseLogger): () => void {
  const outbox = setInterval(() => {
    flushOutbox().then((r) => { if (r.taken) log.info(r, "outbox"); }).catch((e) => log.warn(e, "outbox"));
  }, 30_000);
  const housekeeping = setInterval(async () => {
    try {
      const n = await cleanupSessions();
      await sql`delete from telegram_link_codes where expires_at < now() - interval '1 day'`;
      if (n) log.info({ sessions: n }, "housekeeping");
      // T4: Telegram messages that finally failed in the last hour → one alert to the owner (hub throttles)
      const f = (await sql<{ n: number }[]>`select count(*)::int as n from telegram_outbox where status = 'failed' and created_at > now() - interval '1 hour'`)[0]!.n;
      if (f) hubAlert("outbox", `${f} Telegram message(s) failed in the last hour (chat blocked, bot removed from the group, or no shop bot).`);
    } catch (e) { log.warn(e, "housekeeping"); }
  }, 3600_000);
  outbox.unref(); housekeeping.unref();
  return () => { clearInterval(outbox); clearInterval(housekeeping); };
}
