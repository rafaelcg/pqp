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
