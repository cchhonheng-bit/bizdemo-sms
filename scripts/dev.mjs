#!/usr/bin/env node
// dev.cmd = run the real app on this PC: embedded PostgreSQL 16 (data kept in .local/pgdata) + API server (tsx watch)
// + web dev server (vite, proxies /api). First run seeds a demo company (see apps/server/src/dev-seed.ts).
// Open http://localhost:5173 — accounts: ceo / gm01 / admin / kim / dara, password printed below.
import EmbeddedPostgres from "embedded-postgres";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT, banner, green, tool, yellow } from "./lib/common.mjs";

const PORT_DB = Number(process.env.DEV_DB_PORT || 54329);
const dir = join(ROOT, ".local", "pgdata");
const fresh = !existsSync(dir);
mkdirSync(join(ROOT, ".local"), { recursive: true });
banner("One Team Service — local run");
const pg = new EmbeddedPostgres({ databaseDir: dir, user: "postgres", password: "postgres", port: PORT_DB, persistent: true, onLog: () => undefined, onError: (e) => console.error(String(e)) });
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase("oneteam");
const env = { ...process.env, DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${PORT_DB}/oneteam`, NODE_ENV: "development", PORT: "3000", PUBLIC_URL: "http://localhost:5173", CRON: "true" };
const pnpm = tool("pnpm").replace(/"/g, "");

// seed (idempotent)
await new Promise((res, rej) => {
  const p = spawn(pnpm, ["exec", "tsx", "src/dev-seed.ts"], { cwd: join(ROOT, "apps", "server"), env, stdio: "inherit", shell: process.platform === "win32" });
  p.on("exit", (c) => (c === 0 ? res() : rej(new Error("seed failed"))));
});

const server = spawn(pnpm, ["exec", "tsx", "watch", "src/index.ts"], { cwd: join(ROOT, "apps", "server"), env, stdio: "inherit", shell: process.platform === "win32" });
const web = spawn(pnpm, ["exec", "vite"], { cwd: join(ROOT, "apps", "web"), env: { ...env, API_URL: "http://localhost:3000" }, stdio: "inherit", shell: process.platform === "win32" });
console.log(green("\n  Web:  http://localhost:5173   API: http://localhost:3000/api   DB: 127.0.0.1:" + PORT_DB + "\n"));
console.log(yellow("  Ctrl+C stops everything (data stays in .local/pgdata; delete that folder for a fresh start).\n"));
const stop = async () => { server.kill(); web.kill(); await pg.stop().catch(() => undefined); process.exit(0); };
process.on("SIGINT", stop); process.on("SIGTERM", stop);
