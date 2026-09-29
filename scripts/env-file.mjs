#!/usr/bin/env node
// Create .env.test.local or .env.prod.local from its template with user-only permissions (D-37, SEC-L02).
// Usage: node scripts/env-file.mjs test|prod
import { ensureLocalEnv, yellow } from "./lib/common.mjs";

const kind = process.argv[2];
if (!["test", "prod"].includes(kind)) {
  console.log("usage: node scripts/env-file.mjs test|prod");
  process.exit(2);
}
if (!ensureLocalEnv(kind)) console.log(yellow(`.env.${kind}.local already exists — edit it in Notepad:  notepad .env.${kind}.local`));
