// Shared helpers for the local scripts (deploy / test-local / backup). Node 22+, no dependencies.
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IS_WIN = process.platform === "win32";
export const ENVS = JSON.parse(readFileSync(join(ROOT, "environments.json"), "utf8"));
export const PROD_REF = ENVS.prod.projectRef;

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const red = c("31;1");
export const green = c("32;1");
export const yellow = c("33;1");
export const cyan = c("36;1");
export const dim = c("2");

export function banner(title, color = cyan) {
  const line = "=".repeat(Math.max(60, title.length + 4));
  console.log("\n" + color(line) + "\n" + color("  " + title) + "\n" + color(line));
}

/** Parse a KEY=VALUE file (no expansion, # comments, optional quotes). Missing file → null. */
export function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    let v = line.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[line.slice(0, i).trim()] = v;
  }
  return out;
}

/**
 * Create .env.<kind>.local from <kind>.env.example when missing, restrict it to the current Windows user
 * (icacls — SEC-L02) and open it in Notepad. Returns true when the file was just created.
 */
export function ensureLocalEnv(kind) {
  const target = join(ROOT, `.env.${kind}.local`);
  if (existsSync(target)) return false;
  copyFileSync(join(ROOT, `${kind}.env.example`), target);
  if (IS_WIN) {
    const r = spawnSync(`icacls ".env.${kind}.local" /inheritance:r /grant:r "%USERNAME%:F"`, { cwd: ROOT, shell: true, encoding: "utf8" });
    console.log(r.status === 0 ? green(`.env.${kind}.local created — readable only by %USERNAME%`) : red(`icacls failed — restrict .env.${kind}.local by hand (SETUP_LOCAL.md)`));
    spawnSync(`start "" notepad ".env.${kind}.local"`, { cwd: ROOT, shell: true });
  } else {
    chmodSync(target, 0o600);
    console.log(green(`.env.${kind}.local created (mode 600)`));
  }
  return true;
}

/** True when a string points at the production Supabase project. */
export function isProdTarget(value) {
  return typeof value === "string" && value.toLowerCase().includes(PROD_REF.toLowerCase());
}

/**
 * Resolve the TEST environment from .env.test.local. Throws with a readable message when
 * the file is missing/incomplete or — most importantly — when it points at PRODUCTION (D-37).
 */
export function loadTestEnv({ requireSeed = false, requireDbPassword = false } = {}) {
  const file = join(ROOT, ".env.test.local");
  if (ensureLocalEnv("test")) throw new Error(`.env.test.local was just created (only you can read it) and opened in Notepad — fill it, save, and run again (SETUP_LOCAL.md step 6).`);
  const env = readEnvFile(file);
  if (!env) throw new Error(`.env.test.local could not be read (SETUP_LOCAL.md step 6).`);
  const ref = (env.SUPABASE_PROJECT_REF || "").trim();
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error(`.env.test.local: SUPABASE_PROJECT_REF must be the 20-letter ref of the TEST project (Settings → General).`);
  const url = `https://${ref}.supabase.co`;
  for (const [k, v] of Object.entries(env)) {
    if (isProdTarget(v)) throw new Error(`BLOCKED: .env.test.local ${k} points at PRODUCTION (${PROD_REF}). Local/Test must never use the production project.`);
  }
  if (!env.SUPABASE_PUBLISHABLE_KEY?.startsWith("sb_publishable_") && !env.SUPABASE_PUBLISHABLE_KEY?.startsWith("eyJ"))
    throw new Error(`.env.test.local: SUPABASE_PUBLISHABLE_KEY missing (TEST project → Settings → API Keys → publishable key).`);
  if (env.SUPABASE_PUBLISHABLE_KEY === ENVS.prod.publishableKey) throw new Error(`BLOCKED: .env.test.local uses the PRODUCTION publishable key.`);
  if (requireDbPassword && !env.SUPABASE_DB_PASSWORD) throw new Error(`.env.test.local: SUPABASE_DB_PASSWORD missing (TEST project database password).`);
  if (requireSeed) {
    if (!env.SEED_SECRET_KEY) throw new Error(`.env.test.local: SEED_SECRET_KEY missing (TEST project → API Keys → secret key).`);
    if ((env.TEST_PASSWORD || "").length < 10) throw new Error(`.env.test.local: TEST_PASSWORD must be at least 10 characters.`);
  }
  return {
    name: "test",
    label: ENVS.test.label,
    ref,
    url,
    dbPassword: env.SUPABASE_DB_PASSWORD || "",
    vite: {
      VITE_SUPABASE_URL: url,
      VITE_SUPABASE_PUBLISHABLE_KEY: env.SUPABASE_PUBLISHABLE_KEY,
      VITE_TELEGRAM_BOT: env.TELEGRAM_BOT || "",
      VITE_APP_NAME: ENVS.test.appName,
      VITE_APP_SHORT: ENVS.test.appShort,
    },
    seed: { secretKey: env.SEED_SECRET_KEY || "", password: env.TEST_PASSWORD || "" },
  };
}

/** Resolve PRODUCTION: public values from environments.json, secrets from .env.prod.local (optional file). */
export function loadProdEnv() {
  const env = readEnvFile(join(ROOT, ".env.prod.local")) || {};
  const p = ENVS.prod;
  if (env.SUPABASE_PROJECT_REF && env.SUPABASE_PROJECT_REF !== p.projectRef)
    throw new Error(`.env.prod.local: SUPABASE_PROJECT_REF (${env.SUPABASE_PROJECT_REF}) differs from environments.json (${p.projectRef}). Remove the line — production is fixed in environments.json.`);
  return {
    name: "prod",
    label: p.label,
    ref: p.projectRef,
    url: p.supabaseUrl,
    dbPassword: env.SUPABASE_DB_PASSWORD || "",
    cloudflareAccountId: env.CLOUDFLARE_ACCOUNT_ID || "",
    pagesProject: p.pagesProject,
    siteUrl: p.siteUrl,
    vite: {
      VITE_SUPABASE_URL: p.supabaseUrl,
      VITE_SUPABASE_PUBLISHABLE_KEY: p.publishableKey,
      VITE_TELEGRAM_BOT: p.telegramBot,
      VITE_APP_NAME: p.appName,
      VITE_APP_SHORT: p.appShort,
    },
  };
}

/** Run a shell command, streaming output. Returns the exit code (never throws). */
export function run(cmd, { env = {}, cwd = ROOT, input } = {}) {
  console.log(dim(`$ ${cmd}`));
  const res = spawnSync(cmd, {
    cwd,
    shell: true,
    env: { ...process.env, ...env },
    stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"],
    input,
    windowsHide: false,
  });
  if (res.error) {
    console.log(red(String(res.error.message || res.error)));
    return 1;
  }
  return res.status ?? 1;
}

/** Run a command and capture stdout (trimmed). Returns { code, out }. */
export function capture(cmd, { env = {}, cwd = ROOT } = {}) {
  const res = spawnSync(cmd, { cwd, shell: true, env: { ...process.env, ...env }, encoding: "utf8" });
  return { code: res.status ?? 1, out: (res.stdout || "").trim(), err: (res.stderr || "").trim() };
}

/** Local CLI from node_modules/.bin (installed by `pnpm install`), falling back to a global install. */
export function tool(name) {
  const local = join(ROOT, "node_modules", ".bin", IS_WIN ? `${name}.cmd` : name);
  return existsSync(local) ? `"${local}"` : name;
}

/** Tracks step results and prints a final table. */
export class Steps {
  constructor() {
    this.rows = [];
  }
  add(name, status, note = "", ms = 0) {
    this.rows.push({ name, status, note, ms });
  }
  print(title) {
    banner(title, this.failed() ? red : green);
    for (const r of this.rows) {
      const st = r.status === "PASS" ? green("PASS") : r.status === "FAIL" ? red("FAIL") : r.status === "SKIP" ? yellow("SKIP") : dim(r.status);
      const t = r.ms ? dim(` ${(r.ms / 1000).toFixed(1)}s`) : "";
      console.log(`  ${st.padEnd(tty ? 15 : 4)}  ${r.name}${t}${r.note ? dim("  — " + r.note) : ""}`);
    }
  }
  failed() {
    return this.rows.some((r) => r.status === "FAIL");
  }
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
