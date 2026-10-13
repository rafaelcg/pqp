#!/usr/bin/env node
/**
 * Writes `dist/changes.json`: what changed in the web client, for the update
 * popover (`src/lib/update-changes.ts`). Run by `deploy-web.yml` after the
 * build and before the deploy.
 *
 *   node client/scripts/build-changes.mjs [--out client/dist/changes.json] [--live https://pqp.gg]
 *
 * It asks the live site which build it is serving (`/version.json`) and what it
 * already lists (`/changes.json`), reads the merged work that touched the client
 * since that build from git, and writes the two together (`changes-lib.mjs`).
 *
 * NEVER FAILS THE DEPLOY. Everything here is a nicety; a network error, a
 * history too shallow to contain the live build, a first run with nothing live
 * to read: each is logged and the script exits 0, writing what it has (or
 * nothing). The popover then has no list, which it is built for.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOG_FORMAT, mergeChanges, parseLog } from "./changes-lib.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PATHS = [
  "client/src",
  "client/public",
  "client/index.html",
  ":!*.test.ts",
  ":!*.test.tsx",
];

function flag(name, fallback) {
  const at = process.argv.indexOf(name);
  return at >= 0 && process.argv[at + 1] ? process.argv[at + 1] : fallback;
}

const out = resolve(process.cwd(), flag("--out", "client/dist/changes.json"));
const live = flag("--live", "https://pqp.gg").replace(/\/+$/, "");

function git(args) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function getJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function main() {
  const [version, previous] = await Promise.all([
    getJson(`${live}/version.json`),
    getJson(`${live}/changes.json`),
  ]);
  const liveBuild = typeof version?.build === "string" ? version.build : null;

  let known = false;
  if (liveBuild && /^[0-9a-f]{7,40}$/i.test(liveBuild)) {
    try {
      git(["cat-file", "-e", `${liveBuild}^{commit}`]);
      known = true;
    } catch {
      known = false;
    }
  }
  // When the live build is not in this history (a shallow checkout, a first
  // run) take the last twenty merges that touched the client: a pull request
  // already listed is replaced, not doubled, so reading too much is harmless.
  const range = known ? [`${liveBuild}..HEAD`] : ["-n", "20", "HEAD"];
  const log = git([
    "log",
    "--first-parent",
    `--format=${LOG_FORMAT}`,
    ...range,
    "--",
    ...PATHS,
  ]);
  const fresh = parseLog(log);
  const merged = mergeChanges(previous, fresh, Date.now());

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(merged));
  const withNote = merged.entries.filter((entry) => Object.keys(entry.note).length > 0);
  console.log(
    `changes.json: ${fresh.length} new since ${known ? liveBuild.slice(0, 8) : "(unknown live build)"}, ` +
      `${merged.entries.length} listed, ${withNote.length} with a note -> ${out}`,
  );
}

main().catch((error) => {
  console.log(`changes.json skipped: ${error?.message ?? error}`);
});
