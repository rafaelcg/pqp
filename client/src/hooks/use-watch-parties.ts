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
 * person just left, which is worse than showing nothing for a beat. A
 * `watch-party-update` for a party on another server is ignored for the same
 * reason: the socket's catch-up and fan-out can name a party this tab is
 * not looking at, and writing it in is how a LIVE block for server A
 * appears while they are looking at server B.
 */
export interface WatchPartiesState {
  /** channelId -> the party there, as this person may see it. */
  byChannel: Record<string, WatchParty>;
  /** The live ones in the open server, newest first. What the sidebar block draws. */
  live: WatchParty[];
  /** Every server with a live party, for the rail's dot. */
  liveServerIds: ReadonlySet<string>;
  /** Apply a `watch-party-update` frame. */
  apply: (channelId: string, party: WatchParty | null) => void;
  /** After a mutation whose broadcast this client may not be in scope for. */
  put: (party: WatchParty) => void;
  /** Patch a party only while this cache still holds that exact session. */
  patch: (id: string, partial: Partial<WatchParty>) => void;
  refresh: () => void;
}

export function useWatchParties(serverId: string | null): WatchPartiesState {
  const [byChannel, setByChannel] = useState<Record<string, WatchParty>>({});
  const serverRef = useRef<string | null>(serverId);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    serverRef.current = serverId;
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
        // Authoritative for THIS server only. Other servers' parties stay:
        // they arrived on the socket (`catchUpWatchParties` sends every
        // server's live ones on connect, and updates follow), and they are
        // what lights the rail's dot on a server you are not looking at.
        setByChannel((prev) => {
          const next: Record<string, WatchParty> = {};
          for (const party of Object.values(prev)) {
            if (keepForeignParty(party, serverId)) {
              next[party.channelId] = party;
            }
          }
          for (const party of answer.parties) {
            next[party.channelId] = party;
          }
          return next;
        });
      })
      .catch(() => {
        // No answer reads as no parties: what this server had cached goes,
        // so a party that ended during an outage does not stay on the
        // sidebar, and the rail's dot, until the next frame. Other servers'
        // entries are untouched, and a sidebar block that failed to load
        // must not become an error the room has to look at.
        if (cancelled || serverRef.current !== serverId) {
          return;
        }
        setByChannel((prev) => {
          const next: Record<string, WatchParty> = {};
          for (const party of Object.values(prev)) {
            if (keepForeignParty(party, serverId)) {
              next[party.channelId] = party;
            }
          }
          return next;
        });
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, reloadToken]);

  const apply = useCallback((channelId: string, party: WatchParty | null) => {
    setByChannel((prev) =>
      applyWatchPartyFrame(prev, channelId, party, serverRef.current),
    );
  }, []);

  const put = useCallback(
    (party: WatchParty) => apply(party.channelId, party),
    [apply],
  );

  const patch = useCallback((id: string, partial: Partial<WatchParty>) => {
    setByChannel((prev) => patchWatchParty(prev, id, partial));
  }, []);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  // One pass over the map for both readers: the sidebar block wants the
  // OPEN server's live parties, the rail wants every server with one.
  const allLive = useMemo(
    () => Object.values(byChannel).filter((party) => party.state === "live"),
    [byChannel],
  );
  const live = useMemo(
    () => sortNewestFirst(allLive.filter((p) => p.serverId === serverId)),
    [allLive, serverId],
  );
  const liveServerIds = useMemo<ReadonlySet<string>>(
    () =>
      new Set(
        allLive
          .map((party) => party.serverId)
          .filter((id): id is string => id !== null),
      ),
    [allLive],
  );

  return { byChannel, live, liveServerIds, apply, put, patch, refresh };
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
  openServerId: string | null,
): Record<string, WatchParty> {
  if (!party) {
    if (!(channelId in prev)) {
      return prev;
    }
    const next = { ...prev };
    delete next[channelId];
    return next;
  }
  // A LIVE frame for another server DOES land in this map, and it is the
  // rail's dot that needs it: the socket sends every server's live parties
  // on connect and on change, and a member sitting elsewhere learns a show
  // started only through that. What PR 455 fixed, a foreign party in THIS
  // server's sidebar, is kept by `liveWatchParties` filtering on read.
  // Anything else about another server (a draft, a schedule, an ending) is
  // of no use here and is dropped, so the map holds the open server's
  // parties plus one entry per show on air elsewhere, never every party of
  // every server the person belongs to.
  if (!keepForeignParty(party, openServerId)) {
    if (!(channelId in prev)) {
      return prev;
    }
    const next = { ...prev };
    delete next[channelId];
    return next;
  }
  return { ...prev, [channelId]: party };
}

/** Patch by session id so a late mutation cannot restore a replaced session. */
export function patchWatchParty(
  prev: Record<string, WatchParty>,
  id: string,
  partial: Partial<WatchParty>,
): Record<string, WatchParty> {
  for (const [channelId, party] of Object.entries(prev)) {
    if (party.id === id) {
      return { ...prev, [channelId]: { ...party, ...partial } };
    }
  }
  return prev;
}

/** The open server keeps every party; other servers keep only live ones. */
export function keepForeignParty(
  party: WatchParty,
  openServerId: string | null,
): boolean {
  return party.serverId === openServerId || party.state === "live";
}

function sortNewestFirst(parties: WatchParty[]): WatchParty[] {
  return parties.sort((a, b) =>
    (b.wentLiveAt ?? "").localeCompare(a.wentLiveAt ?? ""),
  );
}

/** Every server with a party on air, for the rail's dot. */
export function liveWatchPartyServerIds(
  byChannel: Record<string, WatchParty>,
): ReadonlySet<string> {
  return new Set(
    Object.values(byChannel)
      .filter((party) => party.state === "live" && party.serverId !== null)
      .map((party) => party.serverId as string),
  );
}

/** The live ones, newest first. What the sidebar block draws. */
export function liveWatchParties(
  byChannel: Record<string, WatchParty>,
  serverId: string | null,
): WatchParty[] {
  return sortNewestFirst(
    Object.values(byChannel).filter(
      (party) => party.state === "live" && party.serverId === serverId,
    ),
  );
}
