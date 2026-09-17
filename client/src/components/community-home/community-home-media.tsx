import { Download } from "lucide-react";
import type { CommunityHomeMedia } from "@pqp/shared";
import {
  formatHomeBytes,
  instagramEmbedSrc,
  tiktokEmbedSrc,
  twitchEmbedSrc,
  youtubeEmbedSrc,
} from "@/lib/community-home/media";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

function twitchPlayerParent(): string {
  if (typeof window !== "undefined" && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
}

function MediaCaption({ media }: { media: CommunityHomeMedia }) {
  return (
    <div className="border-t border-ink-4 px-3 py-1.5 text-[11px] text-paper-muted">
      {media.name}
      {media.byteSize != null ? ` · ${formatHomeBytes(media.byteSize)}` : null}
    </div>
  );
}

/**
 * The player / file / image a published card shows. Composer live preview
 * reuses this so a paste looks like the feed, not a second embed.
 *
 * `flush` is for a Patreon-style card: the media is the top of the card,
 * edge to edge, no inner radius or border of its own.
 */
export function UnlockedMedia({
  media,
  flush = false,
}: {
  media: CommunityHomeMedia;
  flush?: boolean;
}) {
  const { t } = useTranslation();
  const frame = cn(
    "overflow-hidden bg-surface-0",
    flush ? "rounded-none" : "rounded-lg border border-border",
  );
  if (media.kind === "youtube") {
    const src = media.youtubeUrl ? youtubeEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="youtube">
        <iframe
          title={media.name}
          src={src}
          className="aspect-video w-full"
          loading="lazy"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "twitch") {
    const src = media.twitchUrl
      ? twitchEmbedSrc(media.twitchUrl, twitchPlayerParent())
      : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="twitch">
        <iframe
          title={media.name}
          src={src}
          className="aspect-video w-full"
          loading="lazy"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "tiktok") {
    const src = media.youtubeUrl ? tiktokEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="tiktok">
        <iframe
          title={t("communityHome.media.openTikTok")}
          src={src}
          className="mx-auto aspect-[9/16] w-full max-w-[325px]"
          loading="lazy"
          allow="encrypted-media; fullscreen; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "instagram") {
    const src = media.youtubeUrl ? instagramEmbedSrc(media.youtubeUrl) : null;
    if (!src) {
      return null;
    }
    return (
      <div className={frame} data-home-media="instagram">
        <iframe
          title={t("communityHome.media.openInstagram")}
          src={src}
          className="mx-auto min-h-[540px] w-full max-w-[540px]"
          loading="lazy"
          allow="encrypted-media; clipboard-write; picture-in-picture"
          allowFullScreen
        />
      </div>
    );
  }

  if (media.kind === "file") {
    return (
      <div
        className={cn(
          "flex items-center gap-3 px-3 py-2.5 text-sm",
          flush ? "border-t border-border" : "rounded-lg border border-border bg-surface-0",
        )}
        data-home-media="file"
      >
        <span className="rounded bg-signal/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-signal">
          {media.name.toLowerCase().endsWith(".pdf")
            ? "PDF"
            : t("communityHome.media.file")}
        </span>
        <span className="min-w-0 truncate">{media.name}</span>
        {media.byteSize != null && (
          <span className="ml-auto shrink-0 text-xs text-paper-muted">
            {formatHomeBytes(media.byteSize)}
          </span>
        )}
        {media.url ? (
          <a
            className="inline-flex shrink-0 items-center gap-1 text-xs text-signal hover:underline"
            href={media.url}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={t("communityHome.media.download")}
          >
            <Download className="h-3.5 w-3.5" aria-hidden />
          </a>
        ) : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className={frame} data-home-media="video">
        {media.url ? (
          <video
            className="max-h-96 w-full bg-ink"
            controls
            playsInline
            preload="metadata"
            src={media.url}
          >
            <track kind="captions" />
          </video>
        ) : (
          <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
            {t("communityHome.media.unavailable")}
          </div>
        )}
        <MediaCaption media={media} />
      </div>
    );
  }

  return (
    <div className={frame} data-home-media="image">
      {media.url ? (
        <img
          src={media.url}
          alt={media.name}
          loading="lazy"
          decoding="async"
          className="max-h-[32rem] w-full object-contain"
        />
      ) : (
        <div className="flex h-44 items-center justify-center text-xs text-paper-muted">
          {t("communityHome.media.unavailable")}
        </div>
      )}
      <MediaCaption media={media} />
    </div>
  );
}
