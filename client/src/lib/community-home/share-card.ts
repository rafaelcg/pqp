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
  at: number;
  promise: Promise<CommunityHomePostCard | null>;
  value: CommunityHomePostCard | null | undefined;
};

const cache = new Map<string, Entry>();
/** Long enough to scroll a channel back and forth, short enough for a like count. */
const OK_TTL_MS = 60_000;
/** A refusal is cached too, or a 404 card would be refetched on every render. */
const MISS_TTL_MS = 30_000;
const CACHE_MAX = 200;

export function __resetBauCardCache(): void {
  cache.clear();
}

/** The card, or null when the viewer may not see it (or it is gone). */
export function loadBauCard(
  serverId: string,
  postId: string,
  lang?: string,
  now: () => number = Date.now,
): Promise<CommunityHomePostCard | null> {
  const key = `${serverId}:${postId}:${lang ?? ""}`;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.value === null ? MISS_TTL_MS : OK_TTL_MS;
    if (hit.value === undefined || now() - hit.at < ttl) {
      return hit.promise;
    }
  }
  const entry: Entry = {
    at: now(),
    value: undefined,
    promise: fetchCommunityHomePostCard(serverId, postId, lang)
      .then((res) => res.card)
      // 4xx: not ours to show. Offline or 5xx: a plain link for now, and the
      // short miss TTL lets the next render try again.
      .catch(() => null)
      .then((value) => {
        entry.value = value;
        entry.at = now();
        return value;
      }),
  };
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, entry);
  return entry.promise;
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
): BauCardState {
  const serverId = link?.serverId ?? null;
  const postId = link?.postId ?? null;
  const [state, setState] = useState<{ key: string; value: BauCardState } | null>(
    null,
  );
  const key = serverId && postId ? `${serverId}:${postId}:${lang ?? ""}` : null;
  useEffect(() => {
    if (!serverId || !postId || !key) {
      return;
    }
    let cancelled = false;
    void loadBauCard(serverId, postId, lang).then((card) => {
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
    };
  }, [serverId, postId, lang, key]);
  if (!key) {
    return { status: "idle" };
  }
  return state && state.key === key ? state.value : { status: "loading" };
}
