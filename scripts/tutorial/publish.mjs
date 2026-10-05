// Tutorial videos → the server's guide folder /opt/hangkh/guide/<Position>/ (D-128), read (read-only) by the shop for the
// all-guide page /app/all_guide and the «របៀបប្រើ» pages (D-129); the position PDFs (guide-pdf.mjs) → /opt/hangkh/guide/pdf/<tab>.pdf.
// Sends only files that are new or changed (size); --prune also removes videos that are no longer in Doc_Sup/09_Tutorials.
// Nothing else on the server is touched.
//   node publish.mjs [--prune]          (TUTORIAL_SSH=hangkh443 on port-22-blocked networks)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, "../../.."), SSH = process.env.TUTORIAL_SSH || "hangkh";
const SRC = join(ROOT, "Doc_Sup/09_Tutorials"), DEST = "/opt/hangkh/guide";
const FOLDERS = ["Technician", "Admin_GM", "CEO_CFO", "Accounting", "Customer"];
const GUIDES = join(ROOT, "Doc_Sup/08_Sales_Delivery/Guides");
const PDFS = { "Guide_Technician.pdf": "engineer", "Guide_Admin_GM.pdf": "admin", "Guide_CEO.pdf": "ceo", "Guide_CFO.pdf": "cfo", "Guide_Customer.pdf": "customer" };

const local = new Map();
for (const f of FOLDERS) {
  const dir = join(SRC, f);
  if (existsSync(dir)) for (const n of readdirSync(dir)) if (n.endsWith(".mp4")) local.set(`${f}/${n}`, statSync(join(dir, n)).size);
}
const listing = execFileSync("ssh", [SSH, `mkdir -p ${DEST} && cd ${DEST} && find . -type f \\( -name '*.mp4' -o -name '*.pdf' \\) -printf '%P %s\\n'`]).toString().trim();
const remote = new Map(listing.split("\n").filter(Boolean).map((l) => { const i = l.lastIndexOf(" "); return [l.slice(0, i), Number(l.slice(i + 1))]; }));
const send = [...local].filter(([p, size]) => remote.get(p) !== size).map(([p]) => p);
if (send.length) await new Promise((res, rej) => {
  const tar = spawn("tar", ["-cf", "-", "-C", SRC, ...send]), ssh = spawn("ssh", [SSH, `tar -xf - -C ${DEST} && chmod -R a+rX ${DEST}`]);
  tar.stdout.pipe(ssh.stdin);
  ssh.on("close", (code) => (code === 0 ? res() : rej(new Error(`upload failed (${code})`))));
});
const pdfs = [];
for (const [name, tab] of Object.entries(PDFS)) {
  const p = join(GUIDES, name);
  if (!existsSync(p) || remote.get(`pdf/${tab}.pdf`) === statSync(p).size) continue;
  execFileSync("ssh", [SSH, `mkdir -p ${DEST}/pdf && cat > ${DEST}/pdf/${tab}.pdf && chmod a+r ${DEST}/pdf/${tab}.pdf`], { input: readFileSync(p) });
  pdfs.push(tab);
}
const gone = process.argv.includes("--prune") ? [...remote.keys()].filter((p) => p.endsWith(".mp4") && !local.has(p)) : [];
if (gone.length) execFileSync("ssh", [SSH, `cd ${DEST} && rm -f -- ${gone.map((p) => `'${p.replace(/'/g, "")}'`).join(" ")}`]);
console.log(`${local.size} videos here · sent ${send.length}${send.length ? `: ${send.join(", ")}` : ""}${pdfs.length ? ` · PDFs: ${pdfs.join(", ")}` : ""}${gone.length ? ` · removed: ${gone.join(", ")}` : ""}`);
