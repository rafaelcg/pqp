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
 * reordering between two concurrent evictions). A listing reads back
 * every key and this gate takes the newest `revokedAtMs` suffix among the
 * ones under each prefix -- correct regardless of which PUT landed first,
 * because a `list` is a snapshot read, not a race with a writer the way a
 * conditional PUT would be.
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
 * ONE NAMESPACE LISTING PER ISOLATE PER 30 SECONDS, NOT ONE PER VIEWER.
 * `PARTY_PASS_REVOCATION_CACHE_TTL_MS` (30 s) bounds how stale an answer can
 * be, and the unit that is cached is the WHOLE namespace: the first `check()`
 * in a window lists every key (`kv.list` with no prefix, following the cursor
 * to the end), folds them into an in-memory index of `prefix -> newest
 * revokedAtMs`, and every later `check()` for ANY viewer and ANY channel in
 * the window is answered from that index with no KV call at all. The index
 * holds the newest timestamp per prefix, not a boolean, so one snapshot
 * answers correctly for two credentials with two different `issuedAt` claims.
 *
 * WHY THIS REPLACED A PREFIXED LIST PER VIEWER. The gate used to list
 * `<userId>:<channelId>:` and `channel:<channelId>:` separately and cache each
 * per prefix. The user prefix is unique per viewer, so the list rate scaled
 * with the audience (one list per viewer per 30 s per isolate): Cloudflare
 * billed 1.63M list operations in a month against 7k reads. Revocations are
 * rare, human-triggered events and every key self-expires after the party
 * pass ceiling (6 h), so the whole namespace is small, and one listing costs
 * the same however many people are watching. The index is built so that a
 * lookup returns EXACTLY what `kv.list({ prefix })` followed by the old
 * max-suffix scan returned: every colon in a key name is a possible split
 * point (a user or channel id may itself contain one), and a key is indexed
 * under each prefix it has, so a query for `a:b:c:` finds the key
 * `a:b:c:123` whichever way the ids were split. Pinned against a copy of the
 * old implementation over generated namespaces in
 * `party-pass-revocation-differential.test.mjs`.
 *
 * CONCURRENT CALLERS SHARE ONE LISTING. A cold isolate with a few hundred
 * viewers arriving together starts ONE listing and every caller awaits it;
 * only after it settles does a window's worth of callers get an answer. A
 * listing that has been in flight for `LISTING_JOIN_MAX_MS` is not joined any
 * more (a hung KV call must not pin every later caller to it; they start
 * their own, and a stale listing finishing late never overwrites a newer
 * snapshot).
 *
 * A FAILED LISTING IS NEVER CACHED AS "NOTHING IS REVOKED". Every caller
 * waiting on it fails CLOSED (`kvError: true`), nothing is remembered, and
 * the next call after it settles starts a fresh listing. An expired snapshot
 * is never served in place of a failed refresh: that would stretch the signed
 * off 30 s bound for as long as KV stays down.
 *
 * THE PAGE CAP, AND WHAT A NAMESPACE-WIDE LISTING CHANGES ABOUT IT. A single
 * `kv.list` call is one PAGE (1,000 keys), and stopping at the first page
 * silently drops the newest revocation if it sits on a later one, which is a
 * security bug (Farol, 2026-09-14). The listing follows the cursor to
 * `list_complete`, up to `MAX_LIST_PAGES` (10) pages. The old cap was 10
 * pages PER PREFIX; the new one is 10 pages for the whole namespace, so a
 * namespace past 10,000 live keys can now exceed it where no single prefix
 * ever did. Failing closed there would turn a large moderation burst into a
 * refusal for EVERY viewer of EVERY party for up to 6 h (the keys' TTL), a
 * new total-outage mode, so an incomplete listing is NOT trusted and NOT
 * cached as an index: the gate falls back to the previous per-prefix
 * listing (`_readMaxForPrefix`, unchanged, with its own 10-page fail-closed
 * cap) for the rest of the window, which gives the same answers the old gate
 * did, at the old cost, and logs `hlsEdge.revocationNamespaceOverflow` so the
 * condition is visible. The listing is retried once the window closes.
 *
 * THE BINDING IS PART OF THE CACHE KEY. A snapshot answers only for the
 * `KVNamespace` object it was read from; being handed a different one (a
 * test, a rebinding) never reuses another namespace's index.
 */

export const PARTY_PASS_REVOCATION_CACHE_TTL_MS = 30_000;
/** Bound on the per-prefix fallback cache (`_cache`), used only while a namespace listing overflows. */
export const PARTY_PASS_REVOCATION_CACHE_MAX_ENTRIES = 10_000;
/** Pages (1,000 keys each) one listing may follow before it is treated as incomplete. */
export const PARTY_PASS_REVOCATION_MAX_LIST_PAGES = 10;
/**
 * A namespace listing older than this is not joined by a new caller, which
 * starts its own instead -- see the module doc comment. Well above a healthy
 * listing (a few round trips) and well below the 30 s window.
 */
export const PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS = 10_000;

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

/**
 * Folds one key name into `index` (prefix -> newest suffix timestamp) under
 * EVERY prefix of it that ends in a colon. `check()` only ever asks for
 * prefixes of the form `<userId>:<channelId>:` and `channel:<channelId>:`,
 * which end in a colon, but ids may contain colons themselves, so the split
 * between "prefix" and "suffix" is not knowable from the key alone: indexing
 * every colon position makes a lookup equal `startsWith(prefix)` for any
 * prefix a query can build, without ever re-scanning the keys.
 * @param {Map<string, number>} index
 * @param {string} keyName
 */
function indexKey(index, keyName) {
  for (let i = keyName.indexOf(":"); i !== -1; i = keyName.indexOf(":", i + 1)) {
    const prefix = keyName.slice(0, i + 1);
    const ts = suffixTimestamp(keyName, prefix);
    if (ts > (index.get(prefix) ?? 0)) {
      index.set(prefix, ts);
    }
  }
}

/**
 * @typedef {{ list(opts: { prefix?: string, cursor?: string }): Promise<{ keys: { name: string }[], list_complete?: boolean, cursor?: string }> }} KvLike
 * @typedef {{ status: "index", index: Map<string, number> } | { status: "overflow" } | { status: "error" }} ListingResult
 * @typedef {{ kv: KvLike, at: number, index: Map<string, number> | null }} Snapshot
 * @typedef {{ kv: KvLike, startedAt: number, promise: Promise<ListingResult> }} InFlight
 */

/**
 * One instance per Worker isolate (`index.ts` creates it at module scope,
 * same lifetime as the isolate) -- a class rather than module-level `let`s
 * so a test can hold its own instance instead of racing shared state across
 * `node --test`'s parallel test files.
 */
export class PartyPassRevocationGate {
  /**
   * @param {{ log?: (event: string, fields?: Record<string, unknown>) => void }} [options]
   *   `log` is the Worker's `logEvent` (this file stays free of `log.ts` so it
   *   runs under `node --test`); omitted, nothing is logged.
   */
  constructor(options = {}) {
    /** @type {(event: string, fields?: Record<string, unknown>) => void} */
    this._log = typeof options.log === "function" ? options.log : () => {};
    /**
     * Per-prefix cache, used ONLY by the overflow fallback below.
     * @type {Map<string, { revokedAt: number; at: number }>}
     */
    this._cache = new Map();
    /**
     * The last good namespace listing. `index` is null for an OVERFLOWED
     * listing (an incomplete one is never trusted, see the module doc).
     * @type {Snapshot | null}
     */
    this._snapshot = null;
    /** @type {InFlight | null} */
    this._inflight = null;
    /**
     * Cumulative counters, readable by tests and by anything that wants to
     * surface them. `listCalls` is every `kv.list` this gate has issued, the
     * number Cloudflare bills; `listings` counts completed namespace
     * listings, `listingFailures` the ones that failed closed.
     */
    this.stats = { listCalls: 0, listings: 0, listingFailures: 0, listingOverflows: 0 };
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
   * One whole-namespace listing: every key, cursor followed to
   * `list_complete`, at most `PARTY_PASS_REVOCATION_MAX_LIST_PAGES` pages.
   * Never throws. Out of pages with more still unread is `overflow` (an
   * incomplete index must never be trusted or cached), a KV error is `error`.
   * @param {KvLike} kv
   * @returns {Promise<ListingResult>}
   */
  async _listNamespace(kv) {
    const startedMs = Date.now();
    const index = new Map();
    let cursor;
    let keys = 0;
    let pages = 0;
    try {
      for (let page = 0; page < PARTY_PASS_REVOCATION_MAX_LIST_PAGES; page++) {
        this.stats.listCalls += 1;
        pages += 1;
        const listed = await kv.list(cursor ? { cursor } : {});
        for (const key of listed?.keys ?? []) {
          indexKey(index, key.name);
          keys += 1;
        }
        if (listed?.list_complete || !listed?.cursor) {
          this.stats.listings += 1;
          this._log("hlsEdge.revocationListed", { keys, pages, durationMs: Date.now() - startedMs });
          return { status: "index", index };
        }
        cursor = listed.cursor;
      }
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      this.stats.listingFailures += 1;
      this._log("hlsEdge.revocationListFailed", { keys, pages, durationMs: Date.now() - startedMs });
      return { status: "error" };
    }
    this.stats.listingOverflows += 1;
    this._log("hlsEdge.revocationNamespaceOverflow", {
      keys,
      pages,
      maxPages: PARTY_PASS_REVOCATION_MAX_LIST_PAGES,
    });
    return { status: "overflow" };
  }

  /**
   * The listing that answers a call made at `now`: the snapshot while it is
   * inside the window, else the one already in flight, else a new one. An
   * error is never remembered (the next call retries); a good result or an
   * overflow is remembered for the window, stamped with the time the listing
   * STARTED so the 30 s bound is measured from the earliest the read could
   * have happened.
   * @param {KvLike} kv
   * @param {number} now
   * @returns {Promise<ListingResult>}
   */
  _namespaceFor(kv, now) {
    const snapshot = this._snapshot;
    if (snapshot && snapshot.kv === kv && now - snapshot.at < PARTY_PASS_REVOCATION_CACHE_TTL_MS) {
      return Promise.resolve(
        snapshot.index ? { status: "index", index: snapshot.index } : { status: "overflow" },
      );
    }
    const inflight = this._inflight;
    if (
      inflight &&
      inflight.kv === kv &&
      now - inflight.startedAt < PARTY_PASS_REVOCATION_LISTING_JOIN_MAX_MS
    ) {
      return inflight.promise;
    }
    /** @type {InFlight} */
    const record = {
      kv,
      startedAt: now,
      promise: this._listNamespace(kv).then((result) => {
        if (result.status !== "error") {
          const current = this._snapshot;
          // A listing that finishes late must not replace a newer one.
          if (!current || current.kv !== kv || now >= current.at) {
            this._snapshot = { kv, at: now, index: result.status === "index" ? result.index : null };
          }
        }
        if (this._inflight === record) {
          this._inflight = null;
        }
        return result;
      }),
    };
    this._inflight = record;
    return record.promise;
  }

  /**
   * The PER-PREFIX read this gate used before the namespace listing existed,
   * unchanged. It is now only the overflow fallback (see the module doc
   * comment): the newest revocation timestamp among every key listed under
   * `prefix`, or 0 if there are none -- 0 rather than `null` because every
   * comparison against it is `revokedAt > issuedAt`, and a real `issuedAt`
   * is always a positive epoch millisecond value, so 0 can never itself
   * read as "revoked". Follows the cursor to `list_complete`, up to the page
   * cap; running out of pages with more still unread fails CLOSED
   * (`kvError: true`) rather than caching a possibly-incomplete answer.
   * @param {KvLike} kv
   * @param {string} prefix
   * @param {number} now
   * @returns {Promise<{ revokedAt: number; kvError: boolean }>}
   */
  async _readMaxForPrefix(kv, prefix, now) {
    const cached = this._cached(prefix, now);
    if (cached) {
      return { revokedAt: cached.revokedAt, kvError: false };
    }
    let revokedAt = 0;
    let cursor;
    try {
      for (let page = 0; page < PARTY_PASS_REVOCATION_MAX_LIST_PAGES; page++) {
        this.stats.listCalls += 1;
        const listed = await kv.list(cursor ? { prefix, cursor } : { prefix });
        for (const key of listed?.keys ?? []) {
          const ts = suffixTimestamp(key.name, prefix);
          if (ts > revokedAt) {
            revokedAt = ts;
          }
        }
        if (listed?.list_complete || !listed?.cursor) {
          break;
        }
        if (page === PARTY_PASS_REVOCATION_MAX_LIST_PAGES - 1) {
          // Ran out of pages to scan with more still unread -- an
          // incomplete answer is exactly the shape that must never be
          // cached or trusted as "not revoked". Fail CLOSED.
          return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
        }
        cursor = listed.cursor;
      }
    } catch {
      // Bound but unreachable: fail CLOSED (see the module doc comment).
      // Not cached -- a real outage should not pin every request to
      // "revoked" for the next 30 s once the namespace recovers.
      return { revokedAt: Number.POSITIVE_INFINITY, kvError: true };
    }
    this._remember(prefix, revokedAt, now);
    return { revokedAt, kvError: false };
  }

  /**
   * @param {KvLike | null | undefined} kv
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
    const userPrefix = `${userId}:${channelId}:`;
    const channelPrefix = `channel:${channelId}:`;
    const namespace = await this._namespaceFor(kv, now);
    if (namespace.status === "error") {
      return { revoked: true, kvError: true };
    }
    let user;
    let channel;
    if (namespace.status === "index") {
      user = { revokedAt: namespace.index.get(userPrefix) ?? 0, kvError: false };
      channel = { revokedAt: namespace.index.get(channelPrefix) ?? 0, kvError: false };
    } else {
      [user, channel] = await Promise.all([
        this._readMaxForPrefix(kv, userPrefix, now),
        this._readMaxForPrefix(kv, channelPrefix, now),
      ]);
    }
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
