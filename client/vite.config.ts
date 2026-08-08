import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";

/**
 * `/edge-config.json` — the only thing the Cloudflare Pages middleware needs to
 * know, written by the build that already knows it.
 *
 * The middleware in `client/functions/` fetches a profile from the API so it can
 * put real Open Graph tags on `/@handle`. It runs at the edge, so it cannot read
 * `import.meta.env`, and asking an operator to also set `PQP_API_URL` in the
 * Pages dashboard is a second place for the API URL to live and therefore a
 * second place for it to be wrong. Emitting it as an asset means the middleware
 * and the SPA are pointed at the same API by construction, with no new secret
 * and no dashboard step.
 *
 * Empty when `VITE_API_URL` is unset (a self-host serving the SPA from the API's
 * own origin, or a local build). The middleware treats that as "no unfurl" and
 * serves the page unchanged, which is what it did before this existed.
 */
function edgeConfig(): Plugin {
  return {
    name: "pqp-edge-config",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "edge-config.json",
        source: JSON.stringify({ apiUrl: process.env.VITE_API_URL ?? "" }),
      });
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    edgeConfig(),
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
