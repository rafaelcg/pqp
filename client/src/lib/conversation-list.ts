import type { DmSummary, UnreadCounts } from "@pqp/shared";
import { conversationTitle } from "@/lib/conversations";

/**
 * Conversas: the pure rules behind the conversation list (filters, search,
 * the Fixadas section) and the rail badge. No React, so each rule is a test.
 */

export type ConversationFilter = "all" | "unread" | "groups";

/** Lowercase, accents folded: "joão" is found by "joao", the way people type. */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * Does the search box match this conversation? By anybody's display name or
 * username in it, or by the title the row shows. Empty matches everything.
 */
export function matchesConversationQuery(
  conversation: DmSummary,
  query: string,
): boolean {
  const needle = foldForSearch(query);
  if (!needle) {
    return true;
  }
  if (foldForSearch(conversationTitle(conversation.participants)).includes(needle)) {
    return true;
  }
  return conversation.participants.some(
    (person) =>
      foldForSearch(person.displayName).includes(needle) ||
      (person.username ? foldForSearch(person.username).includes(needle) : false) ||
      (person.tag ? foldForSearch(person.tag).includes(needle) : false),
  );
}

/** A conversation the viewer has not read, and is not looking at. */
export function hasUnread(
  conversation: DmSummary,
  unread: Readonly<Record<string, UnreadCounts>>,
  openChannelId: string | null,
): boolean {
  return (
    conversation.channelId !== openChannelId &&
    (unread[conversation.channelId]?.count ?? 0) > 0
  );
}

/**
 * The list as drawn: search, then the chip. The open conversation always
 * survives "Não lidas", or opening it would make it vanish from under the
 * pointer the moment it is read.
 */
export function filterConversations(
  list: readonly DmSummary[],
  options: {
    query: string;
    filter: ConversationFilter;
    unread: Readonly<Record<string, UnreadCounts>>;
    openChannelId: string | null;
  },
): DmSummary[] {
  return list.filter((conversation) => {
    if (!matchesConversationQuery(conversation, options.query)) {
      return false;
    }
    if (options.filter === "groups") {
      return conversation.kind === "group";
    }
    if (options.filter === "unread") {
      return (
        conversation.channelId === options.openChannelId ||
        hasUnread(conversation, options.unread, options.openChannelId)
      );
    }
    return true;
  });
}

/**
 * Fixadas and Recentes. Pinned rows keep the pin order (the rail's order, so
 * the two places agree); the rest keep the list's recency order.
 */
export function splitPinned(
  list: readonly DmSummary[],
  pinnedIds: readonly string[],
): { pinned: DmSummary[]; recent: DmSummary[] } {
  const byId = new Map(list.map((conversation) => [conversation.channelId, conversation]));
  const pinned: DmSummary[] = [];
  const seen = new Set<string>();
  for (const id of pinnedIds) {
    const conversation = byId.get(id);
    if (conversation && !seen.has(id)) {
      pinned.push(conversation);
      seen.add(id);
    }
  }
  return {
    pinned,
    recent: list.filter((conversation) => !seen.has(conversation.channelId)),
  };
}

/**
 * The rail and tab badge: how many CONVERSATIONS are waiting, not how many
 * messages. Three people writing forty lines is "3". Muted conversations are
 * not counted (they badge nothing anywhere else either), and neither is the
 * one on screen.
 */
export function conversationsWithUnread(
  list: readonly DmSummary[],
  unread: Readonly<Record<string, UnreadCounts>>,
  options: { openChannelId?: string | null; isMuted?: (channelId: string) => boolean } = {},
): DmSummary[] {
  return list.filter(
    (conversation) =>
      hasUnread(conversation, unread, options.openChannelId ?? null) &&
      !options.isMuted?.(conversation.channelId),
  );
}
