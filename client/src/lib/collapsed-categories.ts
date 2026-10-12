const STORAGE_KEY = "pqp:collapsed-categories";

/**
 * Which category headers are collapsed, by channel id — global across
 * servers rather than scoped to one, since a category id is already unique
 * and scoping would only cost complexity for a case (the same person
 * managing two servers with the same collapse habits) nobody asked for.
 */
export function loadCollapsedCategories(): Set<string> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return new Set();
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((id): id is string => typeof id === "string"))
      : new Set();
  } catch {
    // Corrupt or inaccessible storage collapses nothing rather than throwing
    // — a sidebar that fails to remember a UI preference is a rough edge, not
    // a broken app.
    return new Set();
  }
}

function persist(ids: Set<string>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // Same trade as the read side: a quota error or a disabled storage API
    // must not stop the toggle from working for the rest of the session.
  }
}

/**
 * The key a classic list's Texto or Voz section folds under, in the same set
 * as the categories (Pinados does the same with `favoritesCollapseKey`).
 * Per server: those two sections exist on every server, so one global key
 * would fold Texto everywhere at once.
 */
export function sectionCollapseKey(
  serverId: string,
  section: "text" | "voice",
): string {
  return `${section}:${serverId}`;
}

/**
 * What a section shows and says while folded. Folding never hides where you
 * are: the open channel and the call you are in stay under a folded header.
 * The dot counts every other unread channel in it.
 */
export function foldSection<C extends { id: string }>(
  channels: C[],
  {
    collapsed,
    selectedChannelId,
    activeVoiceChannelId,
    unreadCount,
  }: {
    collapsed: boolean;
    selectedChannelId: string | null;
    activeVoiceChannelId: string | null;
    unreadCount: (channelId: string) => number;
  },
): { shown: C[]; hasUnread: boolean } {
  const shown = collapsed
    ? channels.filter(
        (c) => c.id === selectedChannelId || c.id === activeVoiceChannelId,
      )
    : channels;
  const hasUnread = channels.some(
    (c) => c.id !== selectedChannelId && unreadCount(c.id) > 0,
  );
  return { shown, hasUnread };
}

/** Flips one category's collapsed state and returns the new set, so a caller
 * can both persist it and set it as React state in one call. */
export function toggleCollapsedCategory(categoryId: string): Set<string> {
  const current = loadCollapsedCategories();
  if (current.has(categoryId)) {
    current.delete(categoryId);
  } else {
    current.add(categoryId);
  }
  persist(current);
  return current;
}
