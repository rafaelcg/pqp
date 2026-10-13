import { useEffect, useState } from "react";

const STORAGE_KEY = "pqp:collapsed-categories";

/**
 * Who else needs to know. The channel list owns the toggle, but the call
 * stage reads it too: a voice room inside a collapsed category is not on
 * screen, so the stage has to name the room itself again.
 */
const listeners = new Set<(ids: Set<string>) => void>();

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
 * The dot counts every other channel whose row would show something unread,
 * which `isUnread` answers with the row's own rule.
 */
export function foldSection<C extends { id: string }>(
  channels: C[],
  {
    collapsed,
    selectedChannelId,
    activeVoiceChannelId,
    isUnread,
  }: {
    collapsed: boolean;
    selectedChannelId: string | null;
    activeVoiceChannelId: string | null;
    isUnread: (channel: C) => boolean;
  },
): { shown: C[]; hasUnread: boolean } {
  const shown = collapsed
    ? channels.filter(
        (c) => c.id === selectedChannelId || c.id === activeVoiceChannelId,
      )
    : channels;
  const hasUnread = channels.some(
    (c) => c.id !== selectedChannelId && isUnread(c),
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
  for (const listener of listeners) {
    listener(new Set(current));
  }
  return current;
}

/** The collapsed set, kept current as the channel list toggles it. */
export function useCollapsedCategories(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(() => loadCollapsedCategories());
  useEffect(() => {
    listeners.add(setIds);
    setIds(loadCollapsedCategories());
    return () => {
      listeners.delete(setIds);
    };
  }, []);
  return ids;
}
