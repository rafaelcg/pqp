/**
 * ONE bounded, detachable join onto somebody else's in-flight fetch.
 *
 * THE BUG THIS EXISTS FOR (production, 2026-09-15). This Worker collapses a
 * rung's origin traffic by sharing ONE in-flight promise between every
 * concurrent caller for the same cache key — `inFlightRenditionFetches` in
 * `index.ts`, `LlPlaylistOrigin.inFlight` for `state.json` and init
 * segments. That is the right shape, and it is also the shape that produced
 * both of that afternoon's failure modes, because of a Workers rule this
 * code was written as if it did not exist:
 *
 *   **A `fetch()` and a `setTimeout()` belong to the request context that
 *   created them.** When that request's handler returns and its context is
 *   torn down, its pending I/O is cancelled and its timers stop firing.
 *
 * So a SECOND request that awaits a promise owned by a FIRST request is
 * betting its own response on a context it does not control, and there are
 * exactly two ways that bet loses:
 *
 *  1. The owner's context dies while the fetch is still in flight. The
 *     shared promise REJECTS with an abort-shaped error even though the
 *     origin was healthy and answering in 1 ms, and the joiner turns that
 *     into a 502 (`hlsEdge.blockingReloadOriginError`). Five of those,
 *     19:55:44-19:55:54, with every origin request in the window a 200.
 *  2. The owner's context dies and the joiner is left awaiting a promise
 *     that nothing will ever settle, with NO pending I/O of its own. The
 *     Workers runtime notices exactly this and answers 500 with "your
 *     Worker's code had hung and would never generate a response" — after a
 *     wall time of ONE MILLISECOND, which is the tell: the request was never
 *     waiting on anything real. Thirteen of those in three and a half
 *     minutes, two of them on the plain (non-blocking) playlist path, which
 *     is how this module's scope reaches past `hls-blocking-reload.js`.
 *
 * WHAT THIS MODULE DOES ABOUT IT. A joiner never awaits a foreign promise
 * unboundedly. It arms `joinBoundMs` on a timer OF ITS OWN (so the runtime
 * always sees pending I/O for this request, and the hang detector never
 * fires), and when that timer wins, or the shared promise rejects, it
 * DETACHES and produces its own fetch instead of inheriting the failure.
 * The shared fetch is never aborted to make that happen — the abort in
 * failure 1 above is the thing being defended against, not a tool — so a
 * slow-but-alive owner still gets to finish and still serves whoever is
 * still attached.
 *
 * WHAT KEEPS THE RETRY FROM BECOMING A HERD. A detaching joiner re-reads the
 * map first: if some OTHER joiner has already started a fresh attempt, it
 * joins that one rather than starting a third. Only the first joiner to
 * notice produces. With `MAX_JOIN_ATTEMPTS` (2) that bounds a pathological
 * key at two extra origin fetches total, not one per waiter, and bounds any
 * single request's wait at `MAX_JOIN_ATTEMPTS * joinBoundMs` before it goes
 * to the origin itself.
 *
 * THE OTHER HALF OF THE FIX IS NOT HERE. Bounding the joiner makes a dead
 * owner survivable; `ctx.waitUntil` on the producer's side (see
 * `index.ts`'s `fetchRenditionCoalesced`) is what stops the owner dying in
 * the first place. Both, because `waitUntil` is not reachable from every
 * caller (`LlPlaylistOrigin` has no `ExecutionContext`) and because a
 * belt-and-braces pair only works when neither strap can veto the other —
 * pitfall 16's lesson, applied to a promise instead of a credential.
 *
 * WHY PLAIN JS, NOT TYPESCRIPT. Same reasoning as `hls-blocking-reload.js`
 * and `hls-viewer-token.js`: `node --test` runs the exact bytes that ship,
 * with no build step between the test and the module under test, and this
 * module is pure — a Map, a promise, and an injectable timer, nothing
 * Workers-only.
 */

/**
 * How long a joiner waits on somebody else's in-flight fetch before
 * detaching and producing its own.
 *
 * The remux origin behind Caddy answered 1,324 requests over the sampled
 * window with a p95 of 1 ms and a max of 12 ms, so a second is roughly 80x
 * the worst real latency ever observed: reaching this bound means something
 * is wrong with the OWNER (its context is gone), not with the origin, and
 * one extra fetch is a cheap way to find out. Short enough that the detached
 * request still answers inside its own hold budget — the audio rung's is
 * ~1.5 s and the video rung's 6 s.
 */
export const DEFAULT_JOIN_BOUND_MS = 1_000;

/**
 * How many times one caller will join a foreign in-flight promise before it
 * gives up on sharing and fetches for itself. Two, so a request's worst-case
 * added latency is bounded (`2 * joinBoundMs`) and so a key whose owners
 * keep dying cannot make a single request bounce between them forever.
 */
export const MAX_JOIN_ATTEMPTS = 2;

/**
 * @param {number} ms
 * @param {() => void} cb
 * @returns {() => void} cancel
 */
function defaultSetTimer(ms, cb) {
  const handle = setTimeout(cb, ms);
  return () => clearTimeout(handle);
}

/**
 * @template T
 * @typedef {{ result: T, isProducer: boolean }} CoalescedResult
 */

/**
 * @template T
 * @typedef {{
 *   joinBoundMs?: number,
 *   setTimer?: (ms: number, cb: () => void) => () => void,
 *   keepAlive?: (promise: Promise<unknown>) => void,
 *   onDetach?: (info: { reason: "detached" | "rejected", attempt: number }) => void,
 * }} CoalesceOptions
 */

/**
 * Awaits `promise`, but never for longer than `boundMs`, and never with an
 * unhandled rejection left behind when the bound wins first.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} boundMs
 * @param {(ms: number, cb: () => void) => () => void} setTimer
 * @returns {Promise<{ kind: "settled", value: T } | { kind: "rejected", err: unknown } | { kind: "detached" }>}
 */
function joinBounded(promise, boundMs, setTimer) {
  return new Promise((resolve) => {
    let done = false;
    const cancel = setTimer(boundMs, () => {
      if (done) {
        return;
      }
      done = true;
      resolve({ kind: "detached" });
    });
    // ALWAYS attached, even after the bound has already won: this is the
    // only handler the shared promise has from this caller's side, so
    // dropping it on a detach would turn every detached-then-rejected fetch
    // into an unhandled rejection (which in Workers is an error the runtime
    // reports against the isolate, not a silent one).
    promise.then(
      (value) => {
        if (done) {
          return;
        }
        done = true;
        cancel();
        resolve({ kind: "settled", value });
      },
      (err) => {
        if (done) {
          return;
        }
        done = true;
        cancel();
        resolve({ kind: "rejected", err });
      },
    );
  });
}

/**
 * Starts `produce()` as THIS caller's own fetch and publishes it for others
 * to join, clearing the map entry when it settles — but only if the entry is
 * still this promise, so a later producer that already replaced it is not
 * evicted by an older one finishing late.
 *
 * @template T
 * @param {Map<string, Promise<T>>} inFlight
 * @param {string} key
 * @param {() => Promise<T>} produce
 * @param {((promise: Promise<unknown>) => void) | undefined} keepAlive
 * @returns {Promise<CoalescedResult<T>>}
 */
function produceAndShare(inFlight, key, produce, keepAlive) {
  /** @type {Promise<T>} */
  let promise;
  try {
    promise = produce();
  } catch (err) {
    return Promise.reject(err);
  }
  inFlight.set(key, promise);
  const forget = () => {
    if (inFlight.get(key) === promise) {
      inFlight.delete(key);
    }
  };
  const settled = promise.then(forget, forget);
  // The producer's request context is what owns this fetch; extending it
  // past the response is what lets a joiner's share actually complete. See
  // this module's header.
  if (keepAlive) {
    keepAlive(settled);
  }
  return promise.then((result) => ({ result, isProducer: true }));
}

/**
 * Shares one in-flight `produce()` per `key`, with every join bounded and
 * detachable. See this module's header for the production failure this
 * replaces.
 *
 * `isProducer` is true for a caller whose own `produce()` started the fetch
 * it is returning — the flag `index.ts` uses to pick exactly one cache
 * writer per shared fetch. A detach-and-reproduce can therefore hand out a
 * second producer for the same key; writing the same bytes to the same cache
 * key twice is wasteful, not wrong, and it is strictly better than the
 * alternative of a request that has no answer at all.
 *
 * @template T
 * @param {Map<string, Promise<T>>} inFlight
 * @param {string} key
 * @param {() => Promise<T>} produce
 * @param {CoalesceOptions<T>} [options]
 * @returns {Promise<CoalescedResult<T>>}
 */
export async function coalesceFetch(inFlight, key, produce, options = {}) {
  const joinBoundMs = options.joinBoundMs ?? DEFAULT_JOIN_BOUND_MS;
  const setTimer = options.setTimer ?? defaultSetTimer;

  let existing = inFlight.get(key);
  for (let attempt = 0; existing && attempt < MAX_JOIN_ATTEMPTS; attempt += 1) {
    const joined = await joinBounded(existing, joinBoundMs, setTimer);
    if (joined.kind === "settled") {
      return { result: joined.value, isProducer: false };
    }
    if (options.onDetach) {
      options.onDetach({ reason: joined.kind, attempt });
    }
    if (inFlight.get(key) === existing) {
      // Nobody else has noticed yet: this caller owns the retry. Dropping
      // the entry first means a request arriving a microsecond from now
      // joins the fresh attempt rather than the one just abandoned.
      inFlight.delete(key);
      existing = undefined;
    } else {
      // Some other detaching joiner already started a fresh attempt — join
      // that instead of opening a third connection to the same origin path.
      existing = inFlight.get(key);
    }
  }

  return produceAndShare(inFlight, key, produce, options.keepAlive);
}
