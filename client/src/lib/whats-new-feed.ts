import { POSTS } from "@/lib/blog/posts";
import { browserStorage } from "@/lib/arrival";

/**
 * Last release-note slug this browser has opened in the in-app feed.
 *
 * Separate from the corner-card pack id (`pqp:whats-new`): that card is a
 * one-shot spotlight, this is "has anything newer than last visit shipped".
 */
const STORAGE_KEY = "pqp:whats-new-feed";

export function newestPostSlug(): string {
  return POSTS[0]?.slug ?? "";
}

export function hasUnseenWhatsNew(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  const newest = newestPostSlug();
  if (!newest) {
    return false;
  }
  if (!storage) {
    return false;
  }
  try {
    return storage.getItem(STORAGE_KEY) !== newest;
  } catch {
    return false;
  }
}

export function rememberWhatsNewFeed(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  const newest = newestPostSlug();
  if (!newest) {
    return;
  }
  try {
    storage?.setItem(STORAGE_KEY, newest);
  } catch {
    // Session-only: the pip comes back next load, which is fine.
  }
}
