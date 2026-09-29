#!/usr/bin/env node
// backup-download.cmd: newest backup of every database on the server → ..\Backup\db (SSH key login).
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, capture, green, red, run } from "./lib/common.mjs";

const cfg = JSON.parse(readFileSync(join(ROOT, "deploy", "target.json"), "utf8"));
const SSH = `${cfg.user}@${cfg.host}`;
const OUT = resolve(ROOT, "..", "Backup", "db");
mkdirSync(OUT, { recursive: true });
let ok = 0;
for (const db of ["hub", "shop_oneteam"]) {
  const latest = capture(`ssh -o BatchMode=yes ${SSH} "ls -t ${cfg.dir}/backups/${db}-*.sql.gz 2>/dev/null | head -1"`).out;
  if (!latest) { console.log(red(`no backup found for ${db}`)); continue; }
  if (run(`scp -q ${SSH}:${latest} "${OUT}"`) === 0) { ok++; console.log(green(`${db}: ${latest.split("/").pop()} → ${OUT}`)); }
}
process.exit(ok ? 0 : 1);
