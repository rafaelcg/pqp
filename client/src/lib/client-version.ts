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
  /**
   * The runtime flag `client_force_update_in_call`: a FORCED update also
   * reloads a page that is in a call. For a critical fix only.
   */
  interruptCalls?: boolean;
  /**
   * Epoch milliseconds (`CLIENT_CRITICAL_MIN_BUILT_AT`): bundles built before it
   * reload even mid-call. Null when unset.
   */
  criticalMinBuiltAt?: number | null;
}

export const NO_FORCE: ForceConfig = {
  forceUpdate: false,
  minBuiltAt: null,
  interruptCalls: false,
  criticalMinBuiltAt: null,
};

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * An older API answers 404 and a newer one may add fields: anything that is not
 * plainly "yes, force" reads as no force. The default is the ordinary path.
 */
export function parseForceConfig(raw: unknown): ForceConfig {
  if (!raw || typeof raw !== "object") {
    return NO_FORCE;
  }
  const { forceUpdate, minBuiltAt, interruptCalls, criticalMinBuiltAt } = raw as {
    forceUpdate?: unknown;
    minBuiltAt?: unknown;
    interruptCalls?: unknown;
    criticalMinBuiltAt?: unknown;
  };
  return {
    forceUpdate: forceUpdate === true,
    minBuiltAt: epochMs(minBuiltAt),
    interruptCalls: interruptCalls === true,
    criticalMinBuiltAt: epochMs(criticalMinBuiltAt),
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

/**
 * Whether the update is CRITICAL for this bundle: it reloads even in a call.
 * Either the operator turned `client_force_update_in_call` on while the build is
 * forced, or the bundle was built before `criticalMinBuiltAt`. Same rule as
 * `isForcedBuild` about only being asked for a page that is already stale.
 */
export function isCriticalBuild(
  running: BuildIdentity,
  config: ForceConfig,
): boolean {
  if (running.build === DEV_BUILD_ID) {
    return false;
  }
  if (config.interruptCalls && isForcedBuild(running, config)) {
    return true;
  }
  const critical = config.criticalMinBuiltAt ?? null;
  return critical !== null && running.builtAt < critical;
}
