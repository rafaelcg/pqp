import type { StoryStrip, StoryStripItem } from "@pqp/shared";

/**
 * What a strip draws, decided without React.
 *
 * Three rules from the contract live here so they are tested in one place:
 *
 * - The server orders the strip and the client never reorders it. Seen state
 *   is overlaid on the item where it stands; an author who has just been
 *   watched keeps their place until the next fetch says otherwise.
 * - Expiry sends no frame. A ring whose newest story has passed `expiresAt`
 *   leaves on the client's own clock, and the strip asks for a timer at the
 *   next expiry so it leaves on time without a poll.
 * - The strip is drawn only while something is live. An empty strip costs a
 *   row of every sidebar forever; the one exception is the first-run row.
 */

function expiresAtMs(item: Pick<StoryStripItem, "expiresAt">): number {
  const ms = Date.parse(item.expiresAt);
  return Number.isFinite(ms) ? ms : 0;
}

export function isStripItemLive(
  item: Pick<StoryStripItem, "expiresAt">,
  now: number,
): boolean {
  return expiresAtMs(item) > now;
}

/**
 * The items still live at `now`, in the server's order, with `unseen` turned
 * off for an author whose every story this browser has watched since the
 * fetch. Never sorts.
 */
export function visibleStripItems(
  items: readonly StoryStripItem[],
  now: number,
  seenIds: ReadonlySet<string>,
): StoryStripItem[] {
  return items
    .filter((item) => isStripItemLive(item, now))
    .map((item) =>
      item.unseen && item.storyIds.every((id) => seenIds.has(id))
        ? { ...item, unseen: false }
        : item,
    );
}

/** The viewer's own ring, or null once its newest story has expired. */
export function liveOwnItem(
  strip: Pick<StoryStrip, "own">,
  now: number,
): StoryStripItem | null {
  return strip.own && isStripItemLive(strip.own, now) ? strip.own : null;
}

/**
 * Milliseconds until the next ring in this strip expires, or null when none
 * will. Clamped so a timer is never armed for 0 ms in a loop, nor for longer
 * than a browser's `setTimeout` can hold.
 */
export function msUntilNextExpiry(
  strip: Pick<StoryStrip, "own" | "items">,
  now: number,
): number | null {
  const candidates = [...strip.items, ...(strip.own ? [strip.own] : [])]
    .map(expiresAtMs)
    .filter((ms) => ms > now);
  if (candidates.length === 0) {
    return null;
  }
  const next = Math.min(...candidates) - now;
  return Math.min(Math.max(next + 50, 250), 2_147_483_000);
}

export type StripView =
  | { kind: "hidden" }
  | { kind: "first-run" }
  | { kind: "strip"; own: StoryStripItem | null; items: StoryStripItem[] };

/**
 * Which of the three faces a strip shows.
 *
 * - `hidden`: the flag is off for this audience, or nothing is live and the
 *   first-run row does not apply (or was dismissed).
 * - `first-run`: the one-off dashed row, only while the server says so, only
 *   for someone who may post, and only until it is dismissed.
 * - `strip`: at least one ring, the viewer's own or somebody else's. With
 *   `ownSlot`, the "Teu story" bubble alone is a ring too: the Conversas
 *   strip of somebody with friends (design §3.4), where no first-run row
 *   ever comes and the bubble is the way in to posting for Amigos.
 */
export function stripView(
  strip: StoryStrip,
  options: {
    now: number;
    seenIds: ReadonlySet<string>;
    firstRunDismissed: boolean;
    ownSlot?: boolean;
  },
): StripView {
  if (!strip.enabled) {
    return { kind: "hidden" };
  }
  const own = liveOwnItem(strip, options.now);
  const items = visibleStripItems(strip.items, options.now, options.seenIds);
  if (own || items.length > 0) {
    return { kind: "strip", own, items };
  }
  if (strip.firstRunHint && strip.canPost && !options.firstRunDismissed) {
    return { kind: "first-run" };
  }
  if (options.ownSlot && strip.canPost) {
    return { kind: "strip", own: null, items: [] };
  }
  return { kind: "hidden" };
}

/**
 * Whether a freshly fetched strip may replace the one on screen right now.
 *
 * The design's rule: the client never reorders while a pointer or a finger is
 * on the strip. A refetch that only changes seen state or adds nothing moves
 * no ring and can land at once; one that changes the ORDER of authors waits
 * for the pointer to leave.
 */
export function canApplyStripNow(
  current: Pick<StoryStrip, "items"> | null,
  next: Pick<StoryStrip, "items">,
  pointerOnStrip: boolean,
): boolean {
  if (!pointerOnStrip || !current) {
    return true;
  }
  const before = current.items.map((item) => item.author.id);
  const after = next.items.map((item) => item.author.id);
  if (before.length !== after.length) {
    return false;
  }
  return before.every((id, index) => id === after[index]);
}
