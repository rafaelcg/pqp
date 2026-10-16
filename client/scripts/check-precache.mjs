#!/usr/bin/env node
/**
 * Fails when any URL the built service worker precaches does not answer 200 on
 * a deployed origin, redirects followed.
 *
 *   node client/scripts/check-precache.mjs https://<deployment>.pqp-3yr.pages.dev [client/dist/sw.js]
 *
 * One non-200 precache entry fails the worker's whole install, so the new
 * worker is thrown away on every deploy, in every browser, with nothing on the
 * page to say so. From 2026-09-30 to 2026-10-10 three standalone pages did
 * exactly that: Pages redirected `/x.html` to `/x` and the edge middleware
 * answered `/x` with a 404. Only the real origin has Pages' pretty URLs and the
 * middleware together, so this runs after the deploy (`deploy-web.yml`).
 *
 * A fresh deployment does not answer for every file at once (2026-10-12: two
 * runs failed on 404s that were all 200 a minute later, every file being in
 * dist). Entries that fail are re-checked every 10 s for up to 120 s before
 * they count (`PRECACHE_RETRY_WINDOW_S`, `PRECACHE_RETRY_INTERVAL_S`; a window
 * of 0 means no retry). What still fails after that fails the gate, and the
 * output says whether the file is in dist. See `precache-retry.mjs`.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_WINDOW_MS,
  checkWithRetry,
} from "./precache-retry.mjs";

const origin = process.argv[2]?.replace(/\/+$/, "");
const swPath = process.argv[3]
  ? resolve(process.argv[3])
  : fileURLToPath(new URL("../dist/sw.js", import.meta.url));
if (!origin) {
  console.error("usage: check-precache.mjs <origin> [path/to/sw.js]");
  process.exit(2);
}

const sw = readFileSync(swPath, "utf8");
const urls = [...sw.matchAll(/\{url:"([^"]+)",revision:/g)].map((m) => m[1]);
if (urls.length === 0) {
  console.error("No precache entries found in sw.js: the manifest format changed.");
  process.exit(1);
}

function envMs(name, fallbackMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallbackMs;
  const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : fallbackMs;
}

async function status(path) {
  try {
    return (
      await fetch(`${origin}/${path}`, { redirect: "follow", cache: "no-store" })
    ).status;
  } catch (error) {
    return String(error?.cause?.code ?? error);
  }
}

const { failed, recovered, attempts, elapsedMs, firstFailures } =
  await checkWithRetry({
    paths: urls,
    statusOf: status,
    windowMs: envMs("PRECACHE_RETRY_WINDOW_S", DEFAULT_WINDOW_MS),
    intervalMs: envMs("PRECACHE_RETRY_INTERVAL_S", DEFAULT_INTERVAL_MS),
    log: (line) => console.log(line),
  });
const seconds = Math.round(elapsedMs / 1000);

if (failed.size > 0) {
  console.error(
    `${failed.size} of ${urls.length} precache entries still do not answer 200 on ${origin}` +
      ` after ${seconds}s and ${attempts} checks (${recovered} of ${firstFailures} first failures recovered).` +
      " The service worker cannot install until they do:",
  );
  for (const [path, code] of failed) {
    // Tells "not propagated" from "not built": a file missing from dist is a
    // build defect, a file in dist that the origin will not serve is the edge.
    const built = existsSync(resolve(swPath, "..", path.split("?")[0]))
      ? "in dist"
      : "NOT in dist";
    console.error(`  ${path} ${code} (${built})`);
  }
  process.exit(1);
}
if (recovered > 0) {
  console.log(
    `${recovered} of ${urls.length} entries were not 200 on the first check and answered 200 after ${seconds}s (deploy propagation).`,
  );
}
console.log(`All ${urls.length} precache entries answer 200 on ${origin}.`);
