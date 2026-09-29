#!/usr/bin/env node
// 04: tests for deploy/server/bin/{backup,restore,remote-deploy}.sh on Linux (needs psql + pg_dump 16 on the host, root,
// writes to /opt/hangkh — run ONLY in a throw-away machine, never on the server). docker is replaced by deploy/test/fake-docker.
import EmbeddedPostgres from "embedded-postgres";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, Steps } from "../../scripts/lib/common.mjs";

if (existsSync("/opt/hangkh/.env")) { console.log("refusing: /opt/hangkh/.env exists (real server?)"); process.exit(1); }
const PORT = 55433, PW_HUB = "hubpw", PW_ONE = "onepw";
const steps = new Steps();
const check = (n, ok, note = "") => { steps.add(n, ok ? "PASS" : "FAIL", note); if (!ok) console.log("FAIL", n, note); };
const work = mkdtempSync(join(tmpdir(), "srv-test-")); chmodSync(work, 0o777);
const pg = new EmbeddedPostgres({ databaseDir: join(work, "pg"), user: "postgres", password: "postgres", port: PORT, persistent: false, initdbFlags: ["--encoding=UTF8", "--locale=C"], onLog: () => undefined, onError: () => undefined });
await pg.initialise(); await pg.start();

const bin = join(work, "bin"); mkdirSync(bin); symlinkSync(join(ROOT, "deploy", "test", "fake-docker"), join(bin, "docker"));
const state = join(work, "state"); mkdirSync(state);
const LOG = join(work, "docker.log");
const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_LOG: LOG, FAKE_STATE: state, FAKE_PGPORT: String(PORT), PW_HUB, PW_ONE, HEALTH_TRIES: "2" };
const sh = (cmd, input) => { const r = spawnSync("bash", ["-c", cmd], { env, encoding: "utf8", input: input ?? "", timeout: 60000 }); if (process.env.DEBUG) console.log("$", cmd, "→", r.status, (r.stdout + r.stderr).slice(-300)); return r; };
const psql = (sql, db = "postgres", user = "postgres") => spawnSync("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", user, "-d", db, "-tAqc", sql], { env: { ...env, PGPASSWORD: user === "postgres" ? "postgres" : user === "hub" ? PW_HUB : PW_ONE }, encoding: "utf8", timeout: 20000 });
const flag = (f, on) => { const p = join(state, f); if (on) writeFileSync(p, on === true ? "" : String(on)); else rmSync(p, { force: true }); };

// fresh /opt/hangkh with the server files
rmSync("/opt/hangkh", { recursive: true, force: true });
mkdirSync("/opt/hangkh/bin", { recursive: true });
for (const f of ["compose.yml", "Caddyfile", "pg-init.sh"]) cpSync(join(ROOT, "deploy/server", f), `/opt/hangkh/${f}`);
for (const f of readdirSync(join(ROOT, "deploy/server/bin"))) cpSync(join(ROOT, "deploy/server/bin", f), `/opt/hangkh/bin/${f}`);
sh("chmod +x /opt/hangkh/bin/* /opt/hangkh/pg-init.sh");

// T1 first install: no volume → skipped, exit 0
let r = sh("/opt/hangkh/bin/backup.sh");
check("backup: first install (no volume) → skipped, exit 0", r.status === 0 && /skipped/.test(r.stdout), r.stdout.trim());

// pg-init.sh itself against the real server
r = sh(`POSTGRES_USER=postgres PGHOST=127.0.0.1 PGPORT=${PORT} PGPASSWORD=postgres DB_PASSWORD_HUB=${PW_HUB} DB_PASSWORD_ONETEAM=${PW_ONE} bash /opt/hangkh/pg-init.sh`);
check("pg-init.sh: creates hub + shop_oneteam (UTF8, template0)", r.status === 0, (r.stderr || r.stdout).trim().slice(0, 200));
check("pg-init.sh: other roles cannot CONNECT", psql("select has_database_privilege('hub', 'shop_oneteam', 'CONNECT')").stdout.trim() === "f");
flag("volume", true);

// T2 backup of an EMPTY new database (hub deployed first, shop not yet) must still pass
r = sh("/opt/hangkh/bin/backup.sh shop_oneteam");
check("backup: empty new database → valid dump (no size guess)", r.status === 0 && /backup: backups\/shop_oneteam-/.test(r.stdout), (r.stdout + r.stderr).trim().slice(-200));

// data: hub schema (as role hub) + one shop
const hubSql = readFileSync(join(ROOT, "apps/server/src/migrations_hub/0001_hub.sql"), "utf8");
let m = spawnSync("psql", ["-h", "127.0.0.1", "-p", String(PORT), "-U", "hub", "-d", "hub", "-v", "ON_ERROR_STOP=1", "-q"], { input: hubSql, env: { ...env, PGPASSWORD: PW_HUB }, encoding: "utf8" });
check("hub migration runs as the NON-superuser role hub", m.status === 0, m.stderr.slice(0, 200));
psql("insert into hub_shops (code, name, internal_url) values ('ONETEAM', 'Original name', 'http://x:3000')", "hub", "hub");

// T3 all DBs
sh("rm -f /opt/hangkh/backups/*");
r = sh("/opt/hangkh/bin/backup.sh");
const files = readdirSync("/opt/hangkh/backups").filter((f) => f.endsWith(".sql.gz"));
check("backup: default = hub + shop_oneteam, 2 files", r.status === 0 && files.length === 2, files.join(", "));

// T4 postgres exec fails → FAILED (R3), not "skipped"
flag("pg_broken", true); r = sh("/opt/hangkh/bin/backup.sh hub"); flag("pg_broken", false);
check("backup: postgres query fails → exit 1 (R3)", r.status !== 0 && /FAILED/.test(r.stdout), r.stdout.trim());
flag("pg_down", true); r = sh("/opt/hangkh/bin/backup.sh hub"); flag("pg_down", false);
check("backup: postgres container down but data exists → exit 1", r.status !== 0);
check("backup: no *.tmp left behind (R4)", readdirSync("/opt/hangkh/backups").every((f) => !f.endsWith(".tmp")));

// T5 restore: change data, restore the backup → original data back, old DB kept, revoke kept, app stopped + started
psql("update hub_shops set name = 'CHANGED'", "hub", "hub");
const hubFile = "backups/" + files.find((f) => f.startsWith("hub-"));
writeFileSync(LOG, "");
r = sh(`cd /opt/hangkh && bin/restore.sh ${hubFile}`, "YES\n");
check("restore: exit 0", r.status === 0, (r.stdout + r.stderr).trim().slice(-300));
check("restore: data back to the backup", psql("select name from hub_shops", "hub", "hub").stdout.trim() === "Original name");
check("restore: previous database kept as hub_before_*", /hub_before_\d{8}_\d{4}/.test(psql("select string_agg(datname, ',') from pg_database").stdout));
check("restore: owner = hub, other roles cannot CONNECT (R2)", psql("select pg_get_userbyid(datdba) from pg_database where datname = 'hub'").stdout.trim() === "hub" && psql("select has_database_privilege('oneteam', 'hub', 'CONNECT')").stdout.trim() === "f");
const log = readFileSync(LOG, "utf8");
check("restore: app-hub stopped then started", log.indexOf("stop app-hub") > -1 && log.indexOf("start app-hub") > log.indexOf("stop app-hub"));
psql("insert into hub_message_log (direction, kind) values ('in', 't')", "hub", "hub");
check("restore: append-only trigger still active after restore", /APPEND_ONLY/.test(psql("delete from hub_message_log", "hub", "hub").stderr));

// T6 corrupt file → nothing changes
writeFileSync("/opt/hangkh/backups/hub-2026-01-01_0000.sql.gz", "not gzip");
r = sh("cd /opt/hangkh && bin/restore.sh backups/hub-2026-01-01_0000.sql.gz", "YES\n");
check("restore: corrupt file refused, data unchanged", r.status !== 0 && psql("select name from hub_shops", "hub", "hub").stdout.trim() === "Original name");

// ---- remote-deploy.sh ----
const stage = (marker) => { rmSync("/opt/hangkh/.incoming", { recursive: true, force: true }); cpSync(join(ROOT, "deploy/server"), "/opt/hangkh/.incoming", { recursive: true });
  if (marker) writeFileSync("/opt/hangkh/.incoming/compose.yml", readFileSync("/opt/hangkh/.incoming/compose.yml", "utf8") + `\n# ${marker}\n`); sh("chmod +x /opt/hangkh/.incoming/bin/*"); };
const images = () => readFileSync("/opt/hangkh/images.env", "utf8").trim().split("\n").sort().join(" ");
rmSync("/opt/hangkh/images.env", { force: true });
stage("v1");
r = sh("bash /opt/hangkh/.incoming/bin/remote-deploy.sh all aaa");
check("remote-deploy: first deploy all → both tags", r.status === 0 && images() === "IMAGE_HUB=hangkh/app:aaa IMAGE_ONETEAM=hangkh/app:aaa", images());
check("remote-deploy: new server files installed, .incoming removed", readFileSync("/opt/hangkh/compose.yml", "utf8").includes("# v1") && !existsSync("/opt/hangkh/.incoming"));
stage("v2");
r = sh("bash /opt/hangkh/.incoming/bin/remote-deploy.sh oneteam bbb");
check("remote-deploy: oneteam only → IMAGE_ONETEAM=bbb, hub unchanged", r.status === 0 && images() === "IMAGE_HUB=hangkh/app:aaa IMAGE_ONETEAM=hangkh/app:bbb", images());
stage("v3-broken"); flag("unhealthy_tag", "ccc");
r = sh("bash /opt/hangkh/.incoming/bin/remote-deploy.sh oneteam ccc");
check("remote-deploy: unhealthy → exit 1 + ROLLBACK", r.status !== 0 && /ROLLBACK/.test(r.stdout), r.stdout.split("\n").filter((l) => l.startsWith("!!") || l.startsWith("==>")).join(" | "));
check("remote-deploy: previous image back (bbb) and healthy again", images() === "IMAGE_HUB=hangkh/app:aaa IMAGE_ONETEAM=hangkh/app:bbb" && /healthy again/.test(r.stdout));
check("remote-deploy: previous server files back (R10)", readFileSync("/opt/hangkh/compose.yml", "utf8").includes("# v2") && !readFileSync("/opt/hangkh/compose.yml", "utf8").includes("v3-broken"));
// first deploy that fails: nothing to roll back → service stopped
rmSync("/opt/hangkh/images.env"); writeFileSync(LOG, ""); stage("first-bad");
r = sh("bash /opt/hangkh/.incoming/bin/remote-deploy.sh hub ccc");
check("remote-deploy: failed FIRST deploy → service stopped (R11)", r.status !== 0 && readFileSync(LOG, "utf8").includes("stop app-hub"));
flag("unhealthy_tag", false);

await pg.stop(); rmSync(work, { recursive: true, force: true }); rmSync("/opt/hangkh", { recursive: true, force: true });
steps.print("SERVER SCRIPTS (backup · restore · remote-deploy) — real PostgreSQL 16, fake docker");
process.exit(steps.failed() ? 1 : 0);
