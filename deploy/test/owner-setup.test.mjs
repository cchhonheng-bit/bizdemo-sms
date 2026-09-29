// 04: owner-setup.mjs with a fake PC + fake server (node --test). Proves: idempotent re-run, secrets never printed or
// written to the report, token only via Notepad file which is shredded, password steps only when needed, clear errors.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, extractToken, mergeSshConfig, passwordLoginEnabled, redact, classifySshError } from "../../scripts/owner-setup.mjs";

const TOKEN = ["7123456789", "AAHkq3-FakeTokenForTests_abcdefghijklmn"].join(":"); // fake, built at runtime so the secret scan stays meaningful
const CFG = { ssh: "hangkh", host: "208.122.29.40", user: "ubuntu", dir: "/opt/hangkh", key: "hangkh_ed25519", domains: { root: "hangkh.com", hub: "hub.hangkh.com", oneteam: "oneteam.hangkh.com" } };

function world(over = {}) {
  const w = {
    keyOnServer: false, pwLogin: true, initDone: false, env: {}, images: "", companies: 0, admins: 0, dns: "208.122.29.40",
    docker: true, gitDirty: false, testsPass: true, deployPass: true, passwordTyped: 0, sudoTyped: 0, notepad: 0,
    editorWrites: TOKEN, getMe: { ok: true, result: { username: "hangkh_bot", can_join_groups: true, can_read_all_group_messages: false } },
    webhookOk: true, https: 200, internal: 404, files: {}, out: "", ...over,
  };
  const dir = mkdtempSync(join(tmpdir(), "owner-setup-"));
  w.home = join(dir, "home"); w.cwd = join(dir, "Source");
  w.files[join(w.cwd, "deploy", "target.json")] = JSON.stringify(CFG);
  w.files[join(w.cwd, "deploy", "server", "bin", "set-env.sh")] = "#!/bin/bash";
  const sshCmd = (cmd, input) => {
    if (!w.keyOnServer) return { code: 255, out: "", err: "ubuntu@208.122.29.40: Permission denied (publickey,password)." };
    if (cmd === "echo HANGKH_KEY_OK") return { code: 0, out: "HANGKH_KEY_OK", err: "" };
    if (cmd.startsWith("S=")) return { code: 0, out: `STATE:${w.initDone ? "env docker" : ""}`, err: "" };
    if (cmd.includes("set-env.sh") && cmd.includes("chmod 755")) return { code: 0, out: "OK", err: "" };
    const m = cmd.match(/set-env\.sh (\w+)$/);
    if (m) { w.env[m[1]] = input.trim(); return { code: 0, out: `set ${m[1]}`, err: "" }; }
    const g = cmd.match(/grep -q '\^(\w+)=\.\.\*'/);
    if (g) return { code: 0, out: w.env[g[1]] ? "YES" : "NO", err: "" };
    if (cmd.startsWith("cat /opt/hangkh/images.env")) return { code: 0, out: w.images, err: "" };
    if (cmd.includes("force-recreate")) { w.recreated = true; return { code: 0, out: "OK", err: "" }; }
    if (cmd.includes("from companies")) return { code: 0, out: String(w.companies), err: "" };
    if (cmd.includes("from hub_admins")) return { code: 0, out: String(w.admins), err: "" };
    if (cmd.includes("dc ps --format")) return { code: 0, out: "caddy=running\npostgres=running\napp-hub=running\napp-oneteam=running", err: "" };
    if (cmd.includes("healthz")) return { code: 0, out: "{\"ok\":true}", err: "" };
    if (cmd.includes("grep 'telegram setWebhook'")) return { code: 0, out: w.webhookOk ? '{"level":30,"ok":true,"msg":"telegram setWebhook"}' : "", err: "" };
    if (cmd.includes("webhook not registered")) return { code: 0, out: "", err: "" };
    if (cmd.endsWith("bin/backup.sh")) return { code: 0, out: "backup: backups/hub-x.sql.gz (8K)\nbackup: backups/shop_oneteam-x.sql.gz (9K)", err: "" };
    if (cmd.startsWith("stat -c %a")) return { code: 0, out: "600", err: "" };
    if (cmd.startsWith("free -m")) return { code: 0, out: "700/1967", err: "" };
    return { code: 0, out: "", err: "" };
  };
  w.sys = {
    win: false, home: w.home, cwd: w.cwd,
    out: (s) => { w.out += s; },
    run(cmd, args, opts = {}) {
      if (cmd === "ssh") {
        if (args.includes("PubkeyAuthentication=no")) return { code: 255, out: "", err: `Permission denied (${w.pwLogin ? "publickey,password" : "publickey"}).` };
        return sshCmd(args[args.length - 1], opts.input);
      }
      if (cmd === "scp") return { code: w.keyOnServer ? 0 : 1, out: "", err: "" };
      if (cmd === "ssh-keygen") { const f = args[args.indexOf("-f") + 1]; w.files[f] = "PRIVATE"; w.files[`${f}.pub`] = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake hangkh-owner-pc"; return { code: 0, out: "", err: "" }; }
      if (cmd === "git") return args[0] === "status" ? { code: 0, out: w.gitDirty ? " M x" : "", err: "" } : { code: 0, out: "abcdef1234", err: "" };
      if (cmd === "docker") return { code: w.docker ? 0 : 1, out: "29", err: "" };
      if (cmd === process.execPath) {
        if (args[0].endsWith("test.mjs")) { w.tested = true; return { code: w.testsPass ? 0 : 1, out: "", err: "" }; }
        if (args[0].endsWith("deploy.mjs")) { w.deployed = true; if (w.deployPass) w.images = "IMAGE_HUB=hangkh/app:abcdef1234\nIMAGE_ONETEAM=hangkh/app:abcdef1234"; return { code: w.deployPass ? 0 : 1, out: "", err: "" }; }
      }
      return { code: 0, out: "v", err: "" };
    },
    async tee(cmd, args) {
      const c = args[args.length - 1];
      if (c.includes("HANGKH_KEY_INSTALLED")) { w.passwordTyped++; w.keyOnServer = true; return { code: 0, out: "HANGKH_KEY_INSTALLED" }; }
      if (c.includes("hangkh-server-init.sh")) { w.sudoTyped++; w.initDone = true; w.pwLogin = false; return { code: 0, out: "...\nHANGKH_INIT_OK" }; }
      if (c.includes("create-company")) { w.companies = 1; w.out += "  ceo      temp password: Xy7pQ2mN8k\n"; return { code: 0, out: "" }; }
      if (c.includes("hub-admin")) { w.admins = 1; w.out += "Platform admin \"heng\" — password: Zz9Yy8Xx7Ww6\n"; return { code: 0, out: "" }; }
      return { code: 0, out: "" };
    },
    exists: (p) => p in w.files,
    read: (p) => { if (!(p in w.files)) throw new Error("ENOENT " + p); return w.files[p]; },
    write: (p, d) => { w.files[p] = String(d); },
    mkdir: () => undefined,
    ask: async (q) => (q.includes("អ៊ីមែល") ? "owner@example.com" : "s"),
    sleep: async () => undefined,
    fetch: async (url) => {
      if (url.includes("api.telegram.org")) return { json: async () => w.getMe };
      const status = url.includes("/internal/") ? w.internal : w.https;
      return { status, headers: { get: (h) => (h === "strict-transport-security" ? "max-age=31536000" : null) } };
    },
    resolve4: async () => [w.dns],
    edit: async (f) => { w.notepad++; w.notepadFile = f; w.files[f] += w.editorWrites; return w.files[f]; },
    shred: (f) => { w.shredded = f; delete w.files[f]; },
    tmpFile: () => join(tmpdir(), "hangkh-token-test.txt"),
    openFile: () => undefined,
  };
  return w;
}
const report = (w) => Object.entries(w.files).filter(([k]) => k.includes("SETUP_REPORT")).map(([, v]) => v).join("\n");

test("helpers: token extraction ignores comments, redact masks secrets, ssh parsing", () => {
  assert.equal(extractToken(`# example 1234567:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n\n  ${TOKEN}  \n`), TOKEN);
  assert.equal(extractToken("# only comments"), null);
  assert.ok(!redact(`token ${TOKEN} key ${"a".repeat(48)}`).includes(TOKEN));
  assert.ok(!redact(`ceo temp password: Xy7pQ2mN8k`).includes("Xy7pQ2mN8k"));
  assert.equal(passwordLoginEnabled("Permission denied (publickey,password)."), true);
  assert.equal(passwordLoginEnabled("Permission denied (publickey)."), false);
  assert.equal(classifySshError("connect to host 208.122.29.40 port 22: Connection timed out"), "timeout");
  const c1 = mergeSshConfig("Host *\n  ForwardAgent no\n", CFG, "C:/Users/h/.ssh/hangkh_ed25519");
  assert.ok(c1.indexOf("Host hangkh") < c1.indexOf("Host *"));
  assert.equal(mergeSshConfig(c1, CFG, "C:/Users/h/.ssh/hangkh_ed25519"), c1); // idempotent
  // P5: global options at the top stay global; our block goes before the first Host
  const c2 = mergeSshConfig("IdentityFile ~/.ssh/id_rsa\nUser git\n\nHost github.com\n  HostName github.com\n", CFG, "~/.ssh/hangkh_ed25519");
  assert.ok(c2.startsWith("IdentityFile ~/.ssh/id_rsa\nUser git"));
  assert.ok(c2.indexOf("Host hangkh") < c2.indexOf("Host github.com"));
  assert.ok(mergeSshConfig("", CFG, "~/.ssh/k").startsWith("# >>> HangKH"));
  // P3: a token that ends with "-" is kept whole
  const t2 = ["7123456789", "AAHkq3-FakeTokenForTests_abcdefghijklm-"].join(":");
  assert.equal(extractToken(t2), t2);
});

test("first run: every step, password + sudo typed once, token via Notepad (shredded), deploy, accounts, verify", async () => {
  const w = world();
  const code = await main([], w.sys);
  if (process.env.SHOW) console.log(w.out);
  assert.equal(code, 0, w.out);
  assert.equal(w.passwordTyped, 1); assert.equal(w.sudoTyped, 1); assert.equal(w.notepad, 1);
  assert.equal(w.env.TELEGRAM_BOT_TOKEN, TOKEN); assert.equal(w.env.TELEGRAM_BOT_USERNAME, "hangkh_bot"); assert.equal(w.env.ACME_EMAIL, "owner@example.com");
  assert.ok(w.shredded && !(w.shredded in w.files), "token file deleted");
  assert.ok(w.tested && w.deployed);
  assert.equal(w.companies, 1); assert.equal(w.admins, 1);
  assert.ok(!w.out.includes(TOKEN), "token never on screen");
  const r = report(w);
  assert.ok(r.includes("រួចរាល់"));
  for (const secret of [TOKEN, "Xy7pQ2mN8k", "Zz9Yy8Xx7Ww6"]) assert.ok(!r.includes(secret), `report leaks ${secret}`);
  assert.ok((w.out.match(/រួច ✓/g) ?? []).length >= 12);
});

test("second run: nothing to type, nothing redeployed (idempotent)", async () => {
  const w = world();
  await main([], w.sys);
  Object.assign(w, { passwordTyped: 0, sudoTyped: 0, notepad: 0, tested: false, deployed: false, out: "" });
  const code = await main([], w.sys);
  assert.equal(code, 0, w.out);
  assert.equal(w.passwordTyped + w.sudoTyped + w.notepad, 0);
  assert.equal(w.tested || w.deployed, false);
  assert.ok(w.out.includes("រំលង"));
});

test("--new-token on a running box: Notepad again, apps recreated with the new .env", async () => {
  const w = world();
  await main([], w.sys);
  w.notepad = 0; w.recreated = false;
  assert.equal(await main(["--new-token"], w.sys), 0);
  assert.equal(w.notepad, 1); assert.ok(w.recreated);
});

test("wrong token three times → clear error, nothing stored", async () => {
  const w = world({ getMe: { ok: false, description: "Unauthorized" } });
  const code = await main([], w.sys);
  assert.equal(code, 1);
  assert.equal(w.notepad, 3); assert.equal(w.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.ok(w.out.includes("ដោះស្រាយ"));
});

test("getMe unreachable → token NOT stored, clear error (P3)", async () => {
  const w = world();
  w.sys.fetch = async () => { throw new Error("offline"); };
  assert.equal(await main([], w.sys), 1);
  assert.equal(w.env.TELEGRAM_BOT_TOKEN, undefined);
  assert.ok(w.out.includes("Internet"));
});

test("--reset-passwords on an existing box shows new passwords, report stays clean (P7)", async () => {
  const w = world();
  await main([], w.sys);
  const calls = [];
  const orig = w.sys.tee;
  w.sys.tee = async (c, a) => { calls.push(a[a.length - 1]); if (a[a.length - 1].includes("reset-password")) w.out += "oneteam/ceo temp password: Qq1Ww2Ee3R\n"; return orig(c, a); };
  assert.equal(await main(["--reset-passwords"], w.sys), 0);
  assert.ok(calls.some((c) => c.includes("reset-password oneteam ceo")) && calls.some((c) => c.includes("hub-admin heng")));
  assert.ok(!report(w).includes("Qq1Ww2Ee3R"));
});

test("server unreachable → Error ✗ with a fix, report written", async () => {
  const w = world();
  w.sys.run = ((orig) => (cmd, args, o) => (cmd === "ssh" ? { code: 255, out: "", err: "ssh: connect to host 208.122.29.40 port 22: Connection timed out" } : orig(cmd, args, o)))(w.sys.run);
  assert.equal(await main([], w.sys), 1);
  assert.ok(w.out.includes("Error ✗") && w.out.includes("Daun Penh"));
  assert.ok(report(w).includes("ដោះស្រាយ"));
});

test("DNS not pointed yet → warning, skip, rest continues; HTTPS check reported", async () => {
  const w = world({ dns: "104.21.3.4", https: 0 });
  w.sys.fetch = ((orig) => async (url, i) => (url.includes("api.telegram.org") ? orig(url, i) : Promise.reject(new Error("ENOTFOUND"))))(w.sys.fetch);
  const code = await main([], w.sys);
  assert.equal(code, 1);
  assert.ok(w.out.includes("Proxied"), "explains the orange cloud");
  assert.ok(w.deployed, "deploy still ran");
});

test("tests fail → no deploy", async () => {
  const w = world({ testsPass: false });
  assert.equal(await main([], w.sys), 1);
  assert.equal(w.deployed, undefined);
});

test("--verify only runs the checks", async () => {
  const w = world({ keyOnServer: true, initDone: true, pwLogin: false, images: "IMAGE_HUB=hangkh/app:abcdef1234\nIMAGE_ONETEAM=hangkh/app:abcdef1234" });
  assert.equal(await main(["--verify"], w.sys), 0, w.out);
  assert.equal(w.passwordTyped + w.notepad, 0);
  const j = JSON.parse(Object.entries(w.files).find(([k]) => k.endsWith("SETUP_REPORT.json"))[1]);
  assert.deepEqual(j.results.map((r) => r.id), ["v-containers", "v-health", "v-https", "v-internal", "v-webhook", "v-backup", "v-security", "v-memory"]);
});
