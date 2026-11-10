import type { Channel } from "@pqp/shared";
import { useEffect, useMemo } from "react";
import { jamSeenAt, useJamSeenVersion } from "@/lib/jam-seen";
import { loadJamChannel, readJamChannel, useJamStoreEpoch, useJamStoreVersion } from "@/lib/jam-store";
import { jamHasNews, latestActivity } from "@/lib/jam-wall";

/**
 * What the sidebar's Jam row says: how many songs, and whether anything moved
 * since the person last opened it.
 *
 * The jam frames only reach a socket that has joined the channel, so a closed
 * Jam learns about new songs by asking: when the server's channels load, when
 * the window is focused again and on a slow timer. Opening the wall is what
 * clears the dot (`rememberJamSeen`), and opening it also keeps the count live
 * through the frames.
 */

export interface JamSidebarRow {
  /** Songs read so far (at most one page: `more` says there are others). */
  songCount: number;
  more: boolean;
  /** A song or track moved after the person last looked. */
  news: boolean;
  loaded: boolean;
}

const REFRESH_MS = 3 * 60_000;

export function useJamSidebar(channels: readonly Pick<Channel, "id" | "type">[]): Record<string, JamSidebarRow> {
  const ids = channels
    .filter((channel) => channel.type === "jam")
    .map((channel) => channel.id)
    .join(",");
  // Another account emptied the store: ask again for these channels.
  const storeEpoch = useJamStoreEpoch();

  useEffect(() => {
    if (!ids) {
      return;
    }
    const list = ids.split(",");
    const refresh = (force: boolean) => {
      for (const id of list) {
        void loadJamChannel(id, { force });
      }
    };
    refresh(false);
    const onFocus = () => {
      if (document.visibilityState === "visible") {
        refresh(true);
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    const timer = window.setInterval(() => refresh(true), REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
      window.clearInterval(timer);
    };
  }, [ids, storeEpoch]);

  const storeVersion = useJamStoreVersion();
  const seenVersion = useJamSeenVersion();
  return useMemo(() => {
    const out: Record<string, JamSidebarRow> = {};
    if (!ids) {
      return out;
    }
    for (const id of ids.split(",")) {
      const state = readJamChannel(id);
      out[id] = {
        songCount: state.songs.length,
        more: state.nextCursor !== null,
        news: state.status === "ready" && jamHasNews(state.songs, jamSeenAt(id)) && latestActivity(state.songs) !== null,
        loaded: state.status === "ready",
      };
    }
    return out;
    // the two versions are the inputs: the store and the seen marks are read above
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, storeVersion, seenVersion]);
}
