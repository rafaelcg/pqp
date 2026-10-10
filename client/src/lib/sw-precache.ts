/**
 * What the service worker precaches, as data, so a test can read the same lists
 * the build does (`vite.config.ts` imports them; `sw-precache.test.ts` applies
 * them to `public/`).
 *
 * THE SHELL ONLY, AND ONE HTML FILE. `index.html` is the shell. Every other
 * `.html` is a file in `public/` that Cloudflare Pages serves at its own
 * address, which is NOT a precache-able 200:
 *
 *   - Pages answers `/x.html` with a 308 to `/x` (pretty URLs);
 *   - the edge middleware (`functions/_middleware.ts`) answers `GET /x` with a
 *     404 unless `spa-routes.ts` knows the path (`HEAD` is untouched, so
 *     `curl -I` looks fine).
 *
 * Workbox fetches every precache entry on install and fails the WHOLE install
 * on one that is not a 200. From 2026-09-30 to 2026-10-10 the glob swept
 * `share-diagnostic.html` and two siblings in, so no service worker installed
 * anywhere and no old one could update. See `docs/PWA.md`.
 */

/** `index.html` explicitly, and no other `.html` by omission. */
export const PRECACHE_GLOB_PATTERNS: string[] = [
  "**/*.{js,css,woff2}",
  "index.html",
];

export const PRECACHE_GLOB_IGNORES: string[] = [
  // The RNNoise worklet is a `.js` file and would otherwise be swept
  // into the shell precache, which is 63 kB downloaded by every install
  // for a setting almost nobody turns on — and useless besides, since
  // the wasm beside it is not a `.js` and is never precached, so the
  // advanced suppressor could not start offline either way. It is
  // fetched on demand, like the wasm.
  "**/workletProcessor-*.js",
  "**/sw-build-*.js",
  // The fonts are self-hosted (`src/fonts.css`), one file per unicode-range
  // subset. Only the Latin ones are the shell's: Vietnamese, Cyrillic and
  // Greek are fetched on demand like the RNNoise wasm, so the install does
  // not download files nobody on this site reads.
  "**/*-vietnamese-*.woff2",
  "**/*-cyrillic-*.woff2",
  "**/*-greek-*.woff2",
];
