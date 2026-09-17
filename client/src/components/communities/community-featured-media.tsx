import type { CommunityFeatured } from "@pqp/shared";
import { twitchEmbedSrc, youtubeEmbedSrc } from "@/lib/community-home/media";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useState } from "react";

function twitchPlayerParent(): string {
  if (typeof window !== "undefined" && window.location.hostname) {
    return window.location.hostname;
  }
  return "localhost";
}

export function CommunityFeaturedMedia({
  featured,
  className,
}: {
  featured: CommunityFeatured;
  className?: string;
}) {
  const { t } = useTranslation();
  const [ready, setReady] = useState(false);

  let src: string | null = null;
  if (featured.kind === "youtube") {
    const embed = youtubeEmbedSrc(featured.url);
    src = embed ? `${embed}?autoplay=0` : null;
  } else if (featured.kind === "twitch") {
    src = twitchEmbedSrc(featured.url, twitchPlayerParent());
  }

  const imageUrl =
    featured.kind === "image" ? resolveUploadedImageUrl(featured.url) : null;

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
        {!ready && (
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
          />
        ) : (
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
          />
        )}
      </div>
    </div>
  );
}
