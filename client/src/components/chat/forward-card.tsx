import type { ForwardMediaKind, MessageForward } from "@pqp/shared";
import {
  ArrowBendUpRight,
  Image as ImageGlyph,
  LockSimple,
  Play as PlayGlyph,
  VideoCamera,
} from "@phosphor-icons/react";
import { Forward, Image as ImageIcon, Lock, Play, Video } from "lucide-react";
import { useCallback, type MouseEvent } from "react";
import { useInRouterContext, useNavigate } from "react-router-dom";
import { BauShareButton } from "@/components/community-home/community-home-share-public";
import { ServerIcon } from "@/components/layout/server-identity";
import {
  CONTENT_CARD_HOVER_REDESIGN,
  CONTENT_CARD_REDESIGN,
} from "@/components/ui/content-card";
import { Icon } from "@/components/ui/icon";
import { messageLinkState } from "@/lib/app-route";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import {
  announceNotInServer,
  forwardShareUrl,
  forwardUrlTarget,
  isKnownNonMember,
} from "@/lib/forward";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A forwarded Baú post or chat message, drawn from the snapshot the server
 * stored (`message.forward`, contract in `@pqp/shared` `forward.ts`).
 *
 * Everything here is plain text from the snapshot: names inside it are never
 * links and ping nobody, and nothing is fetched. The card opens the live
 * source through `url`; a reader who may not open it lands on the app's own
 * "no access" screen, so a card never reveals more than it already says.
 *
 * A card of a free post that has a public page also carries Compartilhar, the
 * same menu as on the Baú post (`BauShareButton`). It sits in a footer BESIDE
 * the link, not inside it: a button in an anchor is not valid markup and its
 * click would navigate.
 */

const MEDIA_LABEL: Record<ForwardMediaKind, MessageKey> = {
  image: "forwardCard.media.image",
  video: "forwardCard.media.video",
  youtube: "forwardCard.media.video",
  embed: "forwardCard.media.embed",
};

export function ForwardCardView({
  forward,
  href,
  external = false,
  onOpen,
}: {
  forward: MessageForward;
  href: string;
  /** Leaves the app: opens in a new tab, with no opener. */
  external?: boolean;
  onOpen: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const { t } = useTranslation();
  const where =
    forward.kind === "bau_post"
      ? t("forwardCard.inBau")
      : forward.sourceChannelName
        ? `#${forward.sourceChannelName}`
        : null;
  const mediaKind = forward.mediaKind;
  // An https poster, or the API's own public cover as a root-relative path.
  const thumb = resolveUploadedImageUrl(forward.mediaThumbUrl);
  const title = forward.title?.trim();
  const excerpt = forward.excerpt.trim();
  const label = t("forwardCard.ariaLabel", {
    server: forward.sourceServerName,
    title: title || excerpt.slice(0, 80) || forward.sourceServerName,
  });
  const shareUrl = forwardShareUrl(forward);
  return (
    <div
      className={cn(
        "group/fwd mt-1.5 w-full max-w-[26rem] overflow-hidden rounded-[var(--radius-card)] border border-border border-l-[3px] border-l-accent bg-surface-1 text-left transition-[border-color,background-color] duration-[var(--duration-fast)] hover:border-accent/50 hover:bg-surface-2",
        CONTENT_CARD_REDESIGN,
        CONTENT_CARD_HOVER_REDESIGN,
      )}
      data-forward-card-frame=""
    >
      <a
        href={href}
        onClick={onOpen}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        aria-label={label}
        data-forward-card=""
        data-forward-kind={forward.kind}
        className="block w-full text-left no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring redesign:rounded-[var(--radius-card)] redesign:focus-visible:ring-accent"
      >
        <div className="flex items-center gap-1.5 px-3 pt-2.5 text-xs text-text-tertiary redesign:px-[var(--content-card-pad)] redesign:pt-[var(--content-card-pad)]">
          <Forward className="h-3.5 w-3.5 shrink-0 redesign:hidden" aria-hidden />
          <Icon icon={ArrowBendUpRight} kind="symbol" size="sm" className="hidden redesign:block" />
          <span className="shrink-0">{t("forwardCard.from")}</span>
          <span
            className="flex h-4 w-4 shrink-0 items-center justify-center overflow-hidden rounded bg-surface-3 text-[8px] font-semibold text-text redesign:rounded-full"
            data-forward-server-icon=""
          >
            <ServerIcon
              name={forward.sourceServerName}
              iconUrl={forward.sourceServerIconUrl}
            />
          </span>
          {/* The server name gives way first: "· Baú" / "· #canal" is what tells
              a post from a message, and stays whole at a phone's width. */}
          <span className="min-w-0 truncate font-medium text-text-secondary">
            {forward.sourceServerName}
          </span>
          {where && <span className="shrink-0 whitespace-nowrap">{`· ${where}`}</span>}
          {forward.restricted && (
            <>
              <Lock
                className="ml-auto h-3 w-3 shrink-0 redesign:hidden"
                aria-label={t("forwardCard.restricted")}
              />
              <span className="ml-auto hidden redesign:block" role="img" aria-label={t("forwardCard.restricted")}>
                <Icon icon={LockSimple} size="sm" />
              </span>
            </>
          )}
        </div>

        <div className="flex gap-3 px-3 pb-3 pt-1.5 max-sm:flex-col redesign:px-[var(--content-card-pad)] redesign:pb-[var(--content-card-pad)]">
          <div className="min-w-0 flex-1 space-y-1">
            {title && (
              <p
                className="line-clamp-2 break-words font-display text-base font-bold leading-snug text-text"
                data-forward-title=""
              >
                {title}
              </p>
            )}
            {excerpt && (
              <p
                className="line-clamp-3 whitespace-pre-line break-words text-sm leading-snug text-text-secondary"
                data-forward-excerpt=""
              >
                {excerpt}
              </p>
            )}
            {forward.authorDisplayName && (
              <p className="truncate text-xs text-text-tertiary">
                {t("forwardCard.by", { name: forward.authorDisplayName })}
              </p>
            )}
            {mediaKind && !thumb && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-medium text-text-secondary redesign:bg-[color:var(--content-glyph-bg)] redesign:text-xs"
                data-forward-media-chip=""
              >
                {mediaKind === "image" ? (
                  <>
                    <ImageIcon className="h-3 w-3 redesign:hidden" aria-hidden />
                    <Icon icon={ImageGlyph} size="sm" className="hidden redesign:block" />
                  </>
                ) : mediaKind === "video" || mediaKind === "youtube" ? (
                  <>
                    <Video className="h-3 w-3 redesign:hidden" aria-hidden />
                    <Icon icon={VideoCamera} size="sm" className="hidden redesign:block" />
                  </>
                ) : (
                  <>
                    <Play className="h-3 w-3 redesign:hidden" aria-hidden />
                    <Icon icon={PlayGlyph} size="sm" className="hidden redesign:block" />
                  </>
                )}
                {t(MEDIA_LABEL[mediaKind])}
              </span>
            )}
          </div>
          {thumb && (
            <div
              className="relative h-16 w-24 shrink-0 self-start overflow-hidden rounded-[var(--radius-control)] bg-surface-2 max-sm:order-first max-sm:h-32 max-sm:w-full max-sm:self-stretch redesign:rounded-[var(--content-media-radius)]"
              data-forward-thumb=""
            >
              <img
                src={thumb}
                alt=""
                loading="lazy"
                decoding="async"
                referrerPolicy="no-referrer"
                className="h-full w-full object-cover"
              />
              {(mediaKind === "video" || mediaKind === "youtube") && (
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-7 w-7 items-center justify-center rounded-full bg-accent text-on-accent shadow">
                    <Play className="h-3.5 w-3.5 translate-x-px fill-current" aria-hidden />
                  </span>
                </span>
              )}
            </div>
          )}
        </div>
      </a>
      {shareUrl && (
        <div className="flex justify-end px-2 pb-1.5" data-forward-share="">
          <BauShareButton
            publicUrl={shareUrl}
            title={title || excerpt.slice(0, 120)}
            surface="forward"
          />
        </div>
      )}
    </div>
  );
}

function NavigatingForwardCard({ forward }: { forward: MessageForward }) {
  const navigate = useNavigate();
  const target = forwardUrlTarget(forward.url, window.location.origin);
  const onOpen = useCallback(
    (event: MouseEvent<HTMLAnchorElement>) => {
      // Let the browser keep its own new-tab and copy-link gestures.
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) {
        return;
      }
      if (target?.kind === "app") {
        event.preventDefault();
        // A server this account is not in has nothing to open: say so, rather
        // than navigating to a screen that silently ends up where it started.
        if (isKnownNonMember(forward.sourceServerId)) {
          announceNotInServer();
          return;
        }
        navigate(target.path, { state: messageLinkState() });
      }
    },
    [forward.sourceServerId, navigate, target],
  );
  return (
    <ForwardCardView
      forward={forward}
      href={hrefOf(forward, target)}
      external={target?.kind !== "app"}
      onOpen={onOpen}
    />
  );
}

function hrefOf(
  forward: MessageForward,
  target: ReturnType<typeof forwardUrlTarget>,
): string {
  if (target?.kind === "app") {
    return target.path;
  }
  return target?.kind === "external" ? target.href : forward.url;
}

export function ForwardCard({ forward }: { forward: MessageForward }) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return <NavigatingForwardCard forward={forward} />;
  }
  const target = forwardUrlTarget(
    forward.url,
    typeof window === "undefined" ? "" : window.location.origin,
  );
  return (
    <ForwardCardView
      forward={forward}
      href={hrefOf(forward, target)}
      external={target?.kind !== "app"}
      onOpen={() => undefined}
    />
  );
}
