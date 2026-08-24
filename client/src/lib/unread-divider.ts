/**
 * Where the NEW / unread rule sits in a loaded message window.
 *
 * The cursor is the channel's last-read timestamp *before* opening marked it
 * read. A message at exactly that instant is already read (`>` matches the
 * SQL unread count). No cursor, or nothing in the window after it, means no
 * divider — first visit and "already caught up" both stay a normal tail.
 */

export function findFirstUnreadMessageId(
  messages: ReadonlyArray<{ id: string; createdAt: string }>,
  unreadSince: string | null | undefined,
): string | null {
  if (!unreadSince) {
    return null;
  }
  const since = Date.parse(unreadSince);
  if (!Number.isFinite(since)) {
    return null;
  }
  for (const message of messages) {
    const created = Date.parse(message.createdAt);
    if (Number.isFinite(created) && created > since) {
      return message.id;
    }
  }
  return null;
}
