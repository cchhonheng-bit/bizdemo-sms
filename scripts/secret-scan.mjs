#!/usr/bin/env node
// Secret scan (D-39, kept in v2). Fails if a tracked or staged file contains a
// secret-looking value, or if a *.local env file is tracked by git.
// Usage: node scripts/secret-scan.mjs            (all tracked files; or all files when there is no git repo)
//        node scripts/secret-scan.mjs --staged   (git pre-commit hook: staged content only)
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { ROOT, capture, green, red } from "./lib/common.mjs";

const staged = process.argv.includes("--staged");

const RULES = [
  { name: "Telegram bot token", re: /\b\d{8,11}:AA[A-Za-z0-9_-]{30,40}\b/ },
  { name: "GitHub token", re: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/ },
  { name: "Private key", re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  // local dev/test URLs (postgres:postgres@127.0.0.1 / localhost) are not secrets
  { name: "Postgres URL with password", re: /postgres(ql)?:\/\/[^:\s/]+:(?!postgres@(127\.0\.0\.1|localhost))[^@\s]{6,}@/ },
];
// JWTs: only flag non-public roles (anon keys are public by design)
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]{10,})\.[A-Za-z0-9_-]{10,}/g;
// KEY=value assignments whose value looks real (env-style files)
const ASSIGN = /^\s*(?:export\s+)?([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|PRIVATE_KEY|SECRET_KEY)[A-Z0-9_]*)\s*=\s*["']?([^"'\s#]+)/;
const PLACEHOLDER = /^(<.*>|\.\.\.|x+|changeme|change[-_]?me.*|your[_-].*|\$\{.*\}|\$[A-Z_]+|dev-only-.*|postgres)$/i;
const SKIP_EXT = /\.(png|jpe?g|gif|ico|ttf|woff2?|pdf|zip|bundle|lock|pyc)$/i;
const SKIP_FILE = /(^|\/)(pnpm-lock\.yaml|deno\.lock)$/;

function listFiles() {
  if (staged) {
    const r = capture("git diff --cached --name-only --diff-filter=ACMR");
    return r.code === 0 ? r.out.split(/\r?\n/).filter(Boolean) : [];
  }
  const r = capture("git ls-files -co --exclude-standard"); // tracked + new (not ignored) = what a commit would contain
  if (r.code === 0 && r.out) return r.out.split(/\r?\n/).filter(Boolean);
  // no git repo yet → walk the tree
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d)) {
      if (["node_modules", ".git", "dist", "dist-mock", "coverage"].includes(e)) continue;
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(ROOT, p).replace(/\\/g, "/"));
    }
  };
  walk(ROOT);
  return out;
}

function content(file) {
  if (staged) {
    const r = capture(`git show ":${file}"`);
    return r.code === 0 ? r.out : "";
  }
  try {
    return readFileSync(join(ROOT, file), "utf8");
  } catch {
    return "";
  }
}

const findings = [];
const files = listFiles();
const gitTracked = capture("git ls-files").code === 0;
for (const f of files) {
  if (gitTracked && /(^|\/)\.env(\.[^/]+)?\.local$|(^|\/)\.env$/.test(f)) findings.push(`${f}: env file with real values must not be committed (it is gitignored — remove it with "git rm --cached ${f}")`);
  if (SKIP_EXT.test(f) || SKIP_FILE.test(f)) continue;
  const text = content(f);
  if (!text) continue;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (/secret-scan:\s*allow/.test(line)) return;
    for (const r of RULES) if (r.re.test(line)) findings.push(`${f}:${i + 1}: ${r.name}`);
    for (const m of line.matchAll(JWT)) {
      try {
        const payload = JSON.parse(Buffer.from(m[1], "base64url").toString("utf8"));
        if (payload.role && payload.role !== "anon") findings.push(`${f}:${i + 1}: JWT with role "${payload.role}"`);
      } catch {
        /* not a JWT */
      }
    }
    const a = ASSIGN.exec(line);
    if (a && !PLACEHOLDER.test(a[2]) && a[2].length >= 8 && /(^|\/)\.env|\.env$|\.toml$|\.ya?ml$|\.cmd$|\.ps1$|\.sh$/.test(f)) findings.push(`${f}:${i + 1}: ${a[1]} has a value`);
  });
}

if (findings.length) {
  console.log(red(`SECRET SCAN FAILED — ${findings.length} finding(s):`));
  for (const x of findings) console.log("  " + x);
  console.log("Move the value to the server .env (never in git), then rotate it if it was ever committed or shared.");
  process.exit(1);
}
console.log(green(`Secret scan OK (${files.length} files${staged ? ", staged" : ""})`));
