#!/usr/bin/env node
// Backup (D-37): git bundle (full history, all branches + tags) + zip of the working tree
// (tracked + untracked, but NOT gitignored files → no node_modules, no .env*.local secrets).
// Then pushes to GitHub (backup remote) unless --no-push. Keeps the newest 30 of each file type.
// Usage: node scripts/backup.mjs [--no-push] [--dir <folder>]     default folder: ..\Backup
import { deflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ROOT, Steps, capture, green, red, run, stamp, yellow } from "./lib/common.mjs";

const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const OUT = resolve(di >= 0 && args[di + 1] ? args[di + 1] : join(ROOT, "..", "Backup"));
const KEEP = 30;
const steps = new Steps();
const ts = stamp();

if (capture("git rev-parse --is-inside-work-tree").out !== "true") {
  console.log(red("Source is not a git repository yet — run scripts\\init-local-git.cmd once (SETUP_LOCAL.md step 3)."));
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

// 1) uncommitted work is included in the zip, but warn — it is not in the bundle / GitHub
const dirty = capture("git status --porcelain").out;
if (dirty) console.log(yellow(`Uncommitted changes (${dirty.split(/\r?\n/).length} files) — they go into the zip only. Use save.cmd to commit.`));

// 2) git bundle
const bundle = join(OUT, `bizdemo-sms_${ts}.bundle`);
if (run(`git bundle create "${bundle}" --all`) === 0 && capture(`git bundle verify "${bundle}"`).code === 0) steps.add("Git bundle (full history)", "PASS", bundle);
else steps.add("Git bundle (full history)", "FAIL");

// 3) zip of the working tree (minimal ZIP writer, deflate, no dependencies)
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function zip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const { name, data } of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const comp = deflateRawSync(data);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(dosTime, 12); cen.writeUInt16LE(dosDate, 14); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28); cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}
try {
  const list = capture("git ls-files -co --exclude-standard").out.split(/\r?\n/).filter(Boolean);
  const files = [];
  for (const f of list) {
    try {
      if (/(^|\/)\.env(\.[^/]+)?\.local$/.test(f)) continue; // never put secrets in a backup
      files.push({ name: `Source/${f}`, data: readFileSync(join(ROOT, f)) });
    } catch {
      /* deleted but not committed */
    }
  }
  const zipPath = join(OUT, `Source_${ts}.zip`);
  writeFileSync(zipPath, zip(files));
  steps.add("Zip of working tree (no node_modules, no .env*.local)", "PASS", `${files.length} files → ${zipPath}`);
} catch (e) {
  steps.add("Zip of working tree", "FAIL", String(e.message || e));
}

// 4) retention
for (const [prefix, ext] of [["bizdemo-sms_", ".bundle"], ["Source_", ".zip"]]) {
  const old = readdirSync(OUT).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort().reverse().slice(KEEP);
  for (const f of old) rmSync(join(OUT, f));
}

// 5) GitHub = backup remote only (no Actions)
if (args.includes("--no-push")) steps.add("Push to GitHub (backup)", "SKIP", "--no-push");
else if (capture("git remote get-url origin").code !== 0) steps.add("Push to GitHub (backup)", "SKIP", "no 'origin' remote");
else {
  const a = run("git push origin --all");
  const b = a === 0 ? run("git push origin --tags") : 1;
  steps.add("Push to GitHub (backup)", a === 0 && b === 0 ? "PASS" : "FAIL", a === 0 && b === 0 ? "all branches + tags" : "local backup is still OK — check internet / GitHub login");
}

const size = (p) => { try { return (statSync(p).size / 1024).toFixed(0) + " KB"; } catch { return "?"; } };
steps.print(steps.failed() ? "BACKUP — WITH ERRORS" : "BACKUP OK");
console.log(`  Folder: ${OUT}  ·  bundle ${size(bundle)}`);
console.log(`  Restore: git clone "${bundle}" bizdemo-sms-restored`);
process.exit(steps.failed() ? 1 : 0);
