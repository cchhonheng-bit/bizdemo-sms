#!/usr/bin/env node
// deploy.cmd = one click (rule 4): tests → git push to the VPS → server hook: backup → build → restart → health.
// First run: asks for the server address, installs the server (deploy/install.sh over ssh) and adds the `vps` git remote.
// Usage: node scripts/deploy.mjs [--skip-tests] [--setup]
import { createInterface } from "node:readline/promises";
import { ROOT, banner, capture, green, red, run, stamp, yellow } from "./lib/common.mjs";

const args = process.argv.slice(2);
const ask = async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = (await rl.question(q)).trim(); rl.close(); return a; };
banner("One Team Service — DEPLOY to the VPS");

if (capture("git rev-parse --is-inside-work-tree").out !== "true") { console.log(red("Source is not a git repository.")); process.exit(1); }
const branch = capture("git rev-parse --abbrev-ref HEAD").out;
if (branch !== "main") { console.log(red(`You are on branch "${branch}" — deploy only from main.`)); process.exit(1); }
if (capture("git status --porcelain").out) { console.log(red("Uncommitted changes — run save.cmd first (production runs committed code only).")); process.exit(1); }

// server remote
let remote = capture("git remote get-url vps").out;
if (!remote || args.includes("--setup")) {
  const host = await ask(yellow("Server address (e.g. 157.10.72.80): "));
  if (!/^[a-zA-Z0-9.-]+$/.test(host)) { console.log(red("invalid address")); process.exit(1); }
  console.log("\nChecking SSH access (needs your public key in /root/.ssh/authorized_keys on the server)…");
  if (run(`ssh -o BatchMode=yes -o ConnectTimeout=10 root@${host} "echo ssh-ok"`) !== 0) {
    console.log(red(`\nSSH key login failed. On this PC run once:\n  ssh-keygen -t ed25519    (Enter, Enter, Enter)\n  type %USERPROFILE%\\.ssh\\id_ed25519.pub | ssh root@${host} "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys"\nthen run deploy.cmd again.`));
    process.exit(1);
  }
  console.log("\nInstalling the server (docker, firewall, swap, git target, .env, nightly backup)…");
  if (run(`ssh root@${host} "bash -s" < deploy/install.sh`) !== 0) { console.log(red("server install failed")); process.exit(1); }
  if (remote) run(`git remote set-url vps root@${host}:/opt/oneteam.git`); else run(`git remote add vps root@${host}:/opt/oneteam.git`);
  remote = `root@${host}:/opt/oneteam.git`;
  console.log(green(`\nServer ready. Before the first deploy, on the server:  nano /opt/oneteam/.env  → TELEGRAM_BOT_TOKEN + DOMAIN.\n`));
  if ((await ask("Continue with the deploy now? (y/N): ")).toLowerCase() !== "y") process.exit(0);
}

// tests
if (!args.includes("--skip-tests")) {
  if (run("node scripts/test.mjs") !== 0) { console.log(red("\nTests failed — nothing was deployed.")); process.exit(1); }
} else console.log(yellow("tests skipped (--skip-tests)"));

// push → server hook does backup → build → restart → health check (output streams below)
const sha = capture("git rev-parse --short HEAD").out;
console.log(`\nDeploying ${sha} → ${remote}\n`);
const code = run("git push vps main");
if (code !== 0) { console.log(red("\nDEPLOY FAILED — see the server output above. The previous version keeps running if the backup or build failed.")); process.exit(1); }
const tag = `deploy-${stamp().slice(0, 13)}`;
run(`git tag -f ${tag}`);
console.log(green(`\nDEPLOYED ${sha} · tag ${tag}\nRollback: git push vps <older-tag>:main --force`));
