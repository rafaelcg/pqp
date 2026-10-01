/**
 * Which translated Baú posts this tab has flipped back to the author's own
 * words. Remembered for the session (a reload keeps it, a new tab starts over)
 * because it is a reading preference for these posts today, not a setting: a
 * person who wanted the original of a post wants it again when the feed
 * refreshes under them.
 *
 * `sessionStorage` can throw (private windows, blocked storage), so every
 * access is wrapped and an in-memory set stands in when it does.
 */

export const COMMUNITY_HOME_SHOW_ORIGINAL_KEY = "pqp:community-home-show-original";

/** A tab that flips more posts than this is not going to notice the oldest forgotten. */
const MAX_REMEMBERED = 200;

const memory = new Set<string>();

function readStored(): string[] {
  try {
    const raw = window.sessionStorage.getItem(COMMUNITY_HOME_SHOW_ORIGINAL_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [...memory];
  }
}

export function readShowOriginal(postId: string): boolean {
  return readStored().includes(postId) || memory.has(postId);
}

export function writeShowOriginal(postId: string, on: boolean): void {
  const next = readStored().filter((id) => id !== postId);
  if (on) {
    next.push(postId);
    memory.add(postId);
  } else {
    memory.delete(postId);
  }
  try {
    window.sessionStorage.setItem(
      COMMUNITY_HOME_SHOW_ORIGINAL_KEY,
      JSON.stringify(next.slice(-MAX_REMEMBERED)),
    );
  } catch {
    // Storage is blocked: the in-memory set above still answers.
  }
}

/** What a card shows for a post, given the reader's choice. Pure, so the lock cannot be bypassed here. */
export function displayFields(
  post: {
    title: string | null;
    body: string | null;
    teaser: string | null;
    translation: null | {
      original: { title: string | null; body: string | null; teaser: string | null };
    };
  },
  showOriginal: boolean,
): { title: string | null; body: string | null; teaser: string | null } {
  if (showOriginal && post.translation) {
    return post.translation.original;
  }
  return { title: post.title, body: post.body, teaser: post.teaser };
}
