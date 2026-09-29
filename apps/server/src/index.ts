// Entry point (v2.1): MODE=shop → shop box (web + /api + /internal + outbox cron) · MODE=hub → hub (webhook, router, platform).
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { migrate, sql } from "./db.js";
import { startCron } from "./jobs/cron.js";
import { buildHubApp } from "./hub/app.js";
import { startHubCron } from "./hub/cron.js";
import { syncShops } from "./hub/shops.js";
import { ensureConsentText } from "./hub/subscribers.js";
import { setCommands, setWebhook } from "./hub/telegram-api.js";

async function main() {
  const hub = config.mode === "hub";
  const app = hub ? buildHubApp() : buildApp();
  const applied = await migrate(sql, hub ? config.hub.migrationsDir : config.migrationsDir, (m) => app.log.info(m));
  if (applied.length) app.log.info({ applied }, "migrations applied");
  if (hub) {
    app.log.info({ shops: await syncShops() }, "shop registry");
    await ensureConsentText();
  }
  await app.listen({ port: config.port, host: config.host });
  if (config.cron) (hub ? startHubCron : startCron)(app.log);
  if (hub) {
    if (config.telegram.botToken && config.telegram.webhookSecret && config.publicUrl.startsWith("https://")) {
      // 3 attempts: right after a deploy both apps boot at once and the first Telegram call can time out (D-63)
      for (let attempt = 1; attempt <= 3; attempt++) {
        const r = await setWebhook(config.publicUrl, config.telegram.webhookSecret);
        app.log.info({ ok: r.ok, attempt, error: r.ok ? undefined : r.error }, "telegram setWebhook");
        if (r.ok || (!r.ok && r.permanent)) break;
        await new Promise((res) => setTimeout(res, 5_000 * attempt));
      }
      await setCommands().catch(() => undefined);
    } else {
      app.log.warn("telegram webhook not registered (needs TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET and an https PUBLIC_URL)");
    }
  }
  app.log.info({ mode: config.mode, shop: hub ? undefined : config.shop.code }, "started");
  const stop = async () => { app.log.info("shutting down"); await app.close(); await sql.end({ timeout: 5 }); process.exit(0); };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main().catch((e) => { console.error(e); process.exit(1); });
