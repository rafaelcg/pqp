#!/usr/bin/env node
/**
 * Does this diff need `pqp-api` redeployed?
 *
 * `deploy-api-fly.yml` used to answer this with one `grep -qE '^(server/|...)'`,
 * which is right about client-only changes and wrong about test-only ones: a
 * PR touching nothing but `server/src/**` *.test.ts files matched, replaced the
 * single Fly machine, and dropped every live WebSocket to ship a `dist` that
 * was byte-for-byte identical. The workflow's own comment already calls that
 * "a user-visible outage bought for nothing"; it just did not cover this case.
 *
 * WHAT MAKES A FILE SAFE TO IGNORE IS THE BUILD, NOT ITS NAME. Nothing here
 * knows that `.test.ts` means anything. It reads each package's
 * `tsconfig.build.json` and takes that file's own `exclude` globs as the
 * definition of "cannot reach the artifact". Today that is
 * `server/tsconfig.build.json` excluding `src/**\/*.test.ts`, and
 * `packages/shared/tsconfig.build.json` excluding its tests and fixtures. If
 * somebody changes what the build compiles, this follows without being edited,
 * and a naming convention drifting away from the build cannot silently skip a
 * deploy.
 *
 * IT FAILS TOWARD DEPLOYING, on purpose and in every direction. A needless
 * restart is a blip; a skipped one serves stale code to everybody until the
 * next merge. So: an unreadable or missing tsconfig contributes no exclusions
 * rather than assuming any, a glob shape this does not understand excludes
 * nothing, and a test helper that lives outside the build's own exclude glob
 * (`server/src/ws/helpers.ts`, say) is an ordinary source file that deploys.
 *
 * Reads the changed paths on stdin, one per line.
 *   exit 0  -> deploy
 *   exit 20 -> no deploy
 *   exit 1  -> something went wrong; the caller fails open and deploys
 * The reason goes to stdout either way.
 */
import { readFileSync } from "node:fs";

/**
 * The paths that can change what the API image runs. Unchanged from the
 * workflow this replaces, including `deploy-api-fly.yml` itself: editing the
 * deploy causes the deploy, which is the safe direction for a file that
 * decides whether to deploy.
 */
const RELEVANT =
  /^(server\/|packages\/|Dockerfile|fly\.toml|fly\.worker\.toml|pnpm-lock\.yaml|pnpm-workspace\.yaml|package\.json|\.github\/workflows\/deploy-api-fly\.yml)/;

/** Every package whose build output ends up in the API image. */
const BUILD_CONFIGS = ["server", "packages/shared"];

/**
 * One `tsconfig` exclude glob to a matcher, for the shapes those files
 * actually use. `**\/` spans directories, `*` stops at one, everything else is
 * literal. A glob using anything else returns null and therefore excludes
 * nothing, which is the failing-toward-deploying direction.
 */
export function globToRegExp(glob) {
  if (/[?[\]{}()!+@]/.test(glob)) {
    return null;
  }
  let out = "";
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith("**/", i)) {
      out += "(?:[^/]+/)*";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += glob[i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * The globs each package's build says it does NOT compile, rebased onto repo
 * paths. A package without a readable `tsconfig.build.json`, or one with no
 * `exclude`, contributes nothing.
 */
export function buildExcludedMatchers(
  readFile = (path) => readFileSync(path, "utf8"),
  packages = BUILD_CONFIGS,
) {
  const matchers = [];
  for (const pkg of packages) {
    let parsed;
    try {
      parsed = JSON.parse(readFile(`${pkg}/tsconfig.build.json`));
    } catch {
      continue;
    }
    for (const glob of parsed?.exclude ?? []) {
      if (typeof glob !== "string") {
        continue;
      }
      const matcher = globToRegExp(`${pkg}/${glob}`);
      if (matcher) {
        matchers.push(matcher);
      }
    }
  }
  return matchers;
}

export function decide(changed, matchers) {
  const kept = changed.filter(
    (file) => file && !matchers.some((m) => m.test(file)),
  );
  const excluded = changed.filter((file) => file && !kept.includes(file));
  const trigger = kept.find((file) => RELEVANT.test(file));
  if (trigger) {
    return { needed: true, reason: `server-relevant file changed: ${trigger}` };
  }
  if (excluded.length > 0 && changed.some((file) => RELEVANT.test(file))) {
    return {
      needed: false,
      reason:
        `only files the build excludes changed under server/ or packages/ ` +
        `(${excluded.length} of ${changed.length}); dist would be identical`,
    };
  }
  return {
    needed: false,
    reason: "no server-relevant files changed; leaving the machine alone",
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stdin = readFileSync(0, "utf8");
  const changed = stdin.split("\n").map((l) => l.trim()).filter(Boolean);
  const { needed, reason } = decide(changed, buildExcludedMatchers());
  process.stdout.write(`${reason}\n`);
  process.exit(needed ? 0 : 20);
}
