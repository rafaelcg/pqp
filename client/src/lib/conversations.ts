/**
 * Turning the conversation list the API returns into something the sidebar and
 * the chat pane can render.
 *
 * A conversation has no name. Everything visible about one — its title, its
 * avatars, its place in the list — is derived from its participants and its last
 * message, which is why that derivation lives here as plain functions rather
 * than inside a component: it is the part worth pinning with tests.
 */

import type { Channel, DmSummary, PublicUser, UnreadCounts } from "@pqp/shared";

/** Past this the names stop identifying the room and start being a wall. */
const MAX_TITLE_NAMES = 3;

/**
 * What to call a conversation, given everybody in it except the reader.
 *
 * The viewer is already excluded by `dmSummarySchema`, so nothing here has to
 * filter them out — and must not try, because a group where somebody happens to
 * share the viewer's display name is not the viewer.
 */
export function conversationTitle(
  participants: readonly PublicUser[],
): string {
  const names = participants.map((person) => person.displayName);
  if (names.length === 0) {
    // Everybody else left, or their accounts are gone. Naming the state beats a
    // blank row that reads as a rendering bug.
    return "Empty conversation";
  }
  if (names.length <= MAX_TITLE_NAMES) {
    return names.join(", ");
  }
  const shown = names.slice(0, MAX_TITLE_NAMES);
  const rest = names.length - MAX_TITLE_NAMES;
  return `${shown.join(", ")} and ${rest} other${rest === 1 ? "" : "s"}`;
}

/**
 * The open conversation, shaped as the channel it actually is in the database.
 *
 * The chat pane, the composer, the message list, typing, reactions and read
 * cursors are all channel-scoped already and work on a conversation unchanged.
 * Handing them this instead of a second set of props is what keeps direct
 * messages from becoming a parallel messaging path — the failure mode the
 * decision record calls out by name.
 *
 * `isPrivate` is false even though a conversation is the most private thing in
 * the product: that flag means "a server channel with an access list", and
 * setting it would put the private-channel lock and its "Private ·" subtitle on
 * every DM. Privacy here is carried by `kind`.
 */
export function conversationChannel(summary: DmSummary): Channel {
  return {
    id: summary.channelId,
    serverId: null,
    kind: summary.kind,
    name: conversationTitle(summary.participants),
    type: "text",
    position: 0,
    isPrivate: false,
    topic: null,
    imageUrl: null,
    // A conversation has no category to sit under — categories are a
    // server-sidebar concept and a conversation lives in the Home rail.
    parentId: null,
  };
}

/**
 * Most recently spoken in first.
 *
 * A conversation nobody has said anything in yet sorts to the bottom rather
 * than the top: it has no activity to justify the position, and opening one
 * navigates straight into it anyway, so it is never lost by being placed last.
 */
export function sortConversations(
  list: readonly DmSummary[],
): DmSummary[] {
  return [...list].sort((a, b) => {
    if (a.lastMessageAt === b.lastMessageAt) {
      return 0;
    }
    if (a.lastMessageAt === null) {
      return 1;
    }
    if (b.lastMessageAt === null) {
      return -1;
    }
    return a.lastMessageAt < b.lastMessageAt ? 1 : -1;
  });
}

/** Add a conversation, or replace the copy already in the list, then re-sort. */
export function upsertConversation(
  list: readonly DmSummary[],
  summary: DmSummary,
): DmSummary[] {
  const without = list.filter(
    (conversation) => conversation.channelId !== summary.channelId,
  );
  return sortConversations([...without, summary]);
}

/**
 * Move a conversation to the top because something was just said in it.
 *
 * Returns the list unchanged when the id is not one of ours, which is the
 * normal case: activity frames arrive for server channels too, and re-sorting
 * the whole list for each of them would reorder the sidebar under the cursor.
 */
export function touchConversation(
  list: readonly DmSummary[],
  channelId: string,
  at: string,
): DmSummary[] {
  const current = list.find(
    (conversation) => conversation.channelId === channelId,
  );
  if (!current) {
    return list as DmSummary[];
  }
  return upsertConversation(list, { ...current, lastMessageAt: at });
}

/**
 * Whoever is in a conversation, said in the fewest words the header can carry.
 *
 * A 1:1 shows the other person's handle, which is the one piece of identity
 * that is stable across display-name changes. A group shows a head count
 * including the reader — "3 people" is what somebody in a room of three would
 * say, and excluding yourself here would contradict the count in the sidebar.
 */
export function conversationSubtitle(summary: DmSummary): string {
  if (summary.participants.length === 1) {
    const other = summary.participants[0]!;
    return other.tag ?? "Direct message";
  }
  return `${summary.participants.length + 1} people`;
}

/**
 * The unread each conversation was carrying when the list was fetched, ready to
 * seed the shared map with.
 *
 * The open conversation is skipped: opening one marks it read, and a snapshot
 * taken a moment earlier would put the badge straight back on the row the user
 * is currently reading.
 */
export function unreadFromConversations(
  list: readonly DmSummary[],
  openChannelId: string | null,
): Record<string, UnreadCounts> {
  const seeded: Record<string, UnreadCounts> = {};
  for (const conversation of list) {
    if (
      conversation.unread.count > 0 &&
      conversation.channelId !== openChannelId
    ) {
      seeded[conversation.channelId] = conversation.unread;
    }
  }
  return seeded;
}

/**
 * What the Home button badges with.
 *
 * Read from the live unread map rather than from `DmSummary.unread`, because
 * the summaries are a snapshot from load time while the map is what opening a
 * conversation clears and what every activity frame increments. Two counters
 * for one number is how a badge ends up outliving the thing it counted.
 */
export function conversationUnreadTotals(
  list: readonly DmSummary[],
  unread: Readonly<Record<string, UnreadCounts>>,
): UnreadCounts {
  return list.reduce<UnreadCounts>(
    (totals, conversation) => {
      const counts = unread[conversation.channelId];
      if (!counts) {
        return totals;
      }
      return {
        count: totals.count + counts.count,
        mentions: totals.mentions + counts.mentions,
      };
    },
    { count: 0, mentions: 0 },
  );
}
