import type { CommunityFeatured } from "@pqp/shared";
import { youtubePosterUrl } from "@pqp/shared";
import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import { twitchEmbedSrc, youtubeEmbedSrc } from "@/lib/community-home/media";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const FEATURED_LOAD_TIMEOUT_MS = 12_000;

function twitchPlayerParent(): string {
  if (typeof window !== "undefined" && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
}

export function CommunityFeaturedMedia({
  featured,
  className,
  clickToPlay = false,
}: {
  featured: CommunityFeatured;
  className?: string;
  /** Public `/c/` uses this so a stranger is not hit with Twitch/YouTube cookies. */
  clickToPlay?: boolean;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(!clickToPlay);

  let src: string | null = null;
  if (featured.kind === "youtube") {
    const embed = youtubeEmbedSrc(featured.url);
    src = embed ? `${embed}?autoplay=0` : null;
  } else if (featured.kind === "twitch") {
    src = twitchEmbedSrc(featured.url, twitchPlayerParent());
  }

  const imageUrl =
    featured.kind === "image" ? resolveUploadedImageUrl(featured.url) : null;
  const posterUrl =
    featured.kind === "youtube" ? youtubePosterUrl(featured.url) : null;

  useEffect(() => {
    setReady(false);
    setFailed(false);
    setPlaying(!clickToPlay);
  }, [featured.kind, featured.url, clickToPlay]);

  useEffect(() => {
    if (failed || ready || (clickToPlay && !playing && featured.kind !== "image")) {
      return;
    }
    const timer = window.setTimeout(() => setFailed(true), FEATURED_LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [clickToPlay, failed, featured.kind, featured.url, playing, ready]);

  if (featured.kind !== "image" && !src) {
    return null;
  }
  if (featured.kind === "image" && !imageUrl) {
    return null;
  }

  return (
    <div
      className={cn(
        "cta-lift overflow-hidden rounded-2xl border border-ink-4 bg-ink",
        className,
      )}
      data-community-featured={featured.kind}
    >
      <div className="relative aspect-video w-full">
        {failed ? (
          <p
            className="absolute inset-0 flex items-center justify-center px-4 text-center text-sm text-paper-muted"
            data-community-featured-failed
          >
            {t("publicCommunity.featuredUnavailable")}
          </p>
        ) : (
          <>
            {!ready && !(clickToPlay && !playing && !imageUrl) && (
              <div
                className="absolute inset-0 bg-ink-3/60 transition-opacity duration-[var(--duration-base)]"
                aria-hidden
              />
            )}
            {imageUrl ? (
              <img
                src={imageUrl}
                alt=""
                className={cn(
                  "h-full w-full object-cover transition-opacity duration-[var(--duration-base)]",
                  ready ? "opacity-100" : "opacity-0",
                )}
                onLoad={() => setReady(true)}
                onError={() => setFailed(true)}
              />
            ) : playing ? (
              <iframe
                title={t("publicCommunity.featured")}
                src={src ?? undefined}
                className={cn(
                  "h-full w-full transition-opacity duration-[var(--duration-base)]",
                  ready ? "opacity-100" : "opacity-0",
                )}
                loading="lazy"
                allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                allowFullScreen
                onLoad={() => setReady(true)}
                onError={() => setFailed(true)}
              />
            ) : (
              <button
                type="button"
                className="absolute inset-0 flex items-center justify-center"
                onClick={() => setPlaying(true)}
                data-community-featured-play
              >
                {posterUrl ? (
                  <img
                    src={posterUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                  />
                ) : (
                  <span className="absolute inset-0 bg-ink-3" aria-hidden />
                )}
                <span className="relative inline-flex items-center gap-2 rounded-full bg-ink/80 px-4 py-2 text-sm font-semibold text-paper">
                  <Play aria-hidden className="h-4 w-4" />
                  {t("publicCommunity.featuredPlay")}
                </span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
