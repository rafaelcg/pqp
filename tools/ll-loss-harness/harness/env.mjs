// Shared plumbing for the harness's Node scripts (server.mjs, run.mjs,
// remux-ctl.mjs): reads .data/harness.env (written by scripts/gen-keys.sh,
// gitignored, never a production credential) and resolves the repo's
// already-installed hls.js and playwright-core packages from
// node_modules/.pnpm without hardcoding a version, so a future `pnpm
// install` does not silently break this harness.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const HARNESS_DIR = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
export const REPO_ROOT = path.resolve(HARNESS_DIR, "..", "..");

// Mirrors tools/watch-party-load's PROD_HOSTS guard (src/index.ts): this
// harness must never be able to reach the real pqp.gg SFU or API, no
// matter what an operator's shell happens to export. Every place this
// harness reads a host that will be dialed gets checked against this
// allowlist -- refuse first, not a blocklist of one bad case.
const ALLOWED_HARNESS_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "livekit"]);

export function assertLocalHost(host, label) {
  const h = String(host).toLowerCase();
  if (h.endsWith(".pqp.gg") || h === "pqp.gg") {
    throw new Error(`refusing ${label}=${host}: production hosts (*.pqp.gg) are forbidden in tools/ll-loss-harness`);
  }
  if (!ALLOWED_HARNESS_HOSTS.has(h)) {
    throw new Error(`refusing ${label}=${host}: only ${[...ALLOWED_HARNESS_HOSTS].join(", ")} are allowed in tools/ll-loss-harness`);
  }
}

export function assertLocalUrl(url, label) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`refusing ${label}=${url}: not a valid URL`);
  }
  assertLocalHost(u.hostname, label);
  return u;
}

export function loadHarnessEnv() {
  const p = path.join(HARNESS_DIR, ".data", "harness.env");
  if (!existsSync(p)) {
    throw new Error(`missing ${p} -- run scripts/gen-keys.sh first (see README.md)`);
  }
  const env = {};
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!/^[A-Z_]+=/.test(line)) continue;
    const i = line.indexOf("=");
    env[line.slice(0, i)] = line.slice(i + 1);
  }
  for (const key of ["LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "REMUX_CONTROL_SECRET", "MEDIA_ORIGIN_KEY"]) {
    if (!env[key]) throw new Error(`${p} is missing ${key}`);
  }
  return env;
}

// Finds the highest-versioned `<name>@...` directory pnpm hoisted into
// node_modules/.pnpm and returns the path to `subpath` inside its package.
// Avoids hardcoding an exact version (e.g. "playwright-core@1.62.1") so
// this harness keeps working after a routine `pnpm install` bump.
function resolvePnpmPackage(name, subpath) {
  const pnpmDir = path.join(REPO_ROOT, "node_modules", ".pnpm");
  if (!existsSync(pnpmDir)) {
    throw new Error(`${pnpmDir} not found -- run "pnpm install" at the repo root first`);
  }
  const prefix = `${name}@`;
  const candidates = readdirSync(pnpmDir).filter((d) => d.startsWith(prefix));
  if (candidates.length === 0) {
    throw new Error(`no ${prefix}* found under ${pnpmDir} -- run "pnpm install" at the repo root first`);
  }
  candidates.sort();
  const chosen = candidates.at(-1);
  const full = path.join(pnpmDir, chosen, "node_modules", name, subpath);
  if (!existsSync(full)) {
    throw new Error(`resolved ${prefix}* to ${chosen} but ${full} does not exist`);
  }
  return full;
}

export function resolvePlaywrightCore() {
  const require = createRequire(import.meta.url);
  // Prefer a normal resolution first (works if this harness ever gets its
  // own node_modules); fall back to the pnpm store scan the repo actually
  // uses today.
  try {
    return require.resolve("playwright-core");
  } catch {
    return resolvePnpmPackage("playwright-core", "index.js");
  }
}

export function resolveHlsJsDist() {
  try {
    const require = createRequire(import.meta.url);
    return path.join(path.dirname(require.resolve("hls.js/package.json")), "dist", "hls.js");
  } catch {
    return resolvePnpmPackage("hls.js", path.join("dist", "hls.js"));
  }
}

export function resolveLlPlaylistModule() {
  return path.join(REPO_ROOT, "tools", "hls-edge", "src", "ll-playlist.js");
}
export function resolveLlStateModule() {
  return path.join(REPO_ROOT, "tools", "hls-edge", "src", "ll-state.js");
}
