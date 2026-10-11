import {
  FORUM_MAX_TAGS_PER_POST,
  FORUM_TITLE_MAX,
  forumSortSchema,
  forumStatusFilterSchema,
} from "@pqp/shared";
import type { ForumFilters } from "@/lib/forum-list";

/**
 * Per-viewer conveniences for the forum pane, in `localStorage`: the filters
 * and sort a forum was left on, whether its guidelines are collapsed, whether
 * a post opens maximized, and the composer's title and tags (the body is the
 * chat composer's own draft, keyed by the forum id in `composer-drafts.ts`).
 *
 * None of it is state that must survive: a private window, blocked storage or
 * a read that throws all fall back to the defaults, and every access is
 * wrapped so the pane renders the same either way.
 */

const PREFIX = "pqp:forum:";

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(PREFIX + key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) {
      window.localStorage.removeItem(PREFIX + key);
    } else {
      window.localStorage.setItem(PREFIX + key, value);
    }
  } catch {
    // Storage is a convenience here; losing a write loses nothing important.
  }
}

function readJson(key: string): unknown {
  const raw = read(key);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/** What the forum was last filtered by. The search query is not remembered. */
export type StoredForumView = Omit<ForumFilters, "q">;

export function readForumView(
  forumId: string,
  fallbackSort: ForumFilters["sort"],
): StoredForumView {
  const stored = readJson(`${forumId}:view`) as Partial<StoredForumView> | null;
  const sort = forumSortSchema.safeParse(stored?.sort);
  const status = forumStatusFilterSchema.safeParse(stored?.status);
  const tagIds = Array.isArray(stored?.tagIds)
    ? stored.tagIds.filter((one): one is string => typeof one === "string")
    : [];
  return {
    sort: sort.success ? sort.data : fallbackSort,
    status: status.success ? status.data : null,
    mine: stored?.mine === true,
    tagIds,
  };
}

export function writeForumView(forumId: string, view: StoredForumView): void {
  write(`${forumId}:view`, JSON.stringify(view));
}

export function readRulesHidden(forumId: string): boolean {
  return read(`${forumId}:rules-hidden`) === "1";
}

export function writeRulesHidden(forumId: string, hidden: boolean): void {
  write(`${forumId}:rules-hidden`, hidden ? "1" : null);
}

/** Global, not per forum: it is how this person likes to read posts. */
export function readPostMaximized(): boolean {
  return read("post-maximized") === "1";
}

export function writePostMaximized(maximized: boolean): void {
  write("post-maximized", maximized ? "1" : null);
}

export interface ForumComposerDraft {
  title: string;
  tagIds: string[];
}

export function readComposerDraft(forumId: string): ForumComposerDraft | null {
  const stored = readJson(`${forumId}:draft`) as Partial<ForumComposerDraft> | null;
  if (!stored) {
    return null;
  }
  const title =
    typeof stored.title === "string" ? stored.title.slice(0, FORUM_TITLE_MAX) : "";
  const tagIds = Array.isArray(stored.tagIds)
    ? stored.tagIds
        .filter((one): one is string => typeof one === "string")
        .slice(0, FORUM_MAX_TAGS_PER_POST)
    : [];
  if (!title && tagIds.length === 0) {
    return null;
  }
  return { title, tagIds };
}

export function writeComposerDraft(forumId: string, draft: ForumComposerDraft): void {
  if (!draft.title && draft.tagIds.length === 0) {
    write(`${forumId}:draft`, null);
    return;
  }
  write(`${forumId}:draft`, JSON.stringify(draft));
}

export function clearComposerDraft(forumId: string): void {
  write(`${forumId}:draft`, null);
}
