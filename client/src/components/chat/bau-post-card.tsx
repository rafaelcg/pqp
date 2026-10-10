import type { BauPostLink, CommunityHomePostCard } from "@pqp/shared";
import { Archive, ArrowRight, Heart, Lock, MessageCircle, Pin, Play } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type MouseEvent } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { Skeleton } from "@/components/ui/skeleton";
import { UserAvatar } from "@/components/user/user-avatar";
import { homeRoutePath, messageLinkState } from "@/lib/app-route";
import type { BauCardState } from "@/lib/community-home/share-card";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A Baú post pasted into chat, drawn as a card: the poster, a play badge for
 * anything that plays, the title, a two-line teaser, who wrote it, and a
 * button that opens the post inside the Baú.
 *
 * The data is the server's `…/card` answer, which runs the feed's own
 * authorization. A reader who may not see the post gets `unavailable` and the
 * caller keeps showing the plain link, so a card is never a way to learn that a
 * post exists.
 */

const PLAYABLE = new Set(["video", "youtube", "twitch", "tiktok", "instagram"]);

/** Pure: does this card have something to put in the poster slot. */
export function posterKind(
  card: Pick<CommunityHomePostCard, "mediaKind" | "mediaUrl">,
): "image" | "video" | "frame" | null {
  if (card.mediaKind === "video" && card.mediaUrl) {
    return "video";
  }
  if (card.mediaUrl && (card.mediaKind === "image" || card.mediaKind === "youtube")) {
    return "image";
  }
  // Twitch, TikTok, Instagram: no picture we may fetch, but the lime plate
  // with a play badge still tells the reader it is a video.
  if (card.mediaKind && PLAYABLE.has(card.mediaKind)) {
    return "frame";
  }
  return null;
}

/**
 * True once the element has come within a screenful of the viewport (and
 * stays true). A channel with several shared videos must not open a media
 * request per card on load: the first frame is fetched when the card is near.
 * Without IntersectionObserver (old webview, test DOM) it is simply true.
 */
function useNearViewport<T extends Element>() {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(
    () => typeof IntersectionObserver === "undefined",
  );
  useEffect(() => {
    const node = ref.current;
    if (near || !node) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setNear(true);
          observer.disconnect();
        }
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [near]);
  return [ref, near] as const;
}

export function BauPostCardView({
  card,
  href,
  onOpen,
}: {
  card: CommunityHomePostCard;
  href: string;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { t } = useTranslation();
  const poster = posterKind(card);
  const [posterRef, near] = useNearViewport<HTMLDivElement>();
  const playable = card.mediaKind !== null && PLAYABLE.has(card.mediaKind);
  const title = card.title?.trim() || t("bauCard.untitled");
  return (
    <a
      href={href}
      onClick={onOpen}
      aria-label={t("bauCard.ariaLabel", { title })}
      data-bau-card=""
      data-bau-card-media={poster ?? "none"}
      className={cn(
        "group/bau mt-1.5 block w-full max-w-[26rem] overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1 text-left no-underline shadow-[0_1px_0_var(--glow-accent-soft)] transition-[border-color,transform] duration-[var(--duration-fast)] hover:border-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
      )}
    >
      <div
        ref={posterRef}
        className={cn(
          "relative overflow-hidden bg-surface-2",
          poster ? "aspect-video" : "h-16",
        )}
      >
        {poster === "image" && card.mediaUrl && near && (
          <img
            src={card.mediaUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className={cn(
              "h-full w-full object-cover transition-transform duration-[var(--duration-slow)] group-hover/bau:scale-[1.03]",
              card.locked && "scale-105 blur-sm",
            )}
          />
        )}
        {poster === "video" && card.mediaUrl && near && (
          <video
            // `#t=0.001` makes iOS Safari paint the first frame without play.
            src={`${card.mediaUrl}#t=0.001`}
            preload="metadata"
            muted
            playsInline
            aria-hidden
            tabIndex={-1}
            className="pointer-events-none h-full w-full object-cover"
          />
        )}
        {/* The brand wash: lime glow top-left on every card, so a text-only
            post and a photo read as the same family. */}
        <div
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0",
            poster
              ? "bg-gradient-to-t from-surface-0/85 via-surface-0/10 to-transparent"
              : "bg-[linear-gradient(120deg,var(--color-accent-soft),transparent_75%),radial-gradient(90%_160%_at_0%_0%,var(--glow-accent),transparent_65%)]",
          )}
        />
        <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider text-on-accent shadow-sm">
          <Archive className="h-3 w-3" aria-hidden />
          {t("communityHome.title")}
        </span>
        {card.pinned && (
          <span className="absolute right-2.5 top-2.5 inline-flex items-center gap-1 rounded-full bg-surface-0/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text backdrop-blur-sm">
            <Pin className="h-3 w-3" aria-hidden />
            {t("communityHome.pinned")}
          </span>
        )}
        {playable && poster && !card.locked && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span
              className="flex h-12 w-12 items-center justify-center rounded-full bg-accent text-on-accent shadow-[0_8px_30px_var(--glow-accent)] transition-transform duration-[var(--duration-fast)] group-hover/bau:scale-110"
              data-bau-card-play=""
            >
              <Play className="h-5 w-5 translate-x-px fill-current" aria-hidden />
              <span className="sr-only">{t("bauCard.video")}</span>
            </span>
          </span>
        )}
        {card.locked && (
          <span className="absolute bottom-2.5 right-2.5 inline-flex items-center gap-1 rounded-full bg-surface-0/75 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text backdrop-blur-sm">
            <Lock className="h-3 w-3" aria-hidden />
            {t("communityHome.lockedBadge")}
          </span>
        )}
      </div>

      <div className="space-y-2 p-3">
        <p className="line-clamp-2 break-words font-display text-base font-bold leading-snug text-text">
          {title}
        </p>
        {card.teaser && (
          <p className="line-clamp-2 break-words text-sm leading-snug text-text-secondary">
            {card.teaser}
          </p>
        )}
        <div className="flex items-center gap-2 text-xs text-text-tertiary">
          {card.author ? (
            <>
              <UserAvatar
                name={card.author.displayName}
                avatarUrl={card.author.avatarUrl}
                className="h-5 w-5"
                rounded="full"
                fallbackClassName="bg-surface-3 text-[10px] text-text"
              />
              <span className="min-w-0 truncate">
                <span className="font-medium text-text-secondary">
                  {card.author.displayName}
                </span>
                {" · "}
                {t("bauCard.inBau")}
              </span>
            </>
          ) : (
            <span className="min-w-0 truncate">
              <span className="font-medium text-text-secondary">
                {card.serverName}
              </span>
              {" · "}
              {t("bauCard.inBau")}
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-2.5">
            {card.likeCount > 0 && (
              <span
                className="inline-flex items-center gap-1"
                aria-label={t("bauCard.likes", { count: card.likeCount })}
              >
                <Heart className="h-3 w-3" aria-hidden />
                {card.likeCount}
              </span>
            )}
            {card.commentCount > 0 && (
              <span
                className="inline-flex items-center gap-1"
                aria-label={t("bauCard.comments", { count: card.commentCount })}
              >
                <MessageCircle className="h-3 w-3" aria-hidden />
                {card.commentCount}
              </span>
            )}
          </span>
        </div>
        <span
          className="flex h-[var(--control-md)] w-full items-center justify-center gap-2 rounded-[var(--radius-control)] bg-accent px-4 text-sm font-semibold text-on-accent transition-colors duration-[var(--duration-fast)] group-hover/bau:bg-accent-hover"
          data-bau-card-cta=""
        >
          {t("bauCard.cta")}
          <ArrowRight
            className="h-4 w-4 transition-transform duration-[var(--duration-fast)] group-hover/bau:translate-x-0.5"
            aria-hidden
          />
        </span>
      </div>
    </a>
  );
}

export function BauPostCardSkeleton() {
  return (
    <div
      className="mt-1.5 w-full max-w-[26rem] overflow-hidden rounded-[var(--radius-card)] border border-border bg-surface-1"
      aria-hidden
      data-bau-card-skeleton=""
    >
      <Skeleton className="aspect-video w-full rounded-none" />
      <div className="space-y-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-[var(--control-md)] w-full" />
      </div>
    </div>
  );
}

function NavigatingCard({ card, link }: { card: CommunityHomePostCard; link: BauPostLink }) {
  const navigate = useNavigate();
  const onOpen = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Let the browser keep its own new-tab and copy-link gestures.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      navigate(homeRoutePath(link.serverId, link.postId), {
        state: messageLinkState(),
      });
    },
    [link.postId, link.serverId, navigate],
  );
  return <BauPostCardView card={card} href={link.url} onOpen={onOpen} />;
}

/**
 * The card for a resolved state. The row owns the state (it needs it to decide
 * whether the bare link is still worth showing) and hands it down.
 */
export function BauPostCard({
  link,
  state,
}: {
  link: BauPostLink;
  state: BauCardState;
}) {
  const inRouter = useInRouterContext();
  if (state.status === "loading") {
    return <BauPostCardSkeleton />;
  }
  if (state.status !== "ok") {
    return null;
  }
  return inRouter ? (
    <NavigatingCard card={state.card} link={link} />
  ) : (
    <BauPostCardView card={state.card} href={link.url} onOpen={() => undefined} />
  );
}
