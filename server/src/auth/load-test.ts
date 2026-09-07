/**
 * A scoped auth path for load testing a HOSTED deployment.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT `DEV_AUTH_BYPASS`. Measuring the join path
 * needs hundreds of distinct identities, which is exactly what the dev bypass's
 * `dev-local-token:<suffix>` gives you locally. But staging is a public
 * hostname, and that token is a constant checked into this repository
 * (`DEV_AUTH_TOKEN` in `@pqp/shared`), so switching the bypass on there would
 * hand every visitor an account by pasting a string they can read on GitHub.
 *
 * So this is the same idea with the constant replaced by a secret: the operator
 * generates a strong random token, sets it as a Fly secret on the staging app
 * only, and the harness presents `Authorization: Bearer <token>:<suffix>`.
 * Unset, none of this exists.
 *
 * THE PRODUCTION GUARD, and why it is not `NODE_ENV`.
 * `isDevAuthBypassEnabled` refuses under `NODE_ENV=production`, which works
 * because the bypass is a local-development tool and no deployed image ever
 * wants it. That test cannot be reused here: the Dockerfile's runner stage
 * hardcodes `ENV NODE_ENV=production`, so staging and production are
 * indistinguishable by it, and a literal copy of that check would make this
 * feature permanently inert on the one host it is for.
 *
 * The equivalent guard is therefore the deployment's own identity:
 *
 *   - On Fly, `FLY_APP_NAME` is injected by the platform and cannot be
 *     spoofed from a request. Only an app whose name ends in `-staging` may
 *     use this path, so `pqp-api` is refused even if the secret were pasted
 *     onto it by mistake.
 *   - Anywhere else (a laptop, a self-host, the image run outside Fly) the
 *     `NODE_ENV` rule applies unchanged: production refuses.
 *
 * That is strictly tighter than the dev bypass in the case that matters, and
 * it fails closed on every host this repository does not name.
 *
 * WHY REFUSING PER REQUEST RATHER THAN THROWING AT BOOT. `assertAuthConfig`
 * makes `DEV_AUTH_BYPASS=true` a fatal boot error under production, because a
 * process running with a *public* token is a total compromise and being down
 * is better. This token is a secret, so the same accident is not a compromise:
 * closing the path and shouting once per boot in `fly logs` costs nothing,
 * where a throw would turn one mistyped secret name into a production outage.
 * A too-short token IS fatal, because a short one is guessable and the operator
 * clearly meant to enable something.
 */

/**
 * Minimum length for the secret. A non-empty value shorter than this is fatal
 * rather than ignored, and that is the point: a five-character
 * `LOAD_TEST_TOKEN` is a mistake somebody made on purpose, and it must not
 * degrade quietly into a working backdoor. Blank is a separate case and means
 * "not set" — see `assertLoadTestAuthConfig`.
 *
 * Same reasoning and roughly the same number as `ADMIN_METRICS_TOKEN_MIN_LENGTH`.
 */
export const LOAD_TEST_TOKEN_MIN_LENGTH = 32;

/**
 * The suffix alphabet, identical to the dev bypass's for the same reason: it is
 * concatenated into an identifier, so a near-miss must be a rejected token
 * rather than a surprise account.
 */
const SUFFIX = /^[a-z0-9_-]{1,32}$/;

/** Every identity this path can mint starts here, so they are greppable. */
export const LOAD_TEST_CLERK_ID_PREFIX = "load_test_user";

let warnedAboutWrongHost = false;

/** Reset the once-per-process warning. Tests only. */
export function resetLoadTestAuthWarning(): void {
  warnedAboutWrongHost = false;
}

/**
 * Whether the host is one where a load-test identity may exist at all.
 *
 * Deliberately independent of whether the token is set, so `assertAuthConfig`
 * can tell "not configured" from "configured on the wrong machine".
 */
function hostAllowsLoadTestAuth(): boolean {
  const app = process.env.FLY_APP_NAME;
  if (app) {
    return app.endsWith("-staging");
  }
  return process.env.NODE_ENV !== "production";
}

/**
 * True only when a usable secret is set AND this is a host allowed to honour
 * it. Every caller goes through here; there is no other way in.
 */
export function isLoadTestAuthEnabled(): boolean {
  const token = process.env.LOAD_TEST_TOKEN;
  if (!token || token.length < LOAD_TEST_TOKEN_MIN_LENGTH) {
    return false;
  }
  if (!hostAllowsLoadTestAuth()) {
    if (!warnedAboutWrongHost) {
      warnedAboutWrongHost = true;
      console.error(
        "[auth] LOAD_TEST_TOKEN ignored: this is not a staging deployment. " +
          "Remove the secret from this app.",
      );
    }
    return false;
  }
  return true;
}

/**
 * Fatal misconfiguration, called from the entrypoint alongside
 * `assertAuthConfig`'s other checks.
 *
 * Only the short-token case throws — see the header for why a secret on the
 * wrong host is closed rather than fatal.
 */
export function assertLoadTestAuthConfig(): void {
  const token = process.env.LOAD_TEST_TOKEN;
  // An EMPTY value is "not set", not "set badly". `set -a; . env; set +a`,
  // docker-compose and CI all hand a process blank variables for names nobody
  // filled in, and refusing to boot over one would be a trap with no upside:
  // blank cannot authenticate anything either way.
  if (token && token.length < LOAD_TEST_TOKEN_MIN_LENGTH) {
    throw new Error(
      `LOAD_TEST_TOKEN must be at least ${LOAD_TEST_TOKEN_MIN_LENGTH} characters. ` +
        "Unset it, or set a strong random value.",
    );
  }
}

/**
 * Constant-time string comparison over the secret half of the header.
 *
 * `timingSafeEqual` needs equal lengths and throws otherwise, and the lengths
 * here are attacker-controlled — so length is compared first and the result
 * folded in, which leaks only the length of the configured token. That is the
 * same trade `ADMIN_METRICS_PATH`'s check makes.
 */
function secretEquals(candidate: string, expected: string): boolean {
  if (candidate.length !== expected.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < candidate.length; i += 1) {
    diff |= candidate.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * The bearer token, optionally carrying `:suffix` to name a distinct throwaway
 * identity — the same shape and the same purpose as `devBypassIdentity`.
 *
 * One account is not enough to load test with: every write budget, typing
 * limit and voice room limiter is keyed on the user id, so N simulated clients
 * sharing one account measure the rate limiter rather than the server.
 *
 * Returns null for every failure, and the caller returns null in turn rather
 * than falling through to Clerk. Only ever consulted behind
 * `isLoadTestAuthEnabled()`.
 */
export function loadTestIdentity(
  token: string,
): { clerkId: string; displayName: string } | null {
  const expected = process.env.LOAD_TEST_TOKEN;
  if (!expected) {
    return null;
  }
  const separator = token.indexOf(":");
  const secret = separator === -1 ? token : token.slice(0, separator);
  if (!secretEquals(secret, expected)) {
    return null;
  }
  if (separator === -1) {
    return {
      clerkId: LOAD_TEST_CLERK_ID_PREFIX,
      displayName: "Load Test",
    };
  }
  const suffix = token.slice(separator + 1);
  if (!SUFFIX.test(suffix)) {
    return null;
  }
  return {
    clerkId: `${LOAD_TEST_CLERK_ID_PREFIX}_${suffix}`,
    displayName: `Load Test ${suffix}`,
  };
}
