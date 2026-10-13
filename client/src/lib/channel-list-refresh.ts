import type { Channel } from "@pqp/shared";
import { isCommunityHomeChannelId } from "@/lib/community-home/id";

/**
 * Where to go after a refetched channel list no longer holds the open
 * channel: somebody deleted it, or it went private and this viewer is not on
 * the list. `null` means stay put: nothing was open, the open channel is
 * still there, or it is Baú, which is a client-only surface and never in the
 * list. Otherwise the first text channel, then the first thing that is not a
 * category, the same pick the delete dialog makes for its own actor. `null`
 * too when the server has nothing left to open; the caller clears the
 * selection then.
 */
export function vanishedChannelFallback(
  list: readonly Channel[],
  currentId: string | null,
): { vanished: false } | { vanished: true; nextId: string | null } {
  if (
    !currentId ||
    isCommunityHomeChannelId(currentId) ||
    list.some((channel) => channel.id === currentId)
  ) {
    return { vanished: false };
  }
  const next =
    list.find((channel) => channel.type === "text") ??
    list.find((channel) => channel.type !== "category");
  return { vanished: true, nextId: next?.id ?? null };
}

/**
 * What to do with a refetched list, given whether this fetch was itself the
 * confirmation of an earlier one that came back without the open channel.
 *
 * ONE LIST IS NOT PROOF. A spectator of a live watch party was sent to
 * #general on their own, once, and nothing in the logs said why; the only
 * code that leaves a channel on its own is this fallback, and it believed a
 * single list. So the first list without the open channel only asks for a
 * second one (`confirm`), and the viewer leaves only when that one agrees
 * and they are still on the same channel. A channel that really was
 * deleted, or that this viewer really lost access to, still sends them out,
 * a fetch later.
 */
export type VanishedChannelDecision =
  | { action: "stay" }
  | { action: "confirm"; channelId: string }
  | { action: "leave"; channelId: string; nextId: string | null };

export function vanishedChannelDecision(
  list: readonly Channel[],
  currentId: string | null,
  confirmingId: string | null,
): VanishedChannelDecision {
  const fallback = vanishedChannelFallback(list, currentId);
  if (!fallback.vanished || !currentId) {
    return { action: "stay" };
  }
  if (confirmingId !== currentId) {
    return { action: "confirm", channelId: currentId };
  }
  return { action: "leave", channelId: currentId, nextId: fallback.nextId };
}

/**
 * How long to wait before the next try at a `channels-update` refetch that
 * failed, by how many tries have failed so far. `null` once the schedule is
 * spent: the list is then marked stale and refetched when the socket next
 * reconnects, since a failure this long is almost always the connection.
 * About 45 seconds in all, so a blip heals on its own without a navigation.
 */
const CHANNEL_LIST_RETRY_MS = [1_000, 4_000, 10_000, 30_000] as const;

export function channelListRetryDelayMs(failedTries: number): number | null {
  return CHANNEL_LIST_RETRY_MS[failedTries - 1] ?? null;
}

export interface ChannelListTickets {
  /** Called when a fetch of the open server's list starts. */
  take(): number;
  /** May the fetch holding this ticket still write the list? */
  isLatest(ticket: number): boolean;
  /**
   * Called when a `channels-update` refetch starts, with its ticket: that
   * server's list is behind a change until a fetch that started no earlier
   * writes it.
   */
  updateStarted(serverId: string, ticket: number): void;
  /** Called when the fetch holding this ticket wrote the list. */
  wrote(ticket: number): void;
  /**
   * A fetch of this server's list failed. True when it held the newest
   * ticket and a `channels-update` refetch it overtook never wrote: nothing
   * else is going to bring the change in, so the caller refetches.
   */
  owesUpdate(serverId: string, ticket: number): boolean;
  /**
   * Where a fetch that takes no ticket of its own starts, for `withCreated`.
   * Not a ticket: it never makes another fetch's ticket stale.
   */
  mark(): number;
  /**
   * This reader just created `channel`. Until a fetch that started after
   * now writes the list, a list that lacks it is older than the create, not
   * proof it was deleted.
   */
  created(channel: Channel): void;
  /** The reader deleted the channel: stop keeping it in older lists. */
  forget(channelId: string): void;
  /**
   * The list a fetch for `serverId` holding `ticket` (or a `mark`) should
   * write: its own, plus every channel this reader created after that fetch
   * started. A fetch that started after a create answers for it, and the
   * create is forgotten.
   */
  withCreated(
    serverId: string,
    list: readonly Channel[],
    ticket: number,
  ): Channel[];
}

/**
 * Tickets for every fetch of the open server's channel list: the
 * `channels-update` refetch and the loads a navigation starts. Only the
 * newest ticket may write the list. A later fetch reads a later state of the
 * list, so this is what keeps an older response from landing on top of a
 * newer one: two quick nudges, or a nudge refetch from an earlier visit to a
 * server returning after the person left and came back, which started a
 * newer load.
 *
 * The flip side is that a newer load silences a nudge refetch it overtook.
 * When that load then fails, the change the nudge was bringing in would be
 * lost until the next navigation, so the tickets also remember the nudge
 * until a fetch at least as new as it writes the list (`owesUpdate`).
 */
export function createChannelListTickets(): ChannelListTickets {
  /**
   * One count for tickets, marks and creates, so "started before the create"
   * is `ticket < create` for all of them. A create moves it without moving
   * `latest`, so it never makes a fetch in flight stale.
   */
  let clock = 0;
  let latest = 0;
  let pending: { serverId: string; ticket: number } | null = null;
  /** Channels this reader created, with the clock at that moment. */
  const createdChannels = new Map<string, { channel: Channel; ticket: number }>();
  return {
    mark: () => clock,
    created: (channel) => {
      clock += 1;
      createdChannels.set(channel.id, { channel, ticket: clock });
    },
    forget: (channelId) => {
      createdChannels.delete(channelId);
    },
    withCreated: (serverId, list, ticket) => {
      const missing: Channel[] = [];
      for (const [id, entry] of createdChannels) {
        if (entry.channel.serverId !== serverId) {
          continue;
        }
        if (ticket >= entry.ticket) {
          createdChannels.delete(id);
          continue;
        }
        if (!list.some((channel) => channel.id === id)) {
          missing.push(entry.channel);
        }
      }
      return missing.length === 0
        ? (list as Channel[])
        : [...list, ...missing].sort((a, b) => a.position - b.position);
    },
    take: () => {
      clock += 1;
      latest = clock;
      return latest;
    },
    isLatest: (ticket) => ticket === latest,
    updateStarted: (serverId, ticket) => {
      pending = { serverId, ticket };
    },
    wrote: (ticket) => {
      if (pending && ticket >= pending.ticket) {
        pending = null;
      }
    },
    owesUpdate: (serverId, ticket) =>
      ticket === latest && pending !== null && pending.serverId === serverId,
  };
}
