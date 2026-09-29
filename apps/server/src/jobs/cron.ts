// In-process cron (rule 2: no separate worker). Outbox every 30 s (backstop for app-triggered flush, D-15),
// housekeeping hourly (expired sessions / link codes).
import type { FastifyBaseLogger } from "fastify";
import { sql } from "../db.js";
import { cleanupSessions } from "../services/auth.js";
import { flushOutbox } from "../services/telegram.js";

export function startCron(log: FastifyBaseLogger): () => void {
  const outbox = setInterval(() => {
    flushOutbox().then((r) => { if (r.taken) log.info(r, "outbox"); }).catch((e) => log.warn(e, "outbox"));
  }, 30_000);
  const housekeeping = setInterval(async () => {
    try {
      const n = await cleanupSessions();
      await sql`delete from telegram_link_codes where expires_at < now() - interval '1 day'`;
      if (n) log.info({ sessions: n }, "housekeeping");
    } catch (e) { log.warn(e, "housekeeping"); }
  }, 3600_000);
  outbox.unref(); housekeeping.unref();
  return () => { clearInterval(outbox); clearInterval(housekeeping); };
}
