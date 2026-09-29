// PostgreSQL access (postgres.js) + tiny SQL-file migrator (runs at startup under an advisory lock).
import postgres, { type Sql, type TransactionSql } from "postgres";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config.js";

export type Db = Sql | TransactionSql;

export const sql = postgres(config.databaseUrl, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  transform: { undefined: null },
  onnotice: () => undefined,
});

export async function migrate(db: Sql = sql, dir = config.migrationsDir, log: (m: string) => void = () => undefined): Promise<string[]> {
  await db`create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())`;
  const applied: string[] = [];
  await db.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(42)`;
    const done = new Set((await tx`select version from schema_migrations`).map((r) => r.version as string));
    const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      if (done.has(version)) continue;
      log(`migrate ${version}`);
      await tx.unsafe(readFileSync(join(dir, f), "utf8"));
      await tx`insert into schema_migrations (version) values (${version})`;
      applied.push(version);
    }
  });
  return applied;
}

/** Run fn in a transaction with `app.user_id` set (used by the booking status trigger for status_log.by). */
export function tx<T>(userId: string | null, fn: (t: TransactionSql) => Promise<T>): Promise<T> {
  return sql.begin(async (t) => {
    if (userId) await t`select set_config('app.user_id', ${userId}, true)`;
    return fn(t);
  }) as Promise<T>;
}
