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
 * A deploy can take a few seconds to answer for every file, so each failure is
 * retried before it counts.
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

async function status(url) {
  for (let attempt = 0; ; attempt += 1) {
    let code;
    try {
      code = (await fetch(url, { redirect: "follow", cache: "no-store" })).status;
    } catch (error) {
      code = String(error?.cause?.code ?? error);
    }
    if (code === 200 || attempt === 4) {
      return code;
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
}

const failed = [];
for (const path of urls) {
  const code = await status(`${origin}/${path}`);
  if (code !== 200) {
    failed.push(`${path} ${code}`);
  }
}

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
