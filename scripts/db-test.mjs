#!/usr/bin/env node
// RLS / SQL tests on a throw-away PostgreSQL 15 — no Docker, no psql, no admin rights (D-38).
// Starts `embedded-postgres` (binaries come from npm via `pnpm install`), applies
// supabase/tests/00_shim.sql + supabase/migrations/*.sql, then runs supabase/tests/[1-9]*_test.sql.
// The test files use three psql features, emulated here: `\set`, `\gset`, `:'var'` / `:"var"` / `:var`.
// Usage: node scripts/db-test.mjs          (exit 0 = all PASSED)
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { ROOT, green, red, dim } from "./lib/common.mjs";

const SUPA = join(ROOT, "supabase");

/** Split psql script text into items: {sql} statements and {meta} commands; tracks quoting so `;` / `\` inside strings are ignored. */
export function parsePsql(text) {
  const items = [];
  let buf = "";
  let i = 0;
  const n = text.length;
  const flush = () => {
    if (buf.trim()) items.push({ sql: buf.trim() });
    buf = "";
  };
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    // line comment
    if (ch === "-" && next === "-") {
      const e = text.indexOf("\n", i);
      const end = e === -1 ? n : e;
      buf += text.slice(i, end);
      i = end;
      continue;
    }
    // block comment (nested)
    if (ch === "/" && next === "*") {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (text[j] === "/" && text[j + 1] === "*") { depth++; j += 2; continue; }
        if (text[j] === "*" && text[j + 1] === "/") { depth--; j += 2; if (depth === 0) break; continue; }
        j++;
      }
      buf += text.slice(i, j);
      i = j;
      continue;
    }
    // single-quoted string ('' escape; E'' strings also allow \' )
    if (ch === "'") {
      const isE = /[eE]$/.test(buf) && !/[A-Za-z0-9_][eE]$/.test(buf);
      let j = i + 1;
      while (j < n) {
        if (isE && text[j] === "\\") { j += 2; continue; }
        if (text[j] === "'") {
          if (text[j + 1] === "'") { j += 2; continue; }
          break;
        }
        j++;
      }
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < n && !(text[j] === '"' && text[j + 1] !== '"')) j += text[j] === '"' ? 2 : 1;
      buf += text.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // dollar-quoted string $tag$ … $tag$
    if (ch === "$") {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 64));
      if (m && !/[A-Za-z0-9_]$/.test(buf)) {
        const tag = m[0];
        const close = text.indexOf(tag, i + tag.length);
        const end = close === -1 ? n : close + tag.length;
        buf += text.slice(i, end);
        i = end;
        continue;
      }
    }
    // psql variable interpolation
    if (ch === ":") {
      if (next === ":") { buf += "::"; i += 2; continue; }
      if (next === "'" || next === '"') {
        const close = text.indexOf(next, i + 2);
        const name = text.slice(i + 2, close);
        if (close > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          buf += `\u0000${next === "'" ? "L" : "I"}:${name}\u0000`;
          i = close + 1;
          continue;
        }
      }
      const m = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(i, i + 80));
      if (m && !/[A-Za-z0-9_]$/.test(buf)) {
        buf += `\u0000R:${m[1]}\u0000`;
        i += m[0].length;
        continue;
      }
    }
    // backslash meta-command → until end of line
    if (ch === "\\") {
      const e = text.indexOf("\n", i);
      const end = e === -1 ? n : e;
      const meta = text.slice(i + 1, end).trim();
      const cmd = meta.split(/\s+/)[0];
      if (cmd === "gset" || cmd === "g") {
        items.push({ sql: buf.trim(), gset: cmd === "gset" });
        buf = "";
      } else {
        flush();
        items.push({ meta });
      }
      i = end;
      continue;
    }
    if (ch === ";") {
      buf += ";";
      flush();
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  flush();
  return items;
}

const quoteLiteral = (v) => "'" + String(v).replace(/'/g, "''") + "'";
const quoteIdent = (v) => '"' + String(v).replace(/"/g, '""') + '"';

function interpolate(sql, vars) {
  return sql.replace(/\u0000([LIR]):([A-Za-z0-9_]+)\u0000/g, (whole, kind, name) => {
    if (!(name in vars)) {
      if (kind === "R") return ":" + name; // not a variable (psql leaves it as-is)
      throw new Error(`psql variable :${name} is not set`);
    }
    return kind === "L" ? quoteLiteral(vars[name]) : kind === "I" ? quoteIdent(vars[name]) : vars[name];
  });
}

async function runFile(client, file, vars = {}) {
  const items = parsePsql(readFileSync(file, "utf8"));
  const passed = [];
  let count = 0;
  for (const it of items) {
    if (it.meta !== undefined) {
      const [cmd, name, ...rest] = it.meta.split(/\s+/);
      if (cmd === "set" && name) vars[name] = rest.join(" ");
      continue;
    }
    const sql = interpolate(it.sql, vars);
    count++;
    let res;
    try {
      res = await client.query(sql);
    } catch (e) {
      const where = sql.length > 400 ? sql.slice(0, 400) + " …" : sql;
      throw new Error(`${file.replace(ROOT, "").replace(/^[\\/]/, "")} statement #${count}\n${where}\n→ ${e.message}`);
    }
    const last = Array.isArray(res) ? res[res.length - 1] : res;
    if (it.gset) {
      if (!last?.rows || last.rows.length !== 1) throw new Error(`\\gset expects exactly one row (got ${last?.rows?.length ?? 0}) in ${file}: ${sql.slice(0, 200)}`);
      for (const [k, v] of Object.entries(last.rows[0])) vars[k] = v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    } else if (last?.rows?.length === 1 && last.fields?.length === 1) {
      const v = Object.values(last.rows[0])[0];
      if (typeof v === "string" && /PASSED/.test(v)) passed.push(v);
    }
  }
  return { count, passed };
}

function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function main() {
  const t0 = Date.now();
  const dir = mkdtempSync(join(tmpdir(), "bizdemo-dbtest-"));
  // Linux as root (CI/containers): embedded-postgres runs initdb as a "postgres" user → it must reach the folder
  if (process.getuid?.() === 0) chmodSync(dir, 0o777);
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: join(dir, "data"),
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => {},
    onError: () => {},
  });
  let ok = false;
  try {
    await server.initialise();
    await server.start();
    const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query("create database sms_test");
    await admin.end();

    const db = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "sms_test" });
    await db.connect();
    db.on("notice", () => {});
    await runFile(db, join(SUPA, "tests", "00_shim.sql"));
    const migrations = readdirSync(join(SUPA, "migrations")).filter((f) => f.endsWith(".sql")).sort();
    for (const f of migrations) {
      await db.query(readFileSync(join(SUPA, "migrations", f), "utf8")).catch((e) => {
        throw new Error(`migration ${f} → ${e.message}`);
      });
      console.log(`  ${green("OK")}   migration ${f}`);
    }
    await db.end();

    const tests = readdirSync(join(SUPA, "tests")).filter((f) => /^[1-9].*_test\.sql$/.test(f)).sort();
    if (!tests.length) throw new Error("no test files found in supabase/tests");
    for (const f of tests) {
      const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "sms_test" });
      await client.connect();
      client.on("notice", () => {});
      try {
        const { count, passed } = await runFile(client, join(SUPA, "tests", f));
        if (!passed.length) throw new Error(`${f}: finished without a "… PASSED" line (${count} statements)`);
        console.log(`  ${green("PASS")} ${f} ${dim(`(${count} statements)`)} — ${passed.join(" · ")}`);
      } finally {
        await client.end().catch(() => {});
      }
    }
    ok = true;
  } catch (e) {
    console.log(`  ${red("FAIL")} ${e.message}`);
  } finally {
    await server.stop().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(ok ? green(`RLS/SQL tests OK (${((Date.now() - t0) / 1000).toFixed(1)}s)`) : red("RLS/SQL tests FAILED"));
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) main();
