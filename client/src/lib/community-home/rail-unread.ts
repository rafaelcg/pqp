/**
 * What the server rail says about one server once the Baú is counted.
 *
 * THE RAIL'S VOCABULARY. A channel with unread messages lights the white pip
 * on the icon's left edge; a red NUMBER on the icon is reserved for mentions,
 * the things addressed to you. A Baú post is news for everybody, so PR 1005 gave
 * it the plain pip, and that turned out to be far too quiet for the feature
 * the product leads with: a new post looked like any busy channel.
 *
 * So the Baú now has a colour of its own, the brand signal (lime), which no
 * other cue on the rail uses for "unread": a lime COUNT at the icon's corner.
 * It never competes with a mention. The corner is one slot, and a red number
 * ("this is for you") must stay unambiguous, so when the server has mentions
 * the red count keeps the corner and the Baú moves to a lime RING around the
 * whole icon: still loud, still lime, no second badge to read. The pip stays
 * on for both, as it does for every unread thing.
 *
 * Server mute wins over all of it, as it does for channels: a muted server's
 * icon is dimmed and says nothing.
 */

export interface RailChannelTotals {
  count: number;
  mentions: number;
}

/** How the Baú announces itself on the icon. */
export type BauCue =
  /** Nothing unread in the Baú, or the server is muted. */
  | "none"
  /** A lime count at the icon's corner. */
  | "count"
  /** A lime ring around the icon: the corner already holds a mention count. */
  | "ring";

export interface RailServerIndicator {
  /** The red number on the icon. Only ever mentions. */
  mentions: number;
  /** The white pip on the icon's edge. */
  hasUnread: boolean;
  /** The pip is lit by the Baú and by nothing else (for the screen reader). */
  bauOnly: boolean;
  /** Which lime cue the Baú gets. */
  bauCue: BauCue;
  /** Unread Baú posts to show (0 when muted). */
  bauCount: number;
}

/** The lime count stops counting here: "9+". The row has room for more, an icon does not. */
export const BAU_BADGE_CAP = 9;

export function formatBauBadge(count: number): string {
  return count > BAU_BADGE_CAP ? `${BAU_BADGE_CAP}+` : String(count);
}

/** How long the "New" chip on the Baú row stays earned after the newest post. */
export const BAU_FRESH_MS = 24 * 60 * 60 * 1000;

/**
 * Whether the newest unread post is young enough to wear the "New" chip.
 * Unknown (an API that predates the field, a bad date) is NOT fresh: a chip
 * that cannot prove itself must not sit on the row for weeks.
 */
export function bauIsFresh(
  newestAt: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!newestAt) {
    return false;
  }
  const at = Date.parse(newestAt);
  if (Number.isNaN(at)) {
    return false;
  }
  // A clock a little behind the server's must not hide a post made a second ago.
  return now - at < BAU_FRESH_MS;
}

export function railServerIndicator(input: {
  totals: RailChannelTotals | null;
  /** Unread Baú posts for this server (`GET /api/community-home/unread`). */
  bauUnread: number;
  muted: boolean;
}): RailServerIndicator {
  if (input.muted) {
    return {
      mentions: 0,
      hasUnread: false,
      bauOnly: false,
      bauCue: "none",
      bauCount: 0,
    };
  }
  const mentions = input.totals?.mentions ?? 0;
  const channelsUnread = !!input.totals && (input.totals.count > 0 || mentions > 0);
  const bauCount = Math.max(0, Math.floor(input.bauUnread));
  const bauUnread = bauCount > 0;
  return {
    mentions,
    hasUnread: channelsUnread || bauUnread,
    bauOnly: bauUnread && !channelsUnread,
    bauCue: !bauUnread ? "none" : mentions > 0 ? "ring" : "count",
    bauCount,
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

/**
 * One server's "newest unread post" time in the per-server map, written. Same
 * contract as `withServerBauUnread`: the same object when nothing changed, the
 * key dropped when there is nothing to remember.
 */
export function withServerBauNewest(
  current: Readonly<Record<string, string>>,
  serverId: string,
  newestAt: string | null | undefined,
): Record<string, string> {
  const have = current[serverId];
  if ((have ?? null) === (newestAt ?? null)) {
    return current as Record<string, string>;
  }
  const next = { ...current };
  if (newestAt) {
    next[serverId] = newestAt;
  } else {
    delete next[serverId];
  }
  return next;
}
