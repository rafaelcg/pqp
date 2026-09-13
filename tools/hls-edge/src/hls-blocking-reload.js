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
 * THREE THINGS THIS FILE DOES, kept as separate pure-ish pieces:
 *
 *  1. **Parse and validate the directives** (`parseBlockingReloadParams`) —
 *     no I/O, no state, a pure function of the URL.
 *  2. **Read the live edge off an already-fetched playlist body**
 *     (`parseLiveEdge`, `isMsnPartAvailable`, `isMsnTooFarAhead`) — pure
 *     functions of playlist text, so a test can hand them a hand-written
 *     manifest string without ever touching the network.
 *  3. **Hold a request open until the edge catches up, or time out**
 *     (`awaitBlockingReload`, `handleBlockingReload`) — the only stateful
 *     part, and the only part that talks to the caller's injected fetch.
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
 * already satisfies it — see the "fast path" in `awaitBlockingReload`). The
 * loop polls the origin at most once per part duration, stops the instant
 * `state.waiters` is empty, and never touches Cloudflare's `caches.default`
 * at all: an LL playlist body is stale in well under a second, which is not
 * a thing worth putting in a cache with any TTL, so this deliberately does
 * NOT add a second cache next to `index.ts`'s existing 2 s one. The actual
 * origin *fetch* — the network call a poll iteration makes — is not
 * reimplemented here either: the caller (`index.ts`) injects a
 * `fetchRendition` closure that wraps its own existing `fetchRenditionCoalesced`
 * single-flight map, so a poll tick here and an ordinary cache-miss fetch on
 * the non-blocking path for the SAME rendition, happening in the same
 * instant, still collapse into one real HTTP request to the API — the exact
 * mechanism this file is told to reuse rather than duplicate.
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
 */

/** Query parameter names, verbatim from RFC 8216bis §6.2.5.2. */
export const HLS_MSN_PARAM = "_HLS_msn";
export const HLS_PART_PARAM = "_HLS_part";

/**
 * Used only when a playlist carries no `EXT-X-PART-INF:PART-TARGET=...` yet
 * (a cold rendition, or one this Worker has not seen a fresh fetch for) —
 * `docs/plans/LL_HLS.md` §1 pins the target part duration at 500 ms. Once a
 * real fetch reveals the playlist's own `PART-TARGET`, that value is used
 * instead (see `awaitBlockingReload`'s doc comment) — this constant is a
 * floor for "we do not know yet", not an override of what the origin says.
 */
export const DEFAULT_PART_TARGET_SECONDS = 0.5;

/** The hold's hard timeout, in units of the target part duration, per L2.1's spec. */
const TIMEOUT_PART_MULTIPLIER = 3;

/** Guards against a pathological (zero or tiny) PART-TARGET turning the poll loop into a busy-wait. */
const MIN_POLL_INTERVAL_MS = 20;

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
 *   { kind: "too-far-ahead" }
 * } BlockingReloadOutcome
 */

/**
 * @typedef {{
 *   fetchRendition: () => Promise<FetchedPlaylist>,
 *   now?: () => number,
 *   sleep?: (ms: number) => Promise<void>,
 * }} BlockingReloadDeps
 */

/**
 * @typedef {{
 *   requested: BlockingReloadDirectives,
 *   deadlineAt: number,
 *   settle: (outcome: BlockingReloadOutcome) => void,
 *   fail: (err: unknown) => void,
 * }} Waiter
 */

/**
 * @typedef {{
 *   waiters: Set<Waiter>,
 *   lastPlaylist: FetchedPlaylist | null,
 *   lastEdge: PlaylistLiveEdge | null,
 *   polling: boolean,
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
 * Holds one request's Promise open until `renditionKey`'s playlist advances
 * to contain `requested`, the request turns out to be too far ahead of the
 * live edge, or `TIMEOUT_PART_MULTIPLIER` part durations pass — whichever
 * comes first. Never issues an origin fetch itself; every fetch goes through
 * `deps.fetchRendition`, which `index.ts` wires to its existing single-flight
 * `fetchRenditionCoalesced`, so this function's only job is deciding WHEN to
 * call that closure and WHO to wake up with the result.
 *
 * @param {string} renditionKey
 * @param {BlockingReloadDirectives} requested
 * @param {BlockingReloadDeps} deps
 * @returns {Promise<BlockingReloadOutcome>}
 */
export async function awaitBlockingReload(renditionKey, requested, deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;

  let state = pollStates.get(renditionKey);
  if (!state) {
    state = { waiters: new Set(), lastPlaylist: null, lastEdge: null, polling: false };
    pollStates.set(renditionKey, state);
  }

  // Fast path: this isolate already knows enough, from a previous fetch on
  // this same rendition, to answer without touching the origin at all. This
  // is what makes "requests for an msn already published return immediately"
  // true even when this is a brand-new waiter arriving mid-party, not just
  // the one that happens to be running the poll loop.
  if (state.lastEdge) {
    if (isMsnTooFarAhead(state.lastEdge, requested)) {
      return { kind: "too-far-ahead" };
    }
    if (isMsnPartAvailable(state.lastEdge, requested) && state.lastPlaylist) {
      return { kind: "available", playlist: state.lastPlaylist };
    }
  }

  const timeoutMs = currentPollIntervalMs(state.lastEdge) * TIMEOUT_PART_MULTIPLIER;

  return new Promise((resolve, reject) => {
    /** @type {Waiter} */
    const waiter = {
      requested,
      deadlineAt: now() + timeoutMs,
      settle: resolve,
      fail: reject,
    };
    state.waiters.add(waiter);
    if (!state.polling) {
      state.polling = true;
      void runPollLoop(renditionKey, state, deps, now, sleep);
    }
  });
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
  try {
    while (state.waiters.size > 0) {
      let fetched;
      try {
        fetched = await deps.fetchRendition();
      } catch (err) {
        // An origin that is actually down is not something a hold should
        // paper over by waiting out the full timeout on every waiter — fail
        // everyone currently waiting now, the same way a normal cache-miss
        // fetch failure becomes a 502 for the caller on the non-blocking path.
        for (const waiter of state.waiters) {
          waiter.fail(err);
        }
        state.waiters.clear();
        break;
      }

      state.lastPlaylist = fetched;
      if (fetched.status >= 200 && fetched.status < 300) {
        try {
          state.lastEdge = parseLiveEdge(decodeText(fetched));
        } catch {
          // A body that fails to parse (should not happen for a 2xx
          // playlist response) just means this tick learned nothing new;
          // keep whatever edge was already known and let the next
          // iteration, or the timeout, resolve things.
        }
      }

      const settled = [];
      const nowMs = now();
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
      if (state.waiters.size === 0) {
        break;
      }

      const intervalMs = currentPollIntervalMs(state.lastEdge);
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
    // itself, and its `lastEdge`/`lastPlaylist`, are deliberately kept
    // rather than deleted: that is what lets the very next request's fast
    // path in `awaitBlockingReload` answer without a fetch at all, which is
    // exactly the "requests for an msn already published return
    // immediately" requirement for a viewer who was not one of the waiters
    // this loop just resolved. The entry is bounded by how many distinct
    // renditions (channel + session + rung) this isolate has ever served a
    // directive for — small in practice, and isolates themselves are
    // recycled by the Workers runtime, so this is not an unbounded leak.
    state.polling = false;
  }
}

/**
 * Test-only: drops all in-memory poll state, so one test's rendition key
 * cannot leak a waiter or a poll loop into the next.
 */
export function resetBlockingReloadStateForTests() {
  pollStates.clear();
}

/**
 * `index.ts`'s entire dispatch hook for a request that carries a valid
 * directive: parse it (already done by the caller), then build the actual
 * `Response`. Kept here rather than inline in `index.ts` so that file's own
 * diff for this task is just "recognize a directive, call this" — see this
 * module's doc comment, "THREE THINGS THIS FILE DOES".
 *
 * @param {string} renditionKey - Same cache-key URL `index.ts` already uses for the non-blocking path (path only, no query).
 * @param {BlockingReloadDirectives} directives
 * @param {() => Promise<FetchedPlaylist>} fetchRendition - Caller's existing single-flight origin fetch (`fetchRenditionCoalesced`).
 * @param {(event: string, fields?: Record<string, unknown>) => void} logEvent
 * @param {{ channelId: string, rung: string }} context
 * @returns {Promise<Response>}
 */
export async function handleBlockingReload(renditionKey, directives, fetchRendition, logEvent, context) {
  let outcome;
  try {
    outcome = await awaitBlockingReload(renditionKey, directives, { fetchRendition });
  } catch {
    logEvent("hlsEdge.blockingReloadOriginError", { channelId: context.channelId, rung: context.rung });
    return new Response("Origin fetch failed", {
      status: 502,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
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

  if (outcome.kind === "timeout") {
    logEvent("hlsEdge.blockingReloadTimeout", {
      channelId: context.channelId,
      rung: context.rung,
      msn: directives.msn,
      part: directives.part ?? null,
    });
  }

  const headers = new Headers(outcome.playlist.headers);
  // Never persisted to `caches.default` — see this module's doc comment,
  // "ORIGIN DISCIPLINE" — so make sure a downstream cache (a browser, a CDN
  // sitting in front of this Worker for some other reason) does not treat a
  // held response as a normal 2 s-fresh playlist either.
  headers.set("Cache-Control", "no-store");
  headers.set("X-HLS-Edge-Cache", outcome.kind === "available" ? "BLOCKING-HIT" : "BLOCKING-TIMEOUT");
  return new Response(outcome.playlist.body, { status: outcome.playlist.status, headers });
}
