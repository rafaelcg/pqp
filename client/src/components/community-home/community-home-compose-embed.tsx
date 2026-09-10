import { useEffect, useState } from "react";
import { UnlockedMedia } from "@/components/community-home/community-home-media";
import { Skeleton } from "@/components/ui/skeleton";
import {
  COMPOSE_EMBED_DEBOUNCE_MS,
  communityHomeEmbedMedia,
} from "@/lib/community-home/embed-preview";
import { useTranslation } from "@/lib/i18n";

function EmbedSkeleton({ label }: { label: string }) {
  return (
    <div
      className="overflow-hidden rounded-lg border border-ink-4"
      data-home-compose-embed-skeleton
      aria-busy="true"
      aria-label={label}
    >
      <Skeleton className="aspect-video w-full rounded-none" />
    </div>
  );
}

/**
 * Discord-style unfurl in the Baú composer: paste a supported link, the
 * same player the feed uses appears in the compose card. No extra Prévia
 * click for media. A 16:9 skeleton covers the debounce; a muted hint is
 * the only "that is not a link" signal, never the red submit error.
 */
export function CommunityHomeComposeEmbed({
  url,
  debounceMs = COMPOSE_EMBED_DEBOUNCE_MS,
}: {
  url: string;
  debounceMs?: number;
}) {
  const { t } = useTranslation();
  const [debouncedUrl, setDebouncedUrl] = useState(url);

  useEffect(() => {
    if (debounceMs <= 0) {
      setDebouncedUrl(url);
      return;
    }
    const handle = window.setTimeout(() => setDebouncedUrl(url), debounceMs);
    return () => window.clearTimeout(handle);
  }, [url, debounceMs]);

  const trimmed = url.trim();
  if (!trimmed) {
    return null;
  }

  const settled = trimmed === debouncedUrl.trim();
  if (!settled) {
    return <EmbedSkeleton label={t("communityHome.compose.embedLoading")} />;
  }

  const media = communityHomeEmbedMedia(debouncedUrl);
  if (media) {
    return (
      <div data-home-compose-embed>
        <UnlockedMedia media={media} />
      </div>
    );
  }

  return (
    <p className="text-xs text-paper-muted" data-home-compose-embed-hint>
      {t("communityHome.compose.embedUnsupported")}
    </p>
  );
}
