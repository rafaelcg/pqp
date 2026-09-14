/**
 * The edge Worker's own revocation gate -- the mechanism `isPartyPassRevoked`
 * in `index.ts` was a TODO for before Rafael's 2026-09-14 sign-off (see
 * README.md "Enabling in production"). Pulled into its own plain-JS module,
 * same reasoning as `hls-viewer-token.js` and `hls-party-pass.js`: a pure
 * function with no dependency on `log.ts` or on Worker-only globals runs
 * unmodified under `node --test`, so the fail-open/fail-closed/production
 * rules below are pinned by a real test instead of only by Miniflare.
 *
 * WHAT THIS CHECKS, AND WHAT IT DOES NOT. `check()` answers one question --
 * "does the KV denylist name this (userId, channelId) pair" -- against
 * whatever `KVNamespace`-shaped object it is handed. It does not decide
 * WHETHER to call the KV at all, and it does not decide what a caller does
 * with a `revoked: true` answer; `index.ts` owns both of those, because the
 * PRODUCTION-REFUSAL rule (`partyPassRequiresKvInProduction` below) only
 * ever applies to party-pass-authorized requests, never to a `?t=` token's
 * own (already accepted, TTL-bounded) trade-off -- see README.md "What this
 * Worker does NOT make faster" for that distinction.
 *
 * KEYED BY userId:channelId, NOT userId ALONE. A party pass is scoped to one
 * channel (`mintHlsPartyPass` in `server/src/voice/hls-viewer-token.ts`
 * binds `channelId` into the signed claims), so a viewer kicked from one
 * channel must not lose a still-valid pass for another channel they legally
 * hold. `server/src/voice/hls-edge-revocation.ts` writes exactly this key on
 * the origin side.
 *
 * TWO DIFFERENT KINDS OF "NO ANSWER", TWO DIFFERENT DEFAULTS -- unchanged
 * from the pre-sign-off TODO this replaces. An UNCONFIGURED binding (no KV
 * namespace bound at all) fails OPEN: "not revoked". A CONFIGURED binding
 * that THROWS on read fails CLOSED: "revoked", because an operator who bound
 * this namespace is telling the Worker revocation matters to them, and a
 * transient KV error is not the same claim as "nothing is wired up". Either
 * way the caller has a fallback that still works on the same request: the
 * shared cache, or (for a `?t=` viewer) the origin's own always-current
 * check.
 *
 * CACHED, NOT READ ON EVERY POLL. `PARTY_PASS_REVOCATION_CACHE_TTL_MS` (30 s)
 * bounds how stale a cached answer can be -- both a "not revoked" and a
 * "revoked" result are cached for the same window, so a moderator does not
 * need millisecond propagation, only propagation inside the bound this
 * Worker advertises. Without this, a synchronized-expiry event turns into
 * hundreds of KV reads a second landing on KV instead of the Cache API hit
 * this whole Worker exists to serve (Farol flagged the unbounded version of
 * this as a MEDIUM performance regression).
 */

export const PARTY_PASS_REVOCATION_CACHE_TTL_MS = 30_000;
export const PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES = 10_000;

/**
 * One instance per Worker isolate (`index.ts` creates it at module scope,
 * same lifetime as the isolate) -- a class rather than module-level `let`s
 * so a test can hold its own instance instead of racing shared state across
 * `node --test`'s parallel test files.
 */
export class PartyPassRevocationGate {
  constructor() {
    /** @type {Map<string, { revoked: boolean; at: number }>} */
    this._cache = new Map();
  }

  /**
   * @param {{ get(key: string): Promise<unknown> } | null | undefined} kv
   * @param {string} userId
   * @param {string} channelId
   * @param {number} [now]
   * @returns {Promise<{ revoked: boolean; kvError: boolean }>}
   */
  async check(kv, userId, channelId, now = Date.now()) {
    if (!kv) {
      return { revoked: false, kvError: false };
    }
    const key = `${userId}:${channelId}`;
    const cached = this._cache.get(key);
    if (cached && now - cached.at < PARTY_PASS_REVOCATION_CACHE_TTL_MS) {
      return { revoked: cached.revoked, kvError: false };
    }
    let revoked;
    try {
      revoked = (await kv.get(key)) !== null;
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      // Not cached -- a real outage should not pin every request to
      // "revoked" for the next 30 s once the namespace recovers.
      return { revoked: true, kvError: true };
    }
    if (this._cache.size >= PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES) {
      // `userId:channelId` only ever reaches here after a valid token or
      // party-pass signature check, so this is bounded by real distinct
      // viewers, not an attacker-controlled path segment -- still, evicting
      // the oldest entry on overflow costs nothing and keeps this from
      // growing without bound across a very long-running isolate.
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }
    this._cache.set(key, { revoked, at: now });
    return { revoked, kvError: false };
  }
}

/**
 * True when a party-pass-authorized request must be refused outright rather
 * than falling back to the unconfigured-KV fail-open default above --
 * see README.md "Enabling in production". Scoped deliberately narrow: it
 * only ever applies to a request THIS Worker is about to authorize BY a
 * party pass. A `?t=` token's own shared-cache trade-off is unaffected --
 * that gap is already bounded by the token's own TTL (an hour, by default)
 * and was already signed off when `LIVE_HLS_PLAYLIST_BASE_URL` first shipped
 * (#559); a party pass with no KV behind it in production is a SIX HOUR
 * gap with zero mitigation, which is what this refuses instead of shipping
 * quietly wider than the original sign-off covered.
 *
 * @param {{ ENVIRONMENT?: string; HLS_REVOKED_USERS?: unknown }} env
 * @returns {boolean}
 */
export function partyPassRequiresKvInProduction(env) {
  return env.ENVIRONMENT === "production" && !env.HLS_REVOKED_USERS;
}
