// Entry point: migrate → listen → cron (outbox 30 s, cleanup) → Telegram webhook registration.
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { startCron } from "./jobs/cron.js";
import { setWebhook } from "./services/telegram.js";

async function main() {
  const app = buildApp();
  const applied = await migrate(sql, config.migrationsDir, (m) => app.log.info(m));
  if (applied.length) app.log.info({ applied }, "migrations applied");
  await app.listen({ port: config.port, host: config.host });
  if (config.cron) startCron(app.log);
  if (config.telegram.botToken && config.telegram.webhookSecret && config.publicUrl.startsWith("https://")) {
    const r = await setWebhook(config.publicUrl, config.telegram.webhookSecret).catch((e) => ({ ok: false, description: String(e) }));
    app.log.info({ ok: r.ok, description: r.description }, "telegram setWebhook");
  } else {
    app.log.warn("telegram webhook not registered (needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an https PUBLIC_URL)");
  }
  const stop = async () => { app.log.info("shutting down"); await app.close(); await sql.end({ timeout: 5 }); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
