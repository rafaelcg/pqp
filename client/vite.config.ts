import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";
import path from "node:path";
import { execSync } from "node:child_process";
import faroUploader from "@grafana/faro-rollup-plugin";
import { googleAds } from "./src/lib/google-ads-tag";
import { NAVIGATE_DENYLIST, swBuildScript } from "./src/lib/sw-build-script";

/**
 * Build-time source-map upload to Grafana Faro, so a production stack trace is
 * de-obfuscated (`App-Db_vfGSK.js:852` becomes a real file and line) instead of
 * pointing at a minified chunk.
 *
 * OFF UNLESS FULLY CONFIGURED, and it never fails the build when it is not. The
 * upload needs four values from the Faro app's "Source maps" settings page:
 * `FARO_SOURCEMAP_API_KEY` (a CI secret — see `docs/MONITORING.md` and
 * `.github/workflows/deploy-web.yml`), plus `FARO_SOURCEMAP_ENDPOINT`,
 * `FARO_SOURCEMAP_APP_ID` and `FARO_SOURCEMAP_STACK_ID`. With the API key unset
 * this returns null and nothing is generated or uploaded; with the key set but
 * a companion missing it prints one line and still skips, rather than throwing
 * during a deploy. `appName` follows `VITE_FARO_APP_NAME` so the maps land under
 * the same app the runtime SDK reports to (`src/lib/faro.ts`).
 */
function faroSourceMaps(): Plugin | null {
  const apiKey = process.env.FARO_SOURCEMAP_API_KEY?.trim();
  if (!apiKey) {
    return null;
  }
  const endpoint = process.env.FARO_SOURCEMAP_ENDPOINT?.trim();
  const appId = process.env.FARO_SOURCEMAP_APP_ID?.trim();
  const stackId = process.env.FARO_SOURCEMAP_STACK_ID?.trim();
  if (!endpoint || !appId || !stackId) {
    console.warn(
      "[faro] FARO_SOURCEMAP_API_KEY is set but FARO_SOURCEMAP_ENDPOINT / _APP_ID / _STACK_ID are not — skipping source-map upload.",
    );
    return null;
  }
  return faroUploader({
    appName: process.env.VITE_FARO_APP_NAME?.trim() || "pqp-web",
    endpoint,
    appId,
    stackId,
    apiKey,
    gzipContents: true,
  }) as unknown as Plugin;
}

// Computed once: it also decides whether Vite emits source maps at all. `hidden`
// generates them for the uploader to read and send, then does NOT reference them
// from the shipped bundles, so the `.map` files are not served to the public.
const faroSourcemapPlugin = faroSourceMaps();

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
 * WHICH BUILD IS THIS, stated twice by the same build: baked into the bundle
 * (`__PQP_BUILD_ID__`, `__PQP_BUILD_TIME__`, read through `src/lib/build-info.ts`)
 * and written beside it as `/version.json`.
 *
 * A running page compares the first to a fresh read of the second. That is how a
 * window that has been open for a week finds out it is a week old, which nothing
 * in the service worker's own update check can tell it: the worker only looks
 * when the page navigates, and an always-open window (the desktop app, a pinned
 * tab) never does. See `src/lib/version-watch.ts` and `docs/PWA.md`.
 *
 * The id is the deployed commit. CI already passes it as `VITE_FARO_APP_VERSION`
 * (so a Faro stack trace and this agree on what "the release" is);
 * `VITE_PQP_BUILD_ID` overrides it (the stale-bundle e2e builds two of these from
 * one tree), and a local build falls back to the current commit, then to "dev",
 * which the client reads as "never compare me".
 */
function resolveBuildId(): string {
  const fromEnv =
    process.env.VITE_PQP_BUILD_ID?.trim() ||
    process.env.VITE_FARO_APP_VERSION?.trim();
  if (fromEnv) {
    return fromEnv;
  }
  try {
    return execSync("git rev-parse HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const BUILD_ID = resolveBuildId();
const BUILD_TIME = Date.now();

/**
 * The service worker's own build stamp, a script the worker imports. It gives
 * the page a way to ask "which build are YOU?" (`PQP_BUILD` message, answered
 * below), which is what lets `src/lib/apply-update.ts` tell a worker that is
 * current from one that only looks idle: a stale `sw.js` served by a CDN finds
 * nothing to install, and from the page that is indistinguishable from "already
 * up to date" without this. The name carries the build so the URL changes with
 * it and no cache can hand back another build's stamp.
 */
/**
 * TEST ONLY: `PQP_TEST_LEGACY_WORKER=1` builds the worker the way it was before
 * this existed (waits instead of taking over, no network-first navigation), so
 * the stale-bundle e2e can stand up "a person on the old worker, then the fix is
 * deployed". Never set in CI deploys.
 */
const LEGACY_WORKER = process.env.PQP_TEST_LEGACY_WORKER === "1";

const SW_BUILD_FILE = `sw-build-${BUILD_ID.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16) || "dev"}.js`;

function versionManifest(): Plugin {
  return {
    name: "pqp-version-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: JSON.stringify({ build: BUILD_ID, builtAt: BUILD_TIME }),
      });
      this.emitFile({
        type: "asset",
        fileName: SW_BUILD_FILE,
        source: swBuildScript(BUILD_ID, { navigation: !LEGACY_WORKER }),
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

export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    edgeConfig(),
    versionManifest(),
    umami(),
    // Same gate as Umami above, same reason. See `src/lib/google-ads-tag.ts`;
    // it lives under `src/` so `vitest` can prove the gate holds.
    googleAds(process.env),
    // Uploads source maps to Faro when fully configured; null (skipped) here
    // otherwise, so a self-host or an unconfigured CI build carries no upload.
    ...(faroSourcemapPlugin ? [faroSourcemapPlugin] : []),
    tailwindcss(),
    VitePWA({
      // `prompt`: the PAGE is never reloaded behind the user's back by the
      // plugin. This client holds live WebSocket state, unsent drafts and
      // possibly a call, so the moment to reload is chosen in
      // `src/lib/update-policy.ts`, not by the plugin's `autoUpdate` reload.
      //
      // That is the page. The WORKER is a different thing and is told below to
      // take over as soon as it is installed (`skipWaiting` + `clientsClaim`).
      // Before, a new worker sat WAITING for every window of the origin to close,
      // and until it took over, a plain reload was answered from the OLD
      // precache: three reloads in a row served the previous bundle
      // (reproduced in `e2e/stale-bundle/`). An always-open desktop window never
      // closes, so it was stranded for as long as it lived.
      registerType: "prompt",
      // The marketing pages are prerendered-ish static routes people may reach
      // first; `/app` is the thing worth installing.
      includeAssets: ["icons/*.png", "robots.txt"],
      manifest: {
        name: "pqp",
        short_name: "pqp",
        // The site's default language is Portuguese (`landing.seo.*`), and a
        // manifest is one static file, so it says the same thing the default
        // head does.
        lang: "pt-BR",
        description:
          "Voz, tela compartilhada e chat pra sua galera. De graça e de código aberto.",
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
        // The RNNoise worklet is a `.js` file and would otherwise be swept
        // into the shell precache, which is 63 kB downloaded by every install
        // for a setting almost nobody turns on — and useless besides, since
        // the wasm beside it is not a `.js` and is never precached, so the
        // advanced suppressor could not start offline either way. It is
        // fetched on demand, like the wasm.
        globIgnores: ["**/workletProcessor-*.js", "**/sw-build-*.js"],
        // Vite emits hashed chunks and the emoji-data chunk is large; the
        // default 2 MiB ceiling silently drops files past it.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        // Workbox's own navigation route (precached shell for every navigation)
        // is OFF, and the network-first handler in the imported `sw-build-*.js`
        // (`src/lib/sw-build-script.ts`) does that job with the shell as its
        // fallback. Two fetch listeners that both call `respondWith` on the same
        // navigation make the second throw `InvalidStateError`, so exactly one
        // may handle it. Only the legacy e2e fixture, which stands in for a
        // worker from before the handler existed, keeps Workbox's route.
        navigateFallback: LEGACY_WORKER ? "/index.html" : undefined,
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
        //
        // The machine-readable files are in here for a third reason: they are
        // real files, not routes, and a returning visitor with this worker
        // installed who opens /llms.txt or /.well-known/agent-skills/index.json
        // would otherwise be handed the SPA shell. Nothing that grades this
        // site runs a service worker, so this is for the human who clicks one
        // of these links.
        // The same list, `NAVIGATE_DENYLIST`, is what the network-first handler
        // leaves alone (`src/lib/sw-build-script.ts`).
        ...(LEGACY_WORKER ? { navigateFallbackDenylist: NAVIGATE_DENYLIST } : {}),
        cleanupOutdatedCaches: true,
        // See `registerType` above. Safe for the open tabs this swaps under
        // because the page keeps running the code it already loaded; the price
        // is that a lazy chunk an old tab has not fetched yet may be gone, and
        // `src/lib/chunk-reload.ts` already recovers from exactly that.
        skipWaiting: !LEGACY_WORKER,
        clientsClaim: !LEGACY_WORKER,
        // Adds the notificationclick handler. Android Chrome only permits
        // notifications raised from a worker, and their clicks arrive here
        // rather than in the page — without it, tapping one does nothing.
        importScripts: ["sw-notification-click.js", SW_BUILD_FILE],
      },
      devOptions: {
        // Off by default: a service worker in dev caches the very assets Vite
        // is trying to hot-reload. Flip on to test the install/update flow.
        enabled: false,
      },
    }),
  ],
  // Source maps are emitted only when the Faro uploader is active, and `hidden`
  // so the `.map` files are generated for upload without being served publicly.
  build: {
    sourcemap: faroSourcemapPlugin ? "hidden" : false,
  },
  define: {
    // `dev` under `vite dev`: a developer's own tab must never poll for, or be
    // told about, a deploy (`src/lib/build-info.ts`). Only a BUILD has an id.
    __PQP_BUILD_ID__: JSON.stringify(command === "build" ? BUILD_ID : "dev"),
    __PQP_BUILD_TIME__: String(BUILD_TIME),
  },
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
}));
