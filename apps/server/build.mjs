// Bundles the server (incl. the workspace package @sms/shared) into one ESM file; npm dependencies stay external.
import { build } from "esbuild";
import { cpSync, mkdirSync, readFileSync } from "node:fs";
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const external = Object.keys(pkg.dependencies).filter((d) => !d.startsWith("@sms/"));
await build({
  entryPoints: ["src/index.ts", "src/cli.ts"],
  bundle: true, platform: "node", format: "esm", target: "node22", outdir: "dist", outExtension: { ".js": ".mjs" },
  external, sourcemap: false, logLevel: "info",
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
mkdirSync("dist/migrations", { recursive: true });
cpSync("src/migrations", "dist/migrations", { recursive: true });
mkdirSync("dist/migrations_hub", { recursive: true });
cpSync("src/migrations_hub", "dist/migrations_hub", { recursive: true });
mkdirSync("dist/brand", { recursive: true });
cpSync("brand", "dist/brand", { recursive: true });
