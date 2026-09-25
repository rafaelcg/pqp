import { useEffect, useRef, useState } from "react";
import { liveStateFromStream, type LiveReactionCount } from "@pqp/shared";
import type { ChannelLive } from "@/hooks/use-voice";
import { subscribeToLiveReactions } from "@/lib/live-reactions";

/**
 * The presenter's activity feed: what the room did while the host was
 * looking at the picture. Twitch's Stream Manager has an Activity Feed
 * (follows, subs, raids) and it is the one panel a streamer keeps open;
 * ours is joins, raised hands and reactions, the three things a watch party
 * produces. In memory only, newest first, capped, forgotten on unmount:
 * this is a glance, not a log.
 */
export interface ActivityPerson {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
}

export type ActivityEvent =
  | { id: number; at: number; kind: "audience"; delta: number; total: number }
  | { id: number; at: number; kind: "hand"; person: ActivityPerson }
  | { id: number; at: number; kind: "reactions"; items: LiveReactionCount[] };

export const ACTIVITY_CAP = 40;

/** `Omit` over a union collapses it; this distributes, so each kind keeps its fields. */
type ActivityInput = ActivityEvent extends infer E
  ? E extends ActivityEvent
    ? Omit<E, "id" | "at"> & { at?: number }
    : never
  : never;

let nextId = 1;

/** Pure: newest first, capped. Exported for the reducer test. */
export function pushActivity(
  prev: readonly ActivityEvent[],
  event: ActivityInput,
  now: number = Date.now(),
  cap: number = ACTIVITY_CAP,
): ActivityEvent[] {
  const full = { ...event, id: nextId++, at: event.at ?? now } as ActivityEvent;
  return [full, ...prev].slice(0, cap);
}

/** Which hands are new against a previous snapshot. Pure, for the test. */
export function newHands(
  prev: readonly ActivityPerson[],
  next: readonly ActivityPerson[],
): ActivityPerson[] {
  const seen = new Set(prev.map((person) => person.userId));
  return next.filter((person) => !seen.has(person.userId));
}

/**
 * The count the feed compares, or `null` while it is not known. The same sum
 * as `watchAudienceCount` (the header and the sidebar), except that "no
 * `channel-live` yet" is unknown rather than zero: see `audienceCount` below.
 */
export function feedAudienceCount(
  live: ChannelLive | undefined,
  participants:
    | readonly { peerId: string; sharingScreen: boolean; userId?: string }[]
    | undefined,
): number | null {
  if (!live) {
    return null;
  }
  return liveStateFromStream(live.stream, participants, live.watching).viewerCount;
}

export function useWatchPartyActivity({
  channelId,
  audienceCount,
  hands,
}: {
  channelId: string;
  /**
   * `null` while this client has not been told the channel's live state yet
   * (no `channel-live` frame since the page loaded). NOT zero: a presenter
   * who reloads mid-party mounts this feed before the first frame lands, and
   * a zero baseline turned the audience already watching into a fresh
   * "+1 assistindo" (production rehearsal C, 2026-09-25). The baseline is
   * the first count this client actually knows.
   */
  audienceCount: number | null;
  hands: readonly ActivityPerson[];
}): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const lastCount = useRef<number | null>(null);
  const lastHands = useRef<readonly ActivityPerson[]>(hands);

  // ONE PARTY'S ACTIVITY AT A TIME (Farol, 2026-09-14). A presenter who
  // switches from one live party to another without this hook unmounting
  // (`channelId` reaches it as a prop, not a key) used to keep the old
  // channel's feed, count and hand roster: the new channel's first bump in
  // viewers read as a delta against the old one's count, and a hand already
  // up in the new room could be misread as freshly raised against the old
  // room's roster. Reset DURING RENDER rather than in an effect, so it lands
  // before either effect below reads `lastCount` or `lastHands` for this
  // channel — React's own documented pattern for "adjusting state when a
  // prop changes" (calling a setter mid-render, guarded by a ref compare, is
  // what discards this render and starts over with the reset already done).
  const seenChannelId = useRef(channelId);
  if (seenChannelId.current !== channelId) {
    seenChannelId.current = channelId;
    lastCount.current = null;
    lastHands.current = hands;
    setEvents([]);
  }

  // Audience: only growth is worth a line. People leaving is a number the
  // header already carries, and a feed of departures is not what a host
  // wants to read mid-show.
  useEffect(() => {
    if (audienceCount === null) {
      // Not known yet: neither a line nor a baseline.
      return;
    }
    const prev = lastCount.current;
    lastCount.current = audienceCount;
    if (prev !== null && audienceCount > prev) {
      setEvents((held) =>
        pushActivity(held, {
          kind: "audience",
          delta: audienceCount - prev,
          total: audienceCount,
        }),
      );
    }
  }, [audienceCount]);

  useEffect(() => {
    const fresh = newHands(lastHands.current, hands);
    lastHands.current = hands;
    if (fresh.length === 0) {
      return;
    }
    setEvents((held) =>
      fresh.reduce(
        (acc, person) => pushActivity(acc, { kind: "hand", person }),
        held,
      ),
    );
  }, [hands]);

  useEffect(
    () =>
      subscribeToLiveReactions((window) => {
        if (window.channelId !== channelId || window.items.length === 0) {
          return;
        }
        setEvents((held) =>
          pushActivity(held, { kind: "reactions", items: window.items }),
        );
      }),
    [channelId],
  );

  return events;
}
