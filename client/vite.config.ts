import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { googleAds } from "./src/lib/google-ads-tag";

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

/**
 * The Umami tag, injected only when this build was told which site it is.
 *
 * WHY THIS IS NOT JUST A `<script>` IN index.html. pqp is AGPL and meant to be
 * self-hosted, and `index.html` ships to every self-hoster. A hardcoded tag
 * would silently send *their* visitors' page views to *our* analytics account:
 * wrong on its own terms, and a flat contradiction of the pitch that you keep
 * your own keys. So the tag exists only when `VITE_UMAMI_WEBSITE_ID` is set,
 * which is only on the pqp.gg build.
 *
 * The website id is not a secret. It is visible in the page source of every
 * site running Umami, which is why it travels as a plain build var rather than
 * as a repository secret pretending otherwise.
 *
 * `VITE_UMAMI_SRC` exists so a self-hoster who wants their own Umami can point
 * at their own instance instead of Umami Cloud. Default is the hosted script.
 */
function umami(): Plugin {
  const websiteId = process.env.VITE_UMAMI_WEBSITE_ID?.trim();
  const src =
    process.env.VITE_UMAMI_SRC?.trim() || "https://cloud.umami.is/script.js";
  return {
    name: "pqp-umami",
    apply: "build",
    transformIndexHtml() {
      if (!websiteId) {
        return [];
      }
      return [
        {
          tag: "script",
          injectTo: "head",
          attrs: { defer: true, src, "data-website-id": websiteId },
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    edgeConfig(),
    umami(),
    // Same gate as Umami above, same reason. See `src/lib/google-ads-tag.ts`;
    // it lives under `src/` so `vitest` can prove the gate holds.
    googleAds(process.env),
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
        //
        // `/r/*` is in here for a different reason: those are the short
        // referral links, and they are not routes at all. They exist only to be
        // 302'd at the edge to `/?ref=...` by client/public/_redirects, which
        // is what puts the channel in the acquisition report. A returning
        // visitor already has this worker installed, so without the denylist
        // the navigation never reaches Cloudflare, the shell is served for
        // /r/x, the router matches nothing and drops the person on `/` with no
        // ref recorded. Verified happening in a real browser on 22 Aug 2026.
        navigateFallbackDenylist: [
          /^\/api\//,
          /^\/status\.json$/,
          /^\/ws/,
          /^\/r\//,
        ],
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
