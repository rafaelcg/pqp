import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // `prompt`, never `autoUpdate`. This client holds live WebSocket state and
      // re-syncs history on reconnect, so swapping the shell out from under a
      // running session can leave a stale bundle talking to a newer API. The
      // user gets a toast and picks the moment.
      registerType: "prompt",
      // The marketing pages are prerendered-ish static routes people may reach
      // first; `/app` is the thing worth installing.
      includeAssets: ["icons/*.png", "robots.txt"],
      manifest: {
        name: "pqp — group chat you own",
        short_name: "pqp",
        description:
          "Discord-like voice and text chat. Self-host it or use the hosted service.",
        start_url: "/app",
        scope: "/",
        display: "standalone",
        orientation: "portrait-primary",
        background_color: "#090e12",
        theme_color: "#090e12",
        categories: ["social", "communication"],
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        shortcuts: [
          { name: "Open chat", url: "/app" },
          { name: "Direct messages", url: "/app/dm" },
        ],
      },
      workbox: {
        // The shell only. Everything dynamic — messages, avatars, uploads —
        // lives on a different origin in production and is deliberately not
        // cached: a chat app serving yesterday's messages from a cache is worse
        // than one that says it is offline.
        globPatterns: ["**/*.{js,css,html,woff2}"],
        // Vite emits hashed chunks and the emoji-data chunk is large; the
        // default 2 MiB ceiling silently drops files past it.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallback: "/index.html",
        // Anything the server answers must never be served from the shell
        // fallback — a navigation to /status.json or an API path is not a route.
        navigateFallbackDenylist: [/^\/api\//, /^\/status\.json$/, /^\/ws/],
        cleanupOutdatedCaches: true,
        // Adds the notificationclick handler. Android Chrome only permits
        // notifications raised from a worker, and their clicks arrive here
        // rather than in the page — without it, tapping one does nothing.
        importScripts: ["sw-notification-click.js"],
      },
      devOptions: {
        // Off by default: a service worker in dev caches the very assets Vite
        // is trying to hot-reload. Flip on to test the install/update flow.
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    port: 5173,
    allowedHosts: [".ngrok-free.app"],
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // Served next to /health rather than under /api (it must skip auth), so
      // it needs its own proxy entry or local dev cannot reach it at all.
      "/status.json": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});
