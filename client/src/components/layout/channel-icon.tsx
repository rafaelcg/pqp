import { Hash, Lock, Mic } from "lucide-react";
import { useState } from "react";
import type { Channel } from "@pqp/shared";
import { cn } from "@/lib/utils";

/**
 * True for values meant to render as an `<img>`. Mirrors the shapes
 * `updateChannelSchema` (packages/shared/src/api.ts) accepts for `imageUrl`:
 * absolute http(s) URLs and root-relative paths off this origin. Anything
 * else (an emoji, a short label) is the pre-existing "icon" shorthand and
 * renders as literal text instead.
 */
export function isChannelImageUrl(value: string): boolean {
  return (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("/")
  );
}

/**
 * The glyph next to a channel's name — its image, its emoji icon, or one of
 * the three defaults (lock / mic / hash) when it has neither. Most channels
 * hit the default path, so that path is drawn deliberately rather than left
 * blank.
 *
 * A channel image is set by whoever renamed the channel, not reviewed by
 * anyone else, and rendered to the whole server — so a broken or slow-to-fail
 * URL falls back to the same default rather than leaving a broken-image icon
 * in a 16rem-wide sidebar. `referrerPolicy="no-referrer"` keeps a
 * tracking-pixel URL from also learning which page linked to it.
 */
export function ChannelIcon({
  channel,
  className = "h-3.5 w-3.5",
}: {
  channel: Channel;
  className?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = channel.imageUrl ?? null;
  const showImage = imageUrl !== null && imageUrl !== failedUrl;

  if (showImage) {
    if (isChannelImageUrl(imageUrl)) {
      return (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          className={cn("shrink-0 rounded-sm object-cover", className)}
          onError={() => setFailedUrl(imageUrl)}
        />
      );
    }
    return (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center text-[11px] leading-none",
          className,
        )}
      >
        {imageUrl}
      </span>
    );
  }
  if (channel.isPrivate) {
    return <Lock className={cn("shrink-0 text-warning", className)} />;
  }
  if (channel.type === "voice") {
    return <Mic className={cn("shrink-0", className)} />;
  }
  return <Hash className={cn("shrink-0", className)} />;
}
