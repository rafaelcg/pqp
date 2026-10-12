import type {
  ForumPostListResponse,
  ForumPostSummary,
  ForumPostViewer,
  ForumSort,
  ForumStatusFilter,
} from "@pqp/shared";
import { FORUM_UNREAD_CAP } from "@pqp/shared";

/**
 * The forum list as the pane holds it, and every change a live frame can make
 * to it. Pure on purpose: the pane is a thin shell around these functions, so
 * the rules that decide where a card goes (and, more often, that it does NOT
 * move) are tested here without a DOM.
 *
 * THE RULE THIS FILE EXISTS FOR: a list must never reorder under the reader.
 * A new post or a bump that arrives while the reader is scrolled down or has a
 * card focused is QUEUED, and the pane says so with a pill ("3 posts com
 * novidade · Atualizar"). Only at the top with nothing focused does a change
 * apply in place. An edit (title, tags, status) never moves anything, held or
 * not, because a card that changes its words in place is not a card that
 * jumps away from the pointer reaching for it.
 *
 * A bump moves a card only under `activity`, and only when the post still
 * passes the filters on screen: under `created` the order is the creation
 * order and a reply cannot change it.
 */

export interface ForumFilters {
  sort: ForumSort;
  status: ForumStatusFilter | null;
  mine: boolean;
  /** AND: a post must carry every one of these. */
  tagIds: readonly string[];
  /** The title search, trimmed. Empty is no search. */
  q: string;
}

export const DEFAULT_FORUM_FILTERS: ForumFilters = {
  sort: "activity",
  status: null,
  mine: false,
  tagIds: [],
  q: "",
};

export interface ForumListState {
  pinned: ForumPostSummary[];
  posts: ForumPostSummary[];
  viewer: Readonly<Record<string, ForumPostViewer>>;
  nextCursor: string | null;
  counts: { posts: number; open: number } | null;
  forumPreviousReadAt: string | null;
  /**
   * Live changes held back while the reader is busy, newest last, one entry
   * per post (a second bump of a queued post replaces the first). Applied by
   * `flushQueued` when the pill is pressed or the reader returns to the top.
   */
  queued: ForumPostSummary[];
  /**
   * Every post this list has seen, drawn or not (a new post that fails the
   * filters is seen and never drawn), with whether it was open. It is what
   * makes the header's totals count a post exactly once, move "abertos" when
   * one is resolved or reopened, and drop it when it is deleted, whichever
   * list it is in. Copied only when a post is first seen or changes state.
   */
  known: ReadonlyMap<string, boolean>;
  /**
   * The newest post by creation (time, then id: the server's keyset order)
   * among the ones seen. An unseen post newer than this is a new post; an
   * unseen older one is an old post this list had not reached.
   */
  newest: { createdAt: string; id: string } | null;
}

export function emptyForumList(): ForumListState {
  return {
    pinned: [],
    posts: [],
    viewer: {},
    nextCursor: null,
    counts: null,
    forumPreviousReadAt: null,
    queued: [],
    known: new Map(),
    newest: null,
  };
}

/** Creation order, newest first: time, then id (the server's tie-breaker). */
function createdAfter(
  post: { createdAt: string; id: string },
  than: { createdAt: string; id: string } | null,
): boolean {
  if (than === null) {
    return true;
  }
  if (post.createdAt !== than.createdAt) {
    return post.createdAt > than.createdAt;
  }
  return post.id > than.id;
}

function newestOf(
  posts: readonly ForumPostSummary[],
  start: ForumListState["newest"] = null,
): ForumListState["newest"] {
  let newest = start;
  for (const post of posts) {
    if (createdAfter(post, newest)) {
      newest = { createdAt: post.createdAt, id: post.id };
    }
  }
  return newest;
}

function withKnown(
  known: ReadonlyMap<string, boolean>,
  posts: readonly ForumPostSummary[],
): ReadonlyMap<string, boolean> {
  const next = new Map(known);
  for (const post of posts) {
    next.set(post.id, post.resolvedAt === null);
  }
  return next;
}

function viewerMap(
  viewers: readonly ForumPostViewer[],
  base: Readonly<Record<string, ForumPostViewer>> = {},
): Record<string, ForumPostViewer> {
  const next: Record<string, ForumPostViewer> = { ...base };
  for (const one of viewers) {
    next[one.postId] = one;
  }
  return next;
}

/** Page 1: replaces everything, the queue included (it is now on screen). */
export function forumListFromPage(page: ForumPostListResponse): ForumListState {
  const pinnedIds = new Set(page.pinned.map((post) => post.id));
  const posts = page.posts.filter((post) => !pinnedIds.has(post.id));
  return {
    pinned: page.pinned,
    posts,
    viewer: viewerMap(page.viewer),
    nextCursor: page.nextCursor,
    counts: page.counts,
    forumPreviousReadAt: page.forumPreviousReadAt,
    queued: [],
    known: withKnown(new Map(), [...page.pinned, ...posts]),
    newest: newestOf([...page.pinned, ...posts]),
  };
}

/**
 * A later page. Deduplicated by id: a keyset page read after a bump moved a
 * card up can hand back a post already on screen, and drawing it twice is the
 * duplicate-key bug every live list ships once.
 */
export function appendForumPage(
  state: ForumListState,
  page: ForumPostListResponse,
): ForumListState {
  const seen = new Set([
    ...state.pinned.map((post) => post.id),
    ...state.posts.map((post) => post.id),
  ]);
  const fresh = page.posts.filter((post) => !seen.has(post.id));
  return {
    ...state,
    posts: [...state.posts, ...fresh],
    viewer: viewerMap(page.viewer, state.viewer),
    nextCursor: page.nextCursor,
    known: fresh.length > 0 ? withKnown(state.known, fresh) : state.known,
    newest: newestOf(fresh, state.newest),
  };
}

/** Lowercased, accents folded: "Notebook não liga" matches "notebook nao". */
export function foldForSearch(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

/** Every word of the query appears in the title, in any order. */
export function titleMatchesQuery(title: string, q: string): boolean {
  const words = foldForSearch(q).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return true;
  }
  const folded = foldForSearch(title);
  return words.every((word) => folded.includes(word));
}

/** The same filter the server applies, for a post a frame just handed us. */
export function passesForumFilters(
  post: ForumPostSummary,
  filters: ForumFilters,
  viewerId: string | null,
): boolean {
  if (filters.status === "open" && post.resolvedAt !== null) {
    return false;
  }
  if (filters.status === "resolved" && post.resolvedAt === null) {
    return false;
  }
  if (filters.mine && (viewerId === null || post.authorId !== viewerId)) {
    return false;
  }
  if (filters.tagIds.some((tagId) => !post.tagIds.includes(tagId))) {
    return false;
  }
  if (filters.q && !titleMatchesQuery(post.title, filters.q)) {
    return false;
  }
  return true;
}

/** Any filter that narrows the list (sort is an order, not a filter). */
export function forumFiltersActive(filters: ForumFilters): boolean {
  return (
    filters.status !== null ||
    filters.mine ||
    filters.tagIds.length > 0 ||
    filters.q.length > 0
  );
}

function sortKey(post: ForumPostSummary, sort: ForumSort): string {
  return sort === "activity" ? post.lastActivityAt : post.createdAt;
}

/** Newest first, then id, the server's keyset order. */
function compareForSort(sort: ForumSort) {
  return (a: ForumPostSummary, b: ForumPostSummary) => {
    const ka = sortKey(a, sort);
    const kb = sortKey(b, sort);
    if (ka !== kb) {
      return ka < kb ? 1 : -1;
    }
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };
}

export interface ForumUpsertContext {
  filters: ForumFilters;
  viewerId: string | null;
  /** The reader is scrolled down or has a card focused: queue, do not move. */
  hold: boolean;
  /** The post open in the pane, whose replies the reader is watching land. */
  openPostId?: string | null;
}

function replaceIn(
  list: ForumPostSummary[],
  post: ForumPostSummary,
): ForumPostSummary[] {
  return list.map((one) => (one.id === post.id ? post : one));
}

function withoutId(list: ForumPostSummary[], id: string): ForumPostSummary[] {
  return list.filter((one) => one.id !== id);
}

/**
 * Where a post the list did not hold belongs, or null when it belongs past
 * the loaded pages (paging will bring it) or nowhere at all.
 */
function insertSorted(
  list: ForumPostSummary[],
  post: ForumPostSummary,
  sort: ForumSort,
  complete: boolean,
): ForumPostSummary[] | null {
  const compare = compareForSort(sort);
  const index = list.findIndex((one) => compare(post, one) < 0);
  if (index === -1) {
    // Older than everything loaded: only ours to draw when there is nothing
    // left to page in, otherwise the next page carries it in its place.
    return complete ? [...list, post] : null;
  }
  return [...list.slice(0, index), post, ...list.slice(index)];
}

/**
 * The viewer half for a post a frame changed. Frames carry no viewer state, so
 * this is a local estimate until the next read: a bump of a post the reader
 * opened before counts its new replies; a post the reader has open counts
 * nothing, because they are reading those replies as they land.
 */
function nextViewer(
  previous: ForumPostSummary | undefined,
  post: ForumPostSummary,
  viewer: ForumPostViewer | undefined,
  ctx: ForumUpsertContext,
): ForumPostViewer | undefined {
  if (ctx.openPostId === post.id) {
    // On screen: whatever just landed in it is being read as it lands, the
    // reader's own reply included. Without this the card beside the open
    // post lit up as unread for the post the reader is in.
    return {
      postId: post.id,
      lastReadAt: post.lastActivityAt,
      newReplyCount: 0,
      following: viewer?.following ?? false,
    };
  }
  if (!viewer) {
    return viewer;
  }
  if (!previous || viewer.lastReadAt === null) {
    return viewer;
  }
  const added = post.replyCount - previous.replyCount;
  if (added <= 0) {
    return viewer;
  }
  return {
    ...viewer,
    newReplyCount: Math.min(FORUM_UNREAD_CAP, viewer.newReplyCount + added),
  };
}

/**
 * The header's totals after one frame, from what this list knew about the
 * post (`known`) rather than from where it happens to be drawn: a post is
 * counted once when it first arrives as new, and "abertos" moves only when a
 * post it knew changes between open and resolved.
 */
function adjustCounts(
  counts: ForumListState["counts"],
  knownOpen: boolean | undefined,
  post: ForumPostSummary,
  isNew: boolean,
): ForumListState["counts"] {
  if (!counts) {
    return counts;
  }
  let { posts, open } = counts;
  const isOpen = post.resolvedAt === null;
  if (isNew) {
    posts += 1;
    if (isOpen) {
      open += 1;
    }
  } else if (knownOpen !== undefined && knownOpen !== isOpen) {
    open = isOpen ? open + 1 : Math.max(0, open - 1);
  }
  return { posts, open };
}

/**
 * One `forum-post-upsert`. See the header for the rules; in short: edits apply
 * in place, moves and arrivals queue while the reader is busy, a bump moves a
 * card only under `activity` and only when it still passes the filters.
 */
export function applyForumUpsert(
  state: ForumListState,
  post: ForumPostSummary,
  ctx: ForumUpsertContext,
): ForumListState {
  const { filters } = ctx;
  const previous =
    state.pinned.find((one) => one.id === post.id) ??
    state.posts.find((one) => one.id === post.id) ??
    state.queued.find((one) => one.id === post.id);
  const viewer = nextViewer(previous, post, state.viewer[post.id], ctx);
  const viewerNext =
    viewer && viewer !== state.viewer[post.id]
      ? { ...state.viewer, [post.id]: viewer }
      : state.viewer;
  // A post never seen, newer by creation than every post seen, is a new
  // post (whether or not it already has a reply when its first frame lands);
  // an unseen older one is an old post bumped or edited beyond the pages.
  const knownOpen = state.known.get(post.id);
  const isOpen = post.resolvedAt === null;
  const brandNew = knownOpen === undefined && createdAfter(post, state.newest);
  const counts = adjustCounts(state.counts, knownOpen, post, brandNew);
  const known =
    knownOpen === isOpen ? state.known : new Map(state.known).set(post.id, isOpen);
  const newest = brandNew ? { createdAt: post.createdAt, id: post.id } : state.newest;
  // A queued snapshot is always the latest: an edit after a held bump must
  // not be undone by the pill applying the older copy.
  const queuedFresh = state.queued.some((one) => one.id === post.id)
    ? replaceIn(state.queued, post)
    : state.queued;

  // ---------------------------------------------------------------- pinned
  // Pins sit above every filter and only vanish under a search.
  const wasPinned = state.pinned.some((one) => one.id === post.id);
  if (post.pinnedAt !== null && !filters.q) {
    const pinned = wasPinned
      ? replaceIn(state.pinned, post)
      : [...state.pinned, post];
    return {
      ...state,
      pinned,
      posts: withoutId(state.posts, post.id),
      queued: withoutId(state.queued, post.id),
      viewer: viewerNext,
      counts,
      known,
      newest,
    };
  }
  const base: ForumListState = {
    ...state,
    pinned: wasPinned ? withoutId(state.pinned, post.id) : state.pinned,
    viewer: viewerNext,
    counts,
    known,
    newest,
    queued: queuedFresh,
  };

  const index = base.posts.findIndex((one) => one.id === post.id);
  const passes = passesForumFilters(post, filters, ctx.viewerId);

  // ------------------------------------------------------------ on screen
  if (index !== -1) {
    const old = base.posts[index];
    if (!passes) {
      // It left the filter (resolved under Abertos, retagged). Under the
      // reader's hand it stays put, updated, until they let go.
      return ctx.hold
        ? { ...base, posts: replaceIn(base.posts, post) }
        : { ...base, posts: withoutId(base.posts, post.id) };
    }
    const moved =
      filters.sort === "activity" && post.lastActivityAt > old.lastActivityAt;
    if (!moved || index === 0) {
      return { ...base, posts: replaceIn(base.posts, post) };
    }
    if (ctx.hold) {
      // The words update now; the move waits for the pill.
      return {
        ...base,
        posts: replaceIn(base.posts, post),
        queued: [...withoutId(base.queued, post.id), post],
      };
    }
    const rest = withoutId(base.posts, post.id);
    const placed = insertSorted(rest, post, filters.sort, true) ?? rest;
    return { ...base, posts: placed };
  }

  // ------------------------------------------------------- not on screen
  if (!passes) {
    return { ...base, queued: withoutId(base.queued, post.id) };
  }
  // By its place in the order on screen: a new post lands on top, an old one
  // the pages had not reached is left for them (insertSorted answers null),
  // and one that now passes the filters (retagged, reopened) takes its slot.
  const placed = insertSorted(
    base.posts,
    post,
    filters.sort,
    base.nextCursor === null,
  );
  if (!placed) {
    // It sorts past the loaded pages: the next page brings it.
    return { ...base, queued: withoutId(base.queued, post.id) };
  }
  if (ctx.hold) {
    return { ...base, queued: [...withoutId(base.queued, post.id), post] };
  }
  return { ...base, posts: placed };
}

/** One `forum-post-removed`: gone from every list, the queue included. */
export function applyForumRemoved(
  state: ForumListState,
  postId: string,
): ForumListState {
  // Whatever list it is in, the queue behind the pill included, or none
  // (a new post the filters hide): the totals drop once for a post they
  // counted, and the pill drops with the queue.
  const knownOpen = state.known.get(postId);
  if (knownOpen === undefined) {
    return state;
  }
  const counts = state.counts
    ? {
        posts: Math.max(0, state.counts.posts - 1),
        open: knownOpen ? Math.max(0, state.counts.open - 1) : state.counts.open,
      }
    : state.counts;
  const viewer = { ...state.viewer };
  delete viewer[postId];
  const known = new Map(state.known);
  known.delete(postId);
  return {
    ...state,
    pinned: withoutId(state.pinned, postId),
    posts: withoutId(state.posts, postId),
    queued: withoutId(state.queued, postId),
    viewer,
    counts,
    known,
  };
}

/** The pill was pressed (or the reader is back at the top): apply the queue. */
export function flushForumQueue(
  state: ForumListState,
  ctx: Omit<ForumUpsertContext, "hold">,
): ForumListState {
  // One pass, not one upsert per queued post: the queued posts (counted and
  // viewer-updated when they were queued) are taken out of the list, sorted
  // among themselves, and merged back into the sorted remainder. A card that
  // left the filters while held stayed put, updated; letting go is when it
  // leaves.
  const compare = compareForSort(ctx.filters.sort);
  const queuedIds = new Set(state.queued.map((post) => post.id));
  const rest = state.posts.filter(
    (post) =>
      !queuedIds.has(post.id) && passesForumFilters(post, ctx.filters, ctx.viewerId),
  );
  const incoming = state.queued
    .filter((post) => passesForumFilters(post, ctx.filters, ctx.viewerId))
    .sort(compare);
  const complete = state.nextCursor === null;
  const last = rest[rest.length - 1];
  const merged: ForumPostSummary[] = [];
  let r = 0;
  for (const post of incoming) {
    while (r < rest.length && compare(rest[r], post) < 0) {
      merged.push(rest[r]);
      r += 1;
    }
    // Past the loaded pages with more to page in: the next page brings it.
    if (r === rest.length && !complete && last && compare(post, last) > 0) {
      continue;
    }
    merged.push(post);
  }
  while (r < rest.length) {
    merged.push(rest[r]);
    r += 1;
  }
  return { ...state, queued: [], posts: merged };
}

/** Mark one post read locally (the reader opened it). */
export function markForumPostRead(
  state: ForumListState,
  postId: string,
  now: string,
): ForumListState {
  const viewer = state.viewer[postId];
  // Never earlier than the post's own last activity: a client clock behind
  // the server's would leave the card bold right after it was read.
  const post =
    state.pinned.find((one) => one.id === postId) ??
    state.posts.find((one) => one.id === postId);
  const at = post && post.lastActivityAt > now ? post.lastActivityAt : now;
  return {
    ...state,
    viewer: {
      ...state.viewer,
      [postId]: {
        postId,
        lastReadAt: at,
        newReplyCount: 0,
        following: viewer?.following ?? false,
      },
    },
  };
}

/** Replace one post wherever it is drawn (an optimistic edit or its rollback). */
export function patchForumPost(
  state: ForumListState,
  post: ForumPostSummary,
): ForumListState {
  return {
    ...state,
    pinned: replaceIn(state.pinned, post),
    posts: replaceIn(state.posts, post),
  };
}

export type ForumUnreadState =
  | { kind: "new" }
  | { kind: "unread"; count: number }
  | { kind: "read" };

/**
 * Two levels (UX §2.3): `new` is a post the viewer never opened, by somebody
 * else, created after their last visit to the forum; `unread` is one they
 * opened that has had replies since.
 */
export function forumUnreadState(
  post: ForumPostSummary,
  viewer: ForumPostViewer | undefined,
  viewerId: string | null,
  forumPreviousReadAt: string | null,
): ForumUnreadState {
  const mine = viewerId !== null && post.authorId === viewerId;
  if (!viewer || viewer.lastReadAt === null) {
    if (mine) {
      return { kind: "read" };
    }
    if (forumPreviousReadAt !== null && post.createdAt <= forumPreviousReadAt) {
      return { kind: "read" };
    }
    return { kind: "new" };
  }
  if (viewer.newReplyCount > 0 || post.lastActivityAt > viewer.lastReadAt) {
    return { kind: "unread", count: viewer.newReplyCount };
  }
  return { kind: "read" };
}

/**
 * Page 1 read again after a reconnect, MERGED into what the reader already
 * has: the fresh page replaces the top, the pages below it that the reader
 * scrolled through stay (with the cursor that continues them), and anything
 * still queued for the pill stays queued. Replacing everything here would
 * throw a reader on page 3 back to the top on every network blip.
 */
export function refreshForumFirstPage(
  state: ForumListState,
  page: ForumPostListResponse,
  options: { hold?: boolean } = {},
): ForumListState {
  const fresh = forumListFromPage(page);
  const known = withKnown(state.known, [...page.pinned, ...page.posts]);
  const newest = newestOf([...page.pinned, ...page.posts], state.newest);
  if (options.hold) {
    // The reader is busy: nothing moves. Cards on screen take the fresh
    // words in place, and posts page 1 shows that the reader does not have
    // yet wait behind the pill like any arrival.
    const freshById = new Map(
      [...fresh.pinned, ...fresh.posts].map((post) => [post.id, post]),
    );
    const onScreen = new Set([
      ...state.pinned.map((post) => post.id),
      ...state.posts.map((post) => post.id),
    ]);
    const patch = (list: ForumPostSummary[]) =>
      list.map((post) => freshById.get(post.id) ?? post);
    const pinnedIds = new Set(fresh.pinned.map((post) => post.id));
    const arrivals = fresh.posts.filter((post) => !onScreen.has(post.id));
    const queued = [
      ...patch(state.queued).filter(
        (post) => !arrivals.some((one) => one.id === post.id),
      ),
      ...arrivals,
    ];
    return {
      ...state,
      pinned: fresh.pinned,
      posts: patch(state.posts).filter((post) => !pinnedIds.has(post.id)),
      viewer: { ...state.viewer, ...fresh.viewer },
      counts: fresh.counts ?? state.counts,
      queued,
      known,
      newest,
    };
  }
  const shown = new Set([
    ...fresh.pinned.map((post) => post.id),
    ...fresh.posts.map((post) => post.id),
  ]);
  const tail = state.posts.filter((post) => !shown.has(post.id));
  const keepsTail = tail.length > 0 && state.posts.length > page.posts.length;
  return {
    ...fresh,
    posts: keepsTail ? [...fresh.posts, ...tail] : fresh.posts,
    nextCursor: keepsTail ? state.nextCursor : fresh.nextCursor,
    viewer: { ...state.viewer, ...fresh.viewer },
    queued: state.queued.filter((post) => !shown.has(post.id)),
    known,
    newest,
  };
}
