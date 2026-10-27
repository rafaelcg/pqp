import { Archive, Heart, MessageCircle, PenLine, Play } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import {
  Archive as ArchiveFill,
  ChatCircle,
  Heart as HeartFill,
  PencilSimple,
  Play as PlayFill,
} from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { CountBadge } from "@/components/ui/count-badge";
import { Icon, IconSwap } from "@/components/ui/icon";
import { SECTION_LABEL_REDESIGN } from "@/components/ui/section-header";
import {
  SIDEBAR_CARD_REDESIGN,
  SIDEBAR_ROW_REDESIGN,
  SIDEBAR_ROW_SELECTED_REDESIGN,
} from "@/components/ui/sidebar-block";
import { UserAvatar } from "@/components/user/user-avatar";
import {
  bauPreviewMode,
  coverSource,
  isPlayable,
  leadPost,
  otherNewPosts,
  type LatestCard,
  type LatestPreview,
} from "@/lib/community-home/latest";
import { heroHue, heroTintStyle } from "@/lib/hero-tint";
import { useTranslation } from "@/lib/i18n";
import { cn, formatRelativeShort } from "@/lib/utils";

/**
 * The Baú in the channel list, once the server serves `…/home/latest`.
 *
 * While something is new it is a CARD: the newest new post's cover, title,
 * who posted and when, and a footer for the other new ones. Once the person
 * opens the Baú it folds into a slim ROW that keeps the last post's thumbnail.
 * With nothing posted, staff get an invite to post and everyone else a quiet
 * row. Same data and same rule as the phones (M2), so the three never
 * disagree about what is new.
 *
 * Card and row are both mounted and trade height (a `grid-template-rows`
 * 0fr/1fr transition) and opacity, so a new post opens the card smoothly and
 * opening the Baú folds it back. Reduced motion gets the end state at once.
 */

/** What `ChannelList` is handed to draw the preview instead of the plain row. */
export type CommunityHomePreviewProps = {
  latest: LatestPreview;
  /** May publish (Manage Server). */
  canPost: boolean;
  /** Open the Baú scrolled to this post. */
  onOpenPost: (postId: string) => void;
  /** Open the Baú with the composer up (staff, empty Baú). */
  onCompose: () => void;
};

const SWAP =
  "grid transition-[grid-template-rows,opacity] duration-[var(--duration-slow)] ease-[var(--ease-emphasized)] motion-reduce:transition-none";

export function CommunityHomePreview({
  latest,
  serverName,
  serverHueSeed,
  selected,
  canPost,
  face,
  onOpen,
  onOpenPost,
  onCompose,
}: {
  latest: LatestPreview;
  serverName: string;
  /** What the plate's colour is hashed from (the slug, else the name). */
  serverHueSeed: string;
  /** The Baú is the open page. */
  selected: boolean;
  /** May publish (Manage Server): an empty Baú invites them to. */
  canPost: boolean;
  /** The row's tile when there is no post to show (the server face). */
  face: ReactNode;
  onOpen: () => void;
  onOpenPost: (postId: string) => void;
  onCompose: () => void;
}) {
  const { t, locale } = useTranslation();
  // On the Baú itself the feed already shows staff its own empty guide, so the
  // sidebar does not repeat the invite there.
  const mode = bauPreviewMode(latest, canPost && !selected);
  const hue = heroHue(serverHueSeed);

  if (mode === "empty-staff") {
    return (
      <div
        data-community-home-row
        data-bau-preview="empty-staff"
        className="rounded-[var(--radius-card)] border border-dashed border-border-strong p-3 redesign:rounded-[var(--sidebar-card-radius)] redesign:border-[color:var(--sidebar-invite-border)]"
      >
        <button
          type="button"
          onClick={onOpen}
          aria-current={selected ? "page" : undefined}
          className="flex w-full items-center gap-2.5 rounded-[var(--radius-control)] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring redesign:focus-visible:ring-accent"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-accent-soft text-on-accent-soft redesign:rounded-[var(--rail-tile-radius-selected)]">
            <Archive className="h-4 w-4 redesign:hidden" aria-hidden />
            <Icon icon={ArchiveFill} size="sm" className="hidden redesign:block" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-bold text-text redesign:font-semibold">
              {t("communityHome.preview.emptyTitle")}
            </span>
            <span className="mt-0.5 block text-xs leading-snug text-text-secondary">
              {t("communityHome.preview.emptyBody")}
            </span>
          </span>
        </button>
        <Button
          size="sm"
          className="mt-2.5 rounded-full"
          onClick={onCompose}
          data-bau-preview-compose
        >
          <IconSwap off={PenLine} on={PencilSimple} offClassName="h-3.5 w-3.5" />
          {t("communityHome.preview.post")}
        </Button>
      </div>
    );
  }

  if (mode === "empty") {
    return (
      <SlimRow
        mode="empty"
        selected={selected}
        onClick={onOpen}
        tile={face}
        title={t("communityHome.channelName")}
        line={t("communityHome.preview.emptyMember")}
        quiet
      />
    );
  }

  const lead = leadPost(latest)!;
  const newest = latest.posts[0]!;
  const card = mode === "card";
  const others = otherNewPosts(latest, lead);
  const leadTitle = postTitle(lead, t);

  return (
    <div data-community-home-row data-bau-preview={mode} className="redesign:px-1">
      <div
        className={cn(SWAP, card ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}
        inert={!card}
        aria-hidden={!card}
        data-bau-preview-card-wrap
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className={cn(
              "overflow-hidden rounded-[var(--radius-card)] border bg-surface-0 transition-colors duration-[var(--duration-fast)]",
              selected ? "border-border-strong" : "border-border hover:border-border-strong",
              // The card tint, without the hover fill: the card holds two
              // buttons, and each lights its own text.
              SIDEBAR_CARD_REDESIGN,
              "redesign:hover:bg-[color:var(--card-bg)]",
              // The open Baú: the selection fill every sidebar row uses, as
              // the party you are watching does.
              selected &&
                "redesign:border-transparent redesign:bg-row-selected redesign:hover:border-transparent redesign:hover:bg-row-selected",
            )}
            data-bau-preview-card
          >
            <button
              type="button"
              onClick={onOpen}
              aria-current={selected ? "page" : undefined}
              className={cn(
                "flex w-full items-center gap-1.5 px-2.5 pb-2 pt-2.5 text-left text-xs font-bold text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring",
                // The section label's face, at the party cards' 12px inset.
                SECTION_LABEL_REDESIGN,
                "redesign:mb-0 redesign:px-3",
                selected && "redesign:text-on-row-selected redesign:hover:text-on-row-selected",
              )}
            >
              <Archive className="h-3.5 w-3.5 redesign:hidden" aria-hidden />
              <Icon icon={ArchiveFill} size="sm" className="hidden h-3.5 w-3.5 redesign:block" />
              {t("communityHome.channelName")}
              {latest.unread > 0 && (
                // The shared count pill; the classes before the redesign
                // ones are the 17px Baú pill it always drew.
                <CountBadge
                  count={latest.unread}
                  tone="accent"
                  data-community-home-unread
                  aria-label={t("communityHome.badge.unread", { count: latest.unread })}
                  className="h-[1.0625rem] min-w-[1.125rem] text-[10.5px]"
                />
              )}
              {/* Already open: the selection says it, so "Abrir" goes quiet. */}
              <span className={cn("ml-auto font-semibold text-text-tertiary", selected && "redesign:invisible")}>
                {t("communityHome.preview.open")}
              </span>
            </button>
            <button
              type="button"
              onClick={() => onOpenPost(lead.postId)}
              aria-label={t("communityHome.preview.cardLabel", { title: leadTitle })}
              className="group/bauprev block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring"
              data-bau-preview-post={lead.postId}
            >
              <div className="px-2 redesign:px-2.5">
                <Cover
                  card={lead}
                  hue={hue}
                  className="aspect-video w-full rounded-[var(--radius-control)]"
                  showPlay="corner"
                >
                  {lead.isNew && (
                    <span className="absolute left-2 top-2 rounded-[var(--radius-control)] bg-accent px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-on-accent">
                      {t("communityHome.badge.new")}
                    </span>
                  )}
                </Cover>
              </div>
              <div className="px-2.5 pb-2.5 pt-2 redesign:px-3">
                <p className="line-clamp-2 break-words text-[13.5px] font-bold leading-snug text-text redesign:text-sm redesign:font-semibold">
                  {leadTitle}
                </p>
                <div className="mt-1.5 flex items-center gap-1.5 text-xs text-text-secondary">
                  {lead.author ? (
                    <UserAvatar
                      name={lead.author.displayName}
                      avatarUrl={lead.author.avatarUrl}
                      className="h-[1.125rem] w-[1.125rem]"
                      rounded="full"
                      fallbackClassName="bg-surface-3 text-[9px] text-text"
                    />
                  ) : null}
                  <span className="min-w-0 truncate">
                    {lead.author?.displayName ?? serverName}
                    {lead.publishedAt ? ` · ${formatRelativeShort(lead.publishedAt, locale)}` : ""}
                  </span>
                  <span className="ml-auto flex shrink-0 items-center gap-2 font-semibold text-text-tertiary">
                    {lead.likeCount > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        aria-label={t("bauCard.likes", { count: lead.likeCount })}
                      >
                        <IconSwap off={Heart} on={HeartFill} offClassName="h-3 w-3" className="h-3 w-3" />
                        {lead.likeCount}
                      </span>
                    )}
                    {lead.commentCount > 0 && (
                      <span
                        className="inline-flex items-center gap-0.5"
                        aria-label={t("bauCard.comments", { count: lead.commentCount })}
                      >
                        <IconSwap off={MessageCircle} on={ChatCircle} offClassName="h-3 w-3" className="h-3 w-3" />
                        {lead.commentCount}
                      </span>
                    )}
                  </span>
                </div>
              </div>
            </button>
            {others.count > 0 && others.first && (
              <button
                type="button"
                onClick={() => onOpenPost(others.first!.postId)}
                className={cn(
                  "flex w-full items-center gap-2 border-t border-border px-2.5 py-2 redesign:px-3 text-left text-xs font-semibold text-text-secondary hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring redesign:border-[color:var(--card-border)] redesign:hover:bg-[color:var(--card-row-hover)] redesign:focus-visible:ring-accent",
                  // The open card keeps one fill: no lighter patch on hover.
                  selected && "redesign:hover:bg-transparent",
                )}
                data-bau-preview-more
              >
                <Cover
                  card={others.first}
                  hue={hue}
                  className="h-[1.375rem] w-[1.375rem] shrink-0 rounded-[0.3125rem]"
                />
                <span className="min-w-0 truncate">
                  {t("communityHome.preview.moreNew", {
                    count: others.count,
                    title: postTitle(others.first, t),
                  })}
                </span>
              </button>
            )}
          </div>
        </div>
      </div>
      <div
        className={cn(SWAP, card ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100")}
        inert={card}
        aria-hidden={card}
        data-bau-preview-row-wrap
      >
        <div className="min-h-0 overflow-hidden">
          <SlimRow
            mode="row"
            selected={selected}
            onClick={onOpen}
            ariaLabel={t("communityHome.preview.rowLabel", { title: postTitle(newest, t) })}
            tile={
              <Cover
                card={newest}
                hue={hue}
                className="h-[2.125rem] w-[2.125rem] shrink-0 rounded-[0.4375rem]"
                showPlay="center"
              />
            }
            title={t("communityHome.channelName")}
            line={t("communityHome.preview.last", { title: postTitle(newest, t) })}
            quiet
          />
        </div>
      </div>
    </div>
  );
}

function postTitle(
  card: Pick<LatestCard, "title" | "teaser">,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  return card.title?.trim() || card.teaser?.trim() || t("bauCard.untitled");
}

function SlimRow({
  mode,
  selected,
  onClick,
  tile,
  title,
  line,
  ariaLabel,
  quiet = false,
}: {
  mode: "row" | "empty";
  selected: boolean;
  onClick: () => void;
  tile: ReactNode;
  title: string;
  line: string;
  ariaLabel?: string;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      data-bau-preview-row={mode}
      {...(mode === "empty"
        ? { "data-community-home-row": "", "data-bau-preview": "empty" }
        : {})}
      aria-current={selected ? "page" : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-[var(--radius-control)] px-2 py-1.5 text-left transition-colors duration-[var(--duration-fast)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring",
        selected ? "bg-surface-2" : "hover:bg-surface-2",
        SIDEBAR_ROW_REDESIGN,
        // Two lines: the card's corner, not a 48px capsule.
        "redesign:rounded-[var(--sidebar-card-radius)]",
        "redesign:focus-visible:ring-inset redesign:focus-visible:ring-accent",
        selected && SIDEBAR_ROW_SELECTED_REDESIGN,
      )}
    >
      {tile}
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-sm font-semibold",
            quiet && !selected ? "text-text-secondary" : "text-text",
            selected && "redesign:text-on-row-selected",
          )}
        >
          {title}
        </span>
        <span
          className={cn(
            "mt-0.5 block truncate text-xs text-text-tertiary",
            selected &&
              "redesign:text-[color:color-mix(in_oklab,var(--color-on-row-selected)_72%,transparent)]",
          )}
        >
          {line}
        </span>
      </span>
    </button>
  );
}

/**
 * A post's picture, or the plate. The image fades in once it has loaded, so a
 * slow cover never pops in over the plate; reduced motion shows it at once.
 */
function Cover({
  card,
  hue,
  className,
  showPlay,
  children,
}: {
  card: LatestCard;
  hue: number;
  className?: string;
  /** Where a playable post's play mark goes, if anywhere. */
  showPlay?: "corner" | "center";
  children?: ReactNode;
}) {
  const source = coverSource(card);
  const [loaded, setLoaded] = useState<string | null>(null);
  const url = source.kind === "image" ? source.url : null;
  // A cached image can finish before React attaches `onLoad`.
  const imgRef = useCallback(
    (node: HTMLImageElement | null) => {
      if (node && url && node.complete && node.naturalWidth > 0) {
        setLoaded(url);
      }
    },
    [url],
  );
  const playable = isPlayable(card) && !card.locked;
  return (
    <span
      className={cn("relative block overflow-hidden", className)}
      style={heroTintStyle(hue, 55)}
      data-bau-preview-cover={source.kind}
    >
      {url && (
        <img
          ref={imgRef}
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(url)}
          className={cn(
            "absolute inset-0 h-full w-full object-cover transition-opacity duration-[var(--duration-base)] ease-[var(--ease-standard)] motion-reduce:transition-none",
            loaded === url ? "opacity-100" : "opacity-0",
            card.locked && "scale-105 blur-sm",
          )}
        />
      )}
      {url && playable && showPlay === "corner" && (
        <span className="absolute right-2 top-2 flex h-6 w-6 items-center justify-center rounded-full bg-surface-0/70 text-text backdrop-blur-sm">
          <IconSwap off={Play} on={PlayFill} offClassName="h-3 w-3 translate-x-px fill-current" className="h-3 w-3 translate-x-px" />
        </span>
      )}
      {playable && showPlay === "center" && (
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-4 w-4 items-center justify-center rounded-full bg-surface-0/70 text-text">
            <IconSwap off={Play} on={PlayFill} offClassName="h-2 w-2 translate-x-px fill-current" className="h-2 w-2 translate-x-px" />
          </span>
        </span>
      )}
      {!url && playable && showPlay === undefined && (
        <span className="absolute inset-0 flex items-center justify-center text-text">
          <IconSwap off={Play} on={PlayFill} offClassName="h-2.5 w-2.5 fill-current" className="h-2.5 w-2.5" />
        </span>
      )}
      {source.kind === "plate" && playable && showPlay === "corner" && (
        // No picture to show: the plate says "video" in the middle, quietly.
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-0/55 text-text backdrop-blur-sm">
            <IconSwap off={Play} on={PlayFill} offClassName="h-4 w-4 translate-x-px fill-current" className="h-4 w-4 translate-x-px" />
          </span>
        </span>
      )}
      {source.kind === "plate" && !playable && (
        <span className="absolute inset-0 flex items-center justify-center text-text/80">
          <IconSwap off={Archive} on={ArchiveFill} offClassName="h-3.5 w-3.5" className="h-3.5 w-3.5" />
        </span>
      )}
      {children}
    </span>
  );
}
