import {
  ChatsCircle,
  FilmSlate,
  Hash as HashBold,
  Lock as LockFill,
  Microphone,
  type Icon as PhosphorIcon,
} from "@phosphor-icons/react";
import {
  Clapperboard,
  Hash,
  Lock,
  MessagesSquare,
  Mic,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { isWatchPartyChannelType, type Channel } from "@pqp/shared";
import { Icon, type IconKind } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Lucide with the toggle off, the Phosphor glyph under the redesign, same size. */
function Glyph({
  off: Off,
  on,
  kind = "object",
  className,
}: {
  off: LucideIcon;
  on: PhosphorIcon;
  kind?: IconKind;
  className: string;
}) {
  return (
    <>
      <Off className={cn(className, "redesign:hidden")} />
      <Icon icon={on} kind={kind} className={cn("hidden redesign:block", className)} />
    </>
  );
}

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
 * Whether `ChannelIcon` will draw the amber padlock for this channel, rather
 * than its own image or emoji.
 *
 * A private channel with no picture already says "private" with its glyph, and
 * the sidebar row leans on that instead of spending 50px of a 256px column on
 * a text pill. A private channel that DOES carry a picture keeps the picture,
 * so the row has to draw the padlock itself; this is the one question it needs
 * answered to know which.
 *
 * The image-that-fails-to-load case falls back to the padlock inside
 * `ChannelIcon` and is not modelled here: the failure is only known after a
 * round trip, and the worst it costs is one redundant padlock beside another.
 */
export function channelIconIsPrivateLock(channel: Channel): boolean {
  return channel.isPrivate === true && !channel.imageUrl;
}

/**
 * The glyph next to a channel's name — its image, its emoji icon, or one of
 * the defaults (lock / clapperboard / mic / speech bubbles / hash) when it has
 * neither. Most channels hit the default path, so that path is drawn
 * deliberately rather than left blank.
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
    return <Glyph off={Lock} on={LockFill} className={cn("shrink-0 text-warning", className)} />;
  }
  if (isWatchPartyChannelType(channel.type)) {
    return <Glyph off={Clapperboard} on={FilmSlate} className={cn("shrink-0", className)} />;
  }
  if (channel.type === "voice") {
    return <Glyph off={Mic} on={Microphone} className={cn("shrink-0", className)} />;
  }
  // A forum: conversations, not one chat. Distinct from `#` at 16 px.
  if (channel.type === "forum") {
    return <Glyph off={MessagesSquare} on={ChatsCircle} className={cn("shrink-0", className)} />;
  }
  return <Glyph off={Hash} on={HashBold} kind="symbol" className={cn("shrink-0", className)} />;
}
