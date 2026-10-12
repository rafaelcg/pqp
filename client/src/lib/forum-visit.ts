/**
 * One read-cursor answer per visit, whatever remounts in between.
 *
 * Opening a forum or a post asks the shell's `markRead` for the cursor the
 * visit replaced: that is what "Novo" and the "Novas" divider are measured
 * against. A remount of the same view (React's dev double mount, a layout
 * swap between the split and the full post) must not ask twice: the second
 * answer would be the first one's "now", and a first visit would read as a
 * revisit with nothing new in it.
 */

const recent = new Map<string, { at: number; previous: Promise<string | null> }>();

/** Asked again within this window, the same visit's answer is reused. */
export const VISIT_REMOUNT_WINDOW_MS = 2000;

export function readCursorOnce(
  channelId: string,
  markRead: (channelId: string) => Promise<string | null>,
  now: number = Date.now(),
): Promise<string | null> {
  const hit = recent.get(channelId);
  if (hit && now - hit.at < VISIT_REMOUNT_WINDOW_MS) {
    return hit.previous;
  }
  const previous = markRead(channelId);
  recent.set(channelId, { at: now, previous });
  return previous;
}

/** The visit really ended (the reader left): the next open is a new visit. */
export function forgetCursorRead(channelId: string): void {
  recent.delete(channelId);
}
