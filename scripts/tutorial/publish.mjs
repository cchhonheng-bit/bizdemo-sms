// Tutorial videos → the server's guide folder /opt/hangkh/guide/<Position>/ (D-128), read (read-only) by the shop for the
// all-guide page /app/all_guide. Sends only files that are new or changed (size); --prune also removes server files that are no
// longer in Doc_Sup/09_Tutorials. Nothing else on the server is touched.
//   node publish.mjs [--prune]          (TUTORIAL_SSH=hangkh443 on port-22-blocked networks)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../.."), SSH = process.env.TUTORIAL_SSH || "hangkh";
const SRC = join(ROOT, "Doc_Sup/09_Tutorials"), DEST = "/opt/hangkh/guide";
const FOLDERS = ["Technician", "Admin_GM", "CEO_CFO", "Accounting", "Customer"];

const local = new Map();
for (const f of FOLDERS) {
  const dir = join(SRC, f);
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (n.endsWith(".mp4")) local.set(`${f}/${n}`, statSync(join(dir, n)).size);
}
const listing = execFileSync("ssh", [SSH, `mkdir -p ${DEST} && cd ${DEST} && find . -type f -name '*.mp4' -printf '%P %s\\n'`]).toString().trim();
const remote = new Map(listing.split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf(" "); return [l.slice(0, i), Number(l.slice(i + 1))]; }));
const send = [...local].filter(([p, size]) => remote.get(p) !== size).map(([p]) => p);
if (send.length) await new Promise((res, rej) => {
  const tar = spawn("tar", ["-cf", "-", "-C", SRC, ...send]), ssh = spawn("ssh", [SSH, `tar -xf - -C ${DEST} && chmod -R a+rX ${DEST}`]);
  tar.stdout.pipe(ssh.stdin);
  ssh.on("close", (code) => (code === 0 ? res() : rej(new Error(`upload failed (${code})`))));
});
const gone = process.argv.includes("--prune") ? [...remote.keys()].filter((p) => !local.has(p)) : [];
if (gone.length) execFileSync("ssh", [SSH, `cd ${DEST} && rm -f -- ${gone.map((p) => `'${p.replace(/'/g, "")}'`).join(" ")}`]);
console.log(`${local.size} videos here · sent ${send.length}${send.length ? `: ${send.join(", ")}` : ""}${gone.length ? ` · removed: ${gone.join(", ")}` : ""}`);
