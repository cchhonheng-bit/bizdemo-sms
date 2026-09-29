import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";

// D-37: Local = TEST. `pnpm dev` reads ../../.env.test.local and REFUSES to start against PRODUCTION.
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WEB = fileURLToPath(new URL(".", import.meta.url));
const ENVS = JSON.parse(readFileSync(`${ROOT}environments.json`, "utf8")) as { prod: { projectRef: string; publishableKey: string }; test: { appName: string; appShort: string } };

function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const i = line.indexOf("=");
    if (!line || line.startsWith("#") || i < 1) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

function guardLocalDev(mode: string) {
  const t = readEnvFile(`${ROOT}.env.test.local`);
  if (t.SUPABASE_PROJECT_REF && !process.env.VITE_SUPABASE_URL) {
    process.env.VITE_SUPABASE_URL = `https://${t.SUPABASE_PROJECT_REF}.supabase.co`;
    process.env.VITE_SUPABASE_PUBLISHABLE_KEY ??= t.SUPABASE_PUBLISHABLE_KEY ?? "";
    process.env.VITE_TELEGRAM_BOT ??= t.TELEGRAM_BOT ?? "";
    process.env.VITE_APP_NAME ??= ENVS.test.appName;
    process.env.VITE_APP_SHORT ??= ENVS.test.appShort;
  }
  const fromProcess = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("VITE_"))) as Record<string, string>;
  const env = { ...loadEnv(mode, WEB, "VITE_"), ...fromProcess };
  const prodRef = ENVS.prod.projectRef.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (v && (v.toLowerCase().includes(prodRef) || v === ENVS.prod.publishableKey)) {
      throw new Error(`BLOCKED (D-37): local dev must never connect to PRODUCTION — ${k} points at ${ENVS.prod.projectRef}. Put the TEST project in .env.test.local (SETUP_LOCAL.md).`);
    }
  }
}

export default defineConfig(({ command, mode, isPreview }) => {
  if (command === "serve" && !isPreview) guardLocalDev(mode);
  const APP_NAME = process.env.VITE_APP_NAME ?? "BizDemo Service Manager";
  const APP_SHORT = process.env.VITE_APP_SHORT ?? "BizDemo";
  return {
    plugins: [
      react(),
      VitePWA({
        registerType: "autoUpdate",
        includeAssets: ["favicon.svg", "icons/icon-192.png", "icons/icon-512.png"],
        manifest: {
          name: APP_NAME,
          short_name: APP_SHORT,
          description: "ប្រព័ន្ធគ្រប់គ្រងសេវាកម្ម",
          lang: "km",
          theme_color: "#2E3A78",
          background_color: "#F4F6FB",
          display: "standalone",
          start_url: "/",
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          ],
        },
        workbox: {
          globPatterns: ["**/*.{js,css,html,svg,png,woff2,ttf}"],
          navigateFallbackDenylist: [/^\/functions\//, /^\/rest\//, /^\/auth\//],
          runtimeCaching: [
            {
              urlPattern: ({ url }) => url.hostname.endsWith("supabase.co") && url.pathname.startsWith("/rest/"),
              handler: "NetworkFirst",
              options: { cacheName: "api", networkTimeoutSeconds: 8, expiration: { maxEntries: 200, maxAgeSeconds: 3600 } },
            },
          ],
        },
      }),
    ],
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    server: { port: 5173 },
    build: { target: "es2022", sourcemap: false },
  };
});
