import {
  type Channel,
  type ForumPostSummary,
  type ForumSettings,
  type ForumTag,
} from "@pqp/shared";
import {
  AlertTriangle,
  BookOpen,
  ChevronRight,
  ChevronUp,
  Info,
  Loader2,
  Menu as MenuIcon,
  MessagesSquare,
  Pin,
  Plus,
  Search,
  SearchX,
  ListFilter,
  Sparkles,
  Tag,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { ComposerSlashContext } from "@/components/chat/message-composer";
import type {
  MessageAuthorInfo,
  MessageRoleColor,
} from "@/components/chat/message-list";
import { FeatureHint, useFeatureHintEnabled } from "@/components/layout/feature-hint";
import { BetaTag } from "@/components/ui/beta-tag";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { SearchDialog } from "@/components/search/search-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import { useMediaQuery } from "@/components/ui/use-media-query";
import { isTextEntryTarget } from "@/components/voice/push-to-talk";
import type { ChatController, ChatMessage } from "@/hooks/use-chat";
import type { DroppedItems } from "@/lib/file-drop";
import {
  fetchForumPost,
  fetchForumPosts,
  fetchForumSettings,
  fetchForumTags,
  putForumTags,
} from "@/lib/forum-api";
import { fetchForumConfig } from "@/lib/api";
import { readCursorOnce } from "@/lib/forum-visit";
import {
  subscribeForumFrames,
  subscribeForumReconnected,
} from "@/lib/forum-frames";
import {
  DEFAULT_FORUM_FILTERS,
  appendForumPage,
  applyForumRemoved,
  applyForumUpsert,
  emptyForumList,
  flushForumQueue,
  forumFiltersActive,
  forumListFromPage,
  refreshForumFirstPage,
  forumUnreadState,
  markForumPostRead,
  patchForumPost,
  type ForumFilters,
  type ForumListState,
} from "@/lib/forum-list";
import {
  readForumView,
  readPostMaximized,
  readRulesHidden,
  writeForumView,
  writePostMaximized,
  writeRulesHidden,
} from "@/lib/forum-prefs";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { cn } from "@/lib/utils";
import { ForumComposerDialog } from "./forum-composer-dialog";
import { ForumFilterBar, describeActiveFilters } from "./forum-filter-bar";
import { ForumPostCard } from "./forum-post-card";
import { ForumPostView, type ForumPostViewProps } from "./forum-post-view";

/**
 * A forum channel (UX.md, "Forum channels: UX and UI"): the list of posts,
 * and the post beside it on a wide screen or over it on a narrow one.
 *
 * App mounts this in the main pane for a `forum` channel and has already sent
 * `join-channel` for the forum (so `forum-post-upsert` / `forum-post-removed`
 * arrive, through `lib/forum-frames.ts`) and moved the forum's read cursor.
 * Everything else is here: the list and its live rules (`lib/forum-list.ts`),
 * the filters, the composer, and the post view on App's thread controller.
 */

export interface ForumPaneProps {
  /** The forum channel. Its topic is the forum's guidelines. */
  channel: Channel;
  server: { id: string; name: string };
  viewerId: string | null;
  currentUser: ForumPostViewProps["currentUser"];
  /** SEND_MESSAGES on the forum: may publish a post. */
  canPost: boolean;
  /** MANAGE_MESSAGES or MANAGE_CHANNELS on the forum. */
  isStaff: boolean;
  /** MANAGE_CHANNELS on the forum: tags and settings. */
  canManage: boolean;
  /**
   * The runtime flag `forum_channels` for this server (`GET /api/forum/config`).
   * Off never hides anything: reading and replying go on, and Novo post becomes
   * "Novos posts estão pausados neste fórum." Omitted, the pane asks itself.
   */
  creationEnabled?: boolean;
  /** App's second chat controller, on the `thread-join` slot. */
  postController: ChatController;
  /**
   * Moves a channel's read cursor to now and answers the one it replaced.
   * The FIRST call for the forum itself answers the cursor from before this
   * visit without moving it again (the shell already moved it when the forum
   * opened); that answer is what "Novo" is measured against.
   */
  markRead: (channelId: string) => Promise<string | null>;
  /** The post in the address bar (`/post/<id>`); omitted, the pane keeps its own. */
  routePostId?: string | null;
  onRoutePostChange?: (postId: string | null) => void;
  onOpenNav: () => void;
  /** Channel settings, at the Tags section when asked (forum PR 3a). */
  onOpenSettings?: (section?: "tags") => void;
  /** The channel header's usual buttons (notifications, settings, members). */
  headerActions?: ReactNode;
  mentionCandidates: MentionCandidate[];
  blockedAuthorIds: ReadonlySet<string>;
  authors?: ReadonlyMap<string, MessageAuthorInfo>;
  roles?: readonly MessageRoleColor[];
  showLinkEmbeds: boolean;
  slashContext?: Omit<
    ComposerSlashContext,
    "sendChance" | "sendPoll" | "canPurgeMessages" | "openPurgeDialog"
  >;
  onReportMessage?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
  /**
   * Files dropped on the forum (the shell makes the whole pane a drop target
   * when it accepts): a drop means "start a post with this attached". The
   * pane opens Novo post with them and calls `onDroppedFilesTaken`; a drop it
   * cannot take is cleared the same way.
   */
  droppedFiles?: File[] | null;
  onDroppedFilesTaken?: () => void;
}

/** The content area must be this wide for the post to sit beside the list. */
const SPLIT_MIN_WIDTH = 900;
/** Infinite scroll asks for the next page this far before the end. */
const NEXT_PAGE_MARGIN_PX = 600;
const SEARCH_DEBOUNCE_MS = 250;
/** Scrolled further than this counts as "away from the top". */
const TOP_SLACK_PX = 8;

type StarterKey =
  | "question"
  | "bug"
  | "suggestion"
  | "tutorial"
  | "release"
  | "wip"
  | "discussion";
const STARTER_SUPPORT: readonly StarterKey[] = ["question", "bug", "suggestion", "tutorial"];
const STARTER_SHOWCASE: readonly StarterKey[] = ["release", "wip", "discussion", "question"];
const STARTER_EMOJI: Record<StarterKey, string> = {
  question: "❓",
  bug: "🐛",
  suggestion: "💡",
  tutorial: "📚",
  release: "🚀",
  wip: "🛠️",
  discussion: "💬",
};
const STARTER_LABEL: Record<StarterKey, MessageKey> = {
  question: "forum.starter.question",
  bug: "forum.starter.bug",
  suggestion: "forum.starter.suggestion",
  tutorial: "forum.starter.tutorial",
  release: "forum.starter.release",
  wip: "forum.starter.wip",
  discussion: "forum.starter.discussion",
};
const SUPPORT_NAME = /ajuda|suporte|help|d[uú]vida|bug|support/i;

export function forumPostPath(serverId: string, forumId: string, postId: string): string {
  return `/app/server/${serverId}/channel/${forumId}/post/${postId}`;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function CardSkeleton() {
  return (
    <div
      aria-hidden
      className="rounded-[var(--radius-card)] border border-border bg-surface-1 px-3.5 py-3"
    >
      <Skeleton className="h-4 w-3/5" />
      <Skeleton className="mt-2 h-3 w-11/12" />
      <div className="mt-3 flex items-center gap-1.5">
        <Skeleton className="h-5 w-14 rounded-full" />
        <Skeleton className="h-5 w-16 rounded-full" />
        <Skeleton className="ml-auto h-3 w-20" />
      </div>
    </div>
  );
}

function EmptyBlock({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-14 text-center animate-fade-in">
      <div className="grid h-14 w-14 place-items-center rounded-2xl bg-surface-2 text-text-secondary">
        {icon}
      </div>
      <p className="mt-4 font-display text-lg font-bold text-text">{title}</p>
      {body && <p className="mt-1 max-w-sm text-sm text-text-tertiary">{body}</p>}
      {children && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{children}</div>
      )}
    </div>
  );
}

export function ForumPane({
  channel,
  server,
  viewerId,
  currentUser,
  canPost,
  isStaff,
  canManage,
  creationEnabled: creationEnabledProp,
  postController,
  markRead,
  routePostId,
  onRoutePostChange,
  onOpenNav,
  onOpenSettings,
  headerActions,
  mentionCandidates,
  blockedAuthorIds,
  authors,
  roles,
  showLinkEmbeds,
  slashContext,
  onReportMessage,
  onForward,
  droppedFiles = null,
  onDroppedFilesTaken,
}: ForumPaneProps) {
  const { t } = useTranslation();
  const forumId = channel.id;
  const isPhone = useMediaQuery("(max-width: 767px)");

  // ---------------------------------------------------------- the visit
  // The cursor this visit replaced, from the shell (see `markRead`). The
  // list's own `forumPreviousReadAt` races the shell's mark-read and can
  // already be "now", which would make nothing look new; it is the fallback
  // only while this answer is in flight.
  const [visitCursor, setVisitCursor] = useState<{ previous: string | null } | null>(null);
  const markReadRef = useRef(markRead);
  markReadRef.current = markRead;
  useEffect(() => {
    let cancelled = false;
    setVisitCursor(null);
    readCursorOnce(forumId, markReadRef.current)
      .then((previous) => {
        if (!cancelled) {
          setVisitCursor({ previous });
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [forumId]);

  // ------------------------------------------------------------ tags etc.
  const [tags, setTags] = useState<ForumTag[]>([]);
  const [settings, setSettings] = useState<ForumSettings | null>(null);
  useEffect(() => {
    let cancelled = false;
    setTags([]);
    setSettings(null);
    fetchForumTags(forumId)
      .then(({ tags: next }) => !cancelled && setTags(next))
      .catch(() => {});
    fetchForumSettings(forumId)
      .then(({ settings: next }) => !cancelled && setSettings(next))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [forumId]);
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  // The flag, when the shell did not pass it. Unknown reads as on: a forum
  // only exists where the flag was on, and the server refuses a create anyway.
  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    if (creationEnabledProp !== undefined) {
      return;
    }
    let cancelled = false;
    fetchForumConfig(server.id)
      .then((config) => {
        if (!cancelled) {
          setFetchedEnabled(config.enabled === true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [creationEnabledProp, server.id]);
  const creationEnabled = creationEnabledProp ?? fetchedEnabled ?? true;

  // -------------------------------------------------------------- filters
  const [filters, setFilters] = useState<ForumFilters>(() => ({
    ...DEFAULT_FORUM_FILTERS,
    ...readForumView(forumId, DEFAULT_FORUM_FILTERS.sort),
  }));
  const [searchText, setSearchText] = useState("");
  // Another forum in the same mount: its own remembered view. Not on mount,
  // where the initial state already read it (a second read would fetch page 1
  // twice).
  const viewForumRef = useRef(forumId);
  useEffect(() => {
    if (viewForumRef.current === forumId) {
      return;
    }
    viewForumRef.current = forumId;
    setFilters({ ...DEFAULT_FORUM_FILTERS, ...readForumView(forumId, "activity") });
    setSearchText("");
  }, [forumId]);
  // The forum's own default order, until this reader picks one.
  const sortTouchedRef = useRef(false);
  useEffect(() => {
    sortTouchedRef.current = false;
  }, [forumId]);
  useEffect(() => {
    if (settings && !sortTouchedRef.current) {
      try {
        if (window.localStorage.getItem(`pqp:forum:${forumId}:view`) !== null) {
          return;
        }
      } catch {
        // No storage: the forum's default is the only answer anyway.
      }
      setFilters((current) =>
        current.sort === settings.defaultSort
          ? current
          : { ...current, sort: settings.defaultSort },
      );
    }
  }, [settings, forumId]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setFilters((current) =>
        current.q === searchText.trim() ? current : { ...current, q: searchText.trim() },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchText]);

  const changeFilters = useCallback(
    (next: Partial<ForumFilters>) => {
      if (next.sort) {
        sortTouchedRef.current = true;
      }
      setFilters((current) => {
        const merged = { ...current, ...next };
        writeForumView(forumId, {
          sort: merged.sort,
          status: merged.status,
          mine: merged.mine,
          tagIds: merged.tagIds,
        });
        return merged;
      });
    },
    [forumId],
  );
  // A stored tag that staff deleted since is dropped, or it would filter
  // every post away with no chip left to take it off.
  useEffect(() => {
    if (tags.length === 0 && settings === null) {
      return;
    }
    const known = new Set(tags.map((tag) => tag.id));
    if (filters.tagIds.some((tagId) => !known.has(tagId))) {
      changeFilters({ tagIds: filters.tagIds.filter((tagId) => known.has(tagId)) });
    }
  }, [tags, settings, filters.tagIds, changeFilters]);

  // ---------------------------------------------------------------- list
  const [list, setList] = useState<ForumListState>(emptyForumList);
  const listRef = useRef(list);
  listRef.current = list;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [moreState, setMoreState] = useState<"idle" | "loading" | "error">("idle");
  const [reloadToken, setReloadToken] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  /** The next page-1 read is a reconnect: merge, do not replace. */
  const mergeNextLoadRef = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    const merge = mergeNextLoadRef.current;
    mergeNextLoadRef.current = false;
    setLoadState((state) => (state === "ready" && listRef.current.posts.length > 0 ? state : "loading"));
    if (!merge) {
      setMoreState("idle");
    }
    fetchForumPosts(forumId, filters, null, controller.signal)
      .then((page) => {
        setList((current) =>
          merge ? refreshForumFirstPage(current, page) : forumListFromPage(page),
        );
        setLoadState("ready");
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadState("error");
        }
      });
    return () => controller.abort();
  }, [forumId, filters, reloadToken]);

  // A reconnect re-reads page 1 and merges, without a skeleton in between.
  useEffect(
    () =>
      subscribeForumReconnected(() => {
        mergeNextLoadRef.current = true;
        setReloadToken((token) => token + 1);
      }),
    [],
  );

  const loadMore = useCallback(() => {
    const cursor = listRef.current.nextCursor;
    // Only from idle: an error waits for Tentar de novo, or the observer
    // would retry a failing page at network speed.
    if (!cursor || moreState !== "idle") {
      return;
    }
    setMoreState("loading");
    const requested = filtersRef.current;
    fetchForumPosts(forumId, requested, cursor)
      .then((page) => {
        if (filtersRef.current !== requested) {
          return;
        }
        setList((current) => appendForumPage(current, page));
        setMoreState("idle");
      })
      .catch(() => setMoreState("error"));
  }, [forumId, moreState]);

  // --------------------------------------------------------- open post
  const [localPostId, setLocalPostId] = useState<string | null>(null);
  const openPostId = routePostId !== undefined ? routePostId : localPostId;
  const setOpenPostId = useCallback(
    (postId: string | null) => {
      if (onRoutePostChange) {
        onRoutePostChange(postId);
      }
      if (routePostId === undefined || !onRoutePostChange) {
        setLocalPostId(postId);
      }
    },
    [onRoutePostChange, routePostId],
  );
  useEffect(() => {
    setLocalPostId(null);
  }, [forumId]);
  const openPostIdRef = useRef(openPostId);
  openPostIdRef.current = openPostId;
  const [fetchedPost, setFetchedPost] = useState<ForumPostSummary | null>(null);
  const fetchedPostRef = useRef(fetchedPost);
  fetchedPostRef.current = fetchedPost;
  const [removedOpenId, setRemovedOpenId] = useState<string | null>(null);
  /** The summary of the open post that was deleted, kept to say so. */
  const [removedOpenPost, setRemovedOpenPost] = useState<ForumPostSummary | null>(null);
  const listedOpenPost = openPostId
    ? (list.pinned.find((one) => one.id === openPostId) ??
      list.posts.find((one) => one.id === openPostId) ??
      list.queued.find((one) => one.id === openPostId) ??
      null)
    : null;
  const openPost =
    listedOpenPost ??
    (fetchedPost?.id === openPostId ? fetchedPost : null) ??
    (removedOpenPost?.id === openPostId ? removedOpenPost : null);
  // A deep link to a post the loaded pages do not hold.
  const [openFailed, setOpenFailed] = useState(false);
  useEffect(() => {
    setOpenFailed(false);
    if (
      !openPostId ||
      listedOpenPost ||
      loadState === "loading" ||
      removedOpenPost?.id === openPostId
    ) {
      return;
    }
    if (fetchedPost?.id === openPostId) {
      return;
    }
    const controller = new AbortController();
    fetchForumPost(openPostId)
      .then(({ post }) => {
        if (controller.signal.aborted) {
          return;
        }
        if (post.forumId === forumId) {
          setFetchedPost(post);
        } else {
          setOpenFailed(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setOpenFailed(true);
        }
      });
    return () => controller.abort();
  }, [openPostId, listedOpenPost, loadState, fetchedPost?.id, forumId, removedOpenPost?.id]);

  // ------------------------------------------------------------ layout
  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(1280);
  useLayoutEffect(() => {
    const node = rootRef.current;
    if (!node || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) {
        setWidth(box.width);
      }
    });
    observer.observe(node);
    setWidth(node.getBoundingClientRect().width || 1280);
    return () => observer.disconnect();
  }, []);
  const [maximized, setMaximized] = useState(readPostMaximized);
  const canSplit = !isPhone && width >= SPLIT_MIN_WIDTH;
  const postOpen = openPostId !== null && (openPost !== null || removedOpenId === openPostId);
  const postFull = postOpen && (!canSplit || maximized);
  const compactList = postOpen && !postFull;

  // ---------------------------------------------------------- live rules
  const scrollRef = useRef<HTMLDivElement>(null);
  const listBoxRef = useRef<HTMLUListElement>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const focusInListRef = useRef(false);
  const isHeld = useCallback(() => {
    const node = scrollRef.current;
    const scrolled = node ? node.scrollTop > TOP_SLACK_PX : false;
    return scrolled || focusInListRef.current;
  }, []);
  const [enteringIds, setEnteringIds] = useState<ReadonlySet<string>>(new Set());
  const [leavingIds, setLeavingIds] = useState<ReadonlySet<string>>(new Set());
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  const markEntering = useCallback((ids: string[]) => {
    if (ids.length === 0 || reducedMotion()) {
      return;
    }
    setEnteringIds((current) => new Set([...current, ...ids]));
    window.setTimeout(() => {
      setEnteringIds((current) => {
        const next = new Set(current);
        for (const id of ids) {
          next.delete(id);
        }
        return next;
      });
    }, 400);
  }, []);

  useEffect(
    () =>
      subscribeForumFrames((frame) => {
        if (frame.forumId !== forumId) {
          return;
        }
        if (frame.type === "forum-post-upsert") {
          const before = listRef.current;
          const wasShown =
            before.posts.some((one) => one.id === frame.post.id) ||
            before.pinned.some((one) => one.id === frame.post.id);
          const next = applyForumUpsert(before, frame.post, {
            filters: filtersRef.current,
            viewerId,
            hold: isHeld(),
            openPostId: openPostIdRef.current,
          });
          setList(next);
          if (!wasShown && next.posts.some((one) => one.id === frame.post.id)) {
            markEntering([frame.post.id]);
          }
          if (next.queued.length !== before.queued.length && next.queued.length > 0) {
            setLiveAnnouncement(t("forum.live", { count: next.queued.length }));
          }
          setFetchedPost((current) =>
            current?.id === frame.post.id ? frame.post : current,
          );
          return;
        }
        // Removed: the card fades, then leaves; the open post says so.
        const postId = frame.postId;
        if (openPostIdRef.current === postId) {
          const current = listRef.current;
          const fetched = fetchedPostRef.current;
          const snapshot =
            current.pinned.find((one) => one.id === postId) ??
            current.posts.find((one) => one.id === postId) ??
            current.queued.find((one) => one.id === postId) ??
            (fetched?.id === postId ? fetched : null);
          setRemovedOpenId(postId);
          setRemovedOpenPost(snapshot);
        }
        const drop = () => {
          setList((current) => applyForumRemoved(current, postId));
          setLeavingIds((current) => {
            const nextSet = new Set(current);
            nextSet.delete(postId);
            return nextSet;
          });
        };
        if (reducedMotion()) {
          drop();
          return;
        }
        setLeavingIds((current) => new Set([...current, postId]));
        window.setTimeout(drop, 180);
      }),
    [forumId, viewerId, isHeld, markEntering, t],
  );

  const flushQueue = useCallback(() => {
    const before = listRef.current;
    const arriving = before.queued
      .filter(
        (post) =>
          !before.posts.some((one) => one.id === post.id) &&
          !before.pinned.some((one) => one.id === post.id),
      )
      .map((post) => post.id);
    setList(
      flushForumQueue(before, {
        filters: filtersRef.current,
        viewerId,
        openPostId: openPostIdRef.current,
      }),
    );
    markEntering(arriving);
    scrollRef.current?.scrollTo({ top: 0, behavior: reducedMotion() ? "auto" : "smooth" });
  }, [viewerId, markEntering]);

  // ----------------------------------------------------- infinite scroll
  const sentinelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    const root = scrollRef.current;
    if (!node || !root || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          loadMore();
        }
      },
      { root, rootMargin: `0px 0px ${NEXT_PAGE_MARGIN_PX}px 0px` },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadMore, list.nextCursor, loadState]);

  // FAB: hides on scroll down, back on scroll up (phone).
  const [fabHidden, setFabHidden] = useState(false);
  const lastScrollTop = useRef(0);
  function onListScroll() {
    const node = scrollRef.current;
    if (!node) {
      return;
    }
    const top = node.scrollTop;
    const delta = top - lastScrollTop.current;
    if (Math.abs(delta) > 6) {
      setFabHidden(delta > 0 && top > 48);
      lastScrollTop.current = top;
    }
  }

  // --------------------------------------------------------- open / close
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const registerLink = useCallback((postId: string, node: HTMLAnchorElement | null) => {
    if (node) {
      linkRefs.current.set(postId, node);
    } else {
      linkRefs.current.delete(postId);
    }
  }, []);
  const returnFocusRef = useRef<string | null>(null);

  const openPostById = useCallback(
    (postId: string) => {
      returnFocusRef.current = postId;
      setRemovedOpenId(null);
      setRemovedOpenPost(null);
      setOpenPostId(postId);
      // Opened is read: the card drops Novo and its count at once.
      setList((current) => markForumPostRead(current, postId, new Date().toISOString()));
    },
    [setOpenPostId],
  );
  const closePost = useCallback(() => {
    const back = returnFocusRef.current ?? openPostIdRef.current;
    if (openPostIdRef.current) {
      const closing = openPostIdRef.current;
      setList((current) => markForumPostRead(current, closing, new Date().toISOString()));
    }
    setOpenPostId(null);
    setRemovedOpenId(null);
    setRemovedOpenPost(null);
    if (back) {
      requestAnimationFrame(() => linkRefs.current.get(back)?.focus());
    }
  }, [setOpenPostId]);

  const toggleMaximize = useCallback(() => {
    setMaximized((current) => {
      writePostMaximized(!current);
      return !current;
    });
  }, []);

  // ----------------------------------------------------------- composer
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerTitle, setComposerTitle] = useState<string | null>(null);
  const openComposer = useCallback((title: string | null = null) => {
    setComposerTitle(title);
    setComposerOpen(true);
  }, []);
  const canCompose = canPost && creationEnabled;

  // A drop on the forum starts a post with the files attached.
  const [composerFiles, setComposerFiles] = useState<DroppedItems | null>(null);
  const droppedTakenRef = useRef(onDroppedFilesTaken);
  droppedTakenRef.current = onDroppedFilesTaken;
  useEffect(() => {
    if (!droppedFiles || droppedFiles.length === 0) {
      return;
    }
    if (canCompose) {
      setComposerFiles({ files: droppedFiles, folders: [] });
      setComposerTitle(null);
      setComposerOpen(true);
    }
    droppedTakenRef.current?.();
  }, [droppedFiles, canCompose]);

  // -------------------------------------------------------------- toast
  const [toast, setToast] = useState<{
    id: number;
    text: string;
    action?: { label: string; onClick: () => void };
  } | null>(null);
  const notify = useCallback(
    (text: string, action?: { label: string; onClick: () => void }) => {
      setToast({ id: Date.now(), text, action });
    },
    [],
  );
  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), toast.action ? 6000 : 3500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // ---------------------------------------------------------- guidelines
  const [rulesHidden, setRulesHidden] = useState(() => readRulesHidden(forumId));
  useEffect(() => {
    setRulesHidden(readRulesHidden(forumId));
  }, [forumId]);
  const [rulesSheetOpen, setRulesSheetOpen] = useState(false);
  const rules = channel.topic?.trim() ? channel.topic.trim() : null;

  // -------------------------------------------------------------- search
  const searchRef = useRef<HTMLInputElement>(null);
  const [messageSearch, setMessageSearch] = useState<string | null>(null);
  const [phoneSearchOpen, setPhoneSearchOpen] = useState(false);

  // ------------------------------------------------------------- keyboard
  const allCards = useMemo(
    () => [...(filters.q ? [] : list.pinned), ...list.posts],
    [filters.q, list.pinned, list.posts],
  );
  const rovingId =
    focusedId && allCards.some((one) => one.id === focusedId)
      ? focusedId
      : (allCards[0]?.id ?? null);

  const focusCard = useCallback((postId: string | undefined) => {
    if (!postId) {
      return;
    }
    setFocusedId(postId);
    const node = linkRefs.current.get(postId);
    node?.focus();
    node?.closest("article")?.scrollIntoView({ block: "nearest" });
  }, []);

  const onCardKeyDown = useCallback(
    (event: KeyboardEvent<HTMLAnchorElement>, postId: string) => {
      if (event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      const index = allCards.findIndex((one) => one.id === postId);
      const key = event.key;
      if (key === "ArrowDown" || key === "j" || key === "J") {
        event.preventDefault();
        focusCard(allCards[Math.min(allCards.length - 1, index + 1)]?.id);
      } else if (key === "ArrowUp" || key === "k" || key === "K") {
        event.preventDefault();
        if (index === 0) {
          searchRef.current?.focus();
          return;
        }
        focusCard(allCards[Math.max(0, index - 1)]?.id);
      } else if (key === "Home") {
        event.preventDefault();
        focusCard(allCards[0]?.id);
      } else if (key === "End") {
        event.preventDefault();
        focusCard(allCards[allCards.length - 1]?.id);
      } else if (key === "o" || key === "O") {
        event.preventDefault();
        openPostById(postId);
      }
      // Enter is the link's own activation.
    },
    [allCards, focusCard, openPostById],
  );

  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) {
        return;
      }
      if (isTextEntryTarget(event.target)) {
        return;
      }
      if (document.querySelector("[data-dialog-layer]") || document.querySelector("[role='menu']")) {
        return;
      }
      const key = event.key;
      const inPost =
        event.target instanceof Element &&
        event.target.closest("[data-forum-post-panel], [data-forum-post-removed]") !== null;
      if (openPostIdRef.current && (key === "Escape" || ((key === "u" || key === "U") && inPost))) {
        event.preventDefault();
        closePost();
        return;
      }
      if ((key === "r" || key === "R") && openPostIdRef.current) {
        const field = document.querySelector<HTMLTextAreaElement>(
          "[data-forum-post-panel] textarea",
        );
        if (field) {
          event.preventDefault();
          field.focus();
        }
        return;
      }
      if (key === "/" && !inPost) {
        event.preventDefault();
        if (isPhone) {
          setPhoneSearchOpen(true);
          window.setTimeout(() => searchRef.current?.focus(), 0);
        } else {
          searchRef.current?.focus();
        }
        return;
      }
      if ((key === "c" || key === "C") && canCompose && !inPost) {
        event.preventDefault();
        openComposer();
        return;
      }
      if ((key === "j" || key === "J" || key === "k" || key === "K") && !inPost) {
        event.preventDefault();
        focusCard(rovingId ?? undefined);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [canCompose, closePost, focusCard, isPhone, openComposer, rovingId]);

  // --------------------------------------------------------------- hint
  const hintWanted = useFeatureHintEnabled("forum");
  const hasPosts = list.posts.length + list.pinned.length > 0;

  // ------------------------------------------------------------- render
  const counts = list.counts;
  const subtitle = counts
    ? counts.posts === 0
      ? t("forum.header.count_zero")
      : `${t("forum.header.count", { count: counts.posts })} · ${t("forum.header.open", {
          count: counts.open,
        })}`
    : null;
  const forumEmpty =
    loadState === "ready" &&
    !forumFiltersActive(filters) &&
    list.posts.length === 0 &&
    list.pinned.length === 0 &&
    list.queued.length === 0;

  const starterKind = SUPPORT_NAME.test(channel.name) ? STARTER_SUPPORT : STARTER_SHOWCASE;
  const [starterBusy, setStarterBusy] = useState(false);
  async function applyStarterTags() {
    setStarterBusy(true);
    try {
      const { tags: next } = await putForumTags(forumId, {
        tags: [
          ...tags.map((tag) => ({
            id: tag.id,
            name: tag.name,
            emoji: tag.emoji,
            moderated: tag.moderated,
          })),
          ...starterKind
            .map((key) => ({
              name: t(STARTER_LABEL[key]),
              emoji: STARTER_EMOJI[key],
              moderated: false,
            }))
            .filter(
              (tag) => !tags.some((one) => one.name.toLowerCase() === tag.name.toLowerCase()),
            ),
        ],
      });
      setTags(next);
    } catch {
      notify(t("forum.saveFailed"));
    } finally {
      setStarterBusy(false);
    }
  }

  const newPostButton = canCompose ? (
    <div className="relative shrink-0">
      <Button
        onClick={() => openComposer()}
        className="gap-1.5"
        data-forum-new-post=""
      >
        <Plus className="h-4 w-4" aria-hidden />
        {t("forum.newPost")}
        <kbd className="ml-0.5 hidden h-5 min-w-5 items-center justify-center rounded-[var(--radius-tick)] border border-on-accent/30 px-1 font-sans text-[10px] font-semibold lg:inline-flex">
          C
        </kbd>
      </Button>
      <div className="absolute right-0 top-full z-30 mt-2 w-72">
        <FeatureHint
          id="forum"
          enabled={hintWanted && hasPosts && !postOpen}
          title={t("forum.hint.title")}
          body={t("forum.hint.body")}
        />
      </div>
    </div>
  ) : null;

  const pausedLine =
    canPost && !creationEnabled ? (
      <p
        role="status"
        className="flex items-center gap-2 rounded-[var(--radius-card)] border border-border bg-surface-1 px-3 py-2 text-sm text-text-secondary"
      >
        <Info className="h-4 w-4 shrink-0" aria-hidden />
        {t("forum.paused")}
      </p>
    ) : null;

  const header = (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/60 px-3 sm:px-4">
      <button
        type="button"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 md:hidden"
        aria-label={t("chrome.openNav")}
        onClick={onOpenNav}
      >
        <MenuIcon className="h-5 w-5" aria-hidden />
      </button>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5 font-display text-base font-bold text-text">
          <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">{channel.name}</span>
          {!creationEnabled ? null : <BetaTag className="max-sm:hidden" />}
        </p>
        <p className="truncate text-[11px] tabular-nums text-text-tertiary">
          {isPhone
            ? [
                server.name,
                counts && counts.posts > 0
                  ? t("forum.header.count", { count: counts.posts })
                  : subtitle,
              ]
                .filter(Boolean)
                .join(" · ")
            : subtitle}
        </p>
      </div>
      {isPhone && !forumEmpty && (
        <button
          type="button"
          aria-label={t("forum.search.open")}
          onClick={() => {
            setPhoneSearchOpen(true);
            window.setTimeout(() => searchRef.current?.focus(), 0);
          }}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary hover:bg-surface-2"
        >
          <Search className="h-5 w-5" aria-hidden />
        </button>
      )}
      {rules && rulesHidden && !isPhone && (
        <Tooltip label={t("forum.rules.show")}>
          <button
            type="button"
            onClick={() => {
              setRulesHidden(false);
              writeRulesHidden(forumId, false);
            }}
            className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:bg-surface-2 hover:text-text"
          >
            <BookOpen className="h-4 w-4" aria-hidden />
          </button>
        </Tooltip>
      )}
      {compactList && newPostButton}
      {headerActions}
    </header>
  );

  const guidelines =
    rules && !isPhone && !rulesHidden ? (
      <section
        aria-label={t("forum.rules.title")}
        className="flex items-start gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 px-3.5 py-3 animate-fade-in"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft">
          <BookOpen className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
            {t("forum.rules.title")}
          </p>
          <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-text-secondary">
            {rules}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setRulesHidden(true);
            writeRulesHidden(forumId, true);
          }}
          className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 text-xs text-text-tertiary hover:bg-surface-2 hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
        >
          {t("forum.rules.hide")}
          <ChevronUp className="h-3.5 w-3.5" aria-hidden />
        </button>
      </section>
    ) : rules && isPhone ? (
      <button
        type="button"
        onClick={() => setRulesSheetOpen(true)}
        className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 px-3 text-left text-sm text-text"
      >
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft">
          <BookOpen className="h-4 w-4" aria-hidden />
        </span>
        <span className="flex-1 font-medium">{t("forum.rules.title")}</span>
        <ChevronRight className="h-4 w-4 text-text-tertiary" aria-hidden />
      </button>
    ) : null;

  const searchField = (
    <label
      className={cn(
        "flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-control)] border border-border bg-surface-1 px-3 text-sm transition-colors duration-[var(--duration-fast)] focus-within:border-border-strong focus-within:ring-2 focus-within:ring-focus-ring",
      )}
    >
      <Search className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden />
      <input
        ref={searchRef}
        type="search"
        value={searchText}
        onChange={(event) => setSearchText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            if (searchText) {
              setSearchText("");
            } else {
              event.currentTarget.blur();
              setPhoneSearchOpen(false);
            }
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            focusCard(allCards[0]?.id);
          } else if (event.key === "Enter" && searchText.trim() && allCards.length === 0 && canCompose) {
            event.preventDefault();
            openComposer(searchText.trim());
          }
        }}
        placeholder={t("forum.search")}
        aria-label={t("forum.search")}
        className="min-w-0 flex-1 bg-transparent text-text placeholder:text-text-tertiary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {searchText ? (
        <button
          type="button"
          onClick={() => {
            setSearchText("");
            searchRef.current?.focus();
          }}
          aria-label={t("forum.search.clear")}
          className="grid h-6 w-6 place-items-center rounded-[var(--radius-control)] text-text-tertiary hover:text-text"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <kbd className="hidden h-5 min-w-5 items-center justify-center rounded-[var(--radius-tick)] border border-border px-1 font-sans text-[10px] text-text-tertiary sm:inline-flex">
          /
        </kbd>
      )}
    </label>
  );

  function cardFor(post: ForumPostSummary, pinnedRow: boolean) {
    return (
      <li key={post.id} className="list-none">
        <ForumPostCard
          post={post}
          unread={forumUnreadState(
            post,
            list.viewer[post.id],
            viewerId,
            visitCursor ? visitCursor.previous : list.forumPreviousReadAt,
          )}
          tagsById={tagsById}
          href={forumPostPath(server.id, forumId, post.id)}
          compact={compactList}
          narrow={isPhone}
          open={post.id === openPostId}
          pinnedRow={pinnedRow}
          entering={enteringIds.has(post.id)}
          leaving={leavingIds.has(post.id)}
          tabIndex={post.id === rovingId ? 0 : -1}
          onOpen={openPostById}
          onFocus={setFocusedId}
          onKeyDown={onCardKeyDown}
          registerLink={registerLink}
        />
      </li>
    );
  }

  // The body of the list: states first, then the cards.
  let listBody: ReactNode;
  if (loadState === "loading" && list.posts.length === 0) {
    listBody = (
      <div className="flex flex-col gap-2" aria-busy="true" aria-label={t("forum.list.label")}>
        <CardSkeleton />
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  } else if (loadState === "error" && list.posts.length === 0) {
    listBody = (
      <div
        role="alert"
        className="flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 px-3.5 py-3 text-sm text-text-secondary"
      >
        <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
        <span className="flex-1">{t("forum.loadError")}</span>
        <Button size="sm" variant="ghost" onClick={() => setReloadToken((n) => n + 1)}>
          {t("forum.retry")}
        </Button>
      </div>
    );
  } else if (forumEmpty) {
    listBody = (
      <EmptyBlock
        icon={
          <span className="relative">
            <MessagesSquare className="h-7 w-7 text-on-accent-soft" aria-hidden />
            <Sparkles className="absolute -right-3 -top-3 h-4 w-4 text-accent" aria-hidden />
          </span>
        }
        title={t("forum.empty")}
        body={t("forum.empty.body")}
      >
        {canCompose && (
          <Button onClick={() => openComposer()} className="gap-1.5">
            <Plus className="h-4 w-4" aria-hidden />
            {t("forum.empty.cta")}
          </Button>
        )}
        {canManage && onOpenSettings && (
          <Button variant="secondary" onClick={() => onOpenSettings("tags")} className="gap-1.5">
            <Tag className="h-4 w-4" aria-hidden />
            {t("forum.empty.setupTags")}
          </Button>
        )}
        {pausedLine}
        {canManage && tags.length === 0 && (
          <div className="mt-2 flex w-full flex-wrap items-center justify-center gap-1.5 text-xs text-text-tertiary">
            <span>{t("forum.empty.starter")}</span>
            {starterKind.map((key) => (
              <span
                key={key}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-dashed border-border-strong px-2.5 text-text-secondary"
              >
                <span aria-hidden>{STARTER_EMOJI[key]}</span>
                {t(STARTER_LABEL[key])}
              </span>
            ))}
            <button
              type="button"
              disabled={starterBusy}
              onClick={() => void applyStarterTags()}
              className="rounded-[var(--radius-control)] px-1.5 py-1 font-semibold text-accent hover:underline disabled:opacity-50"
            >
              {t("forum.empty.starterUse")}
            </button>
          </div>
        )}
      </EmptyBlock>
    );
  } else {
    const noResults = list.posts.length === 0 && (filters.q || list.pinned.length === 0 || forumFiltersActive(filters));
    listBody = (
      <>
        {!filters.q && list.pinned.length > 0 && (
          <section aria-label={t("forum.pinned")} className="mb-3">
            <p className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-text-tertiary">
              <Pin className="h-3 w-3" aria-hidden />
              {t("forum.pinned")}
              <span aria-hidden className="ml-1 h-px flex-1 bg-border" />
            </p>
            <ul role="list" className="flex flex-col gap-2">
              {list.pinned.map((post) => cardFor(post, true))}
            </ul>
          </section>
        )}
        {noResults && list.posts.length === 0 ? (
          filters.q ? (
            <EmptyBlock
              icon={<SearchX className="h-7 w-7" aria-hidden />}
              title={t("forum.searchEmpty", { query: filters.q })}
              body={t("forum.searchEmpty.body")}
            >
              {canCompose && (
                <Button onClick={() => openComposer(filters.q)} className="gap-1.5">
                  <Plus className="h-4 w-4" aria-hidden />
                  {t("forum.searchEmpty.post", { query: filters.q })}
                </Button>
              )}
              <Button variant="ghost" onClick={() => setMessageSearch(filters.q)}>
                {t("forum.searchEmpty.messages")}
              </Button>
            </EmptyBlock>
          ) : filters.mine && filters.tagIds.length === 0 && filters.status === null ? (
            <EmptyBlock
              icon={<ListFilter className="h-7 w-7" aria-hidden />}
              title={t("forum.mineEmpty")}
            >
              <Button variant="secondary" size="sm" onClick={() => changeFilters({ mine: false })}>
                {t("forum.filterEmpty.clear")}
              </Button>
            </EmptyBlock>
          ) : (
            <EmptyBlock
              icon={<ListFilter className="h-7 w-7" aria-hidden />}
              title={t("forum.filterEmpty")}
              body={t("forum.filterEmpty.body", {
                filters: describeActiveFilters(filters, tags, t),
              })}
            >
              <Button
                variant="secondary"
                size="sm"
                onClick={() => changeFilters({ status: null, mine: false, tagIds: [] })}
              >
                {t("forum.filterEmpty.clear")}
              </Button>
            </EmptyBlock>
          )
        ) : (
          <ul
            ref={listBoxRef}
            role="list"
            aria-label={t("forum.list.label")}
            className="flex flex-col gap-2"
            onFocus={() => {
              focusInListRef.current = true;
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                focusInListRef.current = false;
              }
            }}
          >
            {list.posts.map((post) => cardFor(post, false))}
          </ul>
        )}
        <div ref={sentinelRef} aria-hidden className="h-px" />
        {moreState === "loading" && (
          <p className="flex items-center justify-center gap-2 py-4 text-xs text-text-tertiary">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          </p>
        )}
        {moreState === "error" && (
          <div className="mt-2 flex items-center gap-3 rounded-[var(--radius-card)] border border-border bg-surface-1 px-3.5 py-2.5 text-sm text-text-secondary">
            <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
            <span className="flex-1">{t("forum.loadError")}</span>
            <Button size="sm" variant="ghost" onClick={() => setMoreState("idle")}>
              {t("forum.retry")}
            </Button>
          </div>
        )}
        {list.nextCursor === null &&
          loadState === "ready" &&
          list.posts.length > 0 &&
          counts &&
          !forumFiltersActive(filters) && (
            <p className="flex items-center gap-3 py-5 text-xs text-text-tertiary">
              <span aria-hidden className="h-px flex-1 bg-border" />
              {t("forum.end", { count: counts.posts })}
              <span aria-hidden className="h-px flex-1 bg-border" />
            </p>
          )}
      </>
    );
  }

  const listColumn = (
    <div
      className={cn(
        "relative flex min-h-0 min-w-0 flex-1 flex-col",
        // Not display:none: that throws away the list's scroll position,
        // and back has to land where the reader left.
        postFull && "pointer-events-none invisible absolute inset-0",
      )}
    >
      {header}
      {/* "N posts com novidade": the list never reorders under the reader. */}
      {list.queued.length > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-16 z-20 flex justify-center">
          <button
            type="button"
            onClick={flushQueue}
            className="pointer-events-auto inline-flex h-8 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs font-semibold text-on-accent shadow-[var(--shadow-2)] animate-pop-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset"
            data-forum-live-pill=""
          >
            <ChevronUp className="h-3.5 w-3.5" aria-hidden />
            {t("forum.live", { count: list.queued.length })}
            <span aria-hidden className="opacity-70">·</span>
            {t("forum.live.refresh")}
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onListScroll}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className={cn(
            "mx-auto flex w-full flex-col gap-3 px-4 pb-24 pt-4 sm:px-6",
            compactList ? "max-w-none sm:px-4" : "max-w-4xl",
          )}
        >
          {!compactList && guidelines}
          {isPhone && phoneSearchOpen && (
            <div className="flex items-center gap-2 animate-door-reveal">
              {searchField}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchText("");
                  setPhoneSearchOpen(false);
                }}
              >
                {t("forum.edit.cancel")}
              </Button>
            </div>
          )}
          {!forumEmpty && (
            <>
              {!isPhone && (
                <div className="flex items-center gap-2">
                  {searchField}
                  {!compactList && newPostButton}
                </div>
              )}
              {!compactList && pausedLine}
              <ForumFilterBar
                filters={filters}
                tags={tags}
                onChange={changeFilters}
                inlineTags={
                  compactList
                    ? 0
                    : Math.max(1, Math.min(8, Math.floor((Math.min(width, 896) - 520) / 100)))
                }
              />
            </>
          )}
          <div className="min-w-0">{listBody}</div>
        </div>
      </div>
      {/* Phone: the thumb's Novo post, out of the way while scrolling down. */}
      {isPhone && canCompose && !forumEmpty && (
        <Button
          onClick={() => openComposer()}
          className={cn(
            "absolute bottom-5 right-4 z-20 h-12 gap-1.5 rounded-full px-5 text-[15px] shadow-[var(--shadow-2)] transition-[transform,opacity] duration-[var(--duration-base)] ease-[var(--ease-emphasized)] motion-reduce:transition-none",
            fabHidden && "pointer-events-none translate-y-20 opacity-0",
          )}
        >
          <Plus className="h-5 w-5" aria-hidden />
          {t("forum.newPost")}
        </Button>
      )}
      <p role="status" aria-live="polite" className="sr-only">
        {liveAnnouncement}
      </p>
    </div>
  );

  return (
    <div
      ref={rootRef}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-forum-pane={forumId}
      data-forum-layout={postOpen ? (postFull ? "full" : "split") : "list"}
    >
      {listColumn}
      {openPostId && openPost && (
        <ForumPostView
          key={openPost.id}
          post={openPost}
          forumName={channel.name}
          serverId={server.id}
          tags={tags}
          tagsById={tagsById}
          viewerId={viewerId}
          isStaff={isStaff}
          canSend={canPost}
          layout={postFull ? "full" : "side"}
          forcedFull={!canSplit}
          maximized={maximized}
          onToggleMaximize={toggleMaximize}
          removed={removedOpenId === openPost.id}
          pinnedCount={list.pinned.length}
          href={forumPostPath(server.id, forumId, openPost.id)}
          controller={postController}
          currentUser={currentUser}
          mentionCandidates={mentionCandidates}
          blockedAuthorIds={blockedAuthorIds}
          authors={authors}
          roles={roles}
          showLinkEmbeds={showLinkEmbeds}
          slashContext={slashContext}
          onReportMessage={onReportMessage}
          onForward={onForward}
          markRead={markRead}
          onClose={closePost}
          onPostChange={(next) => {
            setList((current) => {
              // A pin moves the card between the two lists; the reducer
              // knows how. The reader's own action never queues a pill.
              const wasPinned = current.pinned.some((one) => one.id === next.id);
              if (wasPinned !== (next.pinnedAt !== null)) {
                return applyForumUpsert(current, next, {
                  filters: filtersRef.current,
                  viewerId,
                  hold: false,
                  openPostId: next.id,
                });
              }
              return patchForumPost(current, next);
            });
            setFetchedPost((current) => (current?.id === next.id ? next : current));
          }}
          onDeleted={(postId) => {
            setList((current) => applyForumRemoved(current, postId));
            setOpenPostId(null);
          }}
          onShowPinned={() => {
            closePost();
            scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
          }}
          notify={notify}
        />
      )}
      {openPostId && !openPost && openFailed && (
        <aside className="flex w-full flex-col items-center justify-center gap-3 border-l border-border/60 bg-surface-0 px-6 text-center max-md:fixed max-md:inset-0 max-md:z-30 md:w-[488px]">
          <AlertTriangle className="h-6 w-6 text-warning" aria-hidden />
          <p className="text-sm text-text-secondary">{t("forum.post.loadFailed")}</p>
          <Button variant="secondary" onClick={closePost}>
            {t("forum.post.back")}
          </Button>
        </aside>
      )}

      <ForumComposerDialog
        open={composerOpen}
        forumId={forumId}
        forumName={channel.name}
        serverId={server.id}
        tags={tags}
        requireTag={settings?.requireTag ?? false}
        isStaff={isStaff}
        initialTitle={composerTitle}
        droppedItems={composerFiles}
        onDroppedItemsConsumed={() => setComposerFiles(null)}
        mentionCandidates={mentionCandidates}
        onClose={() => setComposerOpen(false)}
        onOpenPost={(postId) => {
          setComposerOpen(false);
          openPostById(postId);
        }}
        onPublished={(post, viewer) => {
          setComposerOpen(false);
          setSearchText("");
          setList((current) => {
            const withPost = applyForumUpsert(current, post, {
              filters: { ...filtersRef.current, q: "" },
              viewerId,
              hold: false,
            });
            return { ...withPost, viewer: { ...withPost.viewer, [post.id]: viewer } };
          });
          markEntering([post.id]);
          setFetchedPost(post);
          openPostById(post.id);
        }}
      />

      <SearchDialog
        open={messageSearch !== null}
        serverId={server.id}
        serverName={server.name}
        initialQuery={messageSearch ?? ""}
        onClose={() => setMessageSearch(null)}
      />

      <Dialog
        open={rulesSheetOpen}
        title={t("forum.rules.title")}
        size="sm"
        onClose={() => setRulesSheetOpen(false)}
      >
        <p className="whitespace-pre-wrap break-words px-5 py-4 text-sm text-text-secondary">
          {rules}
        </p>
      </Dialog>

      {toast && (
        <div
          key={toast.id}
          role="status"
          className="pointer-events-auto absolute bottom-5 left-1/2 z-40 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-[var(--radius-card)] px-3.5 py-2.5 text-sm text-text elevation-3 animate-pop-in"
          data-forum-toast=""
        >
          <span className="min-w-0">{toast.text}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.onClick();
                setToast(null);
              }}
              className="shrink-0 font-semibold text-accent hover:underline"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

