import {
  FORUM_PREVIEW_MAX,
  type ForumPostSummary,
  type ForumTag,
} from "@pqp/shared";
import {
  CheckCircle2,
  Lock,
  MessageSquare,
  Pin,
  Play,
  Rss,
  ShieldCheck,
} from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { UserAvatar } from "@/components/user/user-avatar";
import { ForumTagIcon } from "@/components/forum/forum-tag-icon";
import type { ForumUnreadState } from "@/lib/forum-list";
import { useForumTagLabel } from "@/lib/forum-tag-icons";
import { useTranslation, type Translator } from "@/lib/i18n";
import { cn, formatRelativeShort } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";

/**
 * One post in the list (UX §2.3). Three lines: status badges and the title;
 * who wrote it and how the opening message starts; tags on the left and the
 * numbers on the right. A thumbnail when the opening message carries an image.
 *
 * The whole card is the hit target: the title is a real link stretched over
 * the card, so middle-click and copy-link do what a link does, and the list
 * keeps ONE tab stop with arrows inside it (the link's `tabIndex` is the
 * roving one, owned by the list).
 *
 * `compact` is the list beside an open post: no preview line, a smaller
 * thumbnail, status as icons, because two full columns do not fit at 1280.
 */

export interface ForumPostCardProps {
  post: ForumPostSummary;
  unread: ForumUnreadState;
  tagsById: ReadonlyMap<string, ForumTag>;
  href: string;
  compact?: boolean;
  /** This is the post open beside the list: the accent bar on the edge. */
  open?: boolean;
  /**
   * A phone: the badges get their own line above a two-line title, and the
   * tag row keeps fewer chips so the numbers on the right never squeeze them.
   */
  narrow?: boolean;
  /** Under "Fixados": the title and tags, nothing else. */
  pinnedRow?: boolean;
  /** Arrived live while the list was on screen: slides in. */
  entering?: boolean;
  /** Removed live: fades out before it leaves the list. */
  leaving?: boolean;
  tabIndex: 0 | -1;
  onOpen: (postId: string) => void;
  /**
   * Double click: the post takes the whole content area for this visit,
   * without changing the remembered split/maximized choice. A single click
   * keeps opening it beside the list.
   */
  onOpenFull?: (postId: string) => void;
  onFocus: (postId: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLAnchorElement>, postId: string) => void;
  registerLink?: (postId: string, node: HTMLAnchorElement | null) => void;
}

const MAX_TAGS_FULL = 3;
const MAX_TAGS_COMPACT = 2;
/**
 * The 16px avatar's monogram sits on a disc of its own. Without one it was a
 * bare letter beside the name, a stray "D" before "Dev User" (forum QA P14).
 */
const TINY_AVATAR_FALLBACK = "bg-surface-3 text-[9px] leading-none text-text-secondary";

function TagChip({ tag }: { tag: ForumTag }) {
  const tagLabel = useForumTagLabel();
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-[10rem] shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 text-[11px] text-text-secondary transition-colors duration-[var(--duration-fast)] group-hover/card:bg-surface-3",
        tag.moderated && "ring-1 ring-inset ring-border-strong",
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
}: {
  tagIds: readonly string[];
  tagsById: ReadonlyMap<string, ForumTag>;
  max: number;
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
    <span className="flex min-w-0 items-center gap-1 overflow-hidden">
      {shown.map((tag) => (
        <TagChip key={tag.id} tag={tag} />
      ))}
      {hidden > 0 && (
        <span
          className="inline-flex h-5 shrink-0 items-center rounded-full bg-surface-2 px-2 text-[11px] tabular-nums text-text-tertiary"
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

function Thumbnail({
  post,
  className,
}: {
  post: ForumPostSummary;
  className: string;
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
    if (
      !videoUrl ||
      near ||
      !node ||
      typeof IntersectionObserver === "undefined"
    ) {
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
  return (
    <span
      ref={boxRef}
      className={cn(
        "relative shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-2",
        className,
      )}
    >
      {post.thumbnailUrl ? (
        <img
          src={post.thumbnailUrl}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
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
              className="pointer-events-none h-full w-full object-cover"
            />
          )}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 grid place-items-center"
          >
            <span className="grid h-6 w-6 place-items-center rounded-full bg-black/55 text-white">
              <Play className="h-3 w-3 translate-x-px fill-current" />
            </span>
          </span>
        </>
      )}
      {/* The hairline sits ON the image, so a dark screenshot does not melt
          into the card behind it. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-[var(--radius-control)] ring-1 ring-inset ring-border"
      />
    </span>
  );
}

export const ForumPostCard = memo(function ForumPostCard({
  post,
  unread,
  tagsById,
  href,
  compact = false,
  open = false,
  pinnedRow = false,
  narrow = false,
  entering = false,
  leaving = false,
  tabIndex,
  onOpen,
  onOpenFull,
  onFocus,
  onKeyDown,
  registerLink,
}: ForumPostCardProps) {
  const { t, locale } = useTranslation();
  const author = forumAuthorName(t, post);
  const preview = forumPreviewText(t, post);
  const isUnread = unread.kind !== "read";
  const replies = t("forum.replies", { count: post.replyCount });
  const time = formatRelativeShort(post.lastActivityAt, locale);
  const srName = [
    t("forum.card.sr", {
      title: post.title,
      status: statusWord(t, post),
      author,
      replies,
      time,
    }),
    unread.kind === "new"
      ? t("forum.card.srNew")
      : unread.kind === "unread" && unread.count > 0
        ? t("forum.card.srUnread", { count: unread.count })
        : null,
  ]
    .filter(Boolean)
    .join(", ");

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    // A modified click is the browser's: a new tab, a new window.
    if (
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.button !== 0
    ) {
      return;
    }
    event.preventDefault();
    onOpen(post.id);
  }

  // The whole card is the hit target: the title link is stretched over it.
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
        "min-w-0 truncate rounded-[var(--radius-control)] outline-none after:absolute after:inset-0 after:rounded-[var(--radius-card)] after:content-[''] focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-focus-ring",
        className,
        // The title is the line people scan: heavier than everything
        // else on the card read or not, and unread heavier still.
        isUnread ? "font-bold text-text" : "font-semibold text-text-secondary",
      )}
    >
      {post.title}
    </a>
  );

  const pip = isUnread ? (
    <span
      aria-hidden
      className="absolute left-0 top-1/2 h-[18px] w-1 -translate-y-1/2 rounded-r-full bg-text"
    />
  ) : null;

  // A phone's pinned post is one line: the pin, the title, its status as
  // glyphs. Three full cards used to fill the first screen before the reader
  // reached anything new (forum QA P15); the apps already draw it this way.
  if (pinnedRow && narrow) {
    return (
      <article
        data-forum-post={post.id}
        data-unread={unread.kind}
        data-forum-pinned-row=""
        className={cn(
          "group/card relative flex min-h-12 items-center gap-3 overflow-hidden rounded-[var(--radius-card)] border bg-surface-1 py-2 pl-2.5 pr-3.5 transition-[background-color,border-color,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:border-border-strong hover:bg-surface-2",
          open ? "border-border-strong bg-surface-2" : "border-border",
          entering && "animate-door-reveal",
          leaving && "pointer-events-none animate-pop-out",
        )}
      >
        {pip}
        <span
          aria-hidden
          className="grid h-7 w-7 shrink-0 place-items-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft"
        >
          <Pin className="h-3.5 w-3.5" />
        </span>
        {titleLink("flex-1 text-[15px] leading-5")}
        {unread.kind === "new" && <Badge variant="new">{t("forum.badge.new")}</Badge>}
        {post.lockedAt && (
          <Lock
            className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
            role="img"
            aria-label={t("forum.badge.locked")}
          />
        )}
        {post.resolvedAt && (
          <CheckCircle2
            className="h-3.5 w-3.5 shrink-0 text-success"
            role="img"
            aria-label={t("forum.badge.resolved")}
          />
        )}
      </article>
    );
  }

  const badges = (
    <>
      {unread.kind === "new" && !compact && (
        <Badge variant="new">{t("forum.badge.new")}</Badge>
      )}
      {post.pinnedAt && !compact && (
        <Badge variant="accent" icon={Pin}>
          {t("forum.badge.pinned")}
        </Badge>
      )}
      {post.lockedAt && !compact && (
        <Badge variant="neutral" icon={Lock}>
          {t("forum.badge.locked")}
        </Badge>
      )}
      {post.resolvedAt && !compact && (
        <Badge variant="success" icon={CheckCircle2}>
          {t("forum.badge.resolved")}
        </Badge>
      )}
      {compact && unread.kind === "new" && (
        <Badge variant="new">{t("forum.badge.new")}</Badge>
      )}
      {/* Compact: status as a glyph, never truncated, still named. */}
      {compact && post.pinnedAt && (
        <Pin
          className="h-3.5 w-3.5 shrink-0 text-on-accent-soft"
          role="img"
          aria-label={t("forum.badge.pinned")}
        />
      )}
      {compact && post.lockedAt && (
        <Lock
          className="h-3.5 w-3.5 shrink-0 text-text-tertiary"
          role="img"
          aria-label={t("forum.badge.locked")}
        />
      )}
      {compact && post.resolvedAt && (
        <CheckCircle2
          className="h-3.5 w-3.5 shrink-0 text-success"
          role="img"
          aria-label={t("forum.badge.resolved")}
        />
      )}
    </>
  );

  const counts = (
    <span className="ml-auto flex shrink-0 items-center gap-2.5 text-xs tabular-nums text-text-tertiary">
      {post.topReaction && !pinnedRow && (
        <span
          className="inline-flex items-center gap-0.5"
          title={t("forum.reactions", { count: post.reactionCount })}
        >
          <span aria-hidden>{post.topReaction.emoji}</span>
          {post.reactionCount}
        </span>
      )}
      {post.replyCount === 0 ? (
        !pinnedRow &&
        !compact &&
        !narrow && <span>{t("forum.replies", { count: 0 })}</span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          {post.replyCount}
          {unread.kind === "unread" && unread.count > 0 && (
            <span className="font-semibold text-accent">
              {t("forum.newReplies", { count: unread.count })}
            </span>
          )}
        </span>
      )}
      <time
        dateTime={post.lastActivityAt}
        title={new Date(post.lastActivityAt).toLocaleString(locale)}
      >
        {time}
      </time>
    </span>
  );

  return (
    <article
      data-forum-post={post.id}
      data-unread={unread.kind}
      className={cn(
        "group/card relative flex gap-3 overflow-hidden rounded-[var(--radius-card)] border bg-surface-1 transition-[background-color,border-color,opacity,transform] duration-[var(--duration-fast)] ease-[var(--ease-standard)] hover:border-border-strong hover:bg-surface-2",
        compact ? "px-3 py-2.5" : pinnedRow ? "px-3.5 py-2.5" : "px-3.5 py-3",
        open ? "border-border-strong bg-surface-2" : "border-border",
        entering && "animate-door-reveal",
        leaving && "pointer-events-none animate-pop-out",
      )}
    >
      {/* The unread pip, the same shape the sidebar uses. */}
      {pip}
      {open && (
        <span
          aria-hidden
          className="absolute inset-y-0 right-0 w-[3px] bg-accent"
        />
      )}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            "flex min-w-0 items-center gap-1.5",
            narrow && "flex-wrap gap-y-1",
          )}
        >
          {badges}
          {titleLink(
            narrow && !compact
              ? "basis-full whitespace-normal text-base leading-snug line-clamp-2"
              : compact || pinnedRow
                ? "text-[15px] leading-5"
                : "text-base leading-6",
          )}
        </div>
        {!pinnedRow && preview && (
          <p
            className={cn(
              "text-[13px] leading-[18px] text-text-tertiary",
              // Two lines on a full card, one beside an open post.
              compact ? "mt-0.5 line-clamp-1" : "mt-1 line-clamp-2",
            )}
          >
            {post.authorIsWebhook && (
              <UserAvatar
                name={author}
                avatarUrl={post.authorAvatarUrl}
                rounded="full"
                className="mr-1 inline-flex h-4 w-4 align-middle"
                fallbackClassName={TINY_AVATAR_FALLBACK}
              />
            )}
            <span className="font-semibold text-text-secondary">{author}:</span>{" "}
            <span className={cn(post.openingDeleted && "italic")}>
              {preview}
            </span>
          </p>
        )}
        <div
          className={cn(
            "flex min-w-0 items-center justify-between gap-3",
            // A phone wraps the numbers under the tags rather than squeezing
            // the tags to nothing.
            narrow && "flex-wrap gap-y-1.5",
            compact || pinnedRow ? "mt-1" : "mt-2",
          )}
        >
          <span
            className={cn(
              "flex items-center gap-1.5",
              narrow ? "max-w-full shrink-0" : "min-w-0",
            )}
          >
            {post.authorIsWebhook && (
              <Badge variant="accent" icon={Rss}>
                {t("forum.badge.feed")}
              </Badge>
            )}
            <ForumTagList
              tagIds={post.tagIds}
              tagsById={tagsById}
              max={compact ? MAX_TAGS_COMPACT : narrow ? 1 : MAX_TAGS_FULL}
            />
            {pinnedRow && (
              <span className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-text-tertiary">
                {post.authorIsWebhook ? (
                  <ShieldCheck className="h-3 w-3" aria-hidden />
                ) : (
                  <UserAvatar
                    name={author}
                    avatarUrl={post.authorAvatarUrl}
                    rounded="full"
                    className="h-4 w-4"
                    fallbackClassName={TINY_AVATAR_FALLBACK}
                  />
                )}
                <span className="truncate">{author}</span>
              </span>
            )}
          </span>
          {counts}
        </div>
      </div>
      <Thumbnail
        post={post}
        className={
          compact || pinnedRow
            ? "h-11 w-11"
            : "h-14 w-14 sm:h-[72px] sm:w-[72px]"
        }
      />
    </article>
  );
});
