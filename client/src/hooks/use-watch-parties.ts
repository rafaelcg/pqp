import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WatchParty } from "@pqp/shared";
import { fetchServerWatchParties } from "@/lib/watch-parties-api";
import { isWatchPartyChannelsEnabled } from "@/lib/watch-party-channels";

/**
 * Every watch party this person can see in the server they are looking at,
 * keyed by channel.
 *
 * TWO SOURCES, ONE MAP, AND THE SOCKET WINS. `GET /api/servers/:id/watch-parties`
 * fills it when a server is opened, because a client that arrives mid-show
 * must not wait for a state change to learn there is one. After that,
 * `watch-party-update` frames keep it current, and they are authoritative:
 * the server resolves `viewerRole` and draft visibility per recipient, so a
 * frame is a better answer than anything this hook could compute.
 *
 * ONE PARTY PER CHANNEL, which is a database constraint (the partial unique
 * index on `channel_sessions`) and not an assumption made here. A frame with
 * `party: null` deletes the entry, which is how the sidebar block goes away
 * when a show ends.
 *
 * THE MAP IS PER SERVER AND IS CLEARED ON SWITCH. Holding two servers' parties
 * at once would mean the sidebar block could show a party from the server the
 * person just left, which is worse than showing nothing for a beat.
 */
export interface WatchPartiesState {
  /** channelId -> the party there, as this person may see it. */
  byChannel: Record<string, WatchParty>;
  /** The live ones, newest first. What the sidebar block draws. */
  live: WatchParty[];
  /** Apply a `watch-party-update` frame. */
  apply: (channelId: string, party: WatchParty | null) => void;
  /** After a mutation whose broadcast this client may not be in scope for. */
  put: (party: WatchParty) => void;
  refresh: () => void;
}

export function useWatchParties(serverId: string | null): WatchPartiesState {
  const [byChannel, setByChannel] = useState<Record<string, WatchParty>>({});
  const serverRef = useRef<string | null>(serverId);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    serverRef.current = serverId;
    setByChannel({});
    if (!serverId || !isWatchPartyChannelsEnabled()) {
      return;
    }
    let cancelled = false;
    void fetchServerWatchParties(serverId)
      .then((answer) => {
        // The server may have changed under the request. Dropping a late
        // answer for the previous server is the whole reason `serverRef`
        // exists: without it, switching quickly leaves another server's
        // party in the sidebar until the next frame.
        if (cancelled || serverRef.current !== serverId) {
          return;
        }
        const next: Record<string, WatchParty> = {};
        for (const party of answer.parties) {
          next[party.channelId] = party;
        }
        setByChannel(next);
      })
      .catch(() => {
        // No answer reads as no parties. A frame will say otherwise the
        // moment anything happens, and a sidebar block that failed to load
        // must not become an error the room has to look at.
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, reloadToken]);

  const apply = useCallback((channelId: string, party: WatchParty | null) => {
    setByChannel((prev) => applyWatchPartyFrame(prev, channelId, party));
  }, []);

  const put = useCallback(
    (party: WatchParty) => apply(party.channelId, party),
    [apply],
  );

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const live = useMemo(() => liveWatchParties(byChannel), [byChannel]);

  return { byChannel, live, apply, put, refresh };
}


/**
 * Apply one `watch-party-update` frame to the map.
 *
 * A pure function, and not folded back into the hook, for the same reason
 * `formatSessionRelativeTime` is one: it is the only interesting logic here
 * and this repo has no hook-testing library, so the choice is a pure function
 * with a real test or a `setState` callback with none.
 *
 * IT NEVER SECOND-GUESSES THE FRAME. The first version short-circuited when
 * the id, state, name, host, co-host count and viewer role all matched, to
 * save a re-render. Options and the stage are none of those, so it silently
 * dropped every options-only change: a host switching "quem pode falar"
 * mid-show updated the database, rewrote the channel's SPEAK overwrites, and
 * reached every viewer's socket, and not one viewer's screen changed. The
 * saving was imaginary anyway, because this frame is not on a keyframe
 * cadence like `channel-live`: the server sends it when a human changes
 * something, which is exactly when a re-render is the point.
 */
export function applyWatchPartyFrame(
  prev: Record<string, WatchParty>,
  channelId: string,
  party: WatchParty | null,
): Record<string, WatchParty> {
  if (!party) {
    if (!(channelId in prev)) {
      return prev;
    }
    const next = { ...prev };
    delete next[channelId];
    return next;
  }
  return { ...prev, [channelId]: party };
}

/** The live ones, newest first. What the sidebar block draws. */
export function liveWatchParties(
  byChannel: Record<string, WatchParty>,
): WatchParty[] {
  return Object.values(byChannel)
    .filter((party) => party.state === "live")
    .sort((a, b) => (b.wentLiveAt ?? "").localeCompare(a.wentLiveAt ?? ""));
}
