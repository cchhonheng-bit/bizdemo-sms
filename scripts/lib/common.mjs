// Shared helpers for the local scripts (test / dev / deploy / backup). Node 22+, no dependencies.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const IS_WIN = process.platform === "win32";

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

/** Run a command with inherited stdio. Returns the exit code. */
export function run(cmd, { env = {}, cwd = ROOT, input } = {}) {
  console.log(dim(`$ ${cmd}`));
  const res = spawnSync(cmd, { cwd, shell: true, env: { ...process.env, ...env }, stdio: input === undefined ? "inherit" : ["pipe", "inherit", "inherit"], input, windowsHide: false });
  if (res.error) { console.log(red(String(res.error.message || res.error))); return 1; }
  return res.status ?? 1;
}

/** Run a command and capture stdout (trimmed). Returns { code, out, err }. */
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
  constructor() { this.rows = []; }
  add(name, status, note = "", ms = 0) { this.rows.push({ name, status, note, ms }); }
  print(title) {
    banner(title, this.failed() ? red : green);
    for (const r of this.rows) {
      const st = r.status === "PASS" ? green("PASS") : r.status === "FAIL" ? red("FAIL") : r.status === "SKIP" ? yellow("SKIP") : dim(r.status);
      const t = r.ms ? dim(` ${(r.ms / 1000).toFixed(1)}s`) : "";
      console.log(`  ${st.padEnd(tty ? 15 : 4)}  ${r.name}${t}${r.note ? dim("  — " + r.note) : ""}`);
    }
  }
  failed() { return this.rows.some((r) => r.status === "FAIL"); }
}

export function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
