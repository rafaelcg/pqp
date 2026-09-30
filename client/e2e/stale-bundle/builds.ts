import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CLIENT_DIR = path.resolve(import.meta.dirname, "../..");

/**
 * Build the real client, once, as a named fixture with a given build id.
 *
 * Two fixtures of ONE source tree that differ only in `VITE_PQP_BUILD_ID` are
 * exactly what a deploy is to a page that is already open: different hashed
 * bundle, different `sw.js` precache, different `version.json`, same behaviour.
 * That is what lets these specs use the real service worker and the real
 * update code without a hand-written imitation of either.
 *
 * About four seconds a build. `VITE_DEV_AUTH_BYPASS` so the bundle boots
 * without a Clerk key; nothing here talks to an API.
 */
export function buildFixture(name: string, buildId: string): string {
  const out = path.join(os.tmpdir(), "pqp-stale-bundle", name);
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(
    "pnpm",
    ["exec", "vite", "build", "--outDir", out, "--emptyOutDir", "--logLevel", "error"],
    {
      cwd: CLIENT_DIR,
      env: {
        ...process.env,
        VITE_PQP_BUILD_ID: buildId,
        VITE_DEV_AUTH_BYPASS: "true",
        // Never inherited from a developer's shell: the fixtures must be the
        // same tree apart from the id.
        VITE_FARO_URL: "",
        FARO_SOURCEMAP_API_KEY: "",
      },
      stdio: ["ignore", "inherit", "inherit"],
    },
  );
  return out;
}
