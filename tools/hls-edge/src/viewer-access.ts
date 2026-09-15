/**
 * "Is this caller allowed to see this session's bytes at all" — the ONE
 * implementation of that question, for every route this Worker answers.
 *
 * WHY IT IS ITS OWN MODULE. It used to be a block inside
 * `handlePlaylistRequest` (`index.ts`), which was fine while a playlist was
 * the only thing a viewer ever asked this Worker for. Task `L2.3` added a
 * second viewer-facing route — the LL media bytes an LL playlist's own URIs
 * point at (`ll-media.ts`) — and that route needs the SAME answer, checked
 * the SAME way, before it fetches or caches anything. A second copy of a
 * credential check is how the two drift: one of them grows a fix the other
 * never gets. So the check moved here whole, and both routes call it.
 *
 * WHAT IT CHECKS, IN ORDER (unchanged from where it came from):
 *
 *  1. The viewer token (`?t=`, `hls-viewer-token.js`) — signature, expiry,
 *     channel and session, verified in THIS Worker on every request.
 *  2. When the route allows it, the party pass (`?pp=`,
 *     `hls-party-pass.js`) as a fallback — refused outright in production
 *     with no KV denylist behind it (`partyPassRequiresKvInProduction`),
 *     otherwise checked against that denylist.
 *  3. When the route asks for it (`checkTokenRevocation`), the SAME
 *     revocation gate for a `?t=`-authorized caller too.
 *
 * WHY `checkTokenRevocation` IS A PARAMETER AND NOT ALWAYS ON. The
 * session/master route deliberately has no revocation check of its own on
 * the conventional path: it always forwards to the API live, which runs its
 * own always-current `isHlsAccessRevoked` on every request (see `index.ts`'s
 * module doc comment, "WHAT THIS WORKER DOES NOT MAKE FASTER"). The
 * rendition route runs the check but LATER, after the blocking-reload
 * directive is validated, so a malformed directive still answers 400 the way
 * it always did. The two routes that want it folded in right here — the LL
 * media route, and any future route that never reaches the API — pass
 * `true`.
 */

import {
  HLS_VIEWER_TOKEN_PARAM,
  describeHlsViewerToken,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";
import {
  HLS_PARTY_PASS_PARAM,
  describeHlsPartyPass,
  verifyHlsPartyPass,
} from "./hls-party-pass.js";
import {
  PartyPassRevocationGate,
  partyPassRequiresKvInProduction,
} from "./party-pass-revocation.js";
import { logEvent } from "./log.js";

export interface ViewerAccessEnv {
  HLS_VIEWER_TOKEN_SECRET?: string;
  HLS_PARTY_PASS_SECRET?: string;
  HLS_REVOKED_USERS?: KVNamespace;
  ENVIRONMENT?: string;
}

export interface VerifiedViewer {
  userId: string;
  issuedAt: number;
}

export type ViewerAccess =
  | {
      ok: true;
      verified: VerifiedViewer;
      /**
       * The `?t=` string this call just verified, or `null` when the caller
       * got in on a party pass alone. Never an unverified value: a
       * present-but-bad token reads as `null` here, the same rule
       * `index.ts` already applied before forwarding one to an origin.
       */
      token: string | null;
      usedPartyPass: boolean;
      /**
       * The credential that actually authorized this request, as the query
       * parameter and value a URL should carry to repeat it — `t` for a
       * viewer token, `pp` for a party pass. `index.ts`'s `stampLlToken`
       * writes exactly this into every URI of an LL rendition body, so the
       * MEDIA requests those URIs produce (`ll-media.ts`) arrive holding the
       * same credential the playlist request did. Stamping "the token"
       * unconditionally wrote `null` for a party-pass viewer with no `?t=`.
       */
      credential: { param: string; value: string };
    }
  | { ok: false; reason: string; status: number };

/** 401 for "not a valid credential at all", 403 for "valid, but not for this resource". */
export function statusForRejection(reason: string): number {
  return reason === "wrong-channel" ||
    reason === "wrong-session" ||
    reason === "revoked" ||
    reason === "party-pass-kv-unconfigured"
    ? 403
    : 401;
}

/**
 * `X-HLS-Edge-Cache: 401`-shaped rejections are rate-limited the same way
 * `logHlsPlaylistRejection` is on the origin, so a broken client cannot turn
 * its own bug into a log write amplifier.
 *
 * `channelId` is an attacker-controlled path segment (up to 64 characters,
 * `playlist-route.ts`'s own bound, not this map's), so an attacker cycling
 * through distinct channel ids on every request would otherwise grow this
 * map forever — nothing ever deleted an entry, only added or updated one.
 * Two bounds, in `logRejection` below: an ACTIVE sweep drops every entry
 * whose `REJECTION_LOG_WINDOW_MS` has already closed (so ordinary traffic
 * settles back near zero entries once a flood stops), throttled to once per
 * `REJECTION_LOG_SWEEP_INTERVAL_MS` rather than on every new key — a full
 * scan is O(map size), and running it on every previously-unseen key would
 * turn a sustained stream of unique invalid requests into its own CPU cost
 * on the request hot path, which is exactly the kind of amplification this
 * whole rejection log exists to avoid elsewhere. `REJECTION_LOG_MAX_ENTRIES`
 * is the hard ceiling in between sweeps, checked (cheaply, O(1)) on every
 * new key regardless of the throttle: past it, the oldest entry (by
 * insertion order) is evicted — an approximation of LRU, not a precise one,
 * which is enough for a hostile-traffic bound on a log dedupe table, not a
 * cache whose eviction policy anyone depends on.
 */
const REJECTION_LOG_WINDOW_MS = 30_000;
const REJECTION_LOG_MAX_ENTRIES = 1_000;
const REJECTION_LOG_SWEEP_INTERVAL_MS = 10_000;
const rejectionLog = new Map<string, { at: number; suppressed: number }>();
let rejectionLogLastSweptAt = 0;

export function logRejection(
  channelId: string,
  rung: string | undefined,
  reason: string,
): void {
  const key = `${channelId}:${rung ?? "-"}:${reason}`;
  const now = Date.now();
  const seen = rejectionLog.get(key);
  if (seen && now - seen.at < REJECTION_LOG_WINDOW_MS) {
    seen.suppressed += 1;
    return;
  }
  logEvent("hlsEdge.playlistRejected", {
    channelId,
    rung: rung ?? null,
    reason,
    suppressed: seen?.suppressed ?? 0,
  });
  if (!seen) {
    // Active expiry, throttled: at most one full scan per
    // `REJECTION_LOG_SWEEP_INTERVAL_MS`, regardless of how many new keys
    // arrive in between -- see the doc comment above for why an unthrottled
    // scan on every new key would itself be a hot-path cost.
    if (now - rejectionLogLastSweptAt >= REJECTION_LOG_SWEEP_INTERVAL_MS) {
      for (const [existingKey, entry] of rejectionLog) {
        if (now - entry.at >= REJECTION_LOG_WINDOW_MS) {
          rejectionLog.delete(existingKey);
        }
      }
      rejectionLogLastSweptAt = now;
    }
    if (rejectionLog.size >= REJECTION_LOG_MAX_ENTRIES) {
      // Still over the cap after expiry (a sustained flood of genuinely
      // fresh unique keys): fall back to evicting the oldest by insertion
      // order, an approximation of LRU that is enough for a hostile-traffic
      // bound on a log dedupe table, not a cache anyone depends on for
      // eviction precision.
      const oldestKey = rejectionLog.keys().next().value;
      if (oldestKey !== undefined) {
        rejectionLog.delete(oldestKey);
      }
    }
  }
  rejectionLog.set(key, { at: now, suppressed: 0 });
}

/**
 * Verifies the credential(s) on one request. Logs its own rejection (rate
 * limited, see `logRejection`) so callers only have to turn the returned
 * `reason`/`status` into a response body.
 */
export async function authorizeViewer(opts: {
  url: URL;
  env: ViewerAccessEnv;
  gate: PartyPassRevocationGate;
  channelId: string;
  startedAt: string;
  /** The route's rung, for the rejection log only — `undefined` on the session/master route. */
  rung: string | undefined;
  /** Whether a `?pp=` party pass may stand in for a missing/expired `?t=` on this route. */
  allowPartyPass: boolean;
  /** Whether a `?t=`-authorized caller's revocation is checked HERE — see this file's header. */
  checkTokenRevocation: boolean;
}): Promise<ViewerAccess> {
  const { url, env, gate, channelId, startedAt, rung, allowPartyPass, checkTokenRevocation } = opts;
  const token = url.searchParams.get(HLS_VIEWER_TOKEN_PARAM);
  const secret = env.HLS_VIEWER_TOKEN_SECRET ?? null;
  const expected = { channelId, startedAt: Number(startedAt) };

  let verified = await verifyHlsViewerToken(token, expected, secret);
  let usedPartyPass = false;
  // Set only on the party-pass path, so the final rejection block below can
  // report the REAL reason a well-formed pass was refused -- without this,
  // a revoked-but-otherwise-valid pass fell through to `describeHlsPartyPass`,
  // which knows nothing about revocation and answered "malformed" for a
  // pass that was not malformed at all.
  let partyPassRejectReason: "revoked" | "party-pass-kv-unconfigured" | null = null;
  if (!verified && allowPartyPass) {
    const partyPass = url.searchParams.get(HLS_PARTY_PASS_PARAM);
    const partySecret = env.HLS_PARTY_PASS_SECRET ?? null;
    const passVerified = await verifyHlsPartyPass(partyPass, expected, partySecret);
    if (passVerified) {
      if (partyPassRequiresKvInProduction(env)) {
        // See README.md "Enabling in production": a party pass is a 6 h
        // credential this Worker alone checks, and in production that is
        // too wide a gap to accept with no KV denylist behind it at all --
        // refuse outright rather than silently falling open.
        partyPassRejectReason = "party-pass-kv-unconfigured";
      } else {
        const { revoked, kvError } = await gate.check(
          env.HLS_REVOKED_USERS,
          passVerified.userId,
          channelId,
          passVerified.issuedAt,
        );
        if (kvError) {
          logEvent("hlsEdge.partyPassRevocationCheckError", { channelId });
        }
        if (revoked) {
          partyPassRejectReason = "revoked";
        }
      }
      if (!partyPassRejectReason) {
        verified = passVerified;
        usedPartyPass = true;
      }
    }
  }
  if (!verified) {
    // Describe whichever credential was actually offered: a revoked/refused
    // party pass reports that outcome directly (it verified fine as a
    // signature; the KV check is what said no); otherwise the token if
    // present (the common case, and what most rejections are about), the
    // party pass only when the caller sent NO token at all.
    const reason =
      partyPassRejectReason ??
      (token
        ? ((await describeHlsViewerToken(token, expected, secret)) ?? "malformed")
        : ((await describeHlsPartyPass(
            url.searchParams.get(HLS_PARTY_PASS_PARAM),
            expected,
            env.HLS_PARTY_PASS_SECRET ?? null,
          )) ?? "malformed"));
    logRejection(channelId, rung, reason);
    return { ok: false, reason, status: statusForRejection(reason) };
  }

  if (checkTokenRevocation && !usedPartyPass) {
    const { revoked, kvError } = await gate.check(
      env.HLS_REVOKED_USERS,
      verified.userId,
      channelId,
      verified.issuedAt,
    );
    if (kvError) {
      logEvent("hlsEdge.partyPassRevocationCheckError", { channelId });
    }
    if (revoked) {
      logRejection(channelId, rung, "revoked");
      return { ok: false, reason: "revoked", status: statusForRejection("revoked") };
    }
  }

  const credential = usedPartyPass
    ? { param: HLS_PARTY_PASS_PARAM, value: url.searchParams.get(HLS_PARTY_PASS_PARAM)! }
    : { param: HLS_VIEWER_TOKEN_PARAM, value: token! };
  return {
    ok: true,
    verified,
    credential,
    // A party-pass-only caller has no origin-verifiable token to pass on --
    // and a present-but-INVALID `?t=` is not one either, which is why this
    // reads the verification result rather than the raw parameter.
    token: usedPartyPass ? null : token,
    usedPartyPass,
  };
}
