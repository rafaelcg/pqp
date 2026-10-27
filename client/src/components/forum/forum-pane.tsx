import {
  PANE_HEADER_DETAIL_REDESIGN,
  PANE_HEADER_NAV_REDESIGN,
  PANE_HEADER_REDESIGN,
  PANE_HEADER_TITLE_REDESIGN,
} from "@/components/ui/pane-header";
import type { AuthorGoneCheck } from "@/hooks/use-confirmed-gone-authors";
import {
  forumTagIconEmoji,
  forumTagNameKey,
  type Channel,
  type ForumPostSummary,
} from "@pqp/shared";
import {
  AlertTriangle,
  ArrowUp,
  CirclePause,
  Info,
  ListFilter,
  Menu as MenuIcon,
  MessagesSquare,
  Plus,
  Search,
  SearchX,
  SquarePen,
  Tag,
  Trash2,
  WifiOff,
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
  putForumTags,
} from "@/lib/forum-api";
import { fetchForumConfig } from "@/lib/api";
import { loadForumConfig } from "@/hooks/use-forum-config";
import { useForumRules } from "@/hooks/use-forum-rules";
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
  readForumLayout,
  readForumView,
  readPostMaximized,
  writeForumLayout,
  writeForumView,
  writePostMaximized,
  type ForumLayout,
} from "@/lib/forum-prefs";
import { forumTagLabel } from "@/lib/forum-tag-icons";
import { starterTagsFor } from "@/lib/forum-tag-draft";
import { useTranslation } from "@/lib/i18n";
import type { MentionCandidate } from "@/lib/mention-autocomplete";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import {
  ChatsCircle as PhChatsCircle,
  Funnel as PhFunnel,
  MagnifyingGlass as PhMagnifyingGlass,
  WifiSlash as PhWifiSlash,
  List as ListIcon,
} from "@phosphor-icons/react";
import { Icon, IconSwap } from "@/components/ui/icon";
import { ForumComposerDialog } from "./forum-composer-dialog";
import { ForumTagIcon } from "./forum-tag-icon";
import {
  ForumFilterBar,
  ForumLayoutSwitch,
  ForumSortMenu,
  describeActiveFilters,
} from "./forum-filter-bar";
import { ForumPinnedTile, ForumPostCard } from "./forum-post-card";
import { ForumPostView, type ForumPostViewProps } from "./forum-post-view";
import { Spinner } from "@/components/ui/spinner";
import { BELOW_MD_QUERY } from "@/lib/breakpoints";

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
  /** `authors` is the server's whole roster: see MessageList. */
  authorsComplete?: boolean;
  authorGoneCheck?: AuthorGoneCheck;
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
/** From this content width on, the rules and numbers sit in a column beside the list. */
const RAIL_MIN_WIDTH = 1080;
/** Below this list-column width the filters scroll in one strip instead of wrapping. */
const FILTER_STRIP_BELOW = 640;
/** Infinite scroll asks for the next page this far before the end. */
const NEXT_PAGE_MARGIN_PX = 600;
const SEARCH_DEBOUNCE_MS = 250;
/** Scrolled further than this counts as "away from the top". */
const TOP_SLACK_PX = 8;

export function forumPostPath(serverId: string, forumId: string, postId: string): string {
  return `/app/server/${serverId}/channel/${forumId}/post/${postId}`;
}

function reducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function CardSkeleton({ short = false }: { short?: boolean }) {
  return (
    <div aria-hidden className="px-4 pb-4 pt-4">
      <div className="flex items-center gap-2">
        <Skeleton className="h-5 w-5 rounded-full" />
        <Skeleton className="h-3 w-28" />
      </div>
      <Skeleton className={cn("mt-3 h-4", short ? "w-1/2" : "w-4/5")} />
      {!short && (
        <>
          <Skeleton className="mt-2.5 h-3 w-11/12" />
          <Skeleton className="mt-1.5 h-3 w-3/5" />
        </>
      )}
    </div>
  );
}

/** Today's outline glyph with the toggle off, the filled one under the redesign. */
function ForumEmptyGlyph({ line, filled }: { line: ReactNode; filled: ReactNode }) {
  return (
    <>
      <span className="contents redesign:hidden">{line}</span>
      <span className="hidden redesign:contents">{filled}</span>
    </>
  );
}

function EmptyBlock({
  icon,
  title,
  body,
  children,
  role,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  children?: ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <EmptyState
      role={role}
      icon={icon}
      title={title}
      body={body}
      actions={children}
      className="px-6 py-16 animate-fade-in"
      iconClassName="text-text-secondary"
      titleClassName="mt-4 forum-display text-xl font-bold text-text redesign:mt-0"
      bodyClassName="mt-1.5 max-w-sm text-sm leading-5 text-text-secondary"
      actionsClassName="mt-5"
    />
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
  authorsComplete,
  authorGoneCheck,
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
  const isPhone = useMediaQuery(BELOW_MD_QUERY);

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
  // Only an answered read may stand for "this forum has no tags": the starter
  // tags replace the whole list, and building that from a failed read would
  // delete the forum's real tags (`tagsLoaded`).
  const {
    tags,
    status: tagsStatus,
    settings,
    refresh: refreshForumRules,
    retryTags,
    applyTags,
  } = useForumRules(forumId);
  const tagsLoaded = tagsStatus === "ready";
  const tagsById = useMemo(() => new Map(tags.map((tag) => [tag.id, tag])), [tags]);

  // The flag, when the shell did not pass it. Unknown reads as on: a forum
  // only exists where the flag was on, and the server refuses a create anyway.
  const [fetchedEnabled, setFetchedEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    setFetchedEnabled(null);
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
    if (!tagsLoaded) {
      return;
    }
    const known = new Set(tags.map((tag) => tag.id));
    if (filters.tagIds.some((tagId) => !known.has(tagId))) {
      changeFilters({ tagIds: filters.tagIds.filter((tagId) => known.has(tagId)) });
    }
  }, [tags, tagsLoaded, filters.tagIds, changeFilters]);

  // ---------------------------------------------------------------- list
  const [list, setList] = useState<ForumListState>(emptyForumList);
  const listRef = useRef(list);
  listRef.current = list;
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  /** Page 1 failed to refresh while older cards are still on screen. */
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [moreState, setMoreState] = useState<"idle" | "loading" | "error">("idle");
  const [reloadToken, setReloadToken] = useState(0);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  /** The next page-1 read is a reconnect: merge, do not replace. */
  const mergeNextLoadRef = useRef(false);
  /** Read through a ref: the reducer's "is the reader busy" is defined below. */
  const isHeldRef = useRef<() => boolean>(() => false);
  /** Bumped by every page-1 read; a later page from an older read is dropped. */
  const listGenRef = useRef(0);
  /** The forum the list on screen was read for. */
  const listForumRef = useRef<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const merge = mergeNextLoadRef.current && listForumRef.current === forumId;
    mergeNextLoadRef.current = false;
    listGenRef.current += 1;
    if (listForumRef.current !== forumId) {
      // Another forum: its cards never stand in for this one's, not even
      // while this one loads.
      listForumRef.current = forumId;
      setList(emptyForumList());
      setLoadState("loading");
    } else {
      // Same forum, new filters or a reconnect: the cards stay while the new
      // page loads, and a failure says so above them (`refreshFailed`).
      setLoadState((state) => (state === "ready" && listRef.current.posts.length > 0 ? state : "loading"));
    }
    setRefreshFailed(false);
    if (!merge) {
      setMoreState("idle");
    }
    fetchForumPosts(forumId, filters, null, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) {
          return;
        }
        setList((current) =>
          merge
            ? refreshForumFirstPage(current, page, { hold: isHeldRef.current() })
            : forumListFromPage(page),
        );
        setLoadState("ready");
      })
      .catch(() => {
        if (controller.signal.aborted) {
          return;
        }
        if (listRef.current.posts.length > 0 || listRef.current.pinned.length > 0) {
          setRefreshFailed(true);
          setLoadState("ready");
        } else {
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
    const generation = listGenRef.current;
    const current = () => listGenRef.current === generation;
    fetchForumPosts(forumId, requested, cursor)
      .then((page) => {
        if (!current()) {
          return;
        }
        setList((list) => appendForumPage(list, page));
        setMoreState("idle");
      })
      .catch(() => {
        if (current()) {
          setMoreState("error");
        }
      });
  }, [forumId, moreState]);

  // --------------------------------------------------------- open post
  // The address bar drives the open post only when the shell both names it
  // and takes changes; a `routePostId` alone is where the pane starts.
  const routeControlled = routePostId !== undefined && onRoutePostChange !== undefined;
  const [localPostId, setLocalPostId] = useState<string | null>(routePostId ?? null);
  const openPostId = routeControlled ? routePostId : localPostId;
  const setOpenPostId = useCallback(
    (postId: string | null) => {
      if (routeControlled) {
        onRoutePostChange?.(postId);
      } else {
        setLocalPostId(postId);
        onRoutePostChange?.(postId);
      }
    },
    [onRoutePostChange, routeControlled],
  );
  // Another forum in the same mount closes the post; the first render keeps
  // the post it started on.
  const postForumRef = useRef(forumId);
  useEffect(() => {
    if (postForumRef.current !== forumId) {
      postForumRef.current = forumId;
      setLocalPostId(null);
    }
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
  // A double click on a card opens that one post over the whole content
  // area, without touching the remembered maximize choice: a single click
  // on the next card is beside the list again.
  const [fullOnceId, setFullOnceId] = useState<string | null>(null);
  const canSplit = !isPhone && width >= SPLIT_MIN_WIDTH;
  const postOpen = openPostId !== null && (openPost !== null || removedOpenId === openPostId);
  const fullOnce = postOpen && fullOnceId === openPostId;
  const postFull = postOpen && (!canSplit || maximized || fullOnce);
  const compactList = postOpen && !postFull;
  // The reader's layout for this forum; beside an open post the list is
  // always rows, the only shape that fits two columns.
  const [layout, setLayout] = useState<ForumLayout>(() => readForumLayout(forumId));
  useEffect(() => {
    setLayout(readForumLayout(forumId));
  }, [forumId]);
  const changeLayout = useCallback(
    (next: ForumLayout) => {
      setLayout(next);
      writeForumLayout(forumId, next);
    },
    [forumId],
  );
  const cardVariant = compactList
    ? "row"
    : layout === "compact"
      ? "row"
      : layout === "gallery"
        ? "tile"
        : "card";
  // The list column's own width, which decides how many tags fit inline and
  // whether the filters ride one scrolling strip instead of wrapping.
  const railShown = (w: number) =>
    !compactList &&
    !postFull &&
    !isPhone &&
    w >= RAIL_MIN_WIDTH &&
    (Boolean(channel.topic?.trim()) || (list.counts?.posts ?? 0) > 0);
  const listColumnWidth = Math.min(width - (railShown(width) ? 320 : 0), 768) - 48;
  const filterStrip = isPhone || (!compactList && listColumnWidth < FILTER_STRIP_BELOW);
  const showRail =
    !compactList &&
    !postFull &&
    !isPhone &&
    width >= RAIL_MIN_WIDTH &&
    (Boolean(channel.topic?.trim()) || (list.counts?.posts ?? 0) > 0);

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
  isHeldRef.current = isHeld;
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
        // Staff saved tags or settings: `useForumRules` holds them (forum QA P11).
        if (frame.type === "forum-config-update") {
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
          // Now, not at the next render: a second frame in the same tick
          // must build on this one, not on the state before it.
          listRef.current = next;
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
    setFullOnceId(null);
    setRemovedOpenId(null);
    setRemovedOpenPost(null);
    if (back) {
      requestAnimationFrame(() => linkRefs.current.get(back)?.focus());
    }
  }, [setOpenPostId]);

  const openPostFull = useCallback(
    (postId: string) => {
      setFullOnceId(postId);
      openPostById(postId);
    },
    [openPostById],
  );

  const toggleMaximize = useCallback(() => {
    // Opened full by a double click: the button puts it beside the list,
    // and the remembered choice stays what it was.
    if (fullOnceId !== null && fullOnceId === openPostIdRef.current) {
      setFullOnceId(null);
      return;
    }
    setMaximized((current) => {
      writePostMaximized(!current);
      return !current;
    });
  }, [fullOnceId]);

  // ----------------------------------------------------------- composer
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerTitle, setComposerTitle] = useState<string | null>(null);
  const openComposer = useCallback(
    (title: string | null = null) => {
      setComposerTitle(title);
      setComposerOpen(true);
      // The flag is operator data flipped with no deploy: ask again as a
      // post starts, so a pause made since this tab opened shows before the
      // person has written the whole thing (forum QA P11). The tags and the
      // require-a-tag switch are read again for the same reason.
      void loadForumConfig(server.id).catch(() => {});
      refreshForumRules();
    },
    [server.id, refreshForumRules],
  );
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
      refreshForumRules();
    }
    droppedTakenRef.current?.();
  }, [droppedFiles, canCompose, refreshForumRules]);

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
  // The forum's topic is its rules. One rule per line reads as a numbered
  // list in the column beside the list; on a narrower screen the same text
  // opens from the info button in the bar.
  const [rulesSheetOpen, setRulesSheetOpen] = useState(false);
  const rules = channel.topic?.trim() ? channel.topic.trim() : null;
  const ruleLines = useMemo(
    () => (rules ? rules.split(/\n+/).map((line) => line.trim()).filter(Boolean) : []),
    [rules],
  );

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
  const forumEmpty =
    loadState === "ready" &&
    !forumFiltersActive(filters) &&
    list.posts.length === 0 &&
    list.pinned.length === 0 &&
    list.queued.length === 0;

  const starterKind = starterTagsFor(channel.name);
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
            icon: tag.icon ?? null,
            preset: tag.preset ?? null,
            moderated: tag.moderated,
          })),
          // The name is stored in this staff member's language; `preset` is
          // what lets every other reader see their own language's word.
          ...starterKind
            .map((starter) => ({
              name: t(starter.nameKey),
              emoji: forumTagIconEmoji(starter.icon),
              icon: starter.icon,
              preset: starter.preset,
              moderated: false,
            }))
            .filter(
              (tag) =>
                !tags.some(
                  (one) =>
                    forumTagNameKey(one.name) === forumTagNameKey(tag.name) ||
                    forumTagNameKey(forumTagLabel(one, t)) === forumTagNameKey(tag.name),
                ),
            ),
        ],
      });
      const added = next.length - tags.length;
      applyTags(next);
      // The suggestion row goes away with the tags it offered, so say what
      // happened and where they live now (forum QA P1).
      notify(
        t("forum.empty.starterDone", { count: Math.max(added, 1) }),
        onOpenSettings
          ? { label: t("forum.empty.starterEdit"), onClick: () => onOpenSettings("tags") }
          : undefined,
      );
    } catch {
      notify(t("forum.saveFailed"));
    } finally {
      setStarterBusy(false);
    }
  }

  const copyPostLink = useCallback(
    (postId: string) => {
      const url = new URL(forumPostPath(server.id, forumId, postId), window.location.origin);
      if (!navigator.clipboard?.writeText) {
        notify(t("forum.saveFailed"));
        return;
      }
      navigator.clipboard
        .writeText(url.toString())
        .then(() => notify(t("forum.post.linkCopied")))
        .catch(() => notify(t("forum.saveFailed")));
    },
    [forumId, notify, server.id, t],
  );

  const newPostButton = canCompose ? (
    <div className="relative shrink-0">
      <Button
        onClick={() => openComposer()}
        className={cn("gap-1.5", !compactList && "h-10 px-4")}
        size={compactList ? "sm" : undefined}
        data-forum-new-post=""
      >
        <Plus className="h-4 w-4" aria-hidden strokeWidth={2.5} />
        {t("forum.newPost")}
        {!compactList && (
          <kbd className="ml-0.5 hidden h-5 min-w-5 items-center justify-center rounded-[var(--radius-tick)] bg-on-accent/10 px-1 font-sans text-[10px] font-semibold lg:inline-flex">
            C
          </kbd>
        )}
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
        className="flex items-center gap-2.5 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 text-sm text-text-secondary"
      >
        <CirclePause className="h-4 w-4 shrink-0" aria-hidden />
        {t("forum.paused")}
      </p>
    ) : null;

  const rulesButton =
    rules && !showRail ? (
      <Tooltip label={t("forum.rules.show")}>
        <button
          type="button"
          onClick={() => setRulesSheetOpen(true)}
          aria-label={t("forum.rules.show")}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-control)] text-text-secondary hover:bg-surface-2 hover:text-text max-sm:h-11 max-sm:w-11"
          data-forum-rules-button=""
        >
          <Info className="h-4 w-4 max-sm:h-5 max-sm:w-5" aria-hidden />
        </button>
      </Tooltip>
    ) : null;

  const countsLine = counts
    ? counts.posts === 0
      ? t("forum.header.count_zero")
      : `${t("forum.header.count", { count: counts.posts })} · ${t("forum.header.open", {
          count: counts.open,
        })}`
    : null;

  // The bar is orientation and the shell's tiles. Beside an open post it also
  // carries the forum's name and Novo post; otherwise the large title below
  // does, the way an Apple large title sits under a quiet bar.
  const header = (
    <header className={cn("flex h-14 shrink-0 items-center gap-1.5 px-3 sm:px-4", PANE_HEADER_REDESIGN, "redesign:gap-1.5 redesign:max-sm:px-2")}>
      <button
        type="button"
        className={cn(
          "grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] hover:bg-surface-2 md:hidden",
          PANE_HEADER_NAV_REDESIGN,
          "redesign:md:hidden",
        )}
        aria-label={t("chrome.openNav")}
        onClick={onOpenNav}
      >
        <IconSwap off={MenuIcon} on={ListIcon} kind="symbol" offClassName="h-5 w-5" />
      </button>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {compactList ? (
          <>
            <span className={cn("forum-display truncate text-lg font-bold text-text", PANE_HEADER_TITLE_REDESIGN)}>
              {channel.name}
            </span>
            {countsLine && (
              <span className={cn("truncate text-xs tabular-nums text-text-secondary max-lg:hidden", PANE_HEADER_DETAIL_REDESIGN)}>
                {countsLine}
              </span>
            )}
          </>
        ) : isPhone ? null : (
          <span className="flex min-w-0 items-center gap-1.5 text-[13px] text-text-secondary">
            <MessagesSquare className="h-4 w-4 shrink-0" aria-hidden />
            <span className="truncate">{t("forum.kind")}</span>
          </span>
        )}
      </div>
      {isPhone && !forumEmpty && (
        <button
          type="button"
          aria-label={t("forum.search.open")}
          onClick={() => {
            setPhoneSearchOpen(true);
            window.setTimeout(() => searchRef.current?.focus(), 0);
          }}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-text hover:bg-surface-2"
        >
          <Search className="h-5 w-5" aria-hidden />
        </button>
      )}
      {rulesButton}
      {isPhone && canCompose && (
        <button
          type="button"
          aria-label={t("forum.newPost")}
          onClick={() => openComposer()}
          data-forum-new-post=""
          className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-control)] text-accent hover:bg-surface-2"
        >
          <SquarePen className="h-5 w-5" aria-hidden />
        </button>
      )}
      {compactList && !isPhone && newPostButton}
      {/* The shell's header tiles are 32px; on a phone the forum's header has
          room for a full finger target (forum QA P17). */}
      <span className="flex shrink-0 items-center gap-1 max-sm:gap-0 max-sm:[&_button]:h-11 max-sm:[&_button]:w-11">
        {headerActions}
      </span>
    </header>
  );

  // The large title: the forum's name, how much is in it, and the one primary
  // action on the screen.
  const hero = compactList ? null : (
    <div className="flex items-end gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="flex min-w-0 items-center gap-2 forum-display-lg text-[28px] font-bold leading-[34px] text-text sm:text-[34px] sm:leading-10">
          <span className="truncate">{channel.name}</span>
          {creationEnabled && <BetaTag className="max-sm:hidden" />}
        </h1>
        {countsLine && (
          <p className="mt-1 truncate text-[15px] leading-[22px] tabular-nums text-text-secondary">
            {countsLine}
          </p>
        )}
      </div>
      {/* An empty forum's own call to action is the one primary button. */}
      {!isPhone && !forumEmpty && newPostButton}
    </div>
  );

  const searchField = (
    <label
      className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-[var(--radius-card)] bg-surface-1 px-3 text-sm text-text-secondary transition-shadow duration-[var(--duration-fast)] focus-within:ring-2 focus-within:ring-focus-ring"
    >
      <Search className="h-4 w-4 shrink-0" aria-hidden />
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
        placeholder={t("forum.search.placeholder", { name: channel.name })}
        aria-label={t("forum.search")}
        className="min-w-0 flex-1 bg-transparent text-text placeholder:text-text-secondary focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {searchText ? (
        <button
          type="button"
          onClick={() => {
            setSearchText("");
            searchRef.current?.focus();
          }}
          aria-label={t("forum.search.clear")}
          className="grid h-6 w-6 place-items-center rounded-[var(--radius-control)] hover:text-text max-sm:hit-44"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      ) : (
        <kbd className="hidden h-5 min-w-5 items-center justify-center rounded-[var(--radius-tick)] bg-surface-2 px-1 font-sans text-[11px] font-semibold text-text-secondary sm:inline-flex">
          /
        </kbd>
      )}
    </label>
  );

  const unreadFor = (post: ForumPostSummary) =>
    forumUnreadState(
      post,
      list.viewer[post.id],
      viewerId,
      visitCursor ? visitCursor.previous : list.forumPreviousReadAt,
    );

  function cardFor(post: ForumPostSummary) {
    return (
      <li key={post.id} className="list-none">
        <ForumPostCard
          post={post}
          unread={unreadFor(post)}
          tagsById={tagsById}
          href={forumPostPath(server.id, forumId, post.id)}
          variant={cardVariant}
          narrow={isPhone || compactList}
          open={post.id === openPostId}
          entering={enteringIds.has(post.id)}
          leaving={leavingIds.has(post.id)}
          tabIndex={post.id === rovingId ? 0 : -1}
          onOpen={openPostById}
          onOpenFull={canSplit ? openPostFull : undefined}
          onFocus={setFocusedId}
          onKeyDown={onCardKeyDown}
          registerLink={registerLink}
          onCopyLink={copyPostLink}
          viewerId={viewerId}
        />
      </li>
    );
  }

  // The body of the list: states first, then the cards.
  let listBody: ReactNode;
  if (loadState === "loading" && list.posts.length === 0) {
    listBody = (
      <div className="flex flex-col" aria-busy="true" aria-label={t("forum.list.label")}>
        <CardSkeleton />
        <CardSkeleton short />
        <CardSkeleton />
      </div>
    );
  } else if (loadState === "error" && list.posts.length === 0) {
    listBody = (
      <EmptyBlock
        role="alert"
        icon={<ForumEmptyGlyph line={<WifiOff className="h-7 w-7" aria-hidden strokeWidth={1.5} />} filled={<Icon icon={PhWifiSlash} kind="symbol" size="lg" />} />}
        title={t("forum.loadError")}
        body={t("forum.loadError.body")}
      >
        <Button variant="secondary" onClick={() => setReloadToken((n) => n + 1)}>
          {t("forum.retry")}
        </Button>
      </EmptyBlock>
    );
  } else if (forumEmpty) {
    listBody = (
      <EmptyBlock
        icon={<ForumEmptyGlyph line={<MessagesSquare className="h-7 w-7" aria-hidden strokeWidth={1.5} />} filled={<Icon icon={PhChatsCircle} size="lg" />} />}
        title={t("forum.empty")}
        body={t("forum.empty.body")}
      >
        {canCompose && (
          <Button onClick={() => openComposer()} className="h-10 gap-1.5 px-4">
            <Plus className="h-4 w-4" aria-hidden strokeWidth={2.5} />
            {t("forum.empty.cta")}
          </Button>
        )}
        {canManage && onOpenSettings && tags.length > 0 && (
          <Button variant="secondary" onClick={() => onOpenSettings("tags")} className="h-10 gap-1.5">
            <Tag className="h-4 w-4" aria-hidden />
            {t("forum.empty.starterEdit")}
          </Button>
        )}
        {pausedLine}
        {canManage && tagsLoaded && tags.length === 0 && (
          <div className="mt-3 flex w-full flex-wrap items-center justify-center gap-1.5 text-xs text-text-secondary" data-forum-starter="">
            <span className="mr-1">{t("forum.empty.starter")}</span>
            {starterKind.map((starter) => (
              <span
                key={starter.preset}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-dashed border-border-strong px-3 text-[13px] text-text-secondary"
              >
                <ForumTagIcon tag={{ icon: starter.icon, emoji: null }} className="h-3.5 w-3.5" />
                {t(starter.nameKey)}
              </span>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={starterBusy}
              onClick={() => void applyStarterTags()}
              aria-busy={starterBusy || undefined}
              className="gap-1 font-semibold text-text"
            >
              {starterBusy && <Spinner className="h-3 w-3 animate-spin" />}
              {t("forum.empty.starterUse")}
            </Button>
            {onOpenSettings && (
              <Button size="sm" variant="ghost" onClick={() => onOpenSettings("tags")} className="gap-1">
                {t("forum.empty.setupTags")}
              </Button>
            )}
          </div>
        )}
      </EmptyBlock>
    );
  } else {
    const noResults = list.posts.length === 0 && (filters.q || list.pinned.length === 0 || forumFiltersActive(filters));
    const listClass =
      cardVariant === "tile"
        ? "grid grid-cols-2 gap-1 sm:grid-cols-3"
        : cn(
            "flex flex-col",
            // A hairline between posts, inset from the edges, instead of a
            // box around each one.
            "[&>li+li]:before:mx-4 [&>li+li]:before:block [&>li+li]:before:h-px [&>li+li]:before:bg-border/60 [&>li+li]:before:content-['']",
            cardVariant === "row" && "[&>li+li]:before:mx-3",
          );
    listBody = (
      <>
        {refreshFailed && (
          <div
            role="alert"
            className="mb-3 flex items-center gap-3 rounded-[var(--radius-card)] bg-warning-soft px-3.5 py-2.5 text-sm text-on-warning-soft"
            data-forum-refresh-failed=""
          >
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
            <span className="flex-1">{t("forum.refreshFailed")}</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-on-warning-soft"
              onClick={() => setReloadToken((n) => n + 1)}
            >
              {t("forum.live.refresh")}
            </Button>
          </div>
        )}
        {noResults && list.posts.length === 0 ? (
          filters.q ? (
            <EmptyBlock
              icon={<ForumEmptyGlyph line={<SearchX className="h-7 w-7" aria-hidden strokeWidth={1.5} />} filled={<Icon icon={PhMagnifyingGlass} kind="symbol" size="lg" />} />}
              title={t("forum.searchEmpty", { query: filters.q })}
              body={t("forum.searchEmpty.body")}
            >
              {canCompose && (
                // Secondary: Novo post stays the one primary button on the
                // screen (forum QA P6, DESIGN.md).
                <Button
                  variant="secondary"
                  onClick={() => openComposer(filters.q)}
                  className="h-10 gap-1.5"
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t("forum.searchEmpty.post", { query: filters.q })}
                </Button>
              )}
              <Button variant="ghost" className="h-10" onClick={() => setMessageSearch(filters.q)}>
                {t("forum.searchEmpty.messages")}
              </Button>
            </EmptyBlock>
          ) : filters.mine && filters.tagIds.length === 0 && filters.status === null ? (
            <EmptyBlock
              icon={<ForumEmptyGlyph line={<ListFilter className="h-7 w-7" aria-hidden strokeWidth={1.5} />} filled={<Icon icon={PhFunnel} kind="symbol" size="lg" />} />}
              title={t("forum.mineEmpty")}
            >
              <Button variant="secondary" className="h-10" onClick={() => changeFilters({ mine: false })}>
                {t("forum.filterEmpty.clear")}
              </Button>
            </EmptyBlock>
          ) : (
            <EmptyBlock
              icon={<ForumEmptyGlyph line={<ListFilter className="h-7 w-7" aria-hidden strokeWidth={1.5} />} filled={<Icon icon={PhFunnel} kind="symbol" size="lg" />} />}
              title={t("forum.filterEmpty")}
              body={describeActiveFilters(filters, tags, t)}
            >
              <Button
                variant="secondary"
                className="h-10"
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
            className={listClass}
            data-forum-list={cardVariant}
            onFocus={() => {
              focusInListRef.current = true;
            }}
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                focusInListRef.current = false;
              }
            }}
          >
            {list.posts.map((post) => cardFor(post))}
          </ul>
        )}
        <div ref={sentinelRef} aria-hidden className="h-px" />
        {moreState === "loading" && (
          <p className="flex items-center justify-center gap-2 py-5 text-xs text-text-secondary">
            <Spinner className="h-4 w-4 animate-spin" />
          </p>
        )}
        {moreState === "error" && (
          <div className="mt-2 flex items-center gap-3 rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-2.5 text-sm text-text-secondary">
            <span className="flex-1">{t("forum.loadMoreError")}</span>
            <Button size="sm" variant="ghost" className="text-text" onClick={() => setMoreState("idle")}>
              {t("forum.retry")}
            </Button>
          </div>
        )}
        {list.nextCursor === null &&
          loadState === "ready" &&
          list.posts.length > 0 &&
          counts &&
          !forumFiltersActive(filters) && (
            <p className="flex items-center gap-3 px-4 py-6 text-[13px] text-text-secondary">
              <span aria-hidden className="h-px flex-1 bg-border/60" />
              {t("forum.end", { count: counts.posts })}
              <span aria-hidden className="h-px flex-1 bg-border/60" />
            </p>
          )}
      </>
    );
  }

  const pinnedStrip =
    !filters.q && list.pinned.length > 0 && !forumEmpty ? (
      <section aria-label={t("forum.pinned")} className="min-w-0">
        <ul
          role="list"
          className={cn(
            "gap-2",
            compactList
              ? "flex flex-col"
              : isPhone
                ? "-mx-4 flex snap-x scroll-px-4 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>li]:w-[240px] [&>li]:shrink-0 [&>li]:snap-start"
                : "grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))]",
          )}
        >
          {list.pinned.map((post) => (
            <li key={post.id} className="list-none">
              <ForumPinnedTile
                post={post}
                unread={unreadFor(post)}
                href={forumPostPath(server.id, forumId, post.id)}
                open={post.id === openPostId}
                tabIndex={post.id === rovingId ? 0 : -1}
                onOpen={openPostById}
                onFocus={setFocusedId}
                onKeyDown={onCardKeyDown}
                registerLink={registerLink}
              />
            </li>
          ))}
        </ul>
      </section>
    ) : null;

  // Beside the list on a wide screen: what this forum is for, its rules as a
  // numbered list, and how much of it is solved.
  const rail = showRail ? (
    <aside
      aria-label={t("forum.about.title")}
      className="sticky top-4 w-[280px] shrink-0 self-start pt-1"
      data-forum-rail=""
    >
      <div className="rounded-[var(--radius-panel)] bg-surface-1 p-[18px]">
        {counts && counts.posts > 0 && (
          <dl className="grid grid-cols-3 gap-2">
            {[
              { value: counts.posts, label: t("forum.about.posts", { count: counts.posts }) },
              { value: counts.open, label: t("forum.about.open", { count: counts.open }) },
              {
                value: `${Math.round(((counts.posts - counts.open) / counts.posts) * 100)}%`,
                label: t("forum.about.solved"),
              },
            ].map((stat) => (
              <div key={stat.label} className="min-w-0">
                <dd className="forum-display text-lg font-bold tabular-nums text-text">{stat.value}</dd>
                <dt className="truncate text-xs text-text-secondary">{stat.label}</dt>
              </div>
            ))}
          </dl>
        )}
        {rules && (
          <>
            {counts && counts.posts > 0 && <div aria-hidden className="my-4 h-px bg-border/60" />}
            <h2 className="forum-display text-[15px] font-bold leading-5 text-text">
              {t("forum.rules.title")}
            </h2>
            {ruleLines.length > 1 ? (
              <ol className="mt-2.5 flex flex-col gap-2.5 text-[13px] leading-[18px] text-text-secondary">
                {ruleLines.map((line, index) => (
                  <li key={index} className="flex gap-2.5">
                    <span className="w-3 shrink-0 font-bold tabular-nums text-text">{index + 1}</span>
                    <span className="min-w-0 break-words">{line}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-[19px] text-text-secondary">
                {rules}
              </p>
            )}
          </>
        )}
      </div>
    </aside>
  ) : null;

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
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <div
          className={cn(
            "mx-auto flex w-full gap-10 px-4 pb-24 sm:px-6",
            compactList ? "pt-1" : "pt-2 sm:pt-3",
            compactList ? "max-w-none" : showRail ? "max-w-[1080px]" : "max-w-3xl",
          )}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-3">
            {hero}
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
              <div className={cn("flex flex-col gap-2.5", !compactList && "mt-2")}>
                {!isPhone && (
                  <div className="flex items-center gap-2">
                    {searchField}
                    {!compactList && (
                      <>
                        <ForumSortMenu
                          sort={filters.sort}
                          onChange={(sort) => changeFilters({ sort })}
                          className="h-10 rounded-[var(--radius-card)]"
                        />
                        <ForumLayoutSwitch layout={layout} onChange={changeLayout} />
                      </>
                    )}
                  </div>
                )}
                {!compactList && pausedLine}
                <ForumFilterBar
                  filters={filters}
                  tags={tags}
                  onChange={changeFilters}
                  strip={filterStrip}
                  leading={
                    isPhone || compactList ? (
                      <ForumSortMenu
                        sort={filters.sort}
                        onChange={(sort) => changeFilters({ sort })}
                        short
                      />
                    ) : undefined
                  }
                  inlineTags={
                    compactList
                      ? 0
                      : Math.max(1, Math.min(6, Math.floor((listColumnWidth - 360) / 100)))
                  }
                />
              </div>
            )}
            {pinnedStrip}
            {/* "N posts com novidade": the list never reorders under the
                reader. Sticky over the cards, never over the toolbar (forum QA
                P10). Zero height, so it never pushes the list. */}
            {list.queued.length > 0 && (
              <div className="pointer-events-none sticky top-2 z-20 -mb-3 flex h-0 justify-center">
                <button
                  type="button"
                  onClick={flushQueue}
                  className="pointer-events-auto inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-text px-3.5 text-xs font-semibold text-surface-0 shadow-[var(--shadow-2)] animate-pop-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring focus-visible:ring-offset-2 focus-visible:ring-offset-ring-offset max-sm:hit-44"
                  data-forum-live-pill=""
                >
                  <ArrowUp className="h-3.5 w-3.5" aria-hidden />
                  {t("forum.live", { count: list.queued.length })}
                </button>
              </div>
            )}
            <div className={cn("min-w-0", !compactList && (cardVariant === "tile" ? "-mx-2" : "-mx-4"))}>{listBody}</div>
          </div>
          {rail}
        </div>
      </div>
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
          requireTag={settings?.requireTag ?? false}
          tagsStatus={tagsStatus}
          onRefreshTags={refreshForumRules}
          onRetryTags={retryTags}
          canManageTags={canManage}
          onOpenTagSettings={onOpenSettings ? () => onOpenSettings("tags") : undefined}
          tagsById={tagsById}
          viewerId={viewerId}
          isStaff={isStaff}
          canSend={canPost}
          layout={postFull ? "full" : "side"}
          forcedFull={!canSplit}
          isPhone={isPhone}
          maximized={maximized || fullOnce}
          onToggleMaximize={toggleMaximize}
          removed={removedOpenId === openPost.id}
          pinnedCount={list.pinned.length}
          href={forumPostPath(server.id, forumId, openPost.id)}
          controller={postController}
          currentUser={currentUser}
          mentionCandidates={mentionCandidates}
          blockedAuthorIds={blockedAuthorIds}
          authors={authors}
          authorsComplete={authorsComplete}
          authorGoneCheck={authorGoneCheck}
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
        <aside className="flex w-full flex-col items-center justify-center bg-surface-0 px-6 text-center shadow-[-1px_0_0_var(--color-border)] max-md:fixed max-md:inset-0 max-md:z-30 md:w-[520px]">
          <Trash2 className="h-7 w-7 text-text-secondary" aria-hidden strokeWidth={1.5} />
          <p className="mt-4 forum-display text-xl font-bold text-text">{t("forum.post.loadFailed")}</p>
          <p className="mt-1.5 max-w-xs text-sm text-text-secondary">{t("forum.post.loadFailed.body")}</p>
          <Button variant="secondary" className="mt-5 h-10" onClick={closePost}>
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
        tagsStatus={tagsStatus}
        onRetryTags={retryTags}
        canManageTags={canManage}
        onOpenTagSettings={
          onOpenSettings
            ? () => {
                setComposerOpen(false);
                onOpenSettings("tags");
              }
            : undefined
        }
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
        onRefused={(kind) => {
          // The server knew better than the screen: read the rule again, so
          // the paused line or "pelo menos 1" shows without a reload.
          if (kind === "paused") {
            setFetchedEnabled(false);
            void loadForumConfig(server.id).catch(() => {});
          } else {
            // A tag now required: the tags may be what changed too.
            refreshForumRules();
          }
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
        {ruleLines.length > 1 ? (
          <ol className="flex flex-col gap-3 px-5 py-4 text-sm leading-5 text-text-secondary">
            {ruleLines.map((line, index) => (
              <li key={index} className="flex gap-3">
                <span className="w-3 shrink-0 font-bold tabular-nums text-text">{index + 1}</span>
                <span className="min-w-0 break-words">{line}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="whitespace-pre-wrap break-words px-5 py-4 text-sm text-text-secondary">
            {rules}
          </p>
        )}
      </Dialog>

      {toast && (
        <div
          key={toast.id}
          role="status"
          className="pointer-events-auto absolute bottom-5 left-1/2 z-40 flex min-h-11 max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-[var(--radius-card)] bg-text px-4 py-2.5 text-sm text-surface-0 shadow-[var(--shadow-2)] animate-pop-in"
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
              className="shrink-0 font-semibold underline underline-offset-2"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

