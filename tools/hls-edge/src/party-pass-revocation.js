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
 * TWO KEYS PER CHECK, NOT ONE. `userId:channelId` (a kick, a ban, a role
 * losing VIEW -- one viewer) and `channel:channelId` (a channel deleted, or
 * gone private for the whole audience -- no fixed viewer list to key by,
 * see `hls-edge-revocation.ts`'s module doc comment on the origin side).
 * `mintHlsPartyPass` binds `channelId` into a pass's signed claims, so a
 * viewer kicked from one channel must not lose a still-valid pass for
 * another channel they legally hold -- neither key is ever userId alone.
 *
 * THE STORED VALUE IS A TIMESTAMP, NOT A BOOLEAN, AND REVOCATION IS A
 * COMPARISON, NOT A PRESENCE CHECK. A credential names its own `issuedAt`;
 * it is revoked when EITHER key's stored revocation time is newer than
 * that -- the same "was this minted before or after the most recent
 * eviction" rule `hls-revocation.ts`'s in-memory `isHlsAccessRevoked`
 * already applies on the origin. A viewer banned and later un-banned mints
 * a FRESH credential with a newer `issuedAt` than the old ban record, so
 * `check()` correctly reads them as not-revoked again without waiting out
 * the ban record's own TTL -- treating presence alone as revoked (the
 * pre-2026-09-14 shape) would have locked a re-admitted viewer out for up
 * to the party pass's own 6 h ceiling regardless of the un-ban.
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
 * bounds how stale a cached answer can be -- the combined (user, channel)
 * revocation timestamp is cached, not a boolean, so the same cache entry
 * answers correctly for two different credentials with two different
 * `issuedAt` claims polling inside the same 30 s window. Without this, a
 * synchronized-expiry event turns into hundreds of KV reads a second
 * landing on KV instead of the Cache API hit this whole Worker exists to
 * serve (Farol flagged the unbounded version of this as a MEDIUM
 * performance regression).
 */

export const PARTY_PASS_REVOCATION_CACHE_TTL_MS = 30_000;
export const PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES = 10_000;

/**
 * One instance per Worker isolate (`index.ts` creates it at module scope,
 * same lifetime as the isolate) -- a class rather than module-level `let`s
 * so a test can hold its own instance instead of racing shared state across
 * `node --test`'s parallel test files.
 */
/**
 * @param {unknown} raw
 * @returns {number}
 */
function parseTimestamp(raw) {
  if (raw === null || raw === undefined) {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class PartyPassRevocationGate {
  constructor() {
    /** @type {Map<string, { revokedAt: number; at: number }>} */
    this._cache = new Map();
  }

  /**
   * @param {string} cacheKey
   * @returns {{ revokedAt: number; at: number } | undefined}
   */
  _cached(cacheKey, now) {
    const entry = this._cache.get(cacheKey);
    if (entry && now - entry.at < PARTY_PASS_REVOCATION_CACHE_TTL_MS) {
      return entry;
    }
    return undefined;
  }

  _remember(cacheKey, revokedAt, now) {
    if (this._cache.size >= PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES) {
      // The cache key space is bounded by real distinct (viewer, channel)
      // pairs and channels, not an attacker-controlled path segment --
      // still, evicting the oldest entry on overflow costs nothing and
      // keeps this from growing without bound across a very long-running
      // isolate.
      const oldestKey = this._cache.keys().next().value;
      if (oldestKey !== undefined) {
        this._cache.delete(oldestKey);
      }
    }
    this._cache.set(cacheKey, { revokedAt, at: now });
  }

  /**
   * The most recent revocation timestamp recorded at `key`, or 0 if there
   * is none -- 0 rather than `null` because every comparison against it is
   * `revokedAt > issuedAt`, and a real `issuedAt` is always a positive
   * epoch millisecond value, so 0 can never itself read as "revoked".
   * @param {{ get(key: string): Promise<unknown> }} kv
   * @param {string} key
   * @param {number} now
   * @returns {Promise<{ revokedAt: number; kvError: boolean }>}
   */
  async _readOne(kv, key, now) {
    const cached = this._cached(key, now);
    if (cached) {
      return { revokedAt: cached.revokedAt, kvError: false };
    }
    let revokedAt;
    try {
      revokedAt = parseTimestamp(await kv.get(key));
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      // Not cached -- a real outage should not pin every request to
      // "revoked" for the next 30 s once the namespace recovers.
      return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
    }
    this._remember(key, revokedAt, now);
    return { revokedAt, kvError: false };
  }

  /**
   * @param {{ get(key: string): Promise<unknown> } | null | undefined} kv
   * @param {string} userId
   * @param {string} channelId
   * @param {number} issuedAt The credential's own `issuedAt` claim.
   * @param {number} [now]
   * @returns {Promise<{ revoked: boolean; kvError: boolean }>}
   */
  async check(kv, userId, channelId, issuedAt, now = Date.now()) {
    if (!kv) {
      return { revoked: false, kvError: false };
    }
    const [user, channel] = await Promise.all([
      this._readOne(kv, `${userId}:${channelId}`, now),
      this._readOne(kv, `channel:${channelId}`, now),
    ]);
    if (user.kvError || channel.kvError) {
      return { revoked: true, kvError: true };
    }
    const revokedAt = Math.max(user.revokedAt, channel.revokedAt);
    return { revoked: revokedAt > issuedAt, kvError: false };
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
