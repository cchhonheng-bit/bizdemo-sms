#!/usr/bin/env node
// One pipeline, two targets (D-37):
//   deploy.cmd      → node scripts/pipeline.mjs prod      tests → DB + functions (PROD) → build → Cloudflare Pages (PROD)
//   test-local.cmd  → node scripts/pipeline.mjs test      tests → DB + functions (TEST) → seed → local web on :5173 (TEST)
// Options:
//   --yes         skip the production confirmation prompt
//   --tests-only  run the checks only (nothing is deployed)
//   --dev-only    (test) start the local web app against TEST without running anything else
//   --no-dev      (test) do not start the local web app at the end
//   --no-seed     (test) skip seeding
//   --dry-run     run the checks, then print the deploy commands instead of running them
// Any failing check stops the pipeline BEFORE anything is deployed.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { join } from "node:path";
import {
  ENVS, PROD_REF, ROOT, Steps, banner, capture, cyan, dim, green, loadProdEnv, loadTestEnv, red, run, tool, yellow,
} from "./lib/common.mjs";

const args = process.argv.slice(2);
const target = args[0];
const has = (f) => args.includes(f);
if (!["prod", "test"].includes(target)) {
  console.log("usage: node scripts/pipeline.mjs <prod|test> [--yes] [--tests-only] [--dev-only] [--no-dev] [--no-seed] [--dry-run]");
  process.exit(2);
}
const PROD = target === "prod";
const DRY = has("--dry-run");
const steps = new Steps();
const t0 = Date.now();

function fail(msg) {
  console.log("\n" + red(msg));
  steps.print(PROD ? "DEPLOY TO PRODUCTION — STOPPED" : "TEST — STOPPED");
  console.log(red("\nNothing after the failed step was run."));
  process.exit(1);
}

/** Run one step; on failure stop the whole pipeline. */
function step(name, cmd, opts = {}) {
  if (DRY && opts.deploy) {
    console.log(yellow(`[dry-run] ${name}: ${opts.show || cmd}`));
    steps.add(name, "DRY");
    return;
  }
  banner(name);
  const s = Date.now();
  const code = typeof cmd === "function" ? cmd() : run(cmd, opts);
  const ms = Date.now() - s;
  if (code !== 0) {
    steps.add(name, "FAIL", opts.failNote || `exit code ${code}`, ms);
    fail(`✗ ${name} failed.`);
  }
  steps.add(name, "PASS", opts.note || "", ms);
}

// ---------------------------------------------------------------- environment
let E;
try {
  E = PROD ? loadProdEnv() : loadTestEnv({ requireDbPassword: false, requireSeed: !has("--no-seed") && !has("--dev-only") && !has("--tests-only") });
} catch (e) {
  fail(e.message);
}
if (!PROD && (E.ref === PROD_REF || E.url.includes(PROD_REF))) fail("BLOCKED: TEST environment points at PRODUCTION.");
if (PROD && E.ref !== PROD_REF) fail("BLOCKED: production ref mismatch.");

// ---------------------------------------------------------------- dev only
function startDev() {
  banner(`Local web app → ${E.label} (${E.url})`, green);
  console.log(`Open ${cyan(ENVS.test.localUrl)} · stop with Ctrl+C`);
  // vite.config.ts refuses to serve with a production URL (second guard)
  return run("pnpm --filter @sms/web dev", { env: { ...E.vite, BIZDEMO_TARGET: "test" } });
}
if (has("--dev-only")) {
  if (PROD) fail("--dev-only is only for the TEST target.");
  process.exit(startDev());
}

// ---------------------------------------------------------------- header + confirmation
const git = capture("git rev-parse --short HEAD");
const commit = git.code === 0 ? git.out : "(no git)";
const dirty = capture("git status --porcelain").out;
banner(`${PROD ? "DEPLOY" : "TEST"} → ${E.label}  ·  Supabase ${E.ref}  ·  commit ${commit}`, PROD ? yellow : cyan);
if (PROD) {
  console.log(`Web:  ${E.siteUrl}  (Cloudflare Pages "${E.pagesProject}")`);
  console.log(`DB:   ${E.url}`);
  if (git.code !== 0) fail("Source is not a git repository yet — run scripts\\init-local-git.cmd once (SETUP_LOCAL.md step 3).");
  if (dirty && !DRY && !has("--tests-only")) {
    console.log(dirty.split(/\r?\n/).slice(0, 15).join("\n"));
    fail('Uncommitted changes. Production deploys only committed code: run  save.cmd "what changed"  then deploy.cmd again.');
  }
  if (!has("--yes") && !DRY && !has("--tests-only")) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const a = (await rl.question(yellow(`\nDeploy commit ${commit} to PRODUCTION? Type Y and press Enter: `))).trim().toLowerCase();
    rl.close();
    if (a !== "y" && a !== "yes") {
      console.log("Cancelled — nothing was changed.");
      process.exit(1);
    }
  }
}

// ---------------------------------------------------------------- preflight (tools + logins) — before the slow checks
const SB = tool("supabase");
const WR = tool("wrangler");
step("Install dependencies (pnpm, frozen lockfile)", "pnpm install --frozen-lockfile");
if (!has("--tests-only") && !DRY) {
  step("Supabase CLI logged in + project reachable", () => {
    const r = capture(`${SB} projects list -o json`);
    if (r.code !== 0) {
      console.log(red(r.err || r.out));
      console.log("Run once:  pnpm exec supabase login   (SETUP_LOCAL.md step 5)");
      return 1;
    }
    let list = [];
    try {
      list = JSON.parse(r.out);
    } catch {
      /* older CLI output */
    }
    const found = Array.isArray(list) ? list.some((p) => p.id === E.ref || p.ref === E.ref) : r.out.includes(E.ref);
    if (!found) {
      console.log(red(`Project ${E.ref} is not visible to the logged-in Supabase account.`));
      return 1;
    }
    console.log(green(`OK — ${E.ref} visible`));
    return 0;
  });
  if (PROD) {
    step("Wrangler (Cloudflare) logged in", () => {
      const r = capture(`${WR} whoami`, { env: E.cloudflareAccountId ? { CLOUDFLARE_ACCOUNT_ID: E.cloudflareAccountId } : {} });
      const out = `${r.out}\n${r.err}`;
      if (r.code !== 0 || /not authenticated|You are not logged in/i.test(out)) {
        console.log(red(out.trim()));
        console.log("Run once:  pnpm exec wrangler login   (SETUP_LOCAL.md step 5)");
        return 1;
      }
      console.log(out.split(/\r?\n/).filter((l) => /logged in|@|Account/i.test(l)).slice(0, 6).join("\n"));
      return 0;
    });
  }
}

// ---------------------------------------------------------------- checks (all must pass)
step("Secret scan", "node scripts/secret-scan.mjs");
step("Shared code in sync (maps.ts)", () => {
  const a = readFileSync(join(ROOT, "packages/shared/src/maps.ts"));
  const b = readFileSync(join(ROOT, "supabase/functions/_shared/maps.ts"));
  if (!a.equals(b)) {
    console.log(red("packages/shared/src/maps.ts and supabase/functions/_shared/maps.ts differ"));
    return 1;
  }
  console.log(green("maps.ts in sync"));
  return 0;
});
step("Typecheck", "pnpm -r typecheck");
step("Lint", "pnpm -r lint");
step("Unit tests", "pnpm -r test");
step("RLS / SQL tests (embedded PostgreSQL 15)", "node scripts/db-test.mjs");
const DENO = tool("deno"); // devDependency "deno" (pinned) — no separate install
const fnEntries = ENVS.functions.map((f) => `${f}/index.ts`).join(" ");
step("Edge Functions typecheck + lint (Deno)", `${DENO} check ${fnEntries} && ${DENO} lint`, { cwd: join(ROOT, "supabase/functions") });

if (has("--tests-only")) {
  steps.print("CHECKS PASSED — nothing deployed (--tests-only)");
  process.exit(0);
}

// ---------------------------------------------------------------- deploy backend
const sbEnv = E.dbPassword ? { SUPABASE_DB_PASSWORD: E.dbPassword } : {};
const fnList = ENVS.functions.join(" ");
const migrations = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).length;
step(`Database migrations → ${E.label}`, `${SB} db push --project-ref ${E.ref} --yes`, {
  env: sbEnv, deploy: true, note: `${migrations} migration files (only new ones are applied)`,
  failNote: "check DB password in .env." + target + ".local (or type it when asked)",
});
step(`Edge Functions → ${E.label}`, `${SB} functions deploy ${fnList} --project-ref ${E.ref} --no-verify-jwt --use-api --yes`, {
  deploy: true, note: ENVS.functions.length + " functions (JWT verified inside — D-27)",
});

// ---------------------------------------------------------------- TEST: seed + local web
if (!PROD) {
  if (has("--no-seed")) steps.add("Seed TEST data", "SKIP", "--no-seed");
  else step("Seed TEST data (company + test accounts)", "node scripts/seed-test.mjs", { deploy: true });
  steps.print(`TEST PROJECT UPDATED (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  if (has("--no-dev") || DRY) process.exit(0);
  process.exit(startDev());
}

// ---------------------------------------------------------------- PROD: build + Pages
step("Build web (production values)", "pnpm --filter @sms/web build", { env: { ...E.vite, BIZDEMO_TARGET: "prod" } });
step("Verify build output", () => {
  const dist = join(ROOT, "apps/web/dist");
  for (const f of ["index.html", "_headers", "_redirects"]) if (!existsSync(join(dist, f))) return console.log(red(`missing dist/${f}`)), 1;
  const js = readdirSync(join(dist, "assets")).filter((f) => f.endsWith(".js")).map((f) => readFileSync(join(dist, "assets", f), "utf8")).join("\n");
  if (!js.includes(E.url)) return console.log(red(`bundle does not contain ${E.url}`)), 1;
  const other = js.match(/https:\/\/([a-z0-9]{20})\.supabase\.co/g)?.filter((u) => !u.includes(E.ref));
  if (other?.length) return console.log(red(`bundle contains another Supabase project: ${other[0]}`)), 1;
  console.log(green(`dist OK — points at ${E.url}`));
  return 0;
});
const cfEnv = E.cloudflareAccountId ? { CLOUDFLARE_ACCOUNT_ID: E.cloudflareAccountId } : {};
const subject = capture("git log -1 --pretty=%s").out.replace(/["%^&|<>]/g, "").slice(0, 80);
step(`Web → Cloudflare Pages (${E.pagesProject})`, `${WR} pages deploy apps/web/dist --project-name=${E.pagesProject} --branch=main --commit-hash=${commit} --commit-message="${subject}" --commit-dirty=false`, { env: cfEnv, deploy: true });

// ---------------------------------------------------------------- record + summary
if (!DRY) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const tag = `deploy-prod-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  if (capture(`git tag ${tag}`).code === 0) steps.add("Git tag", "PASS", tag);
}
steps.print(`DEPLOYED TO PRODUCTION (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
console.log(`\n  ${green("Live:")} ${E.siteUrl}   ${dim("(hard refresh / reopen the PWA to get the new version)")}`);
console.log(`  ${dim("Rollback web: Cloudflare dashboard → Pages → " + E.pagesProject + " → Deployments → previous → Rollback")}`);
