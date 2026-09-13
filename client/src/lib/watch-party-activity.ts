import { useEffect, useRef, useState } from "react";
import type { LiveReactionCount } from "@pqp/shared";
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

export function useWatchPartyActivity({
  channelId,
  audienceCount,
  hands,
}: {
  channelId: string;
  audienceCount: number;
  hands: readonly ActivityPerson[];
}): ActivityEvent[] {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const lastCount = useRef<number | null>(null);
  const lastHands = useRef<readonly ActivityPerson[]>(hands);

  // Audience: only growth is worth a line. People leaving is a number the
  // header already carries, and a feed of departures is not what a host
  // wants to read mid-show.
  useEffect(() => {
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
