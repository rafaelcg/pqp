/**
 * Where the NEW / unread rule sits in a loaded message window.
 *
 * The cursor is the channel's last-read timestamp *before* opening marked it
 * read. A message at exactly that instant is already read (`>` matches the
 * SQL unread count). No cursor, or nothing in the window after it, means no
 * divider — first visit and "already caught up" both stay a normal tail.
 *
 * The viewer's own messages are never unread, for the same reason the SQL
 * count skips `author_id = viewer`: otherwise a burst you sent puts the rule
 * above your own words, and the divider and the badge disagree.
 */

export function findFirstUnreadMessageId(
  messages: ReadonlyArray<{ id: string; createdAt: string; authorId?: string }>,
  unreadSince: string | null | undefined,
  viewerId: string | null | undefined,
): string | null {
  if (!unreadSince) {
    return null;
  }
  const since = Date.parse(unreadSince);
  if (!Number.isFinite(since)) {
    return null;
  }
  for (const message of messages) {
    if (viewerId && message.authorId === viewerId) {
      continue;
    }
    const created = Date.parse(message.createdAt);
    if (Number.isFinite(created) && created > since) {
      return message.id;
    }
  }
  return null;
}
