import { isEnabled } from "./flags.js";

/**
 * The operator's way to make every stale web or desktop client update, served
 * by `GET /api/client-update/config`, read per request. See
 * `docs/PWA.md` §"Nobody stays on an old bundle".
 *
 * WHY THE SERVER HAS A SAY AT ALL. The client already notices it is out of date
 * by itself (it polls `/version.json`, which the build writes), and updates at
 * a safe moment without being asked. That is the ordinary path and it needs
 * nothing from here. This is the lever for the day a bundle is BAD: a fixed
 * build is up, and waiting for people to go idle or hang up is too slow. The
 * operator flips `client_force_update` on the dashboard (no deploy, no restart)
 * and every client that is not on the latest build puts up a screen with one
 * button, except while it is in a call, where it waits for the hangup.
 *
 * Two levers, both OFF until somebody sets them, so nothing changes for anyone
 * (including a self-host) until an operator does:
 *
 *  - `forceUpdate`: the runtime flag `client_force_update`
 *    (`CLIENT_FORCE_UPDATE=true` as its environment default). Blunt on purpose:
 *    "everyone not on the latest build". Turn it off again once the rollout is
 *    done, or the next ordinary deploy will put the blocking screen up too.
 *  - `minBuiltAt`: `CLIENT_MIN_BUILT_AT`, an ISO date or epoch milliseconds.
 *    Every client whose bundle was BUILT before that moment is forced. Precise
 *    and self-limiting (a later deploy is built after it, so it is never
 *    caught), but it is an environment variable, so moving it is a recreate.
 *    Build ids are commit hashes and cannot be ordered, which is why this is a
 *    time and not "a minimum build".
 *
 * A client only acts on either when it is actually stale (its build differs
 * from `/version.json`), so a `minBuiltAt` set past the newest build cannot
 * trap anybody in a reload loop: there is nothing newer to reload into.
 */
export interface ClientUpdateConfig {
  forceUpdate: boolean;
  /** Epoch milliseconds, or null when no minimum is set. */
  minBuiltAt: number | null;
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
  };
}
