import { isEnabled } from "./flags.js";

/**
 * The operator's way to push an update to every stale web or desktop client,
 * served by `GET /api/client-update/config`, read per request. See
 * `docs/PWA.md` §"Nobody stays on an old bundle".
 *
 * WHY THE SERVER HAS A SAY AT ALL. The client already notices it is out of date
 * by itself (it polls `/version.json`, which the build writes), tells the person
 * ONCE A DAY with a small indicator (`lib/client-version.ts`, 09:00 UTC), and
 * updates at a safe moment without being asked. That is the ordinary path and it
 * needs nothing from here. This is the lever for the day a build matters NOW: a
 * fixed build is up, and waiting for the morning is too slow.
 *
 * Two levers, both OFF until somebody sets them, so nothing changes for anyone
 * (including a self-host) until an operator does:
 *
 *  - `forceUpdate`: the runtime flag `client_force_update`
 *    (`CLIENT_FORCE_UPDATE=true` as its environment default). "Announce now":
 *    every client that is not on the latest build skips the daily wait and draws
 *    its indicator with emphasis. It does NOT block anybody's screen (it used to,
 *    and on 2026-10-13 that was a blocking screen for every one of nineteen
 *    deploys, "de 10 em 10 segundos"), and it never reloads anyone in a call.
 *    Turn it off again once the rollout is done.
 *  - `minBuiltAt`: `CLIENT_MIN_BUILT_AT`, an ISO date or epoch milliseconds.
 *    Every client whose bundle was BUILT before that moment is forced. Precise
 *    and self-limiting (a later deploy is built after it, so it is never
 *    caught), but it is an environment variable, so moving it is a recreate.
 *    Build ids are commit hashes and cannot be ordered, which is why this is a
 *    time and not "a minimum build".
 *
 * And two that make an update CRITICAL, the only thing that still blocks a screen
 * (a small "atualização necessária" dialog) and the only thing that reloads a
 * page IN A CALL. For a critical fix only: they end the call.
 *
 *  - `interruptCalls`: the runtime flag `client_force_update_in_call`. With
 *    either lever above forcing a bundle, that bundle reloads mid-call too, and
 *    the dialog is up.
 *  - `criticalMinBuiltAt`: `CLIENT_CRITICAL_MIN_BUILT_AT`, same format as
 *    `CLIENT_MIN_BUILT_AT`. Bundles built before it reload, call or not.
 *
 * Only bundles from 2026-10-10 on read these two; an older bundle ignores the
 * extra fields and treats a force as before.
 *
 * A client only acts on any of them when it is actually stale (its build differs
 * from `/version.json`), so a `minBuiltAt` set past the newest build cannot
 * trap anybody in a reload loop: there is nothing newer to reload into.
 */
export interface ClientUpdateConfig {
  forceUpdate: boolean;
  /** Epoch milliseconds, or null when no minimum is set. */
  minBuiltAt: number | null;
  /** A forced bundle reloads even in a call. */
  interruptCalls: boolean;
  /** Epoch milliseconds: bundles built before it reload even in a call. */
  criticalMinBuiltAt: number | null;
}

/** Epoch ms from an ISO date or a plain number of milliseconds; null if unusable. */
export function parseMinBuiltAt(raw: string | undefined): number | null {
  const value = raw?.trim();
  if (!value) {
    return null;
  }
  if (/^\d+$/.test(value)) {
    const ms = Number(value);
    // Seconds would be a year-1970 minimum, which forces nobody and hides the
    // typo. Anything below 1e11 is read as seconds, like every unix timestamp.
    return Number.isSafeInteger(ms) ? (ms < 1e11 ? ms * 1000 : ms) : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function clientUpdateConfig(): ClientUpdateConfig {
  return {
    forceUpdate: isEnabled("client_force_update"),
    minBuiltAt: parseMinBuiltAt(process.env.CLIENT_MIN_BUILT_AT),
    interruptCalls: isEnabled("client_force_update_in_call"),
    criticalMinBuiltAt: parseMinBuiltAt(process.env.CLIENT_CRITICAL_MIN_BUILT_AT),
  };
}
