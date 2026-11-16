import type { JamSongSummary } from "@pqp/shared";
import { useEffect, useState } from "react";
import { fetchJamSongs } from "@/lib/jam-api";

/**
 * The songs of one Jam that match what is typed in a palette (Ctrl/Cmd+K, or the
 * server's message search).
 *
 * The server does the matching and the authorization (`GET
 * /api/channels/:id/jam-songs?q=`: title and artist, accent- and case-blind, and
 * only songs this viewer may see), so a palette never holds a song list of its own.
 * Asked once the words have settled and are long enough to mean something; the
 * answer for words that are no longer the words is dropped. Any failure is an empty
 * list: a palette that cannot reach the Jam is just a palette without songs.
 */

const SETTLE_MS = 180;
const MIN_LENGTH = 2;
const LIMIT = 6;

export function useJamSongSearch(channelId: string | null, query: string, enabled = true): readonly JamSongSummary[] {
  const [held, setHeld] = useState<{ key: string; songs: readonly JamSongSummary[] } | null>(null);
  const words = query.trim();
  const key = channelId && enabled && words.length >= MIN_LENGTH ? `${channelId}:${words}` : null;
  useEffect(() => {
    if (!key || !channelId) {
      setHeld(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchJamSongs(channelId, { q: words, limit: LIMIT }, controller.signal).then(
        (answer) => {
          if (!controller.signal.aborted) {
            setHeld({ key, songs: answer.songs });
          }
        },
        () => {
          if (!controller.signal.aborted) {
            setHeld({ key, songs: [] });
          }
        },
      );
    }, SETTLE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, channelId, words]);
  // Between two queries the last answer stays; whatever it holds that no longer matches is filtered out by the caller.
  return key !== null && held !== null && held.key.startsWith(`${channelId}:`) ? held.songs : NONE;
}

const NONE: readonly JamSongSummary[] = [];
