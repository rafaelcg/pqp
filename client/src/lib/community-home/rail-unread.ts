/**
 * What the server rail says about one server once the Baú is counted.
 *
 * THE RAIL'S VOCABULARY, WHICH THIS FOLLOWS. A channel with unread messages
 * lights the white pip on the icon's left edge and nothing else; a red NUMBER
 * on the icon is reserved for mentions, the things addressed to you. A Baú post
 * is the first kind: news for everybody, addressed to nobody. A number on every
 * post would make the rail louder for a staff announcement than for a message
 * somebody wrote to you, so an unread Baú post is a pip, exactly like an unread
 * channel, and never a count.
 *
 * Server mute wins over both, as it does for channels: a muted server's icon
 * is dimmed and says nothing.
 */

export interface RailChannelTotals {
  count: number;
  mentions: number;
}

export interface RailServerIndicator {
  /** The red number on the icon. Only ever mentions. */
  mentions: number;
  /** The white pip on the icon's edge. */
  hasUnread: boolean;
  /** The pip is lit by the Baú and by nothing else (for the screen reader). */
  bauOnly: boolean;
}

export function railServerIndicator(input: {
  totals: RailChannelTotals | null;
  /** Unread Baú posts for this server (`GET /api/community-home/unread`). */
  bauUnread: number;
  muted: boolean;
}): RailServerIndicator {
  if (input.muted) {
    return { mentions: 0, hasUnread: false, bauOnly: false };
  }
  const mentions = input.totals?.mentions ?? 0;
  const channelsUnread = !!input.totals && (input.totals.count > 0 || mentions > 0);
  const bauUnread = input.bauUnread > 0;
  return {
    mentions,
    hasUnread: channelsUnread || bauUnread,
    bauOnly: bauUnread && !channelsUnread,
  };
}

/**
 * One server's entry in the per-server Baú unread map, written. Returns the
 * same object when nothing changed so React skips the render, and drops the
 * key at zero so the map stays the size of what is actually unread.
 */
export function withServerBauUnread(
  current: Readonly<Record<string, number>>,
  serverId: string,
  count: number,
): Record<string, number> {
  const have = current[serverId] ?? 0;
  if (have === count) {
    return current as Record<string, number>;
  }
  const next = { ...current };
  if (count > 0) {
    next[serverId] = count;
  } else {
    delete next[serverId];
  }
  return next;
}
