#!/usr/bin/env node
/**
 * Builds the desktop share smoke page (`harness-page.ts` + `index.html`) into
 * a folder of static files, with Vite and the client's own `@` alias, the same
 * way the app's bundle is built. The output is served by the smoke test over
 * loopback and loaded by the packaged desktop app.
 *
 *   node client/e2e/desktop-share/build.mjs [outDir]
 *
 * Default outDir: `electron/test/share-smoke/.page` (git-ignored).
 *
 * An app build rather than a library build on purpose: the native share audio
 * worklet is imported with `?url`, and a library build would inline it as a
 * data URL where the app serves it as a file.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, "../..");
const outDir = path.resolve(
  process.argv[2] ?? path.join(client, "..", "electron", "test", "share-smoke", ".page"),
);

await build({
  root: here,
  base: "./",
  configFile: false,
  envFile: false,
  logLevel: "warn",
  define: {
    __PQP_BUILD_ID__: JSON.stringify("share-smoke"),
    __PQP_BUILD_TIME__: "0",
  },
  resolve: { alias: { "@": path.join(client, "src") } },
  build: {
    outDir,
    emptyOutDir: true,
    minify: false,
    target: "es2022",
    rollupOptions: { input: path.join(here, "index.html") },
  },
});

console.log(`share smoke page built into ${outDir}`);
