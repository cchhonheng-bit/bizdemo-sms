#!/usr/bin/env node
// save.cmd → commit every change in Source (D-37). Secret scan first (also enforced by the pre-commit hook).
// Usage: node scripts/save.mjs "what changed"      (asks for a message when none is given)
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { ROOT, capture, green, red, run, yellow } from "./lib/common.mjs";

if (capture("git rev-parse --is-inside-work-tree").out !== "true") {
  console.log(red("Source is not a git repository yet — run scripts\\init-local-git.cmd once (SETUP_LOCAL.md step 3)."));
  process.exit(1);
}
const changes = capture("git status --porcelain").out;
if (!changes) {
  console.log(green("Nothing to save — everything is already committed."));
  process.exit(0);
}
console.log(changes.split(/\r?\n/).slice(0, 40).join("\n"));
let msg = process.argv.slice(2).join(" ").trim();
if (!msg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  msg = (await rl.question(yellow("\nDescribe the change (e.g. \"D-40: invoice numbering\"): "))).trim();
  rl.close();
}
if (!msg) {
  console.log(red("A message is required — nothing was saved."));
  process.exit(1);
}
if (run("node scripts/secret-scan.mjs") !== 0) process.exit(1);
if (run("git add -A") !== 0) process.exit(1);
// message passed as an argument array (no shell) → quotes / special characters are safe
const r = spawnSync("git", ["commit", "-m", msg], { cwd: ROOT, stdio: "inherit" });
if (r.status !== 0) {
  console.log(red("Commit failed — see above (the secret scan may have blocked it)."));
  process.exit(1);
}
console.log(green(`Saved: ${capture("git log -1 --oneline").out}`));
console.log("Tip: backup.cmd copies the history to ..\\Backup and GitHub.");
