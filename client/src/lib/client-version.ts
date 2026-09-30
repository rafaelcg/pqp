import { DEV_BUILD_ID, type BuildIdentity } from "@/lib/build-info";

/**
 * Comparing the build a page is running to the build that is deployed now.
 * Pure: everything here takes its inputs as arguments, so the rules that decide
 * whether somebody is told to update can be read, and tested, without a browser.
 */

/** What `/version.json` says is deployed. `builtAt` is null when it did not say. */
export interface LatestBuild {
  build: string;
  builtAt: number | null;
}

/**
 * `/version.json` as a build writes it, or null for anything else.
 *
 * Null is a real and common answer, not an error: a deploy from before the file
 * existed answers the path with the SPA shell (a 200 of `text/html`), and a
 * captive portal or a broken proxy answers with whatever it likes. None of those
 * may read as "a different build", or every such answer would put up an update
 * prompt for a version that does not exist.
 */
export function parseVersionManifest(raw: unknown): LatestBuild | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const { build, builtAt } = raw as { build?: unknown; builtAt?: unknown };
  if (typeof build !== "string" || build.trim() === "" || build.length > 128) {
    return null;
  }
  return {
    build: build.trim(),
    builtAt:
      typeof builtAt === "number" && Number.isFinite(builtAt) && builtAt > 0
        ? builtAt
        : null,
  };
}

/**
 * Whether the deployed build is not the one this page is running.
 *
 * Only a difference counts, never an ordering: build ids are commit hashes and
 * have none, and "the deployed build is OLDER" (a rollback) is exactly a case
 * where everybody should move too. A `dev` build compares to nothing, so a
 * developer's own tab is never told to reload because a deploy landed.
 */
export function isStaleBuild(
  running: BuildIdentity,
  latest: LatestBuild | null,
): boolean {
  if (!latest || running.build === DEV_BUILD_ID) {
    return false;
  }
  return latest.build !== running.build;
}

/** The operator's half, from `GET /api/client-update/config`. */
export interface ForceConfig {
  forceUpdate: boolean;
  /** Epoch milliseconds; bundles built before it are forced. Null when unset. */
  minBuiltAt: number | null;
}

export const NO_FORCE: ForceConfig = { forceUpdate: false, minBuiltAt: null };

/**
 * An older API answers 404 and a newer one may add fields: anything that is not
 * plainly "yes, force" reads as no force. The default is the ordinary path.
 */
export function parseForceConfig(raw: unknown): ForceConfig {
  if (!raw || typeof raw !== "object") {
    return NO_FORCE;
  }
  const { forceUpdate, minBuiltAt } = raw as {
    forceUpdate?: unknown;
    minBuiltAt?: unknown;
  };
  return {
    forceUpdate: forceUpdate === true,
    minBuiltAt:
      typeof minBuiltAt === "number" &&
      Number.isFinite(minBuiltAt) &&
      minBuiltAt > 0
        ? minBuiltAt
        : null,
  };
}

/**
 * Whether the operator has made this update mandatory for THIS bundle. The
 * caller only asks when the build is already stale: a minimum set past the
 * newest build has nothing to reload into and must not trap anybody.
 */
export function isForcedBuild(
  running: BuildIdentity,
  config: ForceConfig,
): boolean {
  if (running.build === DEV_BUILD_ID) {
    return false;
  }
  if (config.forceUpdate) {
    return true;
  }
  return config.minBuiltAt !== null && running.builtAt < config.minBuiltAt;
}
