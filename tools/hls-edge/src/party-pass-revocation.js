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
 * TWO PREFIXES PER CHECK, NOT ONE. `<userId>:<channelId>:` (a kick, a ban, a
 * role losing VIEW -- one viewer) and `channel:<channelId>:` (a channel
 * deleted, or gone private for the whole audience -- no fixed viewer list
 * to key by, see `hls-edge-revocation.ts`'s module doc comment on the
 * origin side). `mintHlsPartyPass` binds `channelId` into a pass's signed
 * claims, so a viewer kicked from one channel must not lose a still-valid
 * pass for another channel they legally hold -- neither prefix is ever
 * userId alone.
 *
 * APPEND-ONLY KEYS, LISTED AND MAXED, NOT ONE MUTABLE KEY READ. Each
 * eviction on the origin writes its OWN key,
 * `<prefix><revokedAtMs>` -- `hls-edge-revocation.ts` never overwrites an
 * existing key, so there is no read-modify-write race to lose (Farol,
 * 2026-09-14: an earlier single-mutable-key design let an older write's
 * PUT clobber a newer one that had already landed, on pure network
 * reordering between two concurrent evictions). `kv.list({ prefix })`
 * reads back every key under a prefix and this gate takes the newest
 * `revokedAtMs` suffix among them -- correct regardless of which PUT
 * landed first, because a `list` is a snapshot read, not a race with a
 * writer the way a conditional PUT would be.
 *
 * REVOCATION IS A COMPARISON, NOT A PRESENCE CHECK. A credential names its
 * own `issuedAt`; it is revoked when the newest listed timestamp under
 * EITHER prefix is newer than that -- the same "was this minted before or
 * after the most recent eviction" rule `hls-revocation.ts`'s in-memory
 * `isHlsAccessRevoked` already applies on the origin. A viewer banned and
 * later un-banned mints a FRESH credential with a newer `issuedAt` than the
 * old ban record, so `check()` correctly reads them as not-revoked again
 * without waiting out the ban record's own TTL -- treating ANY match as
 * revoked (the pre-2026-09-14 shape) would have locked a re-admitted
 * viewer out for up to the party pass's own 6 h ceiling regardless of the
 * un-ban.
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
 * CACHED, NOT LISTED ON EVERY POLL. `PARTY_PASS_REVOCATION_CACHE_TTL_MS`
 * (30 s) bounds how stale a cached answer can be -- the MAX revocation
 * timestamp under a prefix is what gets cached, not a boolean, so the same
 * cache entry answers correctly for two different credentials with two
 * different `issuedAt` claims polling inside the same 30 s window. Without
 * this, a synchronized-expiry event turns into hundreds of KV list calls a
 * second landing on KV instead of the Cache API hit this whole Worker
 * exists to serve (Farol flagged the unbounded version of this as a MEDIUM
 * performance regression).
 *
 * LIST IS NOT PAGINATED HERE ON PURPOSE. A real eviction is a rare,
 * human-triggered event (a kick, a ban) and each key self-expires after
 * the party pass's own 6 h ceiling, so the number of live keys under one
 * prefix is bounded by how many times ONE (userId, channelId) pair (or ONE
 * channel) was evicted inside the last 6 hours -- a handful at most, well
 * inside Cloudflare's default `list` page size. This gate reads the first
 * page and takes the max of what it sees; missing a stray key past that
 * page would only ever make a check MORE permissive by a few keys' worth
 * of margin in a pathological case this design does not expect to hit, not
 * less safe than the single-key design it replaced.
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
 * The `revokedAtMs` suffix of an append-only key, given the prefix it was
 * listed under (`<userId>:<channelId>:` or `channel:<channelId>:`) -- 0 for
 * anything that fails to parse as a positive number, so a malformed or
 * unexpected key name can only ever be ignored, never read as a
 * revocation.
 * @param {string} keyName
 * @param {string} prefix
 * @returns {number}
 */
function suffixTimestamp(keyName, prefix) {
  const parsed = Number(keyName.slice(prefix.length));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
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
   * The newest revocation timestamp among every key listed under `prefix`,
   * or 0 if there are none -- 0 rather than `null` because every
   * comparison against it is `revokedAt > issuedAt`, and a real `issuedAt`
   * is always a positive epoch millisecond value, so 0 can never itself
   * read as "revoked".
   * @param {{ list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }> }} kv
   * @param {string} prefix
   * @param {number} now
   * @returns {Promise<{ revokedAt: number; kvError: boolean }>}
   */
  async _readMaxForPrefix(kv, prefix, now) {
    const cached = this._cached(prefix, now);
    if (cached) {
      return { revokedAt: cached.revokedAt, kvError: false };
    }
    let listed;
    try {
      listed = await kv.list({ prefix });
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      // Not cached -- a real outage should not pin every request to
      // "revoked" for the next 30 s once the namespace recovers.
      return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
    }
    let revokedAt = 0;
    for (const key of listed?.keys ?? []) {
      const ts = suffixTimestamp(key.name, prefix);
      if (ts > revokedAt) {
        revokedAt = ts;
      }
    }
    this._remember(prefix, revokedAt, now);
    return { revokedAt, kvError: false };
  }

  /**
   * @param {{ list(opts: { prefix: string }): Promise<{ keys: { name: string }[] }> } | null | undefined} kv
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
      this._readMaxForPrefix(kv, `${userId}:${channelId}:`, now),
      this._readMaxForPrefix(kv, `channel:${channelId}:`, now),
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
