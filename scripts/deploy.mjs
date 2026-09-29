#!/usr/bin/env node
// deploy.cmd oneteam | hub | all   (MASTER PLAN v2.1 rule B — any failure stops, nothing half-deployed)
//   1 git clean on main   2 tests   3 server config files   4 pg_dump on the server   5 docker build on this PC
//   6 docker save | gzip | ssh | docker load   7 switch tag + restart + health (bad health ⇒ previous image back)   8 git tag
// Needs: Docker Desktop running, SSH alias "hangkh" (owner-setup.cmd). Options: --skip-tests
//   --build-on-server (D-61): Docker Desktop not running on this PC → git archive HEAD | ssh → docker build on the server
//   (automatic fallback; slower, uses the server's 2 GB RAM + swap for a few minutes while nothing else is deployed)
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createGzip } from "node:zlib";
import { ROOT, banner, capture, green, red, run, stamp, yellow } from "./lib/common.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("-"));
const TARGETS = { oneteam: ["shop_oneteam"], hub: ["hub"], all: ["hub", "shop_oneteam"] };
if (!TARGETS[target]) { console.log(red("usage: deploy.cmd oneteam | hub | all")); process.exit(1); }
const cfg = JSON.parse(readFileSync(join(ROOT, "deploy", "target.json"), "utf8"));
// "hangkh" = Host alias in %USERPROFILE%\.ssh\config written by owner-setup.cmd (user ubuntu, key hangkh_ed25519)
const SSH = cfg.ssh;
const stop = (msg) => { console.log(red(`\nDEPLOY STOPPED — ${msg}\nNothing was changed on the server after this point; the running version keeps running.`)); process.exit(1); };
banner(`HangKH — DEPLOY ${target} → ${cfg.host}`);

// 1) only committed code on main goes to production
if (capture("git rev-parse --is-inside-work-tree").out !== "true") stop("Source is not a git repository.");
const branch = capture("git rev-parse --abbrev-ref HEAD").out;
if (branch !== "main") stop(`you are on branch "${branch}" — deploy only from main.`);
if (capture("git status --porcelain").out) stop("uncommitted changes — run save.cmd first.");
const sha = capture("git rev-parse --short=10 HEAD").out;
const tag = `${sha}`.toLowerCase();
const image = `hangkh/app:${tag}`;

// 2) tests
if (!args.includes("--skip-tests")) {
  if (run("node scripts/test.mjs") !== 0) stop("tests failed.");
} else console.log(yellow("tests skipped (--skip-tests)"));

// tools
let onServer = args.includes("--build-on-server");
if (!onServer && capture("docker version --format {{.Server.Version}}").code !== 0) {
  onServer = true;
  console.log(yellow("Docker Desktop is not running on this PC → the image is built on the server instead (D-61)."));
}
if (run(`ssh -o BatchMode=yes -o ConnectTimeout=10 ${SSH} "test -f ${cfg.dir}/.env && echo server-ready"`) !== 0)
  stop(`SSH key login to ${cfg.host} failed, or the server is not initialised — run owner-setup.cmd first.`);

// 3) server files → /opt/hangkh/.incoming only (installed by remote-deploy.sh after the image is loaded; rolled back with it — R10)
console.log("\n==> server files (staged)");
if (run(`ssh ${SSH} "rm -rf ${cfg.dir}/.incoming"`) !== 0 || run(`scp -q -r deploy/server ${SSH}:${cfg.dir}/.incoming`) !== 0 ||
    run(`ssh ${SSH} "sed -i 's/\\r$//' ${cfg.dir}/.incoming/bin/* ${cfg.dir}/.incoming/pg-init.sh && chmod +x ${cfg.dir}/.incoming/bin/*"`) !== 0)
  stop("copying server files failed.");

// 4) backup BEFORE anything changes (owner condition 1: backup fail = stop)
console.log("\n==> backup on the server (pg_dump)");
if (run(`ssh ${SSH} "bash ${cfg.dir}/.incoming/bin/backup.sh ${TARGETS[target].join(" ")}"`) !== 0) stop("server backup failed.");

if (onServer) {
  // 5+6 on the server: committed code only (git archive HEAD) → /opt/hangkh/.build → docker build → build dir removed
  console.log(`\n==> build ${image} ON THE SERVER (git archive | ssh | docker build)`);
  const B = `${cfg.dir}/.build`;
  const built = await new Promise((resolve) => {
    const tar = spawn("git", ["archive", "--format=tar", "HEAD"], { stdio: ["ignore", "pipe", "inherit"] });
    const ssh = spawn("ssh", [SSH, `set -e; rm -rf ${B}; mkdir -p ${B}; tar -x -C ${B}; cd ${B}; docker build -t ${image} . ; cd /; rm -rf ${B}`], { stdio: ["pipe", "inherit", "inherit"] });
    tar.stdout.pipe(ssh.stdin);
    let tarCode = null;
    tar.on("exit", (c) => { tarCode = c; });
    ssh.on("exit", (c) => resolve(c === 0 && tarCode === 0));
    tar.on("error", () => resolve(false)); ssh.on("error", () => resolve(false));
  });
  if (!built) stop("docker build on the server failed.");
} else {
// 5) build on this PC (preferred: the 2 GB server does not build)
console.log(`\n==> docker build ${image}`);
if (run(`docker build --platform linux/amd64 -t ${image} .`) !== 0) stop("docker build failed.");

// 6) ship: docker save | gzip | ssh "gunzip | docker load"
console.log("\n==> sending the image to the server (docker save | ssh | docker load)");
const sent = await new Promise((resolve) => {
  const save = spawn("docker", ["save", image], { stdio: ["ignore", "pipe", "inherit"] });
  const ssh = spawn("ssh", [SSH, "gunzip | docker load"], { stdio: ["pipe", "inherit", "inherit"] });
  let bytes = 0;
  const gz = createGzip({ level: 6 });
  save.stdout.on("data", (b) => { bytes += b.length; });
  save.stdout.pipe(gz).pipe(ssh.stdin);
  let saveCode = null;
  save.on("exit", (c) => { saveCode = c; });
  ssh.on("exit", (c) => { console.log(`    ${(bytes / 1048576).toFixed(0)} MB image`); resolve(c === 0 && saveCode === 0); });
  save.on("error", () => resolve(false)); ssh.on("error", () => resolve(false));
});
if (!sent) stop("sending the image failed.");
}

// 7) switch + restart + health (automatic rollback on the server if unhealthy)
console.log("\n==> restart");
if (run(`ssh ${SSH} "bash ${cfg.dir}/.incoming/bin/remote-deploy.sh ${target} ${tag}"`) !== 0) {
  console.log(red("\nDEPLOY FAILED — the new version was not healthy; the server put the previous version back (see the log above)."));
  process.exit(1);
}

// 8) remember what runs where
const gitTag = `deploy-${target}-${stamp().slice(0, 13)}`;
run(`git tag -f ${gitTag}`);
console.log(green(`\nDEPLOYED ${image} → ${target} · git tag ${gitTag}`));
console.log(`Rollback: check out an older deploy tag and run deploy.cmd ${target} again (database migrations are forward-only).`);
