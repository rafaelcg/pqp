import type { JamSongSummary } from "@pqp/shared";
import { useEffect, useState } from "react";
import { ensureJamConfig } from "@/hooks/use-jam-config";
import { fetchJamSong } from "@/lib/jam-api";
import type { JamSongLink } from "@/lib/jam-share";

/**
 * Loading what a song link card draws: the song, as the signed-in viewer is
 * allowed to read it.
 *
 * Nothing here decides who may see a song. The card's data is the song detail
 * read (`GET /api/jam-songs/:id`), which answers 404 for a song the viewer cannot
 * open (a Jam channel they cannot see, a song that is gone, a song with no take
 * that is not theirs), and this treats every refusal, and every failure, the same
 * way: no card, the link stays an ordinary link. It never learns, and never keeps
 * around, a title or a picture the server did not hand this viewer.
 *
 * The flag is the one rule that is the client's: a server with `jam_channels` off
 * has paused the feature, and a link to it stays a link (reading is not gated by
 * the flag on the server, so this is a choice about the chat, not a permission).
 */

export interface JamCardData {
  song: JamSongSummary;
}

type Entry = {
  holders: number;
  at: number;
  promise: Promise<JamCardData | null>;
  value: JamCardData | null | undefined;
};

const cache = new Map<string, Entry>();
/** At most this many reads in flight: a channel full of shared songs must not open one request per song at once. */
const MAX_CONCURRENT = 4;
let inFlight = 0;
const waiting: Array<() => void> = [];
const OK_TTL_MS = 60_000;
/** A refusal is cached too, or an unavailable card would be asked again on every render. */
const MISS_TTL_MS = 30_000;
const CACHE_MAX = 200;
const SKIPPED = Symbol("skipped");

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
    if (inFlight < MAX_CONCURRENT) {
      run();
    } else {
      waiting.push(run);
    }
  });
}

export function resetJamCardCacheForTests(): void {
  cache.clear();
}

async function read(songId: string): Promise<JamCardData | null> {
  const detail = await fetchJamSong(songId);
  const song = detail.song;
  // Nothing to hear: an empty song is its author's alone and a link to it says nothing yet.
  if (song.trackCount === 0 || detail.tracks.every((track) => !track.inMix)) {
    return null;
  }
  // A standalone public jam (no channel) is not a channel card.
  if (!song.serverId || !song.channelId) {
    return null;
  }
  const config = await ensureJamConfig(song.serverId);
  if (!config.enabled) {
    return null;
  }
  return { song };
}

function acquire(
  songId: string,
  viewerId: string | null,
  now: () => number,
): { promise: Promise<JamCardData | null>; release: () => void } {
  // The viewer is part of the key: what the server answers is decided per person,
  // so a second account in the same tab must never be served the first one's card.
  const key = `${viewerId ?? ""}:${songId}`;
  const hit = cache.get(key);
  if (hit) {
    const ttl = hit.value === null ? MISS_TTL_MS : OK_TTL_MS;
    if (hit.value === undefined || now() - hit.at < ttl) {
      hit.holders += 1;
      return { promise: hit.promise, release: holder(hit) };
    }
  }
  const entry: Entry = { holders: 1, at: now(), value: undefined, promise: Promise.resolve(null) };
  entry.promise = withSlot<JamCardData | null | typeof SKIPPED>(() =>
    entry.holders > 0 ? read(songId) : Promise.resolve(SKIPPED),
  )
    // A 4xx is not ours to show; offline or a 5xx is a plain link for now, and the short
    // miss lifetime lets the next render try again.
    .catch(() => null)
    .then((value) => {
      if (value === SKIPPED) {
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
  return { promise: entry.promise, release: holder(entry) };
}

function holder(entry: Entry): () => void {
  let released = false;
  return () => {
    if (!released) {
      released = true;
      entry.holders -= 1;
    }
  };
}

export type JamCardState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ok"; card: JamCardData }
  | { status: "unavailable" };

/**
 * Loads the card for a link, once the row is near the screen: a channel that opens on a long
 * history must not ask for the detail of every song it ever shared. `observe` goes on the element
 * the row draws while it waits (the card's placeholder). Without IntersectionObserver (an old
 * webview, a test DOM) the answer is asked for at once.
 */
export function useJamCard(
  link: JamSongLink | null,
  viewerId: string | null = null,
): { state: JamCardState; observe: (element: Element | null) => void } {
  const songId = link?.songId ?? null;
  const key = songId ? `${viewerId ?? ""}:${songId}` : null;
  const [state, setState] = useState<{ key: string; value: JamCardState } | null>(null);
  const [near, setNear] = useState(() => typeof IntersectionObserver === "undefined");
  const [node, setNode] = useState<Element | null>(null);
  useEffect(() => {
    if (near || !node) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near, node]);
  useEffect(() => {
    if (!songId || !key || !near) {
      return;
    }
    let cancelled = false;
    const handle = acquire(songId, viewerId, Date.now);
    void handle.promise.then((card) => {
      if (cancelled) {
        return;
      }
      setState({ key, value: card ? { status: "ok", card } : { status: "unavailable" } });
    });
    return () => {
      cancelled = true;
      handle.release();
    };
  }, [songId, key, viewerId, near]);
  if (!key) {
    return { state: { status: "idle" }, observe: setNode };
  }
  return { state: state && state.key === key ? state.value : { status: "loading" }, observe: setNode };
}
