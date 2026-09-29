// 04: owner-setup against a REAL OpenSSH server (Linux sandbox only — changes this machine: user ubuntu, sshd, /opt/hangkh,
// /root/.ssh). Runs the real server-init.sh via sudo; only services a sandbox cannot run (systemctl, ufw, swap, apt) are shims.
// Covers steps 1–10 for real: key, ~/.ssh/config alias, password → key install, key-only login afterwards, init, set-env via
// stdin, e-mail, token via "Notepad" file (shredded), DNS skip, Docker. Deploy is stopped on purpose (no Docker Hub here).
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(fileURLToPath(import.meta.url), "../../..");
if (existsSync("/opt/hangkh/.env") && !process.env.FORCE) { console.log("refusing: /opt/hangkh exists"); process.exit(1); }
const PW = "It-Test-Pass-" + Date.now();
const TOKEN = "7123456789:AAHkq3-FakeTokenForTests_abcdefghijklmn";
const sh = (c) => spawnSync("bash", ["-c", c], { encoding: "utf8" });
const results = []; const check = (n, ok, note = "") => { results.push([ok ? "PASS" : "FAIL", n, note]); };

// --- server side -----------------------------------------------------------------
rmSync("/opt/hangkh", { recursive: true, force: true });
sh(`echo 'ubuntu:${PW}' | chpasswd && rm -f /home/ubuntu/.ssh/authorized_keys /etc/ssh/sshd_config.d/00-hangkh.conf && mkdir -p /run/sshd`);
const shims = "/usr/local/hangkh-shims"; mkdirSync(shims, { recursive: true });
for (const [n, body] of Object.entries({
  "apt-get": "exit 0", ufw: 'echo "ufw $*" >> /tmp/hangkh-shim.log', timedatectl: "exit 0", fallocate: 'touch "${@: -1}"', mkswap: "exit 0",
  swapon: '[ "$1" = --show ] && exit 0; exit 0', sysctl: "exit 0",
  systemctl: 'echo "systemctl $*" >> /tmp/hangkh-shim.log; case "$*" in *reload*ssh*) pkill -HUP -f "sshd -D -p 22" ;; esac; exit 0',
})) { writeFileSync(join(shims, n), `#!/bin/bash\n${body}\n`); chmodSync(join(shims, n), 0o755); }
writeFileSync("/etc/sudoers.d/hangkh-it", `Defaults secure_path="${shims}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"\nubuntu ALL=(ALL) NOPASSWD:ALL\n`, { mode: 0o440 });
// like a cloud image: cloud-init turns password login ON in a drop-in — our 00-hangkh.conf must win (first value wins)
writeFileSync("/etc/ssh/sshd_config.d/50-cloud-init.conf", "PasswordAuthentication yes\n");
const sshd = spawn("/usr/sbin/sshd", ["-D", "-p", "22"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

// --- PC side: repo copy pointing at 127.0.0.1 ------------------------------------------
const work = mkdtempSync(join(tmpdir(), "osit-"));
const repo = join(work, "Source"); mkdirSync(join(work, "Doc_Sup"));
cpSync(SRC, repo, { recursive: true, filter: (p) => !p.includes("node_modules") && !p.includes("/.git/") });
const tj = JSON.parse(readFileSync(join(repo, "deploy/target.json"), "utf8"));
Object.assign(tj, { host: "127.0.0.1", ssh: "hangkh-it", key: "hangkh_it_ed25519" });
writeFileSync(join(repo, "deploy/target.json"), JSON.stringify(tj));
const home = process.env.HOME;
rmSync(join(home, ".ssh", "hangkh_it_ed25519"), { force: true }); rmSync(join(home, ".ssh", "hangkh_it_ed25519.pub"), { force: true });
sh(`ssh-keygen -R 127.0.0.1 >/dev/null 2>&1`);
const confBefore = existsSync(join(home, ".ssh/config")) ? readFileSync(join(home, ".ssh/config"), "utf8") : null;

const mod = await import(join(repo, "scripts/owner-setup.mjs"));
const base = mod.makeSys();
let out = "", notepad = 0, pwPrompts = 0;
const sys = { ...base, cwd: repo,
  out: (s) => { out += s; process.stdout.write(s); },
  ask: async (q) => (q.includes("អ៊ីមែល") ? "owner@example.com" : "s"),
  edit: (f) => { notepad++; writeFileSync(f, readFileSync(f, "utf8") + TOKEN + "\n"); },
  // passwords: the owner would type them; here sshpass types the server password
  tee: (cmd, args) => { if (args.includes("PubkeyAuthentication=no")) { pwPrompts++; return base.tee("sshpass", ["-p", PW, cmd, ...args]); } return base.tee(cmd, args); },
  run: (cmd, args, opts) => (cmd === process.execPath && String(args[0]).endsWith("deploy.mjs") ? { code: 1, out: "", err: "stopped by test" } : base.run(cmd, args, opts)),
  fetch: async () => { throw new Error("offline in sandbox"); },
  resolve4: async () => [],
  openFile: () => undefined,
};
const code1 = await mod.main(["--skip-tests"], sys);
const envStat = sh("stat -c '%a %U' /opt/hangkh/.env").stdout.trim();
const env = readFileSync("/opt/hangkh/.env", "utf8");
check("run 1 stops only at deploy (expected here: no Docker Hub)", code1 === 1 && /\[11\/13\][^\n]*\n?[\s\S]*Error ✗/.test(out.slice(out.indexOf("[11/13]"))));
check("password typed once (key installed)", pwPrompts === 1);
check("key login works; password login now OFF (real sshd)", sh(`ssh -o BatchMode=yes hangkh-it echo ok`).stdout.trim() === "ok" &&
  /Permission denied \(publickey\)/.test(sh(`ssh -o BatchMode=yes -o PubkeyAuthentication=no -o PreferredAuthentications=password ubuntu@127.0.0.1 true 2>&1`).stdout));
check(".env 600 owned by ubuntu, random secrets", envStat === "600 ubuntu" && /DB_PASSWORD_HUB=[a-f0-9]{48}/.test(env), envStat);
check("token + e-mail written through stdin (set-env)", env.includes(`TELEGRAM_BOT_TOKEN=${TOKEN}`) && env.includes("ACME_EMAIL=owner@example.com"));
check("token file shredded, token never printed", notepad === 1 && !out.includes(TOKEN) && !sh(`ls ${tmpdir()} | grep hangkh-token`).stdout.trim());
check("ubuntu in docker group; /opt/hangkh owned by ubuntu", /docker/.test(sh("id -nG ubuntu").stdout) && sh("stat -c %U /opt/hangkh").stdout.trim() === "ubuntu");
check("ufw rules 22/80/443 + deny incoming", ["allow 22/tcp", "allow 80/tcp", "allow 443/tcp", "default deny incoming", "--force enable"].every((x) => readFileSync("/tmp/hangkh-shim.log", "utf8").includes(x)));
check("cron runs backup as ubuntu", /0 2 \* \* \* ubuntu /.test(readFileSync("/etc/cron.d/hangkh", "utf8")));
const rep = readFileSync(join(work, "Doc_Sup", "SETUP_REPORT.json"), "utf8").length ? readFileSync(join(work, "Doc_Sup", "SETUP_REPORT.json"), "utf8") : "";
check("report written, no secrets inside", rep && !rep.includes(TOKEN) && !/[a-f0-9]{48}/.test(rep));

// run 2: idempotent — no password, no Notepad, init skipped
out = ""; pwPrompts = 0; notepad = 0;
const code2 = await mod.main(["--skip-tests"], sys);
check("run 2: nothing typed, init skipped, secrets unchanged", pwPrompts === 0 && notepad === 0 && out.includes("រៀបចំរួចហើយ") && readFileSync("/opt/hangkh/.env", "utf8") === env && code2 === 1);

// cleanup
sshd.kill(); rmSync("/etc/sudoers.d/hangkh-it", { force: true }); rmSync(shims, { recursive: true, force: true });
if (confBefore === null) rmSync(join(home, ".ssh/config"), { force: true }); else writeFileSync(join(home, ".ssh/config"), confBefore);
rmSync(work, { recursive: true, force: true }); rmSync("/opt/hangkh", { recursive: true, force: true }); rmSync("/etc/cron.d/hangkh", { force: true });
rmSync("/etc/ssh/sshd_config.d/00-hangkh.conf", { force: true }); rmSync("/etc/ssh/sshd_config.d/50-cloud-init.conf", { force: true });
console.log("\n==== OWNER-SETUP over real SSH ====");
for (const [s, n, x] of results) console.log(`  ${s}  ${n}${x ? "  — " + x : ""}`);
process.exit(results.some((r) => r[0] === "FAIL") ? 1 : 0);
