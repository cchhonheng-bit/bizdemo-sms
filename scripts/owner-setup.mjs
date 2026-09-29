#!/usr/bin/env node
// owner-setup.cmd — the whole server setup + deploy in ONE click for a non-IT owner (MASTER PLAN v2.1, D-58).
// Every step first checks whether it is already done (safe to run again), prints "រួច ✓" or a clear error + how to fix,
// and stops only where the owner must type something: the server password (once, for the SSH key), the sudo password
// (only if the server asks), the bot token (in Notepad — never in chat), an e-mail address.
// Secrets never go to the screen, to a file in the project, or to the report. Report: ..\Doc_Sup\SETUP_REPORT.html
// Usage: node scripts/owner-setup.mjs [--verify] [--new-token] [--redeploy] [--skip-tests] [--reset-passwords] [--build-on-server] [--no-demo]
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { Resolver } from "node:dns/promises";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, openSync, writeSync, closeSync, statSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
export const TOKEN_RE = /(?<![\d])(\d{6,12}:[A-Za-z0-9_-]{30,60})(?![A-Za-z0-9_-])/;
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const CLOUDFLARE_PREFIXES = ["104.16.", "104.17.", "104.18.", "104.19.", "104.20.", "104.21.", "172.64.", "172.65.", "172.66.", "172.67.", "188.114."];

/** masks anything that looks like a bot token or a long random secret — applied to every line that reaches a report */
export function redact(s) {
  return String(s ?? "")
    .replace(/\d{6,12}:[A-Za-z0-9_-]{30,60}/g, "[token]")
    .replace(/\b[a-f0-9]{32,}\b/gi, "[secret]")
    .replace(/(password:\s*)\S+/gi, "$1[shown on screen only]")
    .replace(/(temp password:\s*)\S+/gi, "$1[shown on screen only]");
}

/** first bot token found in the Notepad file (comment lines ignored) */
export function extractToken(text) {
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(TOKEN_RE);
    if (m) return m[1];
  }
  return null;
}

/** our block in ~/.ssh/config, replaced in place when it exists (idempotent) */
export function mergeSshConfig(existing, cfg, keyPath) {
  const begin = "# >>> HangKH (owner-setup) >>>", end = "# <<< HangKH (owner-setup) <<<";
  const block = [begin, `Host ${cfg.ssh}`, `  HostName ${cfg.host}`, `  User ${cfg.user}`, `  IdentityFile ${keyPath}`, "  IdentitiesOnly yes",
    "  StrictHostKeyChecking accept-new", "  ServerAliveInterval 30", "  ConnectTimeout 15", end].join("\n");
  const text = existing ?? "";
  const re = new RegExp(`${begin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
  if (re.test(text)) return text.replace(re, block);
  // insert just before the first Host/Match section: global options at the top stay global (P5), and our
  // Host comes before any "Host *" so its values win (ssh uses the first value it finds)
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^\s*(Host|Match)\s/i.test(l));
  if (i < 0) return `${text.replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}${block}\n`;
  return [...lines.slice(0, i), block, "", ...lines.slice(i)].join("\n");
}

/** "Permission denied (publickey)" → password login is off; "(publickey,password)" → still on */
export function passwordLoginEnabled(stderr) {
  const m = String(stderr).match(/Permission denied \(([^)]*)\)/);
  if (!m) return null;
  return /password|keyboard-interactive/.test(m[1]);
}

export function classifySshError(stderr) {
  const s = String(stderr);
  if (/Permission denied/i.test(s)) return "auth";
  if (/timed out|Connection timed out/i.test(s)) return "timeout";
  if (/refused/i.test(s)) return "refused";
  if (/Could not resolve|Name or service not known|No such host/i.test(s)) return "dns";
  if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(s)) return "hostkey";
  return "other";
}

const FIX = {
  auth: "ពាក្យសម្ងាត់ ឬ user មិនត្រឹមត្រូវ → ពិនិត្យ user = ubuntu និងពាក្យសម្ងាត់ពី Daun Penh Cloud (email/portal) → រត់ owner-setup.cmd ម្តងទៀត",
  timeout: "Server មិនឆ្លើយ → ពិនិត្យ Internet · Daun Penh Cloud portal: server Running? · Firewall របស់ provider បើក port 22?",
  refused: "Port 22 បិទ → Daun Penh Cloud portal: បើក SSH (port 22) ឬ Restart server",
  dns: "រក server មិនឃើញ → ពិនិត្យ Internet របស់ PC",
  hostkey: "Server ត្រូវបានដំឡើងថ្មី (key ប្តូរ) → លុបបន្ទាត់ 208.122.29.40 ក្នុង %USERPROFILE%\\.ssh\\known_hosts រួចរត់ម្តងទៀត",
  other: "មើលសារខាងលើ · ផ្ញើរូបអេក្រង់ (គ្មាន password/token) មកក្រុម AI",
};

// ---------------------------------------------------------------------------------------------------------------
export function makeSys() {
  const win = process.platform === "win32";
  return {
    win,
    home: homedir(),
    cwd: ROOT,
    out: (s) => process.stdout.write(s),
    run(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.input !== undefined ? ["pipe", "pipe", "pipe"] : opts.inherit ? "inherit" : ["ignore", "pipe", "pipe"], input: opts.input, encoding: "utf8", timeout: opts.timeout ?? 0, windowsHide: !opts.inherit });
      return { code: r.error ? 127 : r.status ?? 1, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
    },
    /** interactive: output shown AND kept (to look for markers); stdin stays the console (passwords) */
    tee(cmd, args) {
      return new Promise((res) => {
        const p = spawn(cmd, args, { cwd: ROOT, stdio: ["inherit", "pipe", "inherit"] });
        let buf = "";
        p.stdout.on("data", (d) => { buf += d; process.stdout.write(d); });
        p.on("error", () => res({ code: 127, out: buf }));
        p.on("exit", (c) => res({ code: c ?? 1, out: buf }));
      });
    },
    exists: existsSync, read: (p) => readFileSync(p, "utf8"), write: writeFileSync, mkdir: (p) => mkdirSync(p, { recursive: true }),
    async ask(q) { const rl = createInterface({ input: process.stdin, output: process.stdout }); const a = await rl.question(q); rl.close(); return a.trim(); },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) }),
    async resolve4(name, servers) { const r = new Resolver(); r.setServers(servers); try { return await r.resolve4(name); } catch { return []; } },
    /** open the editor and wait until it is closed */
    /** open the editor; resolves with the file text as soon as it contains a token (polling — Windows 11 Notepad returns at once) */
    async edit(file, found, timeoutMs = 600_000) {
      if (win) spawn("notepad.exe", [file], { stdio: "ignore", detached: true }).unref();
      else spawnSync(process.env.EDITOR || "nano", [file], { stdio: "inherit" });
      const t0 = Date.now();
      for (;;) {
        let text = "";
        try { text = readFileSync(file, "utf8"); } catch { /* being saved */ }
        if (found(text) || !win || Date.now() - t0 > timeoutMs) return text;
        await new Promise((r) => setTimeout(r, 1000));
      }
    },
    /** delete token files left by an earlier run (e.g. Notepad saved the tab again after we shredded it) */
    sweepTokenFiles() { let n = 0; try { for (const f of readdirSync(tmpdir())) if (/^hangkh-token-[a-f0-9]+\.txt$/.test(f)) { this.shred(join(tmpdir(), f)); n++; } } catch { /* ignore */ } return n; },
    shred(file) {
      try { const n = statSync(file).size; const fd = openSync(file, "r+"); writeSync(fd, Buffer.alloc(Math.max(n, 256))); closeSync(fd); } catch { /* gone */ }
      rmSync(file, { force: true });
    },
    tmpFile(prefix) { return join(tmpdir(), `${prefix}-${randomBytes(6).toString("hex")}.txt`); },
    openFile(p) { if (win) spawnSync("cmd", ["/c", "start", "", p], { stdio: "ignore" }); },
  };
}

// ---------------------------------------------------------------------------------------------------------------
export async function main(argv, sys = makeSys()) {
  const args = new Set(argv);
  const cfg = JSON.parse(sys.read(join(sys.cwd, "deploy", "target.json")));
  const keyPath = join(sys.home, ".ssh", cfg.key);
  const results = [];
  const tty = process.stdout.isTTY;
  const col = (c, s) => (tty ? `\x1b[${c}m${s}\x1b[0m` : s);
  let n = 0;
  const TOTAL = args.has("--verify") ? 1 : 13;
  let envChanged = false;
  const head = (km) => sys.out(`\n${col("36;1", `[${++n}/${TOTAL}]`)} ${km} … `);
  const ok = (id, km, note = "") => { results.push({ id, km, status: "ok", note: redact(note) }); sys.out(col("32;1", "រួច ✓") + (note ? `  ${redact(note)}` : "") + "\n"); };
  const warn = (id, km, note, fix = "") => { results.push({ id, km, status: "warn", note: redact(note), fix }); sys.out(col("33;1", "ប្រុងប្រយ័ត្ន ⚠") + `  ${redact(note)}\n` + (fix ? `   → ${fix}\n` : "")); };
  const fail = (id, km, note, fix) => { results.push({ id, km, status: "fail", note: redact(note), fix }); sys.out(col("31;1", "Error ✗") + `  ${redact(note)}\n   → ដោះស្រាយ: ${fix}\n`); return finish(false); };
  const ssh = (cmd, opts = {}) => sys.run("ssh", ["-o", "BatchMode=yes", cfg.ssh, cmd], opts);
  const finish = (good) => { writeReport(sys, cfg, results, good); return good ? 0 : 1; };

  sys.out(col("36;1", "\n================ HangKH — owner-setup ================\n"));
  sys.out(`Server ${cfg.user}@${cfg.host} · ${cfg.domains.hub} · ${cfg.domains.oneteam}\n`);

  if (args.has("--verify")) return verify(sys, cfg, results, head, ok, warn, fail, ssh).then(finish);

  // 1 ── tools on this PC
  head("ឧបករណ៍លើ PC (Node, Git, OpenSSH)");
  const missing = ["ssh", "scp", "ssh-keygen", "git"].filter((t) => sys.run(t, t === "git" ? ["--version"] : ["-V"]).code === 127);
  if (Number(process.versions.node.split(".")[0]) < 22) missing.push("node 22");
  if (missing.length) return fail("tools", "ឧបករណ៍", `ខ្វះ: ${missing.join(", ")}`, "OpenSSH: Settings → Apps → Optional features → Add → «OpenSSH Client» · Git/Node: owner-setup.cmd ដំឡើងស្វ័យប្រវត្តិ (winget) — រត់ម្តងទៀត");
  ok("tools", "ឧបករណ៍ PC");

  // 2 ── SSH key for this PC
  head("SSH key សម្រាប់ PC នេះ");
  sys.mkdir(join(sys.home, ".ssh"));
  if (!sys.exists(keyPath)) {
    const r = sys.run("ssh-keygen", ["-t", "ed25519", "-a", "64", "-N", "", "-C", `hangkh-owner-${hostname()}`, "-f", keyPath]);
    if (r.code !== 0 || !sys.exists(keyPath)) return fail("key", "SSH key", r.err || "ssh-keygen បរាជ័យ", "រត់ owner-setup.cmd ម្តងទៀត · បើនៅតែ Error: ផ្ញើរូបអេក្រង់");
    ok("key", "SSH key", "បង្កើតថ្មី: " + keyPath);
  } else ok("key", "SSH key", "មានរួច: " + keyPath);
  const pub = sys.read(`${keyPath}.pub`).trim();
  if (!/^ssh-ed25519 [A-Za-z0-9+/=]+ [\w.@-]+$/.test(pub)) return fail("key", "SSH key", "public key ខុសទម្រង់", `លុប ${keyPath}* រួចរត់ម្តងទៀត`);

  // 3 ── ~/.ssh/config alias "hangkh"
  head(`SSH alias «${cfg.ssh}» (%USERPROFILE%\\.ssh\\config)`);
  const confPath = join(sys.home, ".ssh", "config");
  const before = sys.exists(confPath) ? sys.read(confPath) : "";
  const after = mergeSshConfig(before, cfg, `~/.ssh/${cfg.key}`);
  if (after !== before) sys.write(confPath, after);
  ok("sshconfig", "SSH alias", after === before ? "មិនប្តូរ" : "បានសរសេរ");

  // 4 ── key login (password typed ONCE if the key is not on the server yet)
  head(`ចូល server ដោយ key (${cfg.user}@${cfg.host})`);
  let t = ssh("echo HANGKH_KEY_OK", { timeout: 30_000 });
  if (!t.out.includes("HANGKH_KEY_OK")) {
    const why = classifySshError(t.err);
    if (why !== "auth") return fail("login", "ចូល server", t.err.split("\n").pop() || why, FIX[why]);
    sys.out(col("33;1", "\n\n   ⌨  សូមវាយពាក្យសម្ងាត់ server របស់ user «ubuntu» (អក្សរមិនបង្ហាញពេលវាយ — ធម្មតា) រួច Enter:\n\n"));
    const install = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '${pub}' ~/.ssh/authorized_keys || { [ -s ~/.ssh/authorized_keys ] && [ -n "$(tail -c1 ~/.ssh/authorized_keys)" ] && echo >> ~/.ssh/authorized_keys; echo '${pub}' >> ~/.ssh/authorized_keys; }) && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo HANGKH_KEY_INSTALLED`;
    const p = await sys.tee("ssh", ["-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=keyboard-interactive,password", "-o", "StrictHostKeyChecking=accept-new", "-o", "NumberOfPasswordPrompts=3", `${cfg.user}@${cfg.host}`, install]);
    if (!p.out.includes("HANGKH_KEY_INSTALLED")) return fail("login", "ចូល server", "ដាក់ key មិនបាន (ពាក្យសម្ងាត់ខុស 3 ដង ឬ server បិទ password login)", FIX.auth);
    t = ssh("echo HANGKH_KEY_OK", { timeout: 30_000 });
    if (!t.out.includes("HANGKH_KEY_OK")) return fail("login", "ចូល server", t.err || "key មិនដំណើរការ", FIX.other);
    ok("login", "ចូល server ដោយ key", "key បានដាក់ — លើកក្រោយមិនសួរពាក្យសម្ងាត់ទៀត");
  } else ok("login", "ចូល server ដោយ key", "គ្មានពាក្យសម្ងាត់");

  // 5 ── server-init (Docker, UFW, swap, /opt/hangkh, .env, SSH key only)
  head("រៀបចំ Server (Docker · UFW 22/80/443 · swap 2 GB · /opt/hangkh · .env · បិទ password SSH)");
  const state = () => ssh(`S=""; [ -f ${cfg.dir}/.env ] && [ -w ${cfg.dir} ] && S="env"; id -nG | tr ' ' '\\n' | grep -qx docker && docker info >/dev/null 2>&1 && S="$S docker"; sudo -n true 2>/dev/null && S="$S nopass"; echo "STATE:$S"`, { timeout: 30_000 }).out;
  const pwOn = () => passwordLoginEnabled(sys.run("ssh", ["-o", "BatchMode=yes", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=keyboard-interactive,password", `${cfg.user}@${cfg.host}`, "true"], { timeout: 30_000 }).err);
  let st = state();
  if (st.includes("env") && st.includes("docker") && pwOn() === false && !args.has("--reinit")) ok("init", "Server", "រៀបចំរួចហើយ (រំលង)");
  else {
    if (sys.run("scp", ["-q", "-o", "BatchMode=yes", join("deploy", "server-init.sh"), `${cfg.ssh}:hangkh-server-init.sh`]).code !== 0) return fail("init", "Server", "ផ្ញើ server-init.sh មិនបាន", FIX.other);
    if (!st.includes("nopass")) sys.out(col("33;1", "\n\n   ⌨  បើ server សួរ «[sudo] password for ubuntu» — វាយពាក្យសម្ងាត់ ubuntu ដដែល រួច Enter:\n\n"));
    const p = await sys.tee("ssh", ["-t", cfg.ssh, "sed -i 's/\\r$//' ~/hangkh-server-init.sh && sudo bash ~/hangkh-server-init.sh " + cfg.user + "; rc=$?; rm -f ~/hangkh-server-init.sh; exit $rc"]);
    if (!p.out.includes("HANGKH_INIT_OK")) return fail("init", "Server", "server-init មិនបានបញ្ចប់", "មើលបន្ទាត់ «ERROR» ខាងលើ · sudo password ខុស? · រត់ owner-setup.cmd ម្តងទៀត (សុវត្ថិភាព)");
    st = state();
    if (!(st.includes("env") && st.includes("docker"))) return fail("init", "Server", `ស្ថានភាពបន្ទាប់ពី init: ${st}`, FIX.other);
    const pw = pwOn();
    if (pw !== false) warn("init", "Server", "Password SSH នៅបើក", "រត់ owner-setup.cmd --reinit ម្តងទៀត");
    else ok("init", "Server", "Docker ✓ UFW ✓ swap ✓ .env (600) ✓ password SSH បិទ ✓");
  }

  // 6 ── helper for secrets on the server
  head("ឧបករណ៍ set-env លើ server");
  const up = sys.run("scp", ["-q", "-o", "BatchMode=yes", join("deploy", "server", "bin", "set-env.sh"), `${cfg.ssh}:${cfg.dir}/bin/set-env.sh`]);
  if (up.code !== 0 || ssh(`sed -i 's/\\r$//' ${cfg.dir}/bin/set-env.sh && chmod 755 ${cfg.dir}/bin/set-env.sh && echo OK`).out !== "OK") return fail("setenv", "set-env", up.err || "copy failed", FIX.other);
  ok("setenv", "set-env");
  const envHas = (k) => ssh(`grep -q '^${k}=..*' ${cfg.dir}/.env && echo YES || echo NO`).out === "YES";
  const setEnv = (k, v) => { envChanged = true; return ssh(`${cfg.dir}/bin/set-env.sh ${k}`, { input: `${v}\n` }); };

  // 7 ── e-mail for Let's Encrypt
  head("អ៊ីមែលសម្រាប់ HTTPS (Let's Encrypt)");
  if (envHas("ACME_EMAIL")) ok("email", "អ៊ីមែល", "មានរួច");
  else {
    let email = "";
    for (let i = 0; i < 3 && !EMAIL_RE.test(email); i++) email = await sys.ask(col("33;1", "\n   ⌨  វាយអ៊ីមែលរបស់បង (ទទួលដំណឹង certificate) រួច Enter: "));
    if (!EMAIL_RE.test(email)) return fail("email", "អ៊ីមែល", "អ៊ីមែលមិនត្រឹមត្រូវ", "រត់ម្តងទៀត ហើយវាយឧ. name@gmail.com");
    const r = setEnv("ACME_EMAIL", email);
    if (r.code !== 0) return fail("email", "អ៊ីមែល", r.out || r.err, FIX.other);
    ok("email", "អ៊ីមែល", "បានរក្សាក្នុង .env");
  }

  // 8 ── Telegram bot token via Notepad (never chat, never the project folder)
  head("Telegram Bot Token (@BotFather → Notepad)");
  let bot = null;
  sys.sweepTokenFiles?.();
  if (envHas("TELEGRAM_BOT_TOKEN") && !args.has("--new-token")) ok("token", "Bot token", "មានរួចលើ server (ប្តូរ: owner-setup.cmd --new-token)");
  else {
    sys.out("\n   1) ទូរស័ព្ទ/កុំព្យូទ័រ → Telegram → ស្វែងរក @BotFather → /newbot → ឈ្មោះ: HangKH → username: hangkh_bot (ឬឈ្មោះផ្សេងចប់ដោយ _bot)\n");
    sys.out("   2) @BotFather ផ្ញើ Token (ឧ. 123456789:AA…) — ចម្លងវា\n   3) Notepad នឹងបើក → បិទភ្ជាប់ Token → Ctrl+S (រង់ចាំ ≤ 10 នាទី)\n\n");
    let token = null;
    for (let i = 0; i < 3 && !bot; i++) {
      const f = sys.tmpFile("hangkh-token");
      try {
        sys.write(f, "# បិទភ្ជាប់ Token ពី @BotFather នៅបន្ទាត់ខាងក្រោម → Ctrl+S → បិទ Notepad (file នេះនឹងត្រូវលុបភ្លាម)\n# Paste the token from @BotFather on the line below, press Ctrl+S, close Notepad (this file is deleted right after)\n\n", { mode: 0o600 });
        token = extractToken(await sys.edit(f, (text) => !!extractToken(text)));
      } finally { sys.shred(f); }
      sys.out(col("33;1", "   → បិទ Notepad ឥឡូវ (បើវាសួរ Save — ចុច Don't save / មិនរក្សាទុក)\n"));
      if (!token) { sys.out(col("31;1", "   ✗ រកមិនឃើញ Token ក្នុង Notepad — សាកម្តងទៀត\n")); continue; }
      let r;
      try { r = await (await sys.fetch(`https://api.telegram.org/bot${token}/getMe`)).json(); }
      catch { token = null; return fail("token", "Bot token", "ពិនិត្យ Token ជាមួយ Telegram មិនបាន (Internet?)", "ពិនិត្យ Internet របស់ PC → រត់ owner-setup.cmd ម្តងទៀត (Token មិនបានរក្សាទុក)"); }
      if (r?.ok) bot = r.result; else { sys.out(col("31;1", "   ✗ Telegram បដិសេធ Token នេះ (ចម្លងខុស?) — សាកម្តងទៀត\n")); token = null; }
    }
    if (!token) return fail("token", "Bot token", "Token មិនត្រឹមត្រូវ 3 ដង", "@BotFather → /mybots → hangkh_bot → API Token → ចម្លងម្តងទៀត");
    const r = setEnv("TELEGRAM_BOT_TOKEN", token);
    token = null;
    if (r.code !== 0) return fail("token", "Bot token", r.out || r.err, FIX.other);
    if (bot?.username) setEnv("TELEGRAM_BOT_USERNAME", bot.username);
    ok("token", "Bot token", `បានរក្សាលើ server (.env 600) · @${bot.username}`);
    if (bot?.can_read_all_group_messages) warn("privacy", "Bot privacy", "Privacy mode បិទ — bot អានសារទាំងអស់ក្នុង group", "@BotFather → /setprivacy → ជ្រើស bot → Enable");
    if (bot && bot.can_join_groups === false) warn("groups", "Bot groups", "Bot មិនអាចចូល group", "@BotFather → /setjoingroups → ជ្រើស bot → Enable");
  }

  // 9 ── DNS (Cloudflare)
  head("DNS hangkh.com → " + cfg.host);
  let dnsOk = false;
  for (;;) {
    const names = [cfg.domains.hub, cfg.domains.oneteam, cfg.domains.root];
    const bad = [];
    for (const nm of names) {
      const ips = [...new Set([...(await sys.resolve4(nm, ["1.1.1.1"])), ...(await sys.resolve4(nm, ["8.8.8.8"]))])];
      if (!(ips.length === 1 && ips[0] === cfg.host)) bad.push(`${nm} = ${ips.join(",") || "(គ្មាន)"}${ips.some((ip) => CLOUDFLARE_PREFIXES.some((p) => ip.startsWith(p))) ? " ← ពពកពណ៌ទឹកក្រូច (Proxied) — ប្តូរទៅ DNS only" : ""}`);
    }
    if (!bad.length) { dnsOk = true; ok("dns", "DNS", names.join(" · ")); break; }
    sys.out(col("33;1", "\n   DNS មិនទាន់ត្រូវ:\n") + bad.map((b) => `     • ${b}\n`).join(""));
    sys.out("   Cloudflare: dash.cloudflare.com → hangkh.com → DNS → Records → Add record → Type A · Name @ / www / hub / oneteam · IPv4 " + cfg.host + " · Proxy status = DNS only (ពពកប្រផេះ) → Save\n");
    const a = (await sys.ask("   Enter = ពិនិត្យម្តងទៀត · S = រំលង (HTTPS នឹងដំណើរការពេល DNS ត្រូវ): ")).toLowerCase();
    if (a === "s") { warn("dns", "DNS", bad.join(" | "), "បន្ថែម record ក្នុង Cloudflare រួចរត់ owner-setup.cmd --verify"); break; }
    sys.out("   ពិនិត្យម្តងទៀត … ");
  }

  // 10 ── Docker Desktop (preferred) · not running → the image is built on the server instead (D-61)
  head("Docker Desktop (build image លើ PC នេះ)");
  const dockerUp = () => sys.run("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 20_000 }).code === 0;
  let buildOnServer = args.has("--build-on-server");
  if (!buildOnServer && !dockerUp()) {
    const exe = "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe";
    if (sys.run("docker", ["--version"]).code !== 127) {
      if (sys.win && sys.exists(exe)) { sys.out("\n   កំពុងបើក Docker Desktop (រង់ចាំ ≤ 3 នាទី)…"); spawnSync("cmd", ["/c", "start", "", exe], { stdio: "ignore" }); }
      for (let i = 0; i < 36 && !dockerUp(); i++) await sys.sleep(5000);
    }
    if (!dockerUp()) buildOnServer = true;
  }
  if (buildOnServer) warn("docker", "Docker Desktop", "Engine មិនដំណើរការលើ PC នេះ → build image លើ Server ជំនួស (យឺតជាង ~5–10 នាទី · ដំណើរការដូចគ្នា)", "ពេលក្រោយ: បើក Docker Desktop រង់ចាំ «Engine running» → deploy.cmd all នឹង build លើ PC វិញ");
  else ok("docker", "Docker Desktop", "Engine running");

  // 11 ── tests + deploy (skip when the server already runs this exact version)
  head("តេស្ត + Deploy (tests → backup → build → ផ្ញើ → start → health)");
  const sha = sys.run("git", ["rev-parse", "--short=10", "HEAD"]).out.toLowerCase();
  const images = ssh(`cat ${cfg.dir}/images.env 2>/dev/null`).out;
  const deployed = images.includes(`IMAGE_HUB=hangkh/app:${sha}`) && images.includes(`IMAGE_ONETEAM=hangkh/app:${sha}`);
  if (deployed && !args.has("--redeploy")) {
    // settings changed (token / e-mail) → restart the apps + caddy so they read the new .env
    if (envChanged && ssh(`${cfg.dir}/bin/dc up -d --force-recreate app-hub app-oneteam caddy >/dev/null 2>&1 && echo OK`, { timeout: 180_000 }).out !== "OK")
      return fail("deploy", "Deploy", "restart ក្រោយប្តូរ .env បរាជ័យ", "deploy.cmd all");
    ok("deploy", "Deploy", `កំណែ ${sha} ដំណើរការរួចហើយ${envChanged ? " · restart ដោយ .env ថ្មី" : " (រំលង)"}`);
  }
  else {
    if (sys.run("git", ["status", "--porcelain"]).out) return fail("deploy", "Deploy", "មានការកែប្រែមិនទាន់ save ក្នុង Source", "រត់ sync-from-bundle.cmd ឬ save.cmd រួចរត់ម្តងទៀត");
    if (!args.has("--skip-tests")) {
      sys.out("\n");
      const tr = sys.run(process.execPath, [join("scripts", "test.mjs")], { inherit: true });
      if (tr.code !== 0) return fail("deploy", "តេស្ត", "test.cmd បរាជ័យ — មិន deploy", "ផ្ញើរូបអេក្រង់តារាង FAIL មកក្រុម AI");
    }
    sys.out("\n");
    const dr = sys.run(process.execPath, [join("scripts", "deploy.mjs"), "all", "--skip-tests", ...(buildOnServer ? ["--build-on-server"] : [])], { inherit: true });
    if (dr.code !== 0) return fail("deploy", "Deploy", "deploy.cmd all បរាជ័យ (server នៅកំណែចាស់)", "មើលសារ «DEPLOY STOPPED/FAILED» ខាងលើ · រត់ owner-setup.cmd ម្តងទៀត");
    ok("deploy", "Deploy", `hangkh/app:${sha} → hub + oneteam`);
  }

  // 12 ── accounts + demo data (D-62). Temp passwords are NOT shown on screen: owner's decision 29-09 → Doc_Sup\_demo_accounts.txt
  //       (outside git; every account must change its password at first login; delete the file after handing them out)
  head("គណនី + ទិន្នន័យ Demo (ceo · gm01 · admin · kim · dara · platform heng)");
  const q = (db, sql) => ssh(`${cfg.dir}/bin/dc exec -T postgres psql -U postgres -d ${db} -tAc "${sql}"`).out.trim();
  const cli = (app, cmd) => sys.run("ssh", [cfg.ssh, `${cfg.dir}/bin/dc exec -T ${app} node dist/cli.mjs ${cmd}`], { timeout: 120_000 });
  const creds = [];
  const grab = (r, where) => {
    for (const m of r.out.matchAll(/^\s*(?:\S+\/)?([a-z0-9._-]+)\s+temp password: (\S+)\s*$/gm)) creds.push([where, m[1], m[2]]);
    for (const m of r.out.matchAll(/Platform admin "([^"]+)" — password: (\S+)/g)) creds.push(["hub", m[1], m[2]]);
    for (const m of r.out.matchAll(/^DEMO_ACCOUNT (\S+) (\S+) (\S+)$/gm)) creds.push([where, m[1], m[3], m[2]]);
  };
  const notes = [];
  const nCompanies = q("shop_oneteam", "select count(*) from companies"), nAdmins = q("hub", "select count(*) from hub_admins");
  if (!/^\d+$/.test(nCompanies) || !/^\d+$/.test(nAdmins)) return fail("accounts", "គណនី", "អាន database មិនបាន", "ssh hangkh → /opt/hangkh/bin/dc ps (postgres ដំណើរការ?) · រត់ម្តងទៀត");
  if (args.has("--reset-passwords") && nCompanies !== "0") {
    grab(cli("app-oneteam", "reset-password oneteam ceo"), "oneteam");
    grab(cli("app-hub", "hub-admin heng"), "hub");
    notes.push("ពាក្យសម្ងាត់ ceo + heng បានប្តូរ");
  }
  if (nCompanies === "0") {
    const r = cli("app-oneteam", `create-company "One Team Engineering" oneteam`);
    if (r.code !== 0) return fail("accounts", "គណនី", "create-company បរាជ័យ", FIX.other);
    grab(r, "oneteam");
    notes.push("ceo + support បានបង្កើត");
  } else notes.push("One Team មានរួច");
  if (nAdmins === "0") {
    const r = cli("app-hub", "hub-admin heng");
    if (r.code !== 0) return fail("accounts", "គណនី", "hub-admin បរាជ័យ", FIX.other);
    grab(r, "hub");
    notes.push("platform: heng បានបង្កើត");
  } else notes.push("platform admin មានរួច");
  if (!args.has("--no-demo")) {
    const r = cli("app-oneteam", "seed-demo oneteam");
    if (r.code !== 0) return fail("accounts", "Demo", "seed-demo បរាជ័យ", FIX.other);
    grab(r, "oneteam");
    const made = [...r.out.matchAll(/^DEMO_DATA (.+)$/gm)].map((m) => m[1]);
    notes.push(made.length ? `demo: ${made.join(" · ")}` : "demo មានរួច");
  }
  if (creds.length) {
    const f = saveAccounts(sys, cfg, creds);
    notes.push(`ពាក្យសម្ងាត់ ${creds.length} គណនី → ${f ?? "(សរសេរ file មិនបាន)"}`);
    sys.out(col("33;1", `\n   📝 ពាក្យសម្ងាត់បណ្ដោះអាសន្ន ${creds.length} គណនី → ${f} (មិនបង្ហាញលើអេក្រង់ · ត្រូវប្តូរពេលចូលដំបូង · លុប file ក្រោយចែក)\n`));
  }
  ok("accounts", "គណនី", notes.join(" · "));

  await verify(sys, cfg, results, head, ok, warn, fail, ssh, dnsOk);
  return finish(!results.some((r) => r.status === "fail"));
}

// --------------------------------------------------------------------------------------------------------------- 04: C3–C8 minus the phone
async function verify(sys, cfg, results, head, ok, warn, fail, ssh, dnsKnownOk) {
  head("ពិនិត្យក្រោយ Deploy (04)");
  sys.out("\n");
  const check = async (id, km, fn) => {
    let r;
    try { r = await fn(); } catch (e) { r = { status: "fail", note: String(e?.message ?? e) }; }
    results.push({ id, km, ...r, note: redact(r.note ?? "") });
    const mark = r.status === "ok" ? "✓" : r.status === "warn" ? "⚠" : "✗";
    sys.out(`   ${mark} ${km}${r.note ? ` — ${redact(r.note)}` : ""}${r.fix ? `\n      → ${r.fix}` : ""}\n`);
  };
  await check("v-containers", "Containers 4 ដំណើរការ", () => {
    const o = ssh(`${cfg.dir}/bin/dc ps --format '{{.Service}}={{.State}}'`).out;
    const run = o.split(/\s+/).filter((l) => l.endsWith("=running")).map((l) => l.split("=")[0]);
    const need = ["caddy", "postgres", "app-hub", "app-oneteam"];
    const miss = need.filter((s) => !run.includes(s));
    return miss.length ? { status: "fail", note: `មិនដំណើរការ: ${miss.join(", ")}`, fix: "deploy.cmd all ម្តងទៀត · ឬ ssh hangkh → /opt/hangkh/bin/dc logs --tail 50 " + miss[0] } : { status: "ok", note: need.join(" · ") };
  });
  await check("v-health", "Health ខាងក្នុង (hub + oneteam)", () => {
    const bad = ["app-hub", "app-oneteam"].filter((s) => ssh(`${cfg.dir}/bin/dc exec -T ${s} wget -qO- http://127.0.0.1:3000/healthz`).code !== 0);
    return bad.length ? { status: "fail", note: bad.join(", "), fix: "ssh hangkh → /opt/hangkh/bin/dc logs --tail 80 " + bad[0] } : { status: "ok" };
  });
  const https = async (url, tries = 1) => { for (let i = 0; i < tries; i++) { try { return await sys.fetch(url, { redirect: "manual" }); } catch { if (i < tries - 1) await sys.sleep(10_000); } } return null; };
  await check("v-https", "HTTPS + certificate (hub · oneteam)", async () => {
    const out = [];
    for (const d of [cfg.domains.hub, cfg.domains.oneteam]) {
      const r = await https(`https://${d}/healthz`, dnsKnownOk === false ? 1 : 12);
      out.push(`${d}: ${r ? r.status : "មិនភ្ជាប់"}`);
      if (!r || r.status !== 200) return { status: "fail", note: out.join(" · "), fix: "DNS ត្រូវ? (Cloudflare DNS only) · រង់ចាំ 5 នាទី (Let's Encrypt) · owner-setup.cmd --verify" };
      if (!r.headers.get("strict-transport-security")) return { status: "warn", note: `${d}: គ្មាន HSTS` };
    }
    return { status: "ok", note: out.join(" · ") };
  });
  await check("v-internal", "/internal/* បិទពីខាងក្រៅ (404)", async () => {
    const a = await https(`https://${cfg.domains.oneteam}/internal/stats`), b = await https(`https://${cfg.domains.hub}/internal/subscribers`);
    if (!a || !b) return { status: "warn", note: "មិនអាចពិនិត្យ (HTTPS មិនទាន់ដំណើរការ)" };
    return a.status === 404 && b.status === 404 ? { status: "ok" } : { status: "fail", note: `oneteam ${a.status} · hub ${b.status}`, fix: "ផ្ញើលទ្ធផលនេះមកក្រុម AI ភ្លាម (Caddyfile)" };
  });
  await check("v-webhook", "Telegram webhook ចុះឈ្មោះ", async () => {
    const last = () => ssh(`${cfg.dir}/bin/dc logs app-hub 2>&1 | grep 'telegram setWebhook' | tail -1`).out;
    let o = last();
    if (/"ok":true/.test(o)) return { status: "ok" };
    if (o && results.find((x) => x.id === "v-https")?.status === "ok") {
      // DNS/HTTPS became ready after the hub started → one restart registers the webhook again (idempotent)
      ssh(`${cfg.dir}/bin/dc restart app-hub >/dev/null 2>&1`, { timeout: 120_000 });
      for (let i = 0; i < 12 && !/"ok":true/.test(o = last()); i++) await sys.sleep(5000);
      if (/"ok":true/.test(o)) return { status: "ok", note: "ចុះឈ្មោះក្រោយ restart hub" };
    }
    if (/not registered/.test(ssh(`${cfg.dir}/bin/dc logs app-hub 2>&1 | grep 'webhook not registered' | tail -1`).out)) return { status: "fail", note: "token/secret ខ្វះ", fix: "owner-setup.cmd --new-token" };
    return { status: "fail", note: o ? "Telegram បដិសេធ" : "មិនទាន់ឃើញ", fix: "DNS/HTTPS ត្រូវសិន (Telegram ត្រូវការ https) → deploy.cmd hub" };
  });
  await check("v-backup", "Backup ឥឡូវ (hub + shop_oneteam)", () => {
    const r = ssh(`${cfg.dir}/bin/backup.sh`, { timeout: 180_000 });
    const files = (r.out.match(/backup: backups\/\S+/g) ?? []).length;
    return r.code === 0 && files >= 2 ? { status: "ok", note: `${files} files · nightly 02:00` } : { status: "fail", note: r.out.split("\n").pop() || r.err, fix: "ssh hangkh → /opt/hangkh/bin/backup.sh" };
  });
  await check("v-security", "Server: UFW · password SSH · .env 600", () => {
    const perm = ssh(`stat -c %a ${cfg.dir}/.env`).out;
    const pw = passwordLoginEnabled(sys.run("ssh", ["-o", "BatchMode=yes", "-o", "PubkeyAuthentication=no", "-o", "PreferredAuthentications=keyboard-interactive,password", `${cfg.user}@${cfg.host}`, "true"], { timeout: 30_000 }).err);
    const problems = [perm !== "600" && `.env ${perm}`, pw !== false && "password SSH បើក"].filter(Boolean);
    return problems.length ? { status: "fail", note: problems.join(" · "), fix: "owner-setup.cmd --reinit" } : { status: "ok", note: ".env 600 · key only" };
  });
  await check("v-memory", "RAM (2 GB + swap)", () => {
    const o = ssh("free -m | awk '/Mem/{print $3\"/\"$2}'").out;
    const [used, total] = o.split("/").map(Number);
    return used && total ? { status: used / total < 0.85 ? "ok" : "warn", note: `ប្រើ ${used}/${total} MB`, fix: used / total < 0.85 ? undefined : "Upgrade 4 GB" } : { status: "warn", note: "មិនអាចអាន" };
  });
  return !results.some((r) => r.status === "fail");
}

// --------------------------------------------------------------------------------------------------------------- demo accounts file (owner's decision, D-62)
export function accountsText(cfg, creds, now) {
  const role = { ceo: "CEO", support: "Admin (support)", gm: "GM", admin: "Admin", tech: "Technician" };
  const lines = creds.map(([where, user, pw, r]) => {
    const url = where === "hub" ? `https://${cfg.domains.hub}/platform` : `https://${cfg.domains.oneteam}`;
    const rl = where === "hub" ? "Platform owner" : role[r ?? user] ?? r ?? "";
    return `${user.padEnd(10)} ${pw.padEnd(16)} ${rl.padEnd(16)} ${url}`;
  });
  return [`# ${now} — HangKH គណនីថ្មី (ពាក្យសម្ងាត់បណ្ដោះអាសន្ន · ត្រូវប្តូរពេលចូលដំបូង)`,
    "# ⚠️ កុំផ្ញើ file នេះក្នុង Telegram/ឆាត · ប្រគល់ផ្ទាល់ដៃ · លុប file ក្រោយគ្រប់គ្នាប្តូររួច",
    `# username   password         role             URL`, ...lines, "", ""].join("\n");
}
function saveAccounts(sys, cfg, creds) {
  const docDir = resolve(sys.cwd, "..", "Doc_Sup");
  const dir = sys.exists(docDir) ? docDir : join(sys.home, "Documents"); // never inside the repo
  const f = join(dir, "_demo_accounts.txt");
  const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh" });
  try {
    sys.mkdir(dir);
    const prev = sys.exists(f) ? sys.read(f) : "";
    sys.write(f, accountsText(cfg, creds, now) + prev, { mode: 0o600 });
    return f;
  } catch { return null; }
}

// --------------------------------------------------------------------------------------------------------------- report (no secrets)
function writeReport(sys, cfg, results, good) {
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const icon = { ok: "✓", warn: "⚠", fail: "✗" };
  const now = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh" });
  const docDir = resolve(sys.cwd, "..", "Doc_Sup");
  const dir = sys.exists(docDir) ? docDir : join(sys.home, "Documents"); // never inside the repo (P6)
  const next = good
    ? ["បើក https://oneteam.hangkh.com → Login ceo (ពាក្យសម្ងាត់លើក្រដាស) → ប្តូរពាក្យសម្ងាត់", "ខ្ញុំ → ភ្ជាប់ Telegram (ទូរស័ព្ទ) · ការកំណត់ → បង្កើតកូដ Group → /register ក្នុង Group", "ស្កេន QR (OneTeam_Subscribe_Guide_Customer_KM.pdf) ដោយទូរស័ព្ទទី 2 → ☑ យល់ព្រម", "ប្រាប់ក្រុម AI: «setup រួច» — 04 នឹងពិនិត្យពីខាងក្រៅម្តងទៀត"]
    : ["អានជួរ ✗ ខាងក្រោម → ធ្វើតាម «ដោះស្រាយ» → រត់ owner-setup.cmd ម្តងទៀត (ជំហានដែលរួចនឹងរំលង)"];
  const rows = results.map((r) => `<tr class="${r.status}"><td>${icon[r.status]}</td><td>${esc(r.km)}</td><td>${esc(r.note)}${r.fix ? `<br><b>ដោះស្រាយ:</b> ${esc(r.fix)}` : ""}</td></tr>`).join("");
  const html = `<!doctype html><html lang="km"><head><meta charset="utf-8"><title>HangKH setup report</title><style>
body{font-family:'Noto Sans Khmer','Khmer UI','Segoe UI',sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1F2433}h1{color:#2E3A78}
table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #D5DAE8;padding:8px;vertical-align:top}tr.ok td:first-child{color:#188A54;font-weight:700}
tr.warn td:first-child{color:#B45309;font-weight:700}tr.fail td:first-child{color:#B42318;font-weight:700}tr.fail{background:#FEF3F2}.box{padding:12px 16px;border-radius:10px;background:${good ? "#E8F5EE" : "#FEF3F2"}}
</style></head><body><h1>HangKH — របាយការណ៍ Setup</h1><p>${esc(now)} · ${esc(cfg.user)}@${esc(cfg.host)} · ${esc(cfg.domains.hub)} · ${esc(cfg.domains.oneteam)}</p>
<div class="box"><b>${good ? "✓ រួចរាល់" : "✗ មិនទាន់រួច"}</b><ol>${next.map((x) => `<li>${esc(x)}</li>`).join("")}</ol></div>
<table>${rows}</table><p style="color:#6B7280;font-size:13px">⚠️ PC នេះមាន key ចូល Server (គ្មាន passphrase) — ដាក់ Windows password + screen lock · កុំឲ្យអ្នកផ្សេងប្រើ account Windows នេះ។ គ្មាន password/token ក្នុងរបាយការណ៍នេះ។ រត់ម្តងទៀត: owner-setup.cmd · ពិនិត្យតែប៉ុណ្ណោះ: owner-setup.cmd --verify</p></body></html>`;
  try {
    sys.mkdir(dir);
    sys.write(join(dir, "SETUP_REPORT.html"), html);
    sys.write(join(dir, "SETUP_REPORT.json"), JSON.stringify({ at: new Date().toISOString(), good, results }, null, 1));
    sys.out(`\n${good ? "✓ រួចរាល់" : "✗ មិនទាន់រួច"} — របាយការណ៍: ${join(dir, "SETUP_REPORT.html")}\n`);
    sys.openFile(join(dir, "SETUP_REPORT.html"));
  } catch { /* report is best effort */ }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(redact(e?.stack ?? e)); process.exit(1); });
}
