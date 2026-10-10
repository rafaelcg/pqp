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
 * A deploy can take a few seconds to answer for every file, so failures are
 * checked again in a few rounds before they count.
 */
import { readFileSync } from "node:fs";

const origin = process.argv[2]?.replace(/\/+$/, "");
const swPath = process.argv[3] ?? new URL("../dist/sw.js", import.meta.url);
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

const CONCURRENCY = 8;
const ROUNDS = 5;
const ROUND_PAUSE_MS = 3000;

async function status(url) {
  try {
    return (await fetch(url, { redirect: "follow", cache: "no-store" })).status;
  } catch (error) {
    return String(error?.cause?.code ?? error);
  }
}

/** Every path's status, at most `CONCURRENCY` requests at once. */
async function check(paths) {
  const results = new Map();
  let next = 0;
  async function lane() {
    while (next < paths.length) {
      const path = paths[next++];
      results.set(path, await status(`${origin}/${path}`));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, lane));
  return results;
}

// Rounds, not per-URL retries: a deploy that is still propagating makes many
// files fail at once, and one shared pause covers them all.
let pending = urls;
let results = new Map();
for (let round = 0; round < ROUNDS && pending.length > 0; round += 1) {
  if (round > 0) {
    await new Promise((resolve) => setTimeout(resolve, ROUND_PAUSE_MS));
  }
  results = await check(pending);
  pending = pending.filter((path) => results.get(path) !== 200);
}
const failed = pending.map((path) => `${path} ${results.get(path)}`);

if (failed.length > 0) {
  console.error(
    `${failed.length} of ${urls.length} precache entries do not answer 200 on ${origin}.` +
      " The service worker cannot install until they do:",
  );
  for (const line of failed) {
    console.error(`  ${line}`);
  }
  process.exit(1);
}
console.log(`All ${urls.length} precache entries answer 200 on ${origin}.`);
