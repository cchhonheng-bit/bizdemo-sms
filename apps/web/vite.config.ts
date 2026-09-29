import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath, URL } from "node:url";

const APP_NAME = process.env.VITE_APP_NAME ?? "BizDemo Service Manager";
const APP_SHORT = process.env.VITE_APP_SHORT ?? "BizDemo";

export default defineConfig({
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
});
