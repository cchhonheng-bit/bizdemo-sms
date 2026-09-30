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

const mode = env("APP_MODE", "shop");
if (mode !== "shop" && mode !== "hub") throw new Error("APP_MODE must be shop or hub");

export const config = {
  /** v2.1 (D-50): one codebase, two modes — "hub" (hub.hangkh.com) or "shop" (<shop>.hangkh.com) */
  mode: mode as "shop" | "hub",
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
  /** Bot token + webhook secret live ONLY in the hub container; the shop needs the bot username for deep links. */
  telegram: {
    botToken: env("TELEGRAM_BOT_TOKEN", ""),
    botUsername: env("TELEGRAM_BOT_USERNAME", ""), // shop: fallback only — the real username comes from the hub (T6)
    webhookSecret: env("TELEGRAM_WEBHOOK_SECRET", ""),
    /** Bot API base (a local mock in the box simulation; https://api.telegram.org in production) */
    apiBase: env("TELEGRAM_API_BASE", "https://api.telegram.org").replace(/\/$/, ""),
  },
  /** shop mode: who am I, where is the hub, which modules are on (A6) */
  shop: {
    code: env("SHOP_CODE", "ONETEAM").toUpperCase(),
    hubUrl: env("HUB_URL", "").replace(/\/$/, ""),
    hubKey: env("HUB_KEY", ""),
    features: env("FEATURES", ""),
  },
  /** hub mode: registry of shops "CODE|Name|internal url|flags;…" (keys come from HUB_KEY_<CODE>) */
  hub: {
    shops: env("HUB_SHOPS", ""),
    migrationsDir: env("HUB_MIGRATIONS_DIR", resolve(here, "migrations_hub")),
    /** messages per second when flushing broadcasts (Telegram allows ~30/s per bot) */
    sendRate: Number(env("HUB_SEND_RATE", "20")),
    /** AES-256-GCM key for bot tokens + webhook secrets at rest (T2): 32 bytes base64, generated on the server into .env */
    tokenKey: env("HUB_TOKEN_KEY", ""),
    /** username of the HangKH master bot (T4); a legacy TELEGRAM_BOT_TOKEN of this bot is imported once */
    masterUsername: env("MASTER_BOT_USERNAME", "hangkh_bot"),
  },
  /** directory with the built web app (index.html, assets/) */
  webDist: env("WEB_DIST", resolve(here, "../../web/dist")),
  migrationsDir: env("MIGRATIONS_DIR", resolve(here, "migrations")),
  /** photos + signatures (job reports); the uploads_<shop> volume in production */
  uploadsDir: env("UPLOADS_DIR", resolve(here, "../../../.local/uploads")),
  logLevel: env("LOG_LEVEL", "info"),
  /** behind caddy → trust X-Forwarded-For for rate limiting */
  trustProxy: env("TRUST_PROXY", "true") === "true",
  cron: env("CRON", "true") === "true",
};
export type Config = typeof config;
if (config.isProd && (config.sessionSecret.startsWith("dev-only-") || config.sessionSecret.length < 32)) {
  throw new Error("SESSION_SECRET must be set (≥ 32 characters) in production");
}
