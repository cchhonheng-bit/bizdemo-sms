import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

// v2 (D-43): the web app is served by the same Node app that serves /api. In `dev.cmd` vite proxies /api → server.
const APP_NAME = process.env.VITE_APP_NAME ?? "One Team Service";
const APP_SHORT = process.env.VITE_APP_SHORT ?? "One Team";
const API = process.env.API_URL ?? "http://localhost:3000";

export default defineConfig({
  // D-96: "/" is the shop's public website; the staff app, its manifest and its service worker live under /app/
  base: "/app/",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.png", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"],
      manifest: {
        name: APP_NAME,
        short_name: APP_SHORT,
        description: "ប្រព័ន្ធគ្រប់គ្រងសេវាកម្ម",
        lang: "km",
        theme_color: "#14213D",
        background_color: "#F4F6FB",
        display: "standalone",
        id: "/app/",
        start_url: "/app/",
        scope: "/app/",
        // absolute: the same manifest is also answered at the old address /manifest.webmanifest for apps installed before D-96
        icons: [
          { src: "/app/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/app/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2,ttf}"],
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/") && !url.pathname.startsWith("/api/auth/"),
            handler: "NetworkFirst",
            options: { cacheName: "api", networkTimeoutSeconds: 8, expiration: { maxEntries: 200, maxAgeSeconds: 3600 } },
          },
        ],
      },
    }),
  ],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  server: { port: 5173, proxy: { "/api": { target: API, changeOrigin: false }, "/healthz": API } },
  build: { target: "es2022", sourcemap: false },
});
