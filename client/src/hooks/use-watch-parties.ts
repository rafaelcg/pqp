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
    setByChannel((prev) => {
      if (!party) {
        if (!(channelId in prev)) {
          return prev;
        }
        const next = { ...prev };
        delete next[channelId];
        return next;
      }
      const held = prev[channelId];
      if (
        held &&
        held.id === party.id &&
        held.state === party.state &&
        held.name === party.name &&
        held.hostUserId === party.hostUserId &&
        held.hostDisconnectedAt === party.hostDisconnectedAt &&
        held.cohosts.length === party.cohosts.length &&
        held.viewerRole === party.viewerRole
      ) {
        // Same party, same everything the UI reads. Returning the held object
        // keeps the sidebar from re-rendering on every keyframe.
        return prev;
      }
      return { ...prev, [channelId]: party };
    });
  }, []);

  const put = useCallback(
    (party: WatchParty) => apply(party.channelId, party),
    [apply],
  );

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const live = useMemo(
    () =>
      Object.values(byChannel)
        .filter((party) => party.state === "live")
        .sort((a, b) => (b.wentLiveAt ?? "").localeCompare(a.wentLiveAt ?? "")),
    [byChannel],
  );

  return { byChannel, live, apply, put, refresh };
}
