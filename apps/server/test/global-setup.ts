// Starts a throw-away PostgreSQL 16 (embedded-postgres, binaries from npm — no Docker on the PC) for the test run.
// If DATABASE_URL is already set (CI with a real server, or dev.cmd's instance) it is used as-is.
import EmbeddedPostgres from "embedded-postgres";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const freePort = () => new Promise<number>((res, rej) => {
  const s = createServer(); s.listen(0, "127.0.0.1", () => { const { port } = s.address() as { port: number }; s.close(() => res(port)); }); s.on("error", rej);
});

export default async function setup() {
  if (process.env.DATABASE_URL) return;
  const port = await freePort();
  const dir = mkdtempSync(join(tmpdir(), "ots-pg-"));
  if (process.getuid?.() === 0) chmodSync(dir, 0o777); // initdb refuses to run as root → embedded-postgres drops privileges
  const server = new EmbeddedPostgres({ databaseDir: join(dir, "data"), user: "postgres", password: "postgres", port, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => undefined, onError: () => undefined });
  await server.initialise();
  await server.start();
  await server.createDatabase("ots_test");
  process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/ots_test`;
  process.env.NODE_ENV = "test";
  return async () => {
    await server.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    // embedded-postgres registers async-exit-hook, whose 'beforeExit' handler calls process.exit(0) — that erased
    // vitest's failure exit code (failed tests looked green to test.cmd / deploy.sh). The cluster is stopped: drop it.
    for (const ev of ["beforeExit", "exit", "SIGHUP", "SIGINT", "SIGTERM", "SIGBREAK", "message"] as const) {
      for (const l of process.listeners(ev as "exit")) if (String(l).includes("eventFilters")) process.removeListener(ev as "exit", l);
    }
  };
}
