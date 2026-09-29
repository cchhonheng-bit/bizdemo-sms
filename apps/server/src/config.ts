// All configuration comes from the environment (/opt/oneteam/.env on the server — rule 6.4).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const env = (k: string, def?: string): string => {
  const v = process.env[k];
  if (v !== undefined && v !== "") return v;
  if (def !== undefined) return def;
  throw new Error(`Missing environment variable ${k}`);
};

export const config = {
  nodeEnv: env("NODE_ENV", "development"),
  isProd: env("NODE_ENV", "development") === "production",
  port: Number(env("PORT", "3000")),
  host: env("HOST", "0.0.0.0"),
  databaseUrl: env("DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/oneteam"),
  /** cookie signing key, ≥ 32 chars */
  sessionSecret: env("SESSION_SECRET", "dev-only-session-secret-change-me-please-32"),
  sessionDays: Number(env("SESSION_DAYS", "30")),
  /** public https URL of the app — Telegram webhook + secure cookies */
  publicUrl: env("PUBLIC_URL", "http://localhost:3000").replace(/\/$/, ""),
  appName: env("APP_NAME", "One Team Service"),
  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN", ""),
    botUsername: env("TELEGRAM_BOT_USERNAME", ""),
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET", ""),
  },
  /** directory with the built web app (index.html, assets/) */
  webDist: env("WEB_DIST", resolve(here, "../../web/dist")),
  migrationsDir: env("MIGRATIONS_DIR", resolve(here, "migrations")),
  logLevel: env("LOG_LEVEL", "info"),
  /** behind caddy → trust X-Forwarded-For for rate limiting */
  trustProxy: env("TRUST_PROXY", "true") === "true",
  cron: env("CRON", "true") === "true",
};
export type Config = typeof config;
if (config.isProd && (config.sessionSecret.startsWith("dev-only-") || config.sessionSecret.length < 32)) {
  throw new Error("SESSION_SECRET must be set (≥ 32 characters) in production");
}
