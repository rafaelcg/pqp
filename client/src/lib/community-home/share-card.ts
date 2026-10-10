import {
  bodyIsOnlyBauLink,
  findBauPostLinks,
  type BauPostLink,
  type CommunityHomePostCard,
} from "@pqp/shared";
import { fetchCommunityHomePostCard } from "@/lib/api";
import { useEffect, useState } from "react";

/**
 * A Baú post pasted into chat is drawn as a card.
 *
 * Two questions live here, both pure so they can be tested without a DOM:
 * "which link in this message gets a card" and "may this origin be trusted as
 * ours". The fetch is authorized by the server (the feed's own rules); this
 * file never decides who may see a post, it only decides when to ask.
 */

/** Hosts that always mean this product, on top of the origin we are running on. */
const HOSTED_APP_HOSTS = new Set(["pqp.gg", "www.pqp.gg"]);

/**
 * Is `origin` this instance? The page's own origin, or the hosted app. A link
 * to somebody else's pqp is a link: it would need their API and their session,
 * so it stays plain text and the server never sees a foreign id.
 */
export function isOwnInstanceOrigin(
  origin: string,
  currentOrigin: string | null,
): boolean {
  if (currentOrigin && origin === currentOrigin) {
    return true;
  }
  try {
    const url = new URL(origin);
    return url.protocol === "https:" && HOSTED_APP_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export type BauCardSelection = {
  link: BauPostLink;
  /** The message says nothing besides the link, so the card can replace it. */
  linkOnly: boolean;
};

/** The first same-instance Baú permalink in a message body, or null. */
export function selectBauCardLink(
  body: string | null | undefined,
  currentOrigin: string | null,
): BauCardSelection | null {
  if (!body) {
    return null;
  }
  for (const link of findBauPostLinks(body)) {
    if (isOwnInstanceOrigin(link.origin, currentOrigin)) {
      return { link, linkOnly: bodyIsOnlyBauLink(body, link) };
    }
  }
  return null;
}

/**
 * The message with the card's own link taken out, so the words the sender
 * wrote stay and the long URL they pasted does not sit above its own card.
 * Blank lines the removal leaves behind are collapsed.
 */
export function stripBauLink(body: string, link: BauPostLink): string {
  return `${body.slice(0, link.start)}${body.slice(link.end)}`
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ------------------------------------------------------------------- loading

type Entry = {
  /**
   * Rows that still want this card. A request waiting for a slot is dropped
   * when this is zero, so a long channel scrolled past does not leave a queue
   * of fetches for rows that are gone.
   */
  holders: number;
  at: number;
  promise: Promise<CommunityHomePostCard | null>;
  value: CommunityHomePostCard | null | undefined;
};

const cache = new Map<string, Entry>();

/**
 * At most this many card requests in flight. A channel full of shared posts
 * would otherwise open one request per distinct post at once.
 */
const MAX_CONCURRENT_FETCHES = 4;
let inFlight = 0;
const waiting: Array<() => void> = [];

function withSlot<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      inFlight += 1;
      task()
        .then(resolve, reject)
        .finally(() => {
          inFlight -= 1;
          waiting.shift()?.();
        });
    };
    if (inFlight < MAX_CONCURRENT_FETCHES) {
      run();
    } else {
      waiting.push(run);
    }
  });
}
/** Long enough to scroll a channel back and forth, short enough for a like count. */
const OK_TTL_MS = 60_000;
/** A refusal is cached too, or a 404 card would be refetched on every render. */
const MISS_TTL_MS = 30_000;
const CACHE_MAX = 200;

export function __resetBauCardCache(): void {
  cache.clear();
}

const SKIPPED = Symbol("skipped");

/** The card, or null when the viewer may not see it (or it is gone). */
export function loadBauCard(
  serverId: string,
  postId: string,
  lang?: string,
  now: () => number = Date.now,
  viewerId: string | null = null,
): Promise<CommunityHomePostCard | null> {
  return acquireBauCard(serverId, postId, lang, now, viewerId).promise;
}

/**
 * Like {@link loadBauCard}, for a caller that can go away: `release` says it
 * no longer wants the answer, and a fetch nobody wants that has not started
 * yet never starts.
 */
export function acquireBauCard(
  serverId: string,
  postId: string,
  lang?: string,
  now: () => number = Date.now,
  viewerId: string | null = null,
): { promise: Promise<CommunityHomePostCard | null>; release: () => void } {
  // The viewer is part of the key: what the server answers is decided per
  // person (membership, the VIP lock), so a second account on the same tab
  // must never be served the first one's card.
  const key = `${viewerId ?? ""}:${serverId}:${postId}:${lang ?? ""}`;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.value === null ? MISS_TTL_MS : OK_TTL_MS;
    if (hit.value === undefined || now() - hit.at < ttl) {
      hit.holders += 1;
      return { promise: hit.promise, release: holderRelease(hit) };
    }
  }
  const entry: Entry = {
    holders: 1,
    at: now(),
    value: undefined,
    promise: Promise.resolve(null),
  };
  // Assigned after the object exists: the slot may run the task at once, and
  // the task reads `entry.holders`.
  entry.promise = withSlot<{ card: CommunityHomePostCard } | typeof SKIPPED>(() =>
    entry.holders > 0
      ? fetchCommunityHomePostCard(serverId, postId, lang)
      : Promise.resolve(SKIPPED),
  )
    .then((res) => (res === SKIPPED ? SKIPPED : res.card))
    // 4xx: not ours to show. Offline or 5xx: a plain link for now, and the
    // short miss TTL lets the next render try again.
    .catch(() => null)
    .then((value) => {
      if (value === SKIPPED) {
        // Never asked: forget it, so the next row that wants it does.
        if (cache.get(key) === entry) {
          cache.delete(key);
        }
        return null;
      }
      entry.value = value;
      entry.at = now();
      return value;
    });
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, entry);
  return { promise: entry.promise, release: holderRelease(entry) };
}

function holderRelease(entry: Entry): () => void {
  let released = false;
  return () => {
    if (!released) {
      released = true;
      entry.holders -= 1;
    }
  };
}

export type BauCardState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; card: CommunityHomePostCard }
  | { status: "unavailable" };

/** Loads the card for a link. `idle` when the message has none. */
export function useBauCard(
  link: BauPostLink | null,
  lang?: string,
  viewerId: string | null = null,
): BauCardState {
  const serverId = link?.serverId ?? null;
  const postId = link?.postId ?? null;
  const [state, setState] = useState<{ key: string; value: BauCardState } | null>(
    null,
  );
  const key =
    serverId && postId
      ? `${viewerId ?? ""}:${serverId}:${postId}:${lang ?? ""}`
      : null;
  useEffect(() => {
    if (!serverId || !postId || !key) {
      return;
    }
    let cancelled = false;
    const handle = acquireBauCard(serverId, postId, lang, Date.now, viewerId);
    void handle.promise.then((card) => {
      if (cancelled) {
        return;
      }
      setState({
        key,
        value: card ? { status: "ok", card } : { status: "unavailable" },
      });
    });
    return () => {
      cancelled = true;
      handle.release();
    };
  }, [serverId, postId, lang, key, viewerId]);
  if (!key) {
    return { status: "idle" };
  }
  return state && state.key === key ? state.value : { status: "loading" };
}
