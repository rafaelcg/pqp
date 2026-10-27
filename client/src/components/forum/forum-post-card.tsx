import {
  FORUM_PREVIEW_MAX,
  type ForumPostSummary,
  type ForumTag,
} from "@pqp/shared";
import {
  CheckCircle2,
  ImageIcon,
  Link2,
  Lock,
  MessageSquare,
  Pin,
  Play,
  Rss,
  Video,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import { Tooltip } from "@/components/ui/tooltip";
import type { ForumUnreadState } from "@/lib/forum-list";
import { useForumTagLabel } from "@/lib/forum-tag-icons";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn, formatRelativeShort } from "@/lib/utils";
import { badgeRedesignClasses } from "@/components/ui/badge";

/** A tag under the redesign: the neutral badge's tint at the chip's size. */
const TAG_REDESIGN = "redesign:bg-[color:var(--segmented-bg)] redesign:font-medium";
/** Cards, tiles and pinned rows under the redesign: the card tokens. */
const FORUM_CARD_REDESIGN = "redesign:border redesign:border-[color:var(--card-border)] redesign:bg-[color:var(--card-bg)] redesign:rounded-[var(--radius-card)] redesign:hover:border-[color:var(--forum-card-hover-border)] redesign:hover:bg-[color:var(--card-bg)]";
/** The open post's card: a stronger edge on the row-hover fill. */
const FORUM_CARD_OPEN_REDESIGN = "redesign:border-[color:var(--forum-card-open-border)] redesign:bg-[color:var(--card-row-hover)] redesign:hover:bg-[color:var(--card-row-hover)]";

/**
 * One post in the list, in the layout the reader picked (`forum-prefs`):
 *
 * - `card`: who and when, the title, two lines of the opening message, a
 *   large picture when it opens with one, the tags, and the numbers. The
 *   default, and Reddit's shape: content first, chrome last.
 * - `row`: one dense line of title over one line of facts. The compact view,
 *   and the list beside an open post.
 * - `tile`: a picture first, for a showcase forum (the gallery view).
 *
 * Every variant keeps the same contract: the whole surface is the hit target
 * because the title is a real link stretched over it (middle-click and copy
 * link do what a link does), the list keeps ONE tab stop with arrows inside it
 * (the link's `tabIndex` is the roving one, owned by the list), and the link's
 * accessible name says the title, status, author, replies and time.
 *
 * Unread is said twice and never by colour alone: a dot before the title and
 * a heavier title. "+3 new" on the replies says what changed since the visit.
 */

export type ForumPostCardVariant = "card" | "row" | "tile";

export interface ForumPostCardProps {
  post: ForumPostSummary;
  unread: ForumUnreadState;
  tagsById: ReadonlyMap<string, ForumTag>;
  href: string;
  variant?: ForumPostCardVariant;
  /** This is the post open beside the list. */
  open?: boolean;
  /** A phone: tighter tag rows, no thumbnail column on a row. */
  narrow?: boolean;
  /** Arrived live while the list was on screen: slides in. */
  entering?: boolean;
  /** Removed live: fades out before it leaves the list. */
  leaving?: boolean;
  tabIndex: 0 | -1;
  onOpen: (postId: string) => void;
  /**
   * Double click: the post takes the whole content area for this visit,
   * without changing the remembered split/maximized choice.
   */
  onOpenFull?: (postId: string) => void;
  onFocus: (postId: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>, postId: string) => void;
  registerLink?: (postId: string, node: HTMLAnchorElement | null) => void;
  /** Copies the post's link; the card draws a quiet button for it. */
  onCopyLink?: (postId: string) => void;
  /** The viewer, so "be the first to reply" is not said about their own post. */
  viewerId?: string | null;
}

const MAX_TAGS_CARD = 3;
const MAX_TAGS_ROW = 2;
/**
 * The small avatar's monogram sits on a disc of its own. Without one it was a
 * bare letter beside the name, a stray "D" before "Dev User" (forum QA P14).
 */
const TINY_AVATAR_FALLBACK = "bg-surface-3 text-[9px] leading-none text-text-secondary";
/** The tallest a card's picture may be; a portrait shot letterboxes inside it. */
const MEDIA_MAX_HEIGHT = 360;

export function ForumTagChip({ tag, size = "md" }: { tag: ForumTag; size?: "sm" | "md" }) {
  const tagLabel = useForumTagLabel();
  return (
    <span
      className={cn(
        "inline-flex max-w-[11rem] shrink-0 items-center gap-1 rounded-full bg-surface-2 text-text-secondary",
        size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
        tag.moderated && "ring-1 ring-inset ring-border-strong text-text",
        TAG_REDESIGN,
      )}
    >
      <ForumTagIcon tag={tag} />
      <span className="truncate">{tagLabel(tag)}</span>
    </span>
  );
}

export function ForumTagList({
  tagIds,
  tagsById,
  max,
  size = "md",
}: {
  tagIds: readonly string[];
  tagsById: ReadonlyMap<string, ForumTag>;
  max: number;
  size?: "sm" | "md";
}) {
  const tagLabel = useForumTagLabel();
  const tags = tagIds
    .map((tagId) => tagsById.get(tagId))
    .filter((tag): tag is ForumTag => Boolean(tag));
  if (tags.length === 0) {
    return null;
  }
  const shown = tags.slice(0, max);
  const hidden = tags.length - shown.length;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      {shown.map((tag) => (
        <ForumTagChip key={tag.id} tag={tag} size={size} />
      ))}
      {hidden > 0 && (
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full bg-surface-2 tabular-nums text-text-secondary",
            size === "sm" ? "h-5 px-2 text-[11px]" : "h-6 px-2.5 text-xs",
            TAG_REDESIGN,
          )}
          title={tags
            .slice(max)
            .map((tag) => tagLabel(tag))
            .join(", ")}
        >
          +{hidden}
        </span>
      )}
    </span>
  );
}

/** What the second line says when the opening message is not plain text. */
export function forumPreviewText(
  t: Translator["t"],
  post: ForumPostSummary,
): string {
  if (post.openingDeleted) {
    return t("thread.originDeleted");
  }
  if (post.preview && post.preview.trim()) {
    // The server cuts the opening message at FORUM_PREVIEW_MAX characters;
    // a cut that lands inside the second line must still read as "more".
    return Array.from(post.preview).length >= FORUM_PREVIEW_MAX
      ? `${post.preview.trimEnd()}…`
      : post.preview;
  }
  if (post.openingKind === "voice") {
    return t("forum.preview.voice");
  }
  // One picture or one clip says what it is; several files say how many.
  if (post.attachmentCount === 1 && post.thumbnailUrl) {
    return t("forum.preview.image");
  }
  if (post.attachmentCount === 1 && post.thumbnailVideoUrl) {
    return t("forum.preview.video");
  }
  if (post.attachmentCount > 0) {
    return t("forum.preview.files", { count: post.attachmentCount });
  }
  return "";
}

/**
 * The picture before the preview line when the opening message is one image or
 * one clip and has no words: the line says "Image" or "Video", and this is the
 * icon beside it (never an emoji in the copy).
 */
export function forumPreviewKind(post: ForumPostSummary): "image" | "video" | null {
  if (post.openingDeleted || (post.preview && post.preview.trim())) {
    return null;
  }
  if (post.openingKind === "voice" || post.attachmentCount !== 1) {
    return null;
  }
  if (post.thumbnailUrl) {
    return "image";
  }
  return post.thumbnailVideoUrl ? "video" : null;
}

export function forumAuthorName(
  t: Translator["t"],
  post: ForumPostSummary,
): string {
  return post.authorName ?? t("forum.deletedAuthor");
}

function statusWord(t: Translator["t"], post: ForumPostSummary): string {
  const words = [
    post.pinnedAt ? t("forum.badge.pinned") : null,
    post.lockedAt ? t("forum.badge.locked") : null,
    post.resolvedAt ? t("forum.badge.resolved") : t("forum.card.srOpen"),
  ].filter(Boolean);
  return words.join(", ").toLowerCase();
}

/** What a screen reader hears for a post link: the summary, then new or unread. */
function postSrName(
  t: Translator["t"],
  locale: string,
  post: ForumPostSummary,
  unread: ForumUnreadState,
): string {
  const newReplies = unread.kind === "unread" ? unread.count : 0;
  return [
    t("forum.card.sr", {
      title: post.title,
      status: statusWord(t, post),
      author: forumAuthorName(t, post),
      replies: t("forum.replies", { count: post.replyCount }),
      time: formatRelativeShort(post.lastActivityAt, locale),
    }),
    unread.kind === "new"
      ? t("forum.card.srNew")
      : newReplies > 0
        ? t("forum.card.srUnread", { count: newReplies })
        : null,
  ]
    .filter(Boolean)
    .join(", ");
}

function hasMedia(post: ForumPostSummary): boolean {
  return Boolean(post.thumbnailUrl || post.thumbnailVideoUrl);
}

/**
 * The opening message's first picture, or a clip's first frame. `box` is a
 * small square beside a row; `media` is the card's large picture, letterboxed
 * over a blurred copy of itself so a phone screenshot does not become a thin
 * strip in a wide card; `tile` fills the gallery's 4:3 frame.
 */
function Thumbnail({
  post,
  fit,
  className,
}: {
  post: ForumPostSummary;
  fit: "box" | "media" | "tile";
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const videoUrl = post.thumbnailUrl ? null : (post.thumbnailVideoUrl ?? null);
  // A clip's first frame costs a metadata fetch, so it is only asked for once
  // the card is near the screen: a page of 25 video posts must not open 25
  // requests at once. Without an observer (a test, an old engine) it loads.
  const boxRef = useRef<HTMLSpanElement>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const node = boxRef.current;
    if (!videoUrl || near || !node || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [videoUrl, near]);
  if ((!post.thumbnailUrl && !videoUrl) || failed) {
    return null;
  }
  const width = post.thumbnailWidth ?? null;
  const height = post.thumbnailHeight ?? null;
  // The card keeps the picture's own shape up to MEDIA_MAX_HEIGHT; a picture
  // with no known size gets a 16:9 frame and is fitted inside it.
  const mediaStyle =
    fit === "media"
      ? {
          aspectRatio: width && height ? `${width} / ${height}` : "16 / 9",
          maxHeight: MEDIA_MAX_HEIGHT,
        }
      : undefined;
  const contain = fit === "media";
  const count =
    post.attachmentCount > 1 && fit !== "box" ? `1/${post.attachmentCount}` : null;
  return (
    <span
      ref={boxRef}
      data-forum-thumbnail={fit}
      style={mediaStyle}
      className={cn(
        "relative block shrink-0 overflow-hidden bg-surface-1",
        fit === "box" ? "rounded-[var(--radius-control)]" : "rounded-[var(--radius-card)]",
        fit === "media" && "w-full",
        className,
      )}
    >
      {post.thumbnailUrl ? (
        <>
          {contain && (
            <img
              src={post.thumbnailUrl}
              alt=""
              aria-hidden="true"
              loading="lazy"
              decoding="async"
              draggable={false}
              className="pointer-events-none absolute inset-0 h-full w-full scale-110 object-cover opacity-50 blur-2xl"
            />
          )}
          <img
            src={post.thumbnailUrl}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            onError={() => setFailed(true)}
            className={cn(
              "relative h-full w-full",
              contain ? "object-contain" : "object-cover",
            )}
          />
        </>
      ) : (
        <>
          {/* The first frame is the poster: `#t` asks for it, `metadata`
              keeps the fetch to the header and that frame. */}
          {near && (
            <video
              src={`${videoUrl}#t=0.1`}
              preload="metadata"
              muted
              playsInline
              disablePictureInPicture
              tabIndex={-1}
              aria-hidden
              onError={() => setFailed(true)}
              className={cn(
                "pointer-events-none h-full w-full",
                contain ? "object-contain" : "object-cover",
              )}
            />
          )}
          <span aria-hidden className="pointer-events-none absolute inset-0 grid place-items-center">
            <span
              className={cn(
                "grid place-items-center rounded-full bg-black/55 text-white",
                fit === "box" ? "h-6 w-6" : "h-11 w-11",
              )}
            >
              <Play
                className={cn("translate-x-px fill-current", fit === "box" ? "h-3 w-3" : "h-5 w-5")}
              />
            </span>
          </span>
        </>
      )}
      {count && (
        <span
          aria-hidden
          className="absolute right-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-white"
        >
          {count}
        </span>
      )}
      {/* The hairline sits ON the image, so a dark screenshot does not melt
          into the surface behind it. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 ring-1 ring-inset ring-border/70",
          fit === "box" ? "rounded-[var(--radius-control)]" : "rounded-[var(--radius-card)]",
        )}
      />
    </span>
  );
}

/** The dot before an unread title. Shape, not colour, so it reads in any theme. */
function UnreadDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      data-forum-unread-dot=""
      className={cn("inline-block h-2 w-2 shrink-0 rounded-full bg-text", className)}
    />
  );
}

/** Resolved, closed or pinned as a quiet word with its icon; never truncated. */
function StatusMarks({ post, iconsOnly = false }: { post: ForumPostSummary; iconsOnly?: boolean }) {
  const { t } = useTranslation();
  const marks: ReactNode[] = [];
  if (post.pinnedAt) {
    marks.push(
      <span key="pin" className="inline-flex shrink-0 items-center gap-1 text-text-secondary">
        <Pin className="h-3.5 w-3.5" role="img" aria-label={t("forum.badge.pinned")} />
        {!iconsOnly && <span aria-hidden>{t("forum.badge.pinned")}</span>}
      </span>,
    );
  }
  if (post.lockedAt) {
    marks.push(
      <span key="lock" className="inline-flex shrink-0 items-center gap-1 text-text-secondary">
        <Lock className="h-3.5 w-3.5" role="img" aria-label={t("forum.badge.locked")} />
        {!iconsOnly && <span aria-hidden>{t("forum.badge.locked")}</span>}
      </span>,
    );
  }
  if (post.resolvedAt) {
    marks.push(
      <span key="done" className="inline-flex shrink-0 items-center gap-1 font-semibold text-success">
        <CheckCircle2 className="h-3.5 w-3.5" role="img" aria-label={t("forum.badge.resolved")} />
        {!iconsOnly && <span aria-hidden>{t("forum.badge.resolved")}</span>}
      </span>,
    );
  }
  return marks.length > 0 ? <>{marks}</> : null;
}

export const ForumPostCard = memo(function ForumPostCard({
  post,
  unread,
  tagsById,
  href,
  variant = "card",
  open = false,
  narrow = false,
  entering = false,
  leaving = false,
  tabIndex,
  onOpen,
  onOpenFull,
  onFocus,
  onKeyDown,
  registerLink,
  onCopyLink,
  viewerId,
}: ForumPostCardProps) {
  const { t, locale } = useTranslation();
  const author = forumAuthorName(t, post);
  const preview = forumPreviewText(t, post);
  const previewKind = forumPreviewKind(post);
  const isUnread = unread.kind !== "read";
  const newReplies = unread.kind === "unread" ? unread.count : 0;
  const replies = t("forum.replies", { count: post.replyCount });
  const time = formatRelativeShort(post.lastActivityAt, locale);
  const srName = postSrName(t, locale, post, unread);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modified click is the browser's: a new tab, a new window.
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    onOpen(post.id);
  }

  // The whole surface is the hit target: the title link is stretched over it.
  const titleLink = (className: string) => (
    <a
      ref={(node) => registerLink?.(post.id, node)}
      href={href}
      tabIndex={tabIndex}
      aria-label={srName}
      aria-current={open ? "true" : undefined}
      onClick={handleClick}
      onDoubleClick={(event) => {
        if (onOpenFull) {
          event.preventDefault();
          onOpenFull(post.id);
        }
      }}
      onFocus={() => onFocus(post.id)}
      onKeyDown={(event) => onKeyDown?.(event, post.id)}
      className={cn(
        "min-w-0 rounded-[var(--radius-control)] outline-none after:absolute after:inset-0 after:rounded-[inherit] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-focus-ring",
        className,
        // The title is the line people scan: heavier than everything else on
        // the card read or not, and unread heavier still.
        isUnread ? "font-bold text-text" : "font-semibold text-text-secondary",
      )}
    >
      {post.title}
    </a>
  );

  const avatar = (size: string) =>
    post.authorIsWebhook ? (
      <span
        aria-hidden
        className={cn(
          "grid shrink-0 place-items-center rounded-[var(--radius-tick)] bg-accent-soft text-on-accent-soft",
          size,
        )}
      >
        <Rss className="h-3 w-3" />
      </span>
    ) : (
      <UserAvatar
        name={author}
        avatarUrl={post.authorAvatarUrl}
        rounded="full"
        className={size}
        fallbackClassName={TINY_AVATAR_FALLBACK}
      />
    );

  const reaction =
    post.topReaction && post.reactionCount > 0 ? (
      <span
        className="inline-flex items-center gap-1 tabular-nums"
        title={t("forum.reactions", { count: post.reactionCount })}
      >
        <span aria-hidden>{post.topReaction.emoji}</span>
        {post.reactionCount}
      </span>
    ) : null;

  const shell = cn(
    "group/card relative transition-[background-color,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] motion-reduce:transition-none",
    entering && "animate-door-reveal",
    leaving && "pointer-events-none animate-pop-out",
  );

  // ------------------------------------------------------------------ row
  if (variant === "row") {
    return (
      <article
        data-forum-post={post.id}
        data-unread={unread.kind}
        data-forum-variant="row"
        className={cn(
          shell,
          "flex min-h-16 items-center gap-3 rounded-[var(--radius-card)] px-3 py-2.5 hover:bg-surface-1",
          open && "bg-surface-2 hover:bg-surface-2",
          // A list row: the row roles, the selected fill says which is open.
          "redesign:hover:bg-[color:var(--list-row-hover)]",
          open && "redesign:bg-[color:var(--list-row-selected)] redesign:hover:bg-[color:var(--list-row-selected)]",
        )}
      >
        {open && (
          <span aria-hidden className="absolute inset-y-3 left-0 w-[3px] rounded-r-full bg-text redesign:hidden" />
        )}
        <span className="grid w-4 shrink-0 place-items-center text-text-secondary">
          {isUnread ? (
            <UnreadDot />
          ) : post.lockedAt ? (
            <Lock className="h-3.5 w-3.5" aria-hidden />
          ) : null}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center">
            {titleLink("forum-display block truncate text-[15px] font-semibold leading-5")}
          </div>
          <p className="mt-0.5 flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs leading-4 text-text-secondary">
            <span className="truncate font-semibold text-text">{author}</span>
            <span aria-hidden>·</span>
            <time dateTime={post.lastActivityAt} className="shrink-0 tabular-nums">
              {time}
            </time>
            {post.tagIds.length > 0 && (
              <>
                <span aria-hidden>·</span>
                <RowTagNames tagIds={post.tagIds} tagsById={tagsById} />
              </>
            )}
            {newReplies > 0 && (
              <>
                <span aria-hidden>·</span>
                <span className="shrink-0 font-semibold text-text">
                  {t("forum.newReplies", { count: newReplies })}
                </span>
              </>
            )}
          </p>
        </div>
        <span className="flex shrink-0 items-center gap-3 text-xs font-semibold tabular-nums text-text-secondary">
          <StatusMarks post={post} iconsOnly />
          {!narrow && reaction}
          {post.replyCount > 0 && (
            <span className="inline-flex items-center gap-1">
              <MessageSquare className="h-3.5 w-3.5" aria-hidden />
              {post.replyCount}
            </span>
          )}
        </span>
        {!narrow && hasMedia(post) && <Thumbnail post={post} fit="box" className="h-11 w-11" />}
      </article>
    );
  }

  // ----------------------------------------------------------------- tile
  if (variant === "tile") {
    return (
      <article
        data-forum-post={post.id}
        data-unread={unread.kind}
        data-forum-variant="tile"
        className={cn(shell, "flex flex-col rounded-[var(--radius-panel)] p-2 hover:bg-surface-1", open && "bg-surface-2", FORUM_CARD_REDESIGN, open && FORUM_CARD_OPEN_REDESIGN)}
      >
        {hasMedia(post) ? (
          <Thumbnail post={post} fit="tile" className="aspect-[4/3] w-full" />
        ) : (
          <span
            aria-hidden
            className="block aspect-[4/3] w-full overflow-hidden rounded-[var(--radius-card)] bg-surface-1 p-4 text-sm leading-5 text-text-secondary"
          >
            <span className="line-clamp-6">{preview}</span>
          </span>
        )}
        <div className="px-1 pb-1 pt-2.5">
          <div className="flex min-w-0 items-center gap-2">
            {isUnread && <UnreadDot />}
            {titleLink("forum-display block truncate text-[15px] font-semibold leading-5")}
          </div>
          <div className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            <ForumTagList tagIds={post.tagIds.slice(0, 1)} tagsById={tagsById} max={1} size="sm" />
            <StatusMarks post={post} />
          </div>
          <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-text-secondary">
            {avatar("h-[18px] w-[18px]")}
            <span className="truncate">{author}</span>
            <span className="ml-auto flex shrink-0 items-center gap-2.5 font-semibold tabular-nums">
              {reaction}
              <span className="inline-flex items-center gap-1">
                <MessageSquare className="h-3.5 w-3.5" aria-hidden />
                {post.replyCount}
              </span>
            </span>
          </div>
        </div>
      </article>
    );
  }

  // ----------------------------------------------------------------- card
  return (
    <article
      data-forum-post={post.id}
      data-unread={unread.kind}
      data-forum-variant="card"
      className={cn(
        shell,
        "rounded-[var(--radius-panel)] px-4 pb-2.5 pt-4 hover:bg-surface-1",
        open && "bg-surface-2 hover:bg-surface-2",
        FORUM_CARD_REDESIGN,
        open && FORUM_CARD_OPEN_REDESIGN,
      )}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px] leading-[18px] text-text-secondary">
        {avatar("h-5 w-5")}
        <span className="truncate font-semibold text-text">{author}</span>
        {post.authorIsWebhook && (
          <span className={cn("shrink-0 rounded-[var(--radius-tick)] bg-accent-soft px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide text-on-accent-soft", badgeRedesignClasses("new", "tag"))}>
            {t("forum.badge.feed")}
          </span>
        )}
        <span aria-hidden>·</span>
        <time
          dateTime={post.lastActivityAt}
          title={new Date(post.lastActivityAt).toLocaleString(locale)}
          className="shrink-0 tabular-nums"
        >
          {time}
        </time>
        <span className="ml-auto flex shrink-0 items-center gap-3 text-xs">
          <StatusMarks post={post} iconsOnly={narrow} />
        </span>
      </div>
      <h3 className="mt-2 flex min-w-0 items-baseline gap-2">
        {isUnread && <UnreadDot className="-translate-y-0.5" />}
        {titleLink(
          cn(
            "forum-display text-pretty text-lg font-semibold leading-6 [overflow-wrap:anywhere]",
            narrow ? "line-clamp-3" : "line-clamp-2",
          ),
        )}
      </h3>
      {preview && !(previewKind && hasMedia(post)) && (
        <p
          className={cn(
            "mt-1 line-clamp-2 text-sm leading-5 text-text-secondary",
            post.openingDeleted && "italic",
          )}
        >
          {previewKind === "image" && (
            <ImageIcon aria-hidden="true" data-forum-preview-icon="image" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          )}
          {previewKind === "video" && (
            <Video aria-hidden="true" data-forum-preview-icon="video" className="mr-1 inline h-3.5 w-3.5 align-[-2px]" />
          )}
          {preview}
        </p>
      )}
      {hasMedia(post) && <Thumbnail post={post} fit="media" className="mt-3" />}
      {post.tagIds.length > 0 && (
        <div className="mt-2.5">
          <ForumTagList
            tagIds={post.tagIds}
            tagsById={tagsById}
            max={narrow ? 2 : MAX_TAGS_CARD}
          />
        </div>
      )}
      <div className="-ml-2.5 mt-2 flex min-w-0 items-center gap-1 text-[13px] font-semibold tabular-nums text-text-secondary">
        {reaction && <span className="inline-flex h-8 items-center px-2.5">{reaction}</span>}
        <span className="inline-flex h-8 min-w-0 items-center gap-1.5 px-2.5">
          <MessageSquare className="h-4 w-4 shrink-0" aria-hidden />
          <span className="truncate">
            {post.replyCount === 0 && !post.lockedAt && !(viewerId && post.authorId === viewerId)
              ? t("forum.card.noReplies")
              : replies}
          </span>
          {newReplies > 0 && (
            <span className="shrink-0 text-text">
              · {t("forum.newReplies", { count: newReplies })}
            </span>
          )}
        </span>
        {onCopyLink && (
          <Tooltip label={t("forum.post.copyLink")}>
            <button
              type="button"
              // Out of the tab order: the list keeps one tab stop with arrows
              // inside it, and Copy link is in the post's own menu.
              tabIndex={-1}
              aria-label={t("forum.post.copyLink")}
              onClick={(event) => {
                event.stopPropagation();
                onCopyLink(post.id);
              }}
              className="relative z-10 ml-auto grid h-8 w-8 shrink-0 place-items-center rounded-full text-text-secondary opacity-60 transition-[opacity,background-color,color] duration-[var(--duration-fast)] hover:bg-surface-2 hover:text-text hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring group-hover/card:opacity-100 max-sm:hidden"
            >
              <Link2 className="h-4 w-4" aria-hidden />
            </button>
          </Tooltip>
        )}
      </div>
    </article>
  );
});

/** A row's tags as plain words: the row has no room for chips. */
function RowTagNames({
  tagIds,
  tagsById,
}: {
  tagIds: readonly string[];
  tagsById: ReadonlyMap<string, ForumTag>;
}) {
  const tagLabel = useForumTagLabel();
  const names = tagIds
    .map((tagId) => tagsById.get(tagId))
    .filter((tag): tag is ForumTag => Boolean(tag))
    .slice(0, MAX_TAGS_ROW)
    .map((tag) => tagLabel(tag));
  const more = tagIds.length - names.length;
  return (
    <span className="truncate">
      {names.join(", ")}
      {more > 0 ? ` +${more}` : ""}
    </span>
  );
}

/**
 * A pinned post as a small tile in the strip above the list: "Fixado", the
 * title on two lines, and the unread dot. Three tiles fit a row; a phone
 * scrolls them sideways (the full cards used to fill a phone's first screen,
 * forum QA P15).
 */
export const ForumPinnedTile = memo(function ForumPinnedTile({
  post,
  unread,
  href,
  open = false,
  tabIndex,
  onOpen,
  onFocus,
  onKeyDown,
  registerLink,
}: Pick<
  ForumPostCardProps,
  "post" | "unread" | "href" | "open" | "tabIndex" | "onOpen" | "onFocus" | "onKeyDown" | "registerLink"
>) {
  const { t, locale } = useTranslation();
  const isUnread = unread.kind !== "read";
  const srName = postSrName(t, locale, post, unread);
  return (
    <article
      data-forum-post={post.id}
      data-unread={unread.kind}
      data-forum-pinned-row=""
      className={cn(
        "group/card relative flex min-h-[76px] flex-col rounded-[var(--radius-card)] bg-surface-1 px-3.5 py-3 transition-colors duration-[var(--duration-fast)] hover:bg-surface-2",
        open && "bg-surface-2",
        FORUM_CARD_REDESIGN,
        open && FORUM_CARD_OPEN_REDESIGN,
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-text-secondary">
        <Pin className="h-3.5 w-3.5" aria-hidden />
        {t("forum.badge.pinned")}
        {post.lockedAt && (
          <Lock className="h-3.5 w-3.5" role="img" aria-label={t("forum.badge.locked")} />
        )}
        {post.resolvedAt && (
          <CheckCircle2 className="h-3.5 w-3.5 text-success" role="img" aria-label={t("forum.badge.resolved")} />
        )}
        {isUnread && <UnreadDot className="ml-auto" />}
      </span>
      <a
        ref={(node) => registerLink?.(post.id, node)}
        href={href}
        tabIndex={tabIndex}
        aria-label={srName}
        aria-current={open ? "true" : undefined}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
            return;
          }
          event.preventDefault();
          onOpen(post.id);
        }}
        onFocus={() => onFocus(post.id)}
        onKeyDown={(event) => onKeyDown?.(event, post.id)}
        className={cn(
          "forum-display mt-1.5 line-clamp-2 text-sm font-semibold leading-[19px] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-card)] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-focus-ring",
          isUnread ? "font-bold text-text" : "font-semibold text-text-secondary",
        )}
      >
        {post.title}
      </a>
    </article>
  );
});
