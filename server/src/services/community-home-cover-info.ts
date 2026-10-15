import { sniffImage, type ImageInfo } from "../lib/image-info.js";
import { getObjectPrefix, headObject } from "../lib/s3.js";

/**
 * What the bucket says about a public Baú cover: how big it is, what it is, and
 * how many pixels. Two callers want it and they want opposite things.
 *
 *   - THE COVER ROUTE needs the size (it answers `Content-Length` and range
 *     arithmetic) and has nothing to fall back to, so it waits for the answer
 *     (`getCoverInfo`).
 *   - THE POST PAGE wants it as a HINT for the share card, and must never be
 *     held up by it (`peekCoverInfo`): it waits a short budget, and if the bucket
 *     is slow it goes without.
 *
 * ONE PROBE PER KEY, remembered for the life of the process. A storage key never
 * changes what it names (a replaced picture is a new upload under a new key), so
 * an entry cannot go stale and needs no expiry, only a bound. A link going viral
 * therefore costs one HEAD and one ranged GET, not one per viewer.
 *
 * A PROBE IS BOUNDED THREE WAYS, because "the page does not wait" is not the same
 * as "the work stops":
 *   - It has a deadline of its own (`PROBE_DEADLINE_MS`), whatever its callers do.
 *   - When the last caller still waiting on it gives up, it is ABORTED, which
 *     cancels the HEAD and the ranged GET at the bucket. A probe the cover route
 *     is waiting for is never aborted from under it.
 *   - The page only STARTS a probe while fewer than `MAX_HINT_PROBES` are in
 *     flight, so a slow bucket cannot be handed an unbounded pile of them by a
 *     crawler walking distinct posts. (The cover route is not capped by this: it
 *     is what a viewer asked for, behind the public rate limiter.)
 */

/**
 * The most a cover served from our own origin may weigh. X refuses a card
 * image above 5 MB (and so do most unfurlers' budgets), and a bigger one is
 * not worth streaming through this process: past it the route keeps redirecting
 * to the signed URL, which is how every cover answered before this.
 */
export const PUBLIC_COVER_MAX_BYTES = 5 * 1024 * 1024;

/**
 * The formats the route serves itself. The four X accepts for a card, plus
 * AVIF for a browser's own `<img>`. Deliberately NOT svg or anything
 * text-like: bytes served from this origin that a browser would render as a
 * document are an XSS on the API's address, and a redirect to the bucket's
 * origin (the fallback) is where those stay.
 */
const SERVABLE_COVER_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
]);

export function isServableCoverType(contentType: string): boolean {
  return SERVABLE_COVER_TYPES.has(contentType);
}

export interface CoverInfo {
  /** Verified by a HEAD against the bucket, not claimed by the uploader. */
  length: number;
  /**
   * What to SAY the bytes are: what their own header says when it says (the
   * share card advertises exactly this, so the file must agree), else the type
   * the object was stored under. Lowercased, no parameters.
   */
  contentType: string;
  /** The pixels and format the first bytes declare, when they declare any. */
  image: ImageInfo | null;
}

/** How much of the head of an image to read for its dimensions. */
const SNIFF_BYTES = 64 * 1024;

const COVER_INFO_MAX_ENTRIES = 500;
/** A probe's own clock, whatever its callers do. Under the storage client's 10 s. */
const PROBE_DEADLINE_MS = 5_000;
/** How many probes the post page may have in flight at once. */
const MAX_HINT_PROBES = 16;

interface Probe {
  promise: Promise<CoverInfo | null>;
  abort: AbortController;
  /** Callers still waiting on `promise`. At zero, an unsettled probe is aborted. */
  waiters: number;
  settled: boolean;
}

const probes = new Map<string, Probe>();
let inFlight = 0;

async function lookup(key: string, signal: AbortSignal): Promise<CoverInfo | null> {
  // The HEAD and the ranged read go out together: the prefix is wasted if the
  // HEAD then says the object is too big or not an image, and that is the rare
  // case; the usual one is two sequential round trips saved. A missing object
  // answers null from both.
  const [head, prefix] = await Promise.all([
    headObject(key, signal),
    getObjectPrefix(key, SNIFF_BYTES, signal).catch((error: unknown) => {
      // Dimensions are garnish: a failed prefix read is "unknown", not a failure.
      // (An abort is not swallowed into a value: the HEAD beside it fails the same
      // way and rejects the lookup.)
      if (signal.aborted) {
        throw error;
      }
      return null;
    }),
  ]);
  if (!head) {
    return null;
  }
  const readable =
    head.contentLength > 0 &&
    head.contentLength <= PUBLIC_COVER_MAX_BYTES &&
    isServableCoverType(head.contentType);
  const image = readable && prefix ? sniffImage(prefix) : null;
  return {
    length: head.contentLength,
    contentType: image?.type ?? head.contentType,
    image,
  };
}

function touch(key: string, probe: Probe): void {
  // A Map iterates in insertion order, so re-inserting is the LRU.
  probes.delete(key);
  probes.set(key, probe);
}

function start(key: string): Probe {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PROBE_DEADLINE_MS);
  const probe: Probe = {
    promise: undefined as unknown as Promise<CoverInfo | null>,
    abort,
    waiters: 0,
    settled: false,
  };
  inFlight += 1;
  probe.promise = lookup(key, abort.signal).finally(() => {
    clearTimeout(timer);
    probe.settled = true;
    inFlight -= 1;
  });
  probes.set(key, probe);
  while (probes.size > COVER_INFO_MAX_ENTRIES) {
    // The oldest entry; a probe still running keeps running, and is no longer
    // findable, which is why the in-flight cap does not depend on this map.
    probes.delete(probes.keys().next().value as string);
  }
  // Only a SUCCESSFUL answer is remembered. A failure is retried by the next
  // caller, and a missing object is not kept: a row can be pointed at a new one.
  probe.promise.then(
    (info) => (info ? undefined : forget(key, probe)),
    () => forget(key, probe),
  );
  return probe;
}

function forget(key: string, probe: Probe): void {
  if (probes.get(key) === probe) {
    probes.delete(key);
  }
}

function release(key: string, probe: Probe): void {
  probe.waiters -= 1;
  if (probe.waiters <= 0 && !probe.settled) {
    // Nobody is waiting for this any more: stop the requests, and do not let the
    // next caller inherit an aborted probe.
    probe.abort.abort();
    forget(key, probe);
  }
}

/**
 * The cover's facts, waiting as long as the lookup takes (it has a deadline of
 * its own). Null when the object is not there; throws a `StorageError` when the
 * bucket fails, so the route can say 503 rather than 404.
 */
export async function getCoverInfo(key: string): Promise<CoverInfo | null> {
  const known = probes.get(key);
  const probe = known ?? start(key);
  touch(key, probe);
  probe.waiters += 1;
  try {
    return await probe.promise;
  } finally {
    // Settled by now, so this never aborts; it keeps the count honest for a
    // probe that other callers are still waiting on.
    probe.waiters -= 1;
  }
}

/**
 * The cover's facts as a HINT: the answer if it is already known or arrives
 * within `budgetMs`, otherwise null, and never an error. Does not start a probe
 * while `MAX_HINT_PROBES` are already in flight, and cancels the one it started
 * (or joined) if it gives up and nobody else is waiting.
 */
export async function peekCoverInfo(
  key: string,
  budgetMs: number,
): Promise<CoverInfo | null> {
  let probe = probes.get(key);
  if (!probe) {
    if (inFlight >= MAX_HINT_PROBES) {
      return null;
    }
    probe = start(key);
  }
  touch(key, probe);
  probe.waiters += 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = Symbol("timed out");
    const result = await Promise.race([
      probe.promise,
      new Promise<typeof timedOut>((resolve) => {
        timer = setTimeout(() => resolve(timedOut), budgetMs);
      }),
    ]);
    if (result === timedOut) {
      release(key, probe);
      return null;
    }
    probe.waiters -= 1;
    return result;
  } catch (error) {
    probe.waiters -= 1;
    console.error(
      "[bau-public] cover facts failed, serving the post without them:",
      error instanceof Error ? error.message : error,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** For tests: this is process state and must not leak between cases. */
export function resetCoverInfoCache(): void {
  for (const probe of probes.values()) {
    probe.abort.abort();
  }
  probes.clear();
}

/** For tests: how many probes are running right now. */
export function coverProbesInFlight(): number {
  return inFlight;
}
