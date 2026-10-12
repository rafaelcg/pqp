import type { DmSummary, PublicUser, UserStatus } from "@pqp/shared";
import { foldForSearch } from "@/lib/conversation-list";
import { conversationTitle } from "@/lib/conversations";

/**
 * Conversas: what Ctrl/Cmd+K "ir pra" offers, and in what order. Pure, so the
 * ranking is a test and the component only draws it.
 *
 * People first (friends before anybody else, then whoever you have a 1:1
 * with, then people from the open server), then group conversations, then
 * servers, then channels of the open server. A name that STARTS with the typed
 * words ranks above one that merely contains them, the way every switcher
 * people know behaves.
 */

/** The few fields a row needs, which a server member and a friend both have. */
export interface SwitcherPerson {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  tag?: string | null;
}

export type SwitcherItem =
  | {
      kind: "person";
      id: string;
      person: SwitcherPerson;
      status: UserStatus | null;
      friend: boolean;
      /** The existing 1:1, when there is one. */
      channelId: string | null;
      unread: number;
    }
  | { kind: "conversation"; id: string; conversation: DmSummary; title: string; unread: number }
  | { kind: "server"; id: string; name: string; iconUrl: string | null }
  | {
      kind: "channel";
      id: string;
      name: string;
      type: string;
      serverName: string;
    };

export interface SwitcherSources {
  viewerId: string | null;
  friends: readonly (PublicUser & { status: UserStatus })[];
  conversations: readonly DmSummary[];
  unread: Readonly<Record<string, { count: number }>>;
  members: readonly SwitcherPerson[];
  servers: readonly { id: string; name: string; iconUrl?: string | null }[];
  channels: readonly { id: string; name: string; type: string }[];
  openServerName: string | null;
}

export const SWITCHER_LIMITS = { person: 5, conversation: 4, server: 3, channel: 5 } as const;

/** 0 = starts with, 1 = a word starts with, 2 = contains, -1 = no match. */
export function matchRank(haystack: string, needle: string): number {
  const folded = foldForSearch(haystack);
  if (!needle) {
    return 0;
  }
  if (folded.startsWith(needle)) {
    return 0;
  }
  if (folded.split(/[\s#@_.-]+/).some((word) => word.startsWith(needle))) {
    return 1;
  }
  return folded.includes(needle) ? 2 : -1;
}

function bestRank(values: readonly (string | null | undefined)[], needle: string): number {
  let best = -1;
  for (const value of values) {
    if (!value) {
      continue;
    }
    const rank = matchRank(value, needle);
    if (rank >= 0 && (best < 0 || rank < best)) {
      best = rank;
    }
  }
  return best;
}

export function quickSwitcherItems(query: string, sources: SwitcherSources): SwitcherItem[] {
  const needle = foldForSearch(query);
  const empty = needle.length === 0;

  // ---- people
  const oneToOne = new Map<string, DmSummary>();
  for (const conversation of sources.conversations) {
    if (conversation.participants.length === 1) {
      oneToOne.set(conversation.participants[0]!.id, conversation);
    }
  }
  const people = new Map<string, { person: SwitcherPerson; status: UserStatus | null; friend: boolean; order: number }>();
  const add = (person: SwitcherPerson, status: UserStatus | null, friend: boolean, order: number) => {
    if (person.id === sources.viewerId || people.has(person.id)) {
      return;
    }
    people.set(person.id, { person, status, friend, order });
  };
  sources.friends.forEach((friend) => add(friend, friend.status, true, 0));
  sources.conversations.forEach((conversation) => {
    if (conversation.participants.length === 1) {
      add(conversation.participants[0]!, null, false, 1);
    }
  });
  // Server members only once something is typed: an empty switcher listing
  // a 5,000-person community is noise.
  if (!empty) {
    sources.members.forEach((member) => add(member, null, false, 2));
  }
  const personItems = [...people.values()]
    .map((entry) => ({
      ...entry,
      rank: bestRank([entry.person.displayName, entry.person.tag], needle),
      conversation: oneToOne.get(entry.person.id) ?? null,
    }))
    .filter((entry) =>
      empty
        ? // Empty: the people you would plausibly open, friends online and
          // recent 1:1s.
          (entry.friend && entry.status !== null && entry.status !== "offline") ||
          entry.conversation !== null
        : entry.rank >= 0,
    )
    .sort((a, b) => {
      if (empty) {
        const at = a.conversation?.lastMessageAt ?? "";
        const bt = b.conversation?.lastMessageAt ?? "";
        return at === bt ? a.person.displayName.localeCompare(b.person.displayName) : at < bt ? 1 : -1;
      }
      return (
        a.rank - b.rank ||
        a.order - b.order ||
        a.person.displayName.localeCompare(b.person.displayName)
      );
    })
    .slice(0, SWITCHER_LIMITS.person)
    .map(
      (entry): SwitcherItem => ({
        kind: "person",
        id: `person:${entry.person.id}`,
        person: entry.person,
        status: entry.status,
        friend: entry.friend,
        channelId: entry.conversation?.channelId ?? null,
        unread: entry.conversation ? (sources.unread[entry.conversation.channelId]?.count ?? 0) : 0,
      }),
    );

  // ---- group conversations (a 1:1 is its person above)
  const groupItems = sources.conversations
    .filter((conversation) => conversation.participants.length !== 1)
    .map((conversation) => ({
      conversation,
      title: conversationTitle(conversation.participants),
      rank: bestRank(
        [conversationTitle(conversation.participants), ...conversation.participants.map((p) => p.displayName)],
        needle,
      ),
    }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => (empty ? 0 : a.rank - b.rank))
    .slice(0, SWITCHER_LIMITS.conversation)
    .map(
      (entry): SwitcherItem => ({
        kind: "conversation",
        id: `conversation:${entry.conversation.channelId}`,
        conversation: entry.conversation,
        title: entry.title,
        unread: sources.unread[entry.conversation.channelId]?.count ?? 0,
      }),
    );

  if (empty) {
    return [...personItems, ...groupItems.slice(0, 2)];
  }

  const serverItems = sources.servers
    .map((server) => ({ server, rank: matchRank(server.name, needle) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SWITCHER_LIMITS.server)
    .map(
      (entry): SwitcherItem => ({
        kind: "server",
        id: `server:${entry.server.id}`,
        name: entry.server.name,
        iconUrl: entry.server.iconUrl ?? null,
      }),
    );

  const channelItems = sources.channels
    .filter((channel) => channel.type !== "category")
    .map((channel) => ({ channel, rank: matchRank(channel.name, needle.replace(/^#/, "")) }))
    .filter((entry) => entry.rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, SWITCHER_LIMITS.channel)
    .map(
      (entry): SwitcherItem => ({
        kind: "channel",
        id: `channel:${entry.channel.id}`,
        name: entry.channel.name,
        type: entry.channel.type,
        serverName: sources.openServerName ?? "",
      }),
    );

  return [...personItems, ...groupItems, ...serverItems, ...channelItems];
}
