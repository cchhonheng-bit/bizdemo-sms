#!/usr/bin/env node
// test.cmd = ONE command (rule 4): secret scan → typecheck → lint → unit (shared) → API tests on an embedded PostgreSQL 16.
// Exit 0 only when everything passed. No Docker, no psql, no admin rights needed.
import { Steps, banner, run, tool } from "./lib/common.mjs";

const steps = new Steps();
const step = (name, cmd, opts) => {
  if (steps.failed()) { steps.add(name, "SKIP", "after a failure"); return; }
  const t = Date.now();
  const code = run(cmd, opts);
  steps.add(name, code === 0 ? "PASS" : "FAIL", "", Date.now() - t);
};
banner("One Team Service — tests");
step("Secret scan", `node scripts/secret-scan.mjs`);
step("Typecheck (shared · server · web)", `${tool("pnpm")} -r typecheck`);
step("Lint", `${tool("pnpm")} -r lint`);
step("Unit tests (shared)", `${tool("pnpm")} --filter @sms/shared test`);
step("API tests: login · permissions · booking flow (PostgreSQL 16 embedded)", `${tool("pnpm")} --filter @sms/server test`);
steps.print(steps.failed() ? "TESTS FAILED" : "ALL TESTS PASSED");
process.exit(steps.failed() ? 1 : 0);
