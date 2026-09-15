/**
 * HLS blocking playlist reload (RFC 8216bis §6.2.5.2, "Playlist Delivery
 * Directives") — LL-HLS task L2.1
 * (`docs/plans/LL_HLS.md` §7 "L2: the edge and the players").
 *
 * THE PROBLEM THIS REPLACES. Without this module, a media playlist request
 * either has a rung's answer already or it does not — there is no way for a
 * client to ask "hold this request open until segment N / part P exists".
 * hls.js 1.7 and the native players ask for exactly that once a playlist
 * advertises `EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES` (task L2.2, not this
 * one) by adding `_HLS_msn` (and optionally `_HLS_part`) to the SAME request
 * shape this Worker already answers. **This module changes nothing about a
 * request that carries neither parameter** — `parseBlockingReloadParams`
 * returns `{ kind: "none" }` and `index.ts` falls straight through to its
 * existing cache-or-forward path, byte for byte. Only a request that
 * actually sends a directive reaches anything in this file.
 *
 * WHY PLAIN JS, NOT TYPESCRIPT. Same reasoning as `hls-viewer-token.js`:
 * `node --test` cannot run `.ts` without a build step, and this module is
 * unit-testable as a set of plain functions (no Workers runtime needed — no
 * `crypto.subtle`, no `caches.default`, nothing Workers-only). Keeping it
 * plain JS means `test/hls-blocking-reload.test.mjs` exercises the exact
 * bytes that ship, the same fidelity argument `hls-viewer-token.js`'s doc
 * comment makes.
 *
 * FOUR THINGS THIS FILE DOES, kept as separate pure-ish pieces:
 *
 *  1. **Parse and validate the directives** (`parseBlockingReloadParams`) —
 *     no I/O, no state, a pure function of the URL.
 *  2. **Read the live edge off an already-fetched playlist body**
 *     (`parseLiveEdge`, `isMsnPartAvailable`, `isMsnTooFarAhead`) — pure
 *     functions of playlist text, so a test can hand them a hand-written
 *     manifest string without ever touching the network.
 *  3. **Hold a request open until the edge catches up, or time out**
 *     (`awaitBlockingReload`, `runPollLoop`) — the stateful part, and the
 *     only part that talks to the caller's injected fetch.
 *  4. **Build the Response** (`handleBlockingReload`) — the thin wrapper
 *     `index.ts` actually calls.
 *
 * ORIGIN DISCIPLINE: ONE POLL LOOP PER RENDITION, NOT PER WAITER, NOT A
 * SECOND CACHE. `awaitBlockingReload` is called once per incoming request
 * that carries a directive. Many viewers holding on the SAME rendition
 * (channel + session + rung) — even if they asked for different exact
 * `_HLS_msn`/`_HLS_part` values, which is the normal case since viewers join
 * at different moments — share exactly ONE `pollStates` entry, keyed on the
 * rendition (the same path `index.ts` already uses as its cache key, minus
 * the query string). The FIRST waiter to arrive for a cold rendition starts
 * `runPollLoop`; every waiter that arrives while it is already running just
 * joins `state.waiters` and gets checked against the loop's next fetch (or
 * resolved immediately, with no fetch at all, if the loop's last-known edge
 * is both satisfying AND fresh enough to trust — see "REVOCATION AND
 * FRESHNESS" below). The loop polls the origin at most once per part
 * duration, stops the instant `state.waiters` is empty, and never touches
 * Cloudflare's `caches.default` at all: an LL playlist body is stale in well
 * under a second, which is not a thing worth putting in a cache with any
 * TTL, so this deliberately does NOT add a second cache next to `index.ts`'s
 * existing 2 s one. The actual origin *fetch* — the network call a poll
 * iteration makes — is not reimplemented here either: the caller
 * (`index.ts`) injects a `fetchRendition` closure that wraps its own
 * existing `fetchRenditionCoalesced` single-flight map, so a poll tick here
 * and an ordinary cache-miss fetch on the non-blocking path for the SAME
 * rendition, happening in the same instant, still collapse into one real
 * HTTP request to the API — the exact mechanism this file is told to reuse
 * rather than duplicate. Racing a poll tick against a waiter's own deadline
 * (see "A SLOW ORIGIN DOES NOT OWE A WAITER ITS OWN DEADLINE" below) reuses
 * this same coalescing for free: abandoning a slow tick never cancels the
 * underlying fetch, so the very next tick's call to `fetchRendition` reuses
 * whatever is still in flight instead of starting a second request.
 *
 * REVOCATION AND FRESHNESS. `state.lastEdge`/`state.lastPlaylist` answer a
 * NEW waiter's fast path only while they are younger than
 * `FAST_PATH_FRESHNESS_MS` — the same order of staleness `index.ts`'s own 2 s
 * non-blocking cache already tolerates. This bounds three things Farol's
 * 2026-09-13 review of this file's first draft found, all stemming from the
 * same root cause (retained state with no freshness bound): a rendition that
 * has genuinely moved on being wrongly told "too far ahead" from a long-
 * stale edge (an old edge cannot be trusted for THAT decision either, so it
 * is gated by the same freshness check, not just the availability check); a
 * revoked viewer's still-valid token being served from a fast path with no
 * expiry at all instead of the ~2 s window the non-blocking cache already
 * accepts as a trade-off (see `README.md` "What this Worker does NOT make
 * faster"); and unbounded memory, since a stale-and-idle entry is now both
 * useless (nothing trusts it) and swept (see `sweepIdlePollStates` and
 * `MAX_POLL_STATE_ENTRIES` below). The waiter's TIMEOUT, in contrast,
 * tolerates a stale `partTargetSeconds` on purpose — see
 * "PROVISIONAL TIMEOUTS" below for why that is a different question from
 * trusting stale content.
 *
 * PROVISIONAL TIMEOUTS. A cold rendition's very first waiter has no
 * `PART-TARGET` to time its hold against yet, so its deadline starts
 * provisional (computed from `DEFAULT_PART_TARGET_SECONDS`) and is
 * corrected, once, the moment the first successful fetch reveals the
 * playlist's real `PART-TARGET` — `fixProvisionalDeadlines`. Without this, a
 * playlist with a real target larger than the default would time out a
 * waiter too early (RFC 8216bis's own fallback fires before the promised 3x
 * window), and a smaller one would hold too long. `partTargetSeconds`
 * itself, unlike `lastEdge`/`lastPlaylist`, is read without a freshness
 * check even once known: a part duration is an encoder-config property that
 * does not change mid-session, so a slightly stale value is still the right
 * value, which is why this is a SEPARATE rule from the freshness gate above.
 *
 * A SLOW ORIGIN DOES NOT OWE A WAITER ITS OWN DEADLINE, NOT EVEN ON THE
 * FIRST TICK. `runPollLoop` used to simply `await` each poll tick's fetch
 * before checking any deadline, so an origin that stalled (up to
 * `index.ts`'s own `UPSTREAM_TIMEOUT_MS`) could hold every current waiter
 * well past the 3x-part-target promise this module makes.
 * `fetchWithDeadlineRace` races every tick's fetch against a timer for the
 * soonest waiter's own deadline; if the deadline wins, waiters already due
 * are settled without waiting on the slow fetch further (see "origin
 * discipline" above for why abandoning it here costs nothing). An earlier
 * version of this race only applied once `state.lastPlaylist` existed —
 * "there is nothing to fall back to yet" for the very first tick — which
 * Farol's 2026-09-14 review named as two faces of the same gap: a cold
 * rendition's first waiter could be held for the FULL upstream timeout
 * instead of the documented ~1.5 s hold, and an abort landing while that
 * unbounded first fetch was still in flight left `state.polling` stuck true
 * — unswept, unevictable, joined by every later request for the same key —
 * until the origin eventually answered or never did. The fix is the same
 * for both: race the first tick too. There is genuinely no PLAYLIST to fall
 * back to yet, so a first-tick deadline win settles due waiters with
 * `{ kind: "cold-timeout" }` instead of a timeout-with-a-body (see
 * `settleDueWaiters`), but the request is bounded either way, and so is how
 * long `state.polling` can stay stuck for an abandoned cold rendition —
 * never past that same waiter's own deadline.
 *
 * TWO MORE CEILINGS, ORTHOGONAL TO `MAX_POLL_STATE_ENTRIES`. That cap bounds
 * how many DISTINCT renditions this isolate retains; it says nothing about
 * how many WAITERS pile up on one of them, or how many of them have a poll
 * loop actually RUNNING at once. `MAX_WAITERS_PER_RENDITION` (2,000) caps
 * the former — one popular or attacked rendition otherwise accumulates
 * unbounded concurrent holds under the SAME map entry, which the 500-entry
 * cap does nothing to stop (Farol 2026-09-14: "one valid viewer credential
 * to create an unbounded number of long-lived holds"). `MAX_ACTIVE_POLL_LOOPS`
 * (64) caps the latter — every active loop is its own independent origin
 * poller, so origin-request volume scales with how many renditions are
 * SIMULTANEOUSLY being held open, not with how many are merely retained
 * (Farol 2026-09-14: "hundreds of independent sub-second origin pollers when
 * traffic spans many renditions"). Both are declined with a fallback to the
 * plain non-blocking path, exactly like `MAX_POLL_STATE_ENTRIES`'s own
 * `capacity-fallback` — see `MAX_WAITERS_PER_RENDITION` and
 * `MAX_ACTIVE_POLL_LOOPS`'s own doc comments for the mechanics of each.
 *
 * NON-2XX NEVER POISONS THE RETAINED STATE. A poll tick's response updates
 * `lastPlaylist`/`lastEdge`/`lastFetchedAt` together, and ONLY on a 2xx
 * response — never separately, and never on an error. Every waiter alive at
 * that tick is settled immediately with the error response, the same way a
 * thrown network failure already was, rather than left to time out against
 * whatever the LAST successful fetch said.
 *
 * DISCONNECTED VIEWERS DO NOT KEEP A LOOP ALIVE. `index.ts` passes the
 * incoming request's `AbortSignal` through as `deps.signal`; a waiter whose
 * signal fires is removed from `state.waiters` and settled immediately
 * (`{ kind: "aborted" }`) instead of sitting in the set — polled for,
 * counted toward "keep this loop alive" — until its timeout arrives for a
 * browser tab that is already gone.
 *
 * THE PER-COLO LIMIT, STATED HONESTLY. `pollStates` is a module-level Map:
 * memory local to ONE Worker isolate. Cloudflare runs a busy Worker across
 * more than one isolate, generally one (or a few) per colo a request enters
 * through, and isolates are never shared across colos. So "one origin poll
 * loop per rendition" is true per isolate, which in practice reads as
 * roughly "per colo" — an audience spread across N colos still produces
 * something on the order of N concurrent poll loops for the same rendition,
 * never one truly global loop. That is the same shape `index.ts`'s own
 * README already documents for the non-blocking cache ("Cache API is
 * colo-local, not a single global cache") and is not a new weakening this
 * module introduces; it is a Workers-platform property that any
 * in-isolate-only coalescing strategy inherits. A durable, cross-colo
 * version would need the Durable Object seam `playlist-origin.ts` already
 * reserves for the always-on work (see its doc comment and the commented
 * bindings in `wrangler.jsonc`) — deliberately not reached for here, since
 * introducing a Durable Object is a deploy-time class Cloudflare has to
 * provision, and this task's job is the blocking-reload PROTOCOL, not a new
 * piece of durable infrastructure.
 *
 * WHAT ISN'T HERE (left to later tasks, `docs/plans/LL_HLS.md` §7 "L2"):
 *  - `EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES` / `PART-HOLD-BACK` emission
 *    on the ORIGIN's playlist body — L2.2. This module only ever reacts to a
 *    client that already sends a directive; it never advertises the
 *    capability itself, so nothing changes for a client that never asks.
 *  - `EXT-X-PART` / `EXT-X-PRELOAD-HINT` playlist generation — also L2.2.
 *  - Serving PART byte ranges themselves through this Worker — L2.3.
 *
 * IMPORTS `LL_VIDEO_RUNG` FROM `ll-state.js`, NOTHING ELSE. That module has
 * no imports of its own, so this stays a one-way, non-circular edge purely
 * to reuse the ONE constant that names the video rung, rather than
 * hardcoding the string `"ll"` a second time here.
 *
 * THE VIDEO RUNG'S HOLD BUDGET IS NOT THE PLAIN 3x-PART-TARGET FORMULA. PR
 * #629 (merged b06cf621, `tools/pqp-remux`) made the remux honest about a
 * quiet video source: on a static tab share a video part may take up to ~1s
 * to appear, and after a genuine freeze the next video part waits on the
 * keyframe gate -- a PLI every 4s, answered in ~1s -- so the next part can be
 * ~5s away. The plain formula (3 x the 500ms default PART-TARGET = 1.5s) is
 * nowhere near that, and it timed out in production
 * (`hlsEdge.blockingReloadTimeout`, 2026-09-15 15:10:40 UTC), stalling the
 * player. `VIDEO_RUNG_HOLD_BUDGET_MS` replaces the formula for exactly the
 * VIDEO rung (`ll`, `LL_VIDEO_RUNG`) with a flat 6s -- the ~5s worst case
 * plus margin, still well inside RFC 8216bis's own ceiling of
 * `3 x TARGETDURATION` (~18s here). See that constant's own doc comment for
 * the mechanics: it replaces the deadline calculation only -- the poll
 * cadence stays the plain `currentPollIntervalMs` for the FIRST
 * `VIDEO_RUNG_FAST_POLL_WINDOW_MS` of a video hold (1.5s, the old budget),
 * then backs off to `VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS` for the remainder
 * (see `pollIntervalForLoop`), so the extra ~4.5s this change adds does not
 * poll the origin at the fast cadence the whole way through (Farol
 * 2026-09-15, PR #634). It is never "provisional" the way the plain
 * formula's deadline is -- there is nothing to correct once a real
 * `PART-TARGET` is known, because the video budget never depended on it.
 * `ll-audio` (`LL_AUDIO_RUNG`) never idles this way and keeps the plain
 * formula and cadence, and so does the conventional (non-LL) path, which
 * never reaches this file at all regardless (see "THE PROBLEM THIS
 * REPLACES" above).
 */

import { LL_VIDEO_RUNG } from "./ll-state.js";

/** Query parameter names, verbatim from RFC 8216bis §6.2.5.2. */
export const HLS_MSN_PARAM = "_HLS_msn";
export const HLS_PART_PARAM = "_HLS_part";

/**
 * Used only when a playlist carries no `EXT-X-PART-INF:PART-TARGET=...` yet
 * (a cold rendition, or one this Worker has not seen a fresh fetch for) —
 * `docs/plans/LL_HLS.md` §1 pins the target part duration at 500 ms. Once a
 * real fetch reveals the playlist's own `PART-TARGET`, that value is used
 * instead (see "PROVISIONAL TIMEOUTS" above) — this constant is a floor for
 * "we do not know yet", not an override of what the origin says.
 */
export const DEFAULT_PART_TARGET_SECONDS = 0.5;

/** The hold's hard timeout, in units of the target part duration, per L2.1's spec. Used for every rendition except the video rung -- see `VIDEO_RUNG_HOLD_BUDGET_MS`. */
const TIMEOUT_PART_MULTIPLIER = 3;

/**
 * The VIDEO rung's (`ll`, `LL_VIDEO_RUNG`) own hold budget, replacing
 * `TIMEOUT_PART_MULTIPLIER x PART-TARGET` for that one rendition. See the
 * module doc comment, "THE VIDEO RUNG'S HOLD BUDGET IS NOT THE PLAIN
 * 3x-PART-TARGET FORMULA", for the full derivation -- in short: a quiet tab
 * share's next video part can lag up to ~1s, and a part that follows a
 * genuine freeze waits on a PLI/keyframe round trip (a PLI every 4s,
 * answered in ~1s), putting the next part as much as ~5s away. 6s is that
 * ~5s worst case plus margin, and still comfortably inside RFC 8216bis's own
 * ceiling of `3 x TARGETDURATION` (~18s at this deployment's 4s
 * TARGETDURATION). `ll-audio` never idles this way and keeps the plain
 * multiplier above.
 */
export const VIDEO_RUNG_HOLD_BUDGET_MS = 6_000;

/**
 * How long a video-rung poll LOOP keeps the plain PART-TARGET cadence before
 * backing off -- see `pollIntervalForLoop`'s doc comment for the full
 * reasoning (Farol 2026-09-15, PR #634). Set to exactly the OLD budget
 * (`TIMEOUT_PART_MULTIPLIER x` the 500ms default = 1.5s) on purpose: a video
 * hold polls exactly like every other rendition until the moment the old,
 * pre-this-PR formula would already have given up, and only backs off past
 * that point, where the extra time is new.
 */
export const VIDEO_RUNG_FAST_POLL_WINDOW_MS = 1_500;

/**
 * The video rung's poll cadence once `VIDEO_RUNG_FAST_POLL_WINDOW_MS` has
 * elapsed on its loop -- see `pollIntervalForLoop`'s doc comment. A flat 1s
 * (not `PART-TARGET x 2`, which would vary the backoff cadence with the
 * source's own part duration for no real benefit here): simple, well above
 * the fast cadence, and still frequent enough that the loop's LAST tick
 * lands close to the 6s deadline rather than overshooting it by a full
 * backoff interval (the trailing `Math.min(intervalMs, soonestDeadline -
 * now())` in `runPollLoop` shortens that final wait regardless).
 */
export const VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS = 1_000;

/** Guards against a pathological (zero or tiny) PART-TARGET turning the poll loop into a busy-wait. */
const MIN_POLL_INTERVAL_MS = 20;

/**
 * How long retained `lastEdge`/`lastPlaylist` state may answer a NEW
 * waiter's fast path (availability AND too-far-ahead) without a fresh origin
 * fetch. See the module doc comment, "REVOCATION AND FRESHNESS". Matches
 * `CACHE_TTL_SECONDS` on the non-blocking path in `index.ts`.
 */
const FAST_PATH_FRESHNESS_MS = 2_000;

/**
 * Ceiling on distinct renditions (channel + session + rung) this isolate
 * retains poll state for at once. A viewer with an otherwise-valid token can
 * choose the `rung` segment freely, so an attacker cycling through many
 * distinct rung values could otherwise grow `pollStates` without bound —
 * `sweepIdlePollStates` handles the ordinary case (idle entries expiring),
 * this handles a sustained flood of genuinely distinct, still-fresh keys.
 * Same shape as `REJECTION_LOG_MAX_ENTRIES` in `index.ts`.
 *
 * WHAT HAPPENS AT THE CEILING. `insertPollState` only ever evicts an IDLE
 * entry (no waiters, no running loop) to make room — never an active one.
 * Evicting an active rendition would split its waiters across two
 * independent states: the ones already registered on the evicted entry would
 * be orphaned (nothing left polls or settles them, since the loop closure
 * still points at the old, now-unreachable `state` object), and the very
 * next waiter for that same key would start a SECOND poll loop for the
 * identical rendition, exactly the duplicate-loop failure "ORIGIN
 * DISCIPLINE" above exists to prevent. So when the map is full and every
 * entry is active, a brand-new rendition key gets NO entry at all —
 * `awaitBlockingReload` returns `{ kind: "capacity-fallback" }` and the
 * caller (`handleBlockingReload` / `index.ts`) serves that one request
 * through the plain non-blocking cache-or-forward path instead. This is
 * correct RFC 8216bis behaviour on its own terms: §6.2.5.2 says a server MAY
 * ignore a Playlist Delivery Directive it does not want to honour, and a
 * saturated isolate declining to open one more hold is exactly that.
 */
export const MAX_POLL_STATE_ENTRIES = 500;

/**
 * Ceiling on waiters a SINGLE rendition's poll-state entry will retain.
 * `MAX_POLL_STATE_ENTRIES` bounds how many DISTINCT renditions this isolate
 * holds at once; it does nothing to stop one popular (or attacked) rendition
 * from accumulating unbounded waiters of its own — a caller with one
 * otherwise-valid viewer token can open as many concurrent holds on the SAME
 * rendition as it likes, each parked in `state.waiters` until the playlist
 * advances, its own timeout fires, or it aborts (Farol 2026-09-14: "one
 * valid viewer credential to create an unbounded number of long-lived
 * holds"). Past this many LIVE waiters on one rendition, a new request for
 * it is answered the plain, non-blocking way instead
 * (`{ kind: "waiter-cap-fallback" }`) — it still gets a playlist, just not a
 * hold, exactly like `MAX_POLL_STATE_ENTRIES`'s own capacity-fallback.
 * `hlsEdge.blockingWaiterCapHit` counts how often this actually bites.
 */
export const MAX_WAITERS_PER_RENDITION = 2_000;

/**
 * Ceiling on renditions with a poll loop actively RUNNING (`state.polling
 * === true`) at once, distinct from `MAX_POLL_STATE_ENTRIES` (which bounds
 * how many renditions are RETAINED, active or idle). Every active loop polls
 * the origin on its own schedule — Farol 2026-09-14: "hundreds of
 * independent sub-second origin pollers when traffic spans many renditions"
 * — so the origin-request rate this module can generate scales with the
 * number of SIMULTANEOUSLY ACTIVE loops, not the size of the retained map. A
 * request that would need to (re)start a loop, once this many are already
 * running, is answered the plain, non-blocking way instead
 * (`{ kind: "loop-cap-fallback" }`): the newest renditions lose their hold
 * first, the existing ones keep polling uninterrupted. Deliberately computed
 * from `pollStates` itself (`countActivePollLoops`) rather than tracked as a
 * separately incremented/decremented counter — a manually maintained counter
 * can only go stale (a `finally` block firing for a poll loop whose entry a
 * test, or a future eviction path, already dropped from the map would
 * decrement a counter nothing else agrees with), where a live scan of the
 * map's own `polling` flags cannot.
 */
export const MAX_ACTIVE_POLL_LOOPS = 64;

/** How often the opportunistic idle sweep is allowed to run a full scan. Same shape as `index.ts`'s `REJECTION_LOG_SWEEP_INTERVAL_MS`. */
const POLL_STATE_SWEEP_INTERVAL_MS = 10_000;

let pollStatesLastSweptAt = 0;

/**
 * Throttle for the "poll-state map is saturated with active renditions" log
 * line (`hlsEdge.blockingReloadCapacityFallback`) — a client that keeps
 * requesting distinct rungs while the map is full would otherwise turn every
 * one of those requests into its own log write, the same write-amplifier
 * shape pitfall 16 in `CLAUDE.md` warns about. Real wall-clock time on
 * purpose: this fires from `handleBlockingReload`, which (unlike
 * `awaitBlockingReload`) has no injected fake clock to be deterministic
 * against in tests, and the exact cadence of this log line is not something
 * any test needs to pin to the microsecond.
 */
const CAPACITY_FALLBACK_LOG_INTERVAL_MS = 60_000;
let capacityFallbackLastLoggedAt = 0;

/** Same throttling shape as `CAPACITY_FALLBACK_LOG_INTERVAL_MS`, for `hlsEdge.blockingWaiterCapHit`. */
const WAITER_CAP_LOG_INTERVAL_MS = 60_000;
let waiterCapFallbackLastLoggedAt = 0;

/** Same throttling shape as `CAPACITY_FALLBACK_LOG_INTERVAL_MS`, for `hlsEdge.blockingReloadLoopCapFallback`. */
const LOOP_CAP_LOG_INTERVAL_MS = 60_000;
let loopCapFallbackLastLoggedAt = 0;

/**
 * @typedef {{ msn: number, part?: number }} BlockingReloadDirectives
 */

/**
 * @typedef {
 *   { kind: "none" } |
 *   { kind: "directives", value: BlockingReloadDirectives } |
 *   { kind: "invalid", reason: string }
 * } ParsedBlockingReloadParams
 */

/**
 * @param {string} raw
 * @returns {number | null}
 */
function parseNonNegativeInteger(raw) {
  // A single check that rejects everything the spec wants rejected in one
  // place: a leading `-` (negative), a decimal point or exponent
  // (non-integer), whitespace, and empty strings all fail this pattern.
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Reads and validates `_HLS_msn` / `_HLS_part` off a request URL. Pure: no
 * network, no shared state, safe to call for every request regardless of
 * whether it turns out to carry a rung.
 *
 * @param {URL} url
 * @returns {ParsedBlockingReloadParams}
 */
export function parseBlockingReloadParams(url) {
  const msnRaw = url.searchParams.get(HLS_MSN_PARAM);
  const partRaw = url.searchParams.get(HLS_PART_PARAM);
  if (msnRaw === null && partRaw === null) {
    return { kind: "none" };
  }
  if (msnRaw === null) {
    // RFC 8216bis: "_HLS_part MUST NOT be present without _HLS_msn."
    return { kind: "invalid", reason: "part-without-msn" };
  }
  const msn = parseNonNegativeInteger(msnRaw);
  if (msn === null) {
    return { kind: "invalid", reason: "invalid-msn" };
  }
  if (partRaw === null) {
    return { kind: "directives", value: { msn } };
  }
  const part = parseNonNegativeInteger(partRaw);
  if (part === null) {
    return { kind: "invalid", reason: "invalid-part" };
  }
  return { kind: "directives", value: { msn, part } };
}

/**
 * @typedef {{
 *   lastCompleteMsn: number,
 *   partialMsn: number | null,
 *   partialPartCount: number,
 *   partTargetSeconds: number | null,
 * }} PlaylistLiveEdge
 */

const MEDIA_SEQUENCE_RE = /^#EXT-X-MEDIA-SEQUENCE:(\d+)/m;
const PART_TARGET_RE = /PART-TARGET=([0-9]*\.?[0-9]+)/;

/**
 * Reads the "live edge" off a playlist body: the newest fully-published
 * segment, and how far into the NEXT segment's parts the playlist has gotten
 * (if that segment is being built via `EXT-X-PART` lines rather than a
 * finished `EXTINF`).
 *
 * Deliberately a light-touch parse, not a full playlist model: it counts
 * `#EXTINF:` lines to learn how many complete segments are listed (a
 * playlist never lists an `EXTINF` for a segment that has not finished, so
 * `EXT-X-MEDIA-SEQUENCE + count(EXTINF) - 1` is the newest complete segment's
 * own Media Sequence Number), then counts any `#EXT-X-PART:` lines trailing
 * AFTER the last `EXTINF` — those describe the one segment currently being
 * assembled from parts, whose own Media Sequence Number is one past the last
 * complete segment's.
 *
 * @param {string} playlistText
 * @returns {PlaylistLiveEdge}
 */
export function parseLiveEdge(playlistText) {
  const mediaSequence = Number(MEDIA_SEQUENCE_RE.exec(playlistText)?.[1] ?? "0");
  const lines = playlistText.split(/\r?\n/);

  let fullSegmentCount = 0;
  let lastExtinfLineIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].startsWith("#EXTINF:")) {
      fullSegmentCount += 1;
      lastExtinfLineIndex = i;
    }
  }

  let trailingPartCount = 0;
  for (let i = lastExtinfLineIndex + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith("#EXT-X-PART:")) {
      trailingPartCount += 1;
    }
  }

  const lastCompleteMsn = mediaSequence + fullSegmentCount - 1;
  const partTargetMatch = PART_TARGET_RE.exec(playlistText);
  return {
    lastCompleteMsn,
    partialMsn: trailingPartCount > 0 ? lastCompleteMsn + 1 : null,
    partialPartCount: trailingPartCount,
    partTargetSeconds: partTargetMatch ? Number(partTargetMatch[1]) : null,
  };
}

/**
 * Is `requested` already answerable from `edge` — i.e. does the playlist
 * already contain it? A Media Sequence Number, once complete, stays
 * available (segments are never un-published within a hold's lifetime), so
 * `requested.msn <= edge.lastCompleteMsn` is sufficient on its own regardless
 * of `requested.part`: a complete segment implicitly contains every one of
 * its parts. Only a request for the segment CURRENTLY being built needs the
 * finer per-part check.
 *
 * @param {PlaylistLiveEdge} edge
 * @param {BlockingReloadDirectives} requested
 * @returns {boolean}
 */
export function isMsnPartAvailable(edge, requested) {
  if (requested.msn <= edge.lastCompleteMsn) {
    return true;
  }
  if (edge.partialMsn !== null && requested.msn === edge.partialMsn) {
    if (requested.part === undefined) {
      // A whole-segment request for the segment that is still only partial:
      // not yet available, no matter how many parts have landed.
      return false;
    }
    return edge.partialPartCount > requested.part;
  }
  return false;
}

/**
 * RFC 8216bis §6.2.5.2: "If the _HLS_msn is greater than the Media Sequence
 * Number of the last Media Segment in the Playlist plus two, [...] the
 * server SHOULD respond with 400 Bad Request." The "last Media Segment" for
 * this purpose is whichever is newer: the last complete segment, or the one
 * currently being assembled from parts.
 *
 * @param {PlaylistLiveEdge} edge
 * @param {BlockingReloadDirectives} requested
 * @returns {boolean}
 */
export function isMsnTooFarAhead(edge, requested) {
  const liveEdgeMsn = edge.partialMsn ?? edge.lastCompleteMsn;
  return requested.msn > liveEdgeMsn + 2;
}

/**
 * @typedef {{ status: number, headers: Headers, body: ArrayBuffer }} FetchedPlaylist
 */

/**
 * @typedef {
 *   { kind: "available", playlist: FetchedPlaylist } |
 *   { kind: "timeout", playlist: FetchedPlaylist } |
 *   { kind: "cold-timeout" } |
 *   { kind: "too-far-ahead" } |
 *   { kind: "origin-error", playlist: FetchedPlaylist } |
 *   { kind: "aborted" } |
 *   { kind: "capacity-fallback" } |
 *   { kind: "waiter-cap-fallback" } |
 *   { kind: "loop-cap-fallback" }
 * } BlockingReloadOutcome
 */

/**
 * @typedef {{
 *   fetchRendition: () => Promise<FetchedPlaylist>,
 *   signal?: AbortSignal,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 *   rung?: string,
 * }} BlockingReloadDeps
 */

/**
 * @typedef {{
 *   requested: BlockingReloadDirectives,
 *   registeredAt: number,
 *   deadlineAt: number,
 *   provisional: boolean,
 *   settle: (outcome: BlockingReloadOutcome) => void,
 *   fail: (err: unknown) => void,
 * }} Waiter
 */

/**
 * @typedef {{
 *   waiters: Set<Waiter>,
 *   lastPlaylist: FetchedPlaylist | null,
 *   lastEdge: PlaylistLiveEdge | null,
 *   lastFetchedAt: number,
 *   polling: boolean,
 *   pollLoopStartedAt: number,
 * }} RenditionPollState
 */

/** One entry per rendition (channel + session + rung) this isolate currently has a hold open for. */
const pollStates = new Map();

/** @param {number} ms @returns {Promise<void>} */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {FetchedPlaylist} fetched
 * @returns {string}
 */
function decodeText(fetched) {
  return new TextDecoder().decode(fetched.body);
}

/**
 * @param {PlaylistLiveEdge | null} edge
 * @returns {number}
 */
function currentPollIntervalMs(edge) {
  const seconds = edge?.partTargetSeconds ?? DEFAULT_PART_TARGET_SECONDS;
  return Math.max(MIN_POLL_INTERVAL_MS, Math.round(seconds * 1000));
}

/**
 * The video rung's poll LOOP cadence (distinct from `currentPollIntervalMs`,
 * which this wraps and which stays the plain PART-TARGET-derived value for
 * every other rendition, and for a video hold's own first
 * `VIDEO_RUNG_FAST_POLL_WINDOW_MS`). Farol's 2026-09-15 review of PR #634
 * named this directly: extending the deadline to 6s while polling stayed at
 * the plain ~500ms cadence the whole time meant a quiet/frozen video
 * rendition got polled roughly 12 times before timing out instead of the old
 * ~3, multiplying origin traffic for exactly the case (a genuinely quiet or
 * frozen source) this fix exists to tolerate rather than time out on. So a
 * video hold keeps the plain cadence only for its first
 * `VIDEO_RUNG_FAST_POLL_WINDOW_MS` (1.5s -- deliberately the OLD budget, so
 * a video rendition's polling is indistinguishable from every other
 * rendition's for exactly as long as the old formula would already have
 * given up) and backs off to `VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS` (1s) for
 * the rest of its 6s budget. This governs the tick-to-tick PACING sleep in
 * `runPollLoop` only -- it never changes `fetchWithDeadlineRace`'s own
 * per-waiter deadline race, and the trailing
 * `Math.min(intervalMs, soonestDeadline - now())` in `runPollLoop` still
 * shortens the final wait so the loop lands on time at the 6s deadline
 * either way.
 *
 * @param {PlaylistLiveEdge | null} edge
 * @param {boolean} isVideoRung
 * @param {number} loopElapsedMs - `now() - state.pollLoopStartedAt`: how long THIS run of the poll loop has been going, not any one waiter's own hold time.
 * @returns {number}
 */
function pollIntervalForLoop(edge, isVideoRung, loopElapsedMs) {
  const baseMs = currentPollIntervalMs(edge);
  if (isVideoRung && loopElapsedMs >= VIDEO_RUNG_FAST_POLL_WINDOW_MS) {
    return Math.max(baseMs, VIDEO_RUNG_BACKOFF_POLL_INTERVAL_MS);
  }
  return baseMs;
}

/**
 * Opportunistic, throttled eviction of idle poll-state entries whose
 * retained data has already aged out of the fast path anyway (see the
 * module doc comment, "REVOCATION AND FRESHNESS"). Never touches an entry
 * with an active loop or a live waiter — only genuinely idle, stale ones.
 *
 * @param {number} nowMs
 */
function sweepIdlePollStates(nowMs) {
  if (nowMs - pollStatesLastSweptAt < POLL_STATE_SWEEP_INTERVAL_MS) {
    return;
  }
  pollStatesLastSweptAt = nowMs;
  for (const [key, state] of pollStates) {
    if (
      !state.polling &&
      state.waiters.size === 0 &&
      nowMs - state.lastFetchedAt >= FAST_PATH_FRESHNESS_MS
    ) {
      pollStates.delete(key);
    }
  }
}

/**
 * How many renditions currently have a poll loop actually running — see the
 * module doc comment on `MAX_ACTIVE_POLL_LOOPS` for why this is a live scan
 * rather than a maintained counter. `pollStates` is capped at
 * `MAX_POLL_STATE_ENTRIES` (500), so this is a cheap, bounded scan, and it
 * only runs when a request is about to (re)start a loop — the common case
 * (joining an already-running loop) never calls it.
 *
 * @returns {number}
 */
function countActivePollLoops() {
  let count = 0;
  for (const state of pollStates.values()) {
    if (state.polling) {
      count += 1;
    }
  }
  return count;
}

/**
 * Inserts a new poll-state entry, evicting one first if `pollStates` is at
 * `MAX_POLL_STATE_ENTRIES` — but ONLY an idle entry (no waiters, no running
 * loop). Never evicts a rendition with a live loop or waiter: doing so would
 * orphan whatever waiters were already registered on the evicted state (its
 * loop closure still points at that now-unreachable object, so nothing would
 * ever poll or settle them again) and would start a SECOND, duplicate poll
 * loop for the same rendition the moment its next request arrives — see the
 * module doc comment on `MAX_POLL_STATE_ENTRIES`.
 *
 * Returns `false`, without inserting anything, when the map is already at
 * capacity and every entry is active. The caller (`awaitBlockingReload`)
 * treats that as "no room for this rendition right now" and falls back to
 * serving the request without a hold at all, rather than picking some other
 * active entry to sacrifice.
 *
 * @param {string} key
 * @param {RenditionPollState} state
 * @returns {boolean}
 */
function insertPollState(key, state) {
  if (pollStates.size >= MAX_POLL_STATE_ENTRIES) {
    let evictedIdle = false;
    for (const [existingKey, existingState] of pollStates) {
      if (!existingState.polling && existingState.waiters.size === 0) {
        pollStates.delete(existingKey);
        evictedIdle = true;
        break;
      }
    }
    if (!evictedIdle) {
      return false;
    }
  }
  pollStates.set(key, state);
  return true;
}

/**
 * Holds one request's Promise open until `renditionKey`'s playlist advances
 * to contain `requested`, the request turns out to be too far ahead of the
 * live edge, the caller's `signal` aborts, or the hold's own deadline passes
 * — whichever comes first. That deadline is `TIMEOUT_PART_MULTIPLIER` part
 * durations for every rendition except `deps.rung === LL_VIDEO_RUNG`, which
 * gets the flat `VIDEO_RUNG_HOLD_BUDGET_MS` instead — see the module doc
 * comment, "THE VIDEO RUNG'S HOLD BUDGET IS NOT THE PLAIN 3x-PART-TARGET
 * FORMULA". Never issues an origin fetch itself; every fetch goes through
 * `deps.fetchRendition`, which `index.ts` wires to its existing
 * single-flight `fetchRenditionCoalesced`, so this function's only job is
 * deciding WHEN to call that closure and WHO to wake up with the result.
 *
 * @param {string} renditionKey
 * @param {BlockingReloadDirectives} requested
 * @param {BlockingReloadDeps} deps
 * @returns {Promise<BlockingReloadOutcome>}
 */
export async function awaitBlockingReload(renditionKey, requested, deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const signal = deps.signal;
  const nowMs = now();

  // An already-gone caller gets the same outcome, checked BEFORE anything
  // else -- including the retained-state fast path just below. Farol's
  // 2026-09-14 finding: that fast path used to answer (or reject) straight
  // from `state.lastEdge`/`state.lastPlaylist` with no abort check at all, so
  // a request whose signal was already aborted before this function even ran
  // could still come back "available" or "too-far-ahead" instead of
  // "aborted" -- serving a body nothing was left to read. Checking here,
  // before the fast path AND before touching `pollStates` at all, means an
  // aborted caller never contends for capacity or a fetch either.
  if (signal && signal.aborted) {
    return { kind: "aborted" };
  }

  sweepIdlePollStates(nowMs);

  let state = pollStates.get(renditionKey);
  let insertedNewState = false;
  if (!state) {
    const candidate = {
      waiters: new Set(),
      lastPlaylist: null,
      lastEdge: null,
      lastFetchedAt: 0,
      polling: false,
      pollLoopStartedAt: 0,
    };
    if (!insertPollState(renditionKey, candidate)) {
      // The map is full and every entry is active -- see `insertPollState`
      // and the module doc comment on `MAX_POLL_STATE_ENTRIES`. Rather than
      // evict a live rendition (which would orphan its waiters and spawn a
      // duplicate loop the next time it's asked for), this ONE request goes
      // unheld: the caller falls back to its own plain, non-blocking fetch.
      return { kind: "capacity-fallback" };
    }
    state = candidate;
    insertedNewState = true;
  }

  // Fast path: this isolate already knows enough, from a recent fetch on
  // this same rendition, to answer without touching the origin at all. Only
  // trusted while fresh -- see the module doc comment, "REVOCATION AND
  // FRESHNESS" -- so a rendition this isolate has not heard from in a while
  // always falls through to a real fetch below instead of answering (or
  // rejecting) from long-stale content.
  const freshEnough = state.lastEdge !== null && nowMs - state.lastFetchedAt < FAST_PATH_FRESHNESS_MS;
  if (freshEnough) {
    if (isMsnTooFarAhead(state.lastEdge, requested)) {
      return { kind: "too-far-ahead" };
    }
    if (isMsnPartAvailable(state.lastEdge, requested) && state.lastPlaylist) {
      return { kind: "available", playlist: state.lastPlaylist };
    }
  }

  // A request that would need a FRESH loop (nothing is currently polling
  // this rendition) is declined once this isolate is already running
  // `MAX_ACTIVE_POLL_LOOPS` of them -- see that constant's doc comment.
  // Joining an ALREADY-running loop (the common case at party scale, many
  // viewers on the same rendition) never reaches this: `state.polling` is
  // true for it, so `needsNewLoop` is false and no cap applies.
  const needsNewLoop = !state.polling;
  if (needsNewLoop && countActivePollLoops() >= MAX_ACTIVE_POLL_LOOPS) {
    if (insertedNewState) {
      // Never actually going to be polled -- free the slot immediately
      // rather than leaving an idle placeholder (it would just sit there
      // until the next sweep anyway, but there is no reason to make some
      // OTHER rendition wait for that sweep to get a map slot).
      pollStates.delete(renditionKey);
    }
    return { kind: "loop-cap-fallback" };
  }

  // Only reachable while JOINING an already-running loop: `needsNewLoop`
  // above already returned for a brand-new (0-waiter) state, so this can
  // only trip for a rendition that already has waiters of its own -- see
  // `MAX_WAITERS_PER_RENDITION`'s doc comment.
  if (state.waiters.size >= MAX_WAITERS_PER_RENDITION) {
    return { kind: "waiter-cap-fallback" };
  }

  // `partTargetSeconds`, unlike the rest of `lastEdge`, is trusted even when
  // stale -- see the module doc comment, "PROVISIONAL TIMEOUTS".
  const knownPartTargetSeconds = state.lastEdge?.partTargetSeconds ?? null;
  // The video rung gets a flat, larger budget instead of the plain formula
  // -- see the module doc comment, "THE VIDEO RUNG'S HOLD BUDGET IS NOT THE
  // PLAIN 3x-PART-TARGET FORMULA", and `VIDEO_RUNG_HOLD_BUDGET_MS`'s own doc
  // comment. Every other rendition (including `ll-audio` and the
  // conventional path) is unaffected: `deps.rung` is only ever
  // `LL_VIDEO_RUNG` for a request `index.ts` already identified as the video
  // rendition (`context.rung` in `handleBlockingReload`, forwarded here
  // unchanged), and every existing caller that does not pass `rung` at all
  // (tests, and any future caller) keeps today's formula exactly.
  const isVideoRung = deps.rung === LL_VIDEO_RUNG;
  const timeoutMs = isVideoRung
    ? VIDEO_RUNG_HOLD_BUDGET_MS
    : currentPollIntervalMs(state.lastEdge) * TIMEOUT_PART_MULTIPLIER;
  // A LONGER budget does not mean an UNBOUNDED number of in-flight waiters
  // on the video rung -- Farol 2026-09-15 (PR #634) asked this be cited
  // explicitly: `MAX_WAITERS_PER_RENDITION` (2,000, above) already caps
  // waiters on ANY single rendition, video included, and once hit a new
  // waiter fails fast into `{ kind: "waiter-cap-fallback" }` (checked just
  // above, before this point) rather than being added here -- it still gets
  // served the current playlist through the plain non-blocking path, never
  // an error. `MAX_ACTIVE_POLL_LOOPS` (64) and `MAX_POLL_STATE_ENTRIES`
  // (500) are the other two ceilings in the same three-tier admission
  // control, also unmodified and also rung-agnostic. Holding a video waiter
  // 4x longer (6s vs. the old ~1.5s) does mean, at a fixed arrival rate,
  // roughly 4x as many concurrent video waiters for a given rendition --
  // which is exactly what makes MAX_WAITERS_PER_RENDITION's existing 2,000
  // ceiling reachable sooner under sustained load on one rendition, by
  // design: it still fails new waiters fast once reached.

  return new Promise((resolve, reject) => {
    /** @type {Waiter} */
    let waiter;
    const cleanup = () => {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
    };
    const settle = (outcome) => {
      cleanup();
      resolve(outcome);
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };
    const onAbort = () => {
      state.waiters.delete(waiter);
      settle({ kind: "aborted" });
    };

    waiter = {
      requested,
      registeredAt: nowMs,
      deadlineAt: nowMs + timeoutMs,
      // The video rung's deadline never needs correcting -- it does not
      // depend on `PART-TARGET` in the first place, unlike the plain
      // formula's provisional guess (see "PROVISIONAL TIMEOUTS"). Marking it
      // non-provisional keeps `fixProvisionalDeadlines` from ever touching
      // it once a real `PART-TARGET` becomes known.
      provisional: !isVideoRung && knownPartTargetSeconds === null,
      settle,
      fail,
    };

    if (signal) {
      if (signal.aborted) {
        // Already gone before this request ever joined the waiter set.
        settle({ kind: "aborted" });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    state.waiters.add(waiter);
    if (!state.polling) {
      state.polling = true;
      // Marks when THIS run of the loop started, not any one waiter's own
      // `registeredAt` -- the video rung's poll backoff
      // (`pollIntervalForLoop`) measures elapsed time against the loop, since
      // it is the loop's own cadence that backs off, shared by every waiter
      // currently joined to it.
      state.pollLoopStartedAt = nowMs;
      void runPollLoop(renditionKey, state, deps, now, sleep);
    }
  });
}

/**
 * Corrects every still-provisional waiter's deadline the moment a real
 * `PART-TARGET` becomes known, so a cold rendition's hold times out against
 * the playlist's ACTUAL part duration rather than the default guess it
 * necessarily started with. See the module doc comment, "PROVISIONAL
 * TIMEOUTS".
 *
 * @param {RenditionPollState} state
 */
function fixProvisionalDeadlines(state) {
  if (!state.lastEdge || state.lastEdge.partTargetSeconds === null) {
    return;
  }
  const fixedIntervalMs = currentPollIntervalMs(state.lastEdge);
  for (const waiter of state.waiters) {
    if (waiter.provisional) {
      waiter.deadlineAt = waiter.registeredAt + fixedIntervalMs * TIMEOUT_PART_MULTIPLIER;
      waiter.provisional = false;
    }
  }
}

/**
 * Settles every waiter this tick's fetch actually answers: available, too
 * far ahead, or past its own deadline. Whatever remains keeps waiting for
 * the next tick.
 *
 * @param {RenditionPollState} state
 * @param {FetchedPlaylist} fetched
 * @param {number} nowMs
 */
function settleReadyWaiters(state, fetched, nowMs) {
  const settled = [];
  for (const waiter of state.waiters) {
    if (state.lastEdge && isMsnTooFarAhead(state.lastEdge, waiter.requested)) {
      waiter.settle({ kind: "too-far-ahead" });
      settled.push(waiter);
    } else if (state.lastEdge && isMsnPartAvailable(state.lastEdge, waiter.requested)) {
      waiter.settle({ kind: "available", playlist: fetched });
      settled.push(waiter);
    } else if (nowMs >= waiter.deadlineAt) {
      // RFC 8216bis's timeout fallback: hand back whatever the current
      // playlist is rather than an error. The client's own reload logic
      // takes it from here (a non-blocking re-request, or a retry).
      waiter.settle({ kind: "timeout", playlist: fetched });
      settled.push(waiter);
    }
  }
  for (const waiter of settled) {
    state.waiters.delete(waiter);
  }
}

/**
 * Settles only the waiters that are ALREADY past their own deadline, using
 * `state.lastPlaylist` (the last successfully fetched one) rather than
 * whatever slow fetch this tick abandoned. Called only from the "the origin
 * did not answer before the soonest deadline" branch of `runPollLoop` — see
 * the module doc comment, "A SLOW ORIGIN DOES NOT OWE A WAITER ITS OWN
 * DEADLINE". `state.lastPlaylist` can itself still be null here: a cold
 * rendition's very FIRST tick is now raced against a deadline too (Farol
 * 2026-09-14, see `fetchWithDeadlineRace`), so the deadline can win before
 * ANY fetch has ever completed for this rendition. RFC 8216bis's own timeout
 * fallback ("return the current playlist") has nothing to return in that
 * case, so a due waiter with no retained playlist gets a distinct outcome,
 * `{ kind: "cold-timeout" }`, instead of a `{ kind: "timeout", playlist: null }`
 * that would crash whatever tries to read `.playlist.body` off it.
 *
 * @param {RenditionPollState} state
 * @param {number} nowMs
 */
function settleDueWaiters(state, nowMs) {
  const due = [];
  for (const waiter of state.waiters) {
    if (nowMs >= waiter.deadlineAt) {
      due.push(waiter);
    }
  }
  for (const waiter of due) {
    if (state.lastPlaylist) {
      waiter.settle({ kind: "timeout", playlist: state.lastPlaylist });
    } else {
      waiter.settle({ kind: "cold-timeout" });
    }
    state.waiters.delete(waiter);
  }
}

/**
 * One poll tick's fetch, raced against the soonest current waiter's own
 * deadline. Never cancels the fetch itself: a lost race just means THIS tick
 * does not wait on it any further, and the SAME in-flight call is reused by
 * the next tick via the caller's own single-flight `fetchRendition` closure
 * (see the module doc comment, "ORIGIN DISCIPLINE").
 *
 * ALWAYS raced, including a cold rendition's very FIRST tick (`state.lastPlaylist
 * === null`). An earlier version skipped the race in that case — "nothing to
 * fall back to yet" — and simply awaited the origin fetch directly, which
 * meant a stalled or non-settling first fetch held every waiter on it open
 * until the origin's own (much longer) timeout, or forever
 * (Farol 2026-09-14: "the first origin call stalls, the request can remain
 * open ... instead of giving up around the configured deadline"; also the
 * mechanism behind "an aborted waiter can leave its poll state active until
 * the origin fetch settles" — with nothing bounding the first tick, an abort
 * that emptied `state.waiters` left `state.polling` stuck true, unswept and
 * unevictable, until that same unbounded fetch eventually settled). Racing
 * unconditionally means the very first tick times out exactly like every
 * later one -- see `settleDueWaiters` for what a deadline win means when
 * there is still no playlist to fall back to.
 *
 * @param {BlockingReloadDeps} deps
 * @param {RenditionPollState} state
 * @param {() => number} now
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<{ kind: "fetched", value: FetchedPlaylist } | { kind: "error", err: unknown } | { kind: "deadline" }>}
 */
function fetchWithDeadlineRace(deps, state, now, sleep) {
  const outcomePromise = deps.fetchRendition().then(
    (value) => ({ kind: "fetched", value }),
    (err) => ({ kind: "error", err }),
  );
  let soonestDeadline = Infinity;
  for (const waiter of state.waiters) {
    if (waiter.deadlineAt < soonestDeadline) {
      soonestDeadline = waiter.deadlineAt;
    }
  }
  if (soonestDeadline === Infinity) {
    // No waiters at all. `runPollLoop`'s own `while (state.waiters.size > 0)`
    // guard means this tick was only ever started with at least one, so this
    // is just a defensive fallback (a deadline of "never" is exactly "await
    // the fetch directly"), not a path normal traffic takes.
    return outcomePromise;
  }
  const waitMs = Math.max(0, soonestDeadline - now());
  const deadlinePromise = sleep(waitMs).then(() => ({ kind: "deadline" }));
  return Promise.race([outcomePromise, deadlinePromise]);
}

/**
 * The ONE poll loop for `renditionKey`. Runs for as long as `state.waiters`
 * is non-empty; a new waiter arriving while this is already running just
 * gets added to the same `Set` (from `awaitBlockingReload`) and is picked up
 * by whichever iteration runs next — no second loop is ever started for the
 * same key (`state.polling` guards that in `awaitBlockingReload`).
 *
 * @param {string} renditionKey
 * @param {RenditionPollState} state
 * @param {BlockingReloadDeps} deps
 * @param {() => number} now
 * @param {(ms: number) => Promise<void>} sleep
 * @returns {Promise<void>}
 */
async function runPollLoop(renditionKey, state, deps, now, sleep) {
  // Same test as `awaitBlockingReload`'s own `isVideoRung`, recomputed here
  // from `deps.rung` (this loop's own closure already has it) rather than
  // threaded through as an extra parameter -- see `pollIntervalForLoop`.
  const isVideoRung = deps.rung === LL_VIDEO_RUNG;
  try {
    while (state.waiters.size > 0) {
      const raced = await fetchWithDeadlineRace(deps, state, now, sleep);

      if (raced.kind === "deadline") {
        settleDueWaiters(state, now());
        if (state.waiters.size === 0) {
          break;
        }
        // The slow fetch is still in flight; the next iteration's call to
        // `fetchRendition` reuses it via the caller's single-flight map
        // rather than starting a second request.
        continue;
      }

      if (raced.kind === "error") {
        // An origin that is actually down is not something a hold should
        // paper over by waiting out the full timeout on every waiter — fail
        // everyone currently waiting now, the same way a normal cache-miss
        // fetch failure becomes a 502 for the caller on the non-blocking path.
        for (const waiter of state.waiters) {
          waiter.fail(raced.err);
        }
        state.waiters.clear();
        break;
      }

      const fetched = raced.value;
      if (fetched.status < 200 || fetched.status >= 300) {
        // Never let a non-2xx response become the retained fast-path state
        // (see the module doc comment, "NON-2XX NEVER POISONS THE RETAINED
        // STATE") -- settle current waiters with it directly instead,
        // leaving `lastPlaylist`/`lastEdge` exactly as they were.
        for (const waiter of state.waiters) {
          waiter.settle({ kind: "origin-error", playlist: fetched });
        }
        state.waiters.clear();
        break;
      }

      state.lastPlaylist = fetched;
      state.lastFetchedAt = now();
      try {
        state.lastEdge = parseLiveEdge(decodeText(fetched));
      } catch {
        // A body that fails to parse (should not happen for a 2xx playlist
        // response) just means this tick learned nothing new; keep whatever
        // edge was already known and let the next iteration, or the
        // timeout, resolve things.
      }

      fixProvisionalDeadlines(state);
      settleReadyWaiters(state, fetched, now());
      if (state.waiters.size === 0) {
        break;
      }

      const intervalMs = pollIntervalForLoop(state.lastEdge, isVideoRung, now() - state.pollLoopStartedAt);
      let soonestDeadline = Infinity;
      for (const waiter of state.waiters) {
        if (waiter.deadlineAt < soonestDeadline) {
          soonestDeadline = waiter.deadlineAt;
        }
      }
      const waitMs = Math.max(0, Math.min(intervalMs, soonestDeadline - now()));
      await sleep(waitMs);
    }
  } finally {
    // Stop POLLING the instant nobody is left holding — a rendition nobody
    // is blocking on costs this Worker nothing once this runs. The entry
    // itself is deliberately kept rather than deleted immediately: that is
    // what lets the very next request's fast path in `awaitBlockingReload`
    // answer without a fetch at all, for a viewer who was not one of the
    // waiters this loop just resolved. It stops being useful, and gets
    // swept, once `FAST_PATH_FRESHNESS_MS` passes with nobody asking — see
    // `sweepIdlePollStates`.
    state.polling = false;
  }
}

/**
 * Test-only: drops all in-memory poll state, so one test's rendition key
 * cannot leak a waiter or a poll loop into the next.
 */
export function resetBlockingReloadStateForTests() {
  pollStates.clear();
  pollStatesLastSweptAt = 0;
  capacityFallbackLastLoggedAt = 0;
  waiterCapFallbackLastLoggedAt = 0;
  loopCapFallbackLastLoggedAt = 0;
}

/**
 * `index.ts`'s entire dispatch hook for a request that carries a valid
 * directive: parse it (already done by the caller), then build the actual
 * `Response`. Kept here rather than inline in `index.ts` so that file's own
 * diff for this task is just "recognize a directive, call this" — see this
 * module's doc comment, "FOUR THINGS THIS FILE DOES".
 *
 * Returns `null`, not a `Response`, for `{ kind: "capacity-fallback" }` (see
 * `MAX_POLL_STATE_ENTRIES`), `{ kind: "waiter-cap-fallback" }` (see
 * `MAX_WAITERS_PER_RENDITION`), and `{ kind: "loop-cap-fallback" }` (see
 * `MAX_ACTIVE_POLL_LOOPS`): all three mean the same thing to the caller —
 * this isolate declines to hold THIS request open — for three different
 * reasons, so `index.ts` serves it through its own pre-existing non-blocking
 * cache-or-forward path instead, exactly as it would a request with no
 * directive at all, rather than this module inventing a second
 * implementation of that path here.
 *
 * @param {string} renditionKey - Same cache-key URL `index.ts` already uses for the non-blocking path (path only, no query).
 * @param {BlockingReloadDirectives} directives
 * @param {() => Promise<FetchedPlaylist>} fetchRendition - Caller's existing single-flight origin fetch (`fetchRenditionCoalesced`).
 * @param {(event: string, fields?: Record<string, unknown>) => void} logEvent
 * @param {{ channelId: string, rung: string }} context
 * @param {AbortSignal} [signal] - The incoming request's signal, so a disconnected viewer's hold does not outlive the connection.
 * @returns {Promise<Response | null>}
 */
export async function handleBlockingReload(renditionKey, directives, fetchRendition, logEvent, context, signal) {
  let outcome;
  try {
    // `context.rung` is what selects `VIDEO_RUNG_HOLD_BUDGET_MS` over the
    // plain formula inside `awaitBlockingReload` -- see that function and
    // the module doc comment, "THE VIDEO RUNG'S HOLD BUDGET IS NOT THE
    // PLAIN 3x-PART-TARGET FORMULA".
    outcome = await awaitBlockingReload(renditionKey, directives, { fetchRendition, signal, rung: context.rung });
  } catch {
    logEvent("hlsEdge.blockingReloadOriginError", { channelId: context.channelId, rung: context.rung });
    return new Response("Origin fetch failed", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  if (outcome.kind === "capacity-fallback") {
    // Rate-limited on purpose -- see `CAPACITY_FALLBACK_LOG_INTERVAL_MS` --
    // so a client that keeps cycling through distinct rungs while the map is
    // saturated cannot turn every one of its own requests into a log write.
    const loggedAt = Date.now();
    if (loggedAt - capacityFallbackLastLoggedAt >= CAPACITY_FALLBACK_LOG_INTERVAL_MS) {
      capacityFallbackLastLoggedAt = loggedAt;
      logEvent("hlsEdge.blockingReloadCapacityFallback", {
        channelId: context.channelId,
        rung: context.rung,
        maxEntries: MAX_POLL_STATE_ENTRIES,
      });
    }
    return null;
  }

  if (outcome.kind === "waiter-cap-fallback") {
    // See `MAX_WAITERS_PER_RENDITION`'s doc comment: this ONE rendition
    // already has as many holds open as this isolate will retain for it.
    // Same rate-limiting shape as the capacity-fallback log line above.
    const loggedAt = Date.now();
    if (loggedAt - waiterCapFallbackLastLoggedAt >= WAITER_CAP_LOG_INTERVAL_MS) {
      waiterCapFallbackLastLoggedAt = loggedAt;
      logEvent("hlsEdge.blockingWaiterCapHit", {
        channelId: context.channelId,
        rung: context.rung,
        maxWaiters: MAX_WAITERS_PER_RENDITION,
      });
    }
    return null;
  }

  if (outcome.kind === "loop-cap-fallback") {
    // See `MAX_ACTIVE_POLL_LOOPS`'s doc comment: this isolate is already
    // running as many independent poll loops as it will start at once, and
    // this rendition needed a fresh one. Same rate-limiting shape as the
    // capacity-fallback log line above.
    const loggedAt = Date.now();
    if (loggedAt - loopCapFallbackLastLoggedAt >= LOOP_CAP_LOG_INTERVAL_MS) {
      loopCapFallbackLastLoggedAt = loggedAt;
      logEvent("hlsEdge.blockingReloadLoopCapFallback", {
        channelId: context.channelId,
        rung: context.rung,
        maxActiveLoops: MAX_ACTIVE_POLL_LOOPS,
      });
    }
    return null;
  }

  if (outcome.kind === "cold-timeout") {
    // The deadline won before ANY playlist was ever fetched for this
    // rendition -- see `fetchWithDeadlineRace` and `settleDueWaiters`. There
    // is no "current playlist" to fall back to the way a warm timeout has,
    // so this is a distinct, honest failure rather than a 200 with an empty
    // or fabricated body: the client's own reload logic retries, same as it
    // would any other transient origin failure.
    logEvent("hlsEdge.blockingReloadColdTimeout", {
      channelId: context.channelId,
      rung: context.rung,
      msn: directives.msn,
      part: directives.part ?? null,
    });
    return new Response(JSON.stringify({ error: "Gateway Timeout", reason: "origin-did-not-respond" }), {
      status: 504,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  if (outcome.kind === "aborted") {
    // The client is already gone; nothing reads this response, but the
    // Workers runtime still expects the handler to return something. 499
    // ("client closed request") is the closest conventional status.
    return new Response(null, { status: 499 });
  }

  if (outcome.kind === "too-far-ahead") {
    logEvent("hlsEdge.blockingReloadRejected", {
      channelId: context.channelId,
      rung: context.rung,
      reason: "msn-too-far-ahead",
      msn: directives.msn,
      part: directives.part ?? null,
    });
    return new Response(JSON.stringify({ error: "Bad Request", reason: "msn-too-far-ahead" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  if (outcome.kind === "origin-error") {
    logEvent("hlsEdge.blockingReloadOriginRejected", {
      channelId: context.channelId,
      rung: context.rung,
      status: outcome.playlist.status,
    });
    const headers = new Headers(outcome.playlist.headers);
    headers.set("Cache-Control", "no-store");
    headers.set("X-HLS-Edge-Cache", "SKIP");
    return new Response(outcome.playlist.body, { status: outcome.playlist.status, headers });
  }

  if (outcome.kind === "timeout") {
    logEvent("hlsEdge.blockingReloadTimeout", {
      channelId: context.channelId,
      rung: context.rung,
      msn: directives.msn,
      part: directives.part ?? null,
    });
  }

  const headers = new Headers(outcome.playlist.headers);
  // Never persisted to `caches.default` — see the module doc comment,
  // "ORIGIN DISCIPLINE" — so make sure a downstream cache (a browser, a CDN
  // sitting in front of this Worker for some other reason) does not treat a
  // held response as a normal 2 s-fresh playlist either.
  headers.set("Cache-Control", "no-store");
  headers.set("X-HLS-Edge-Cache", outcome.kind === "available" ? "BLOCKING-HIT" : "BLOCKING-TIMEOUT");
  return new Response(outcome.playlist.body, { status: outcome.playlist.status, headers });
}
