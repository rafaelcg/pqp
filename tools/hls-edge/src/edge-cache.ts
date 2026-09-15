/**
 * The Cache API, wrapped so that losing it never costs a viewer their
 * request — shared by the two routes that use it: the rendition playlist
 * (`index.ts`, one entry per rung per 2 s) and the LL media bytes
 * (`ll-media.ts`, one entry per part/segment/init, immutable for a year).
 *
 * Lifted out of `index.ts` verbatim when `ll-media.ts` arrived (task
 * `L2.3`), rather than imported back out of it: `index.ts` imports the
 * media route, so the media route importing `index.ts` for these three
 * helpers would be a cycle. These are also the ONE place in this Worker
 * that decides what a cache key is, and both routes need the same answer —
 * the path, never the token (README.md "Why the cache key drops the
 * token").
 */

import { logEvent } from "./log.js";

/**
 * The cache-key request for anything this Worker caches: path only, no
 * query. On the rendition route the token never varies the body; on the LL
 * media route the bytes of `part-164.m4s` are the same bytes for everyone
 * who is allowed to ask for them at all. Dropping the query from the KEY is
 * what makes two viewers in one colo share one origin fetch — the token is
 * still verified, on every request, before this function's result is ever
 * looked up.
 */
export function cacheKeyRequest(request: Request): Request {
  const url = new URL(request.url);
  url.search = "";
  return new Request(url.toString(), { method: "GET" });
}

/**
 * `cache.match` failing (a transient Cache API error) must read as a MISS,
 * not as a thrown error that fails the whole request — this cache is an
 * optimization, and losing it for one request is a much smaller problem than
 * turning a Cache API hiccup into a 500 for every viewer of a rung.
 */
export async function safeCacheMatch(cache: Cache, key: Request): Promise<Response | undefined> {
  try {
    return await cache.match(key);
  } catch {
    logEvent("hlsEdge.cacheReadError", {});
    return undefined;
  }
}

/**
 * Same reasoning in the other direction: a failed `cache.put` must not
 * become an unhandled rejection under `ctx.waitUntil` (which Cloudflare
 * treats as a Worker error) when the response it was populating the cache
 * FOR has already been served successfully.
 *
 * ONE RETRY, NOT ZERO. This is the producer's ONLY attempt at populating
 * the shared cache for this window (see "ONLY THE PRODUCER WRITES THE
 * CACHE" at the call site) — every OTHER caller sharing the coalesced fetch
 * already has its own copy of the bytes and returns successfully to its own
 * viewer regardless, so a bare `cache.put` failure was invisible to every
 * individual request while still meaning NOBODY populated the shared cache
 * for the rest of the window, undoing exactly the collapse this Worker
 * exists for. A transient Cache API error is the common failure shape here
 * (`cache.match` gets the identical treatment above), so one immediate
 * retry recovers most of them; `hlsEdge.cacheWriteError` now fires only
 * once BOTH attempts have failed, with `attempts: 2` to tell it apart from
 * a single-attempt failure if this ever needs a third try later.
 */
export async function safeCachePut(cache: Cache, key: Request, response: Response): Promise<void> {
  try {
    await cache.put(key, response.clone());
    return;
  } catch {
    // fall through to the retry below
  }
  try {
    await cache.put(key, response);
  } catch {
    logEvent("hlsEdge.cacheWriteError", { attempts: 2 });
  }
}
