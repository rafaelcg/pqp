import { useState } from "react";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * A server's icon and its banner, and the monogram both fall back to.
 *
 * One file for the pair because they fail the same way and must fail
 * identically: a picture set by a server owner, rendered to everyone who is in
 * the room, from a URL nobody else reviewed. A broken or slow-to-fail one has
 * to land on the same two letters the server had before it uploaded anything —
 * never a broken-image icon in a 72px rail, never an empty 120px band above the
 * channel list. That is the same rule `ChannelIcon` follows, for the same
 * reason, and it is why both components below hold a `failedUrl` rather than
 * trusting the load.
 */

/**
 * The two letters a server is drawn as when it has no icon.
 *
 * Uppercased and taken from the start of the name, matching what the rail has
 * always rendered — the whole point of a fallback is that turning an icon off
 * puts things back exactly as they were.
 */
export function serverMonogram(name: string): string {
  return name.slice(0, 2).toUpperCase();
}

/**
 * The square that identifies a server: its uploaded icon, or its monogram.
 *
 * `referrerPolicy="no-referrer"` and `loading="lazy"` for the reasons spelled
 * out on `ChannelIcon` — an icon URL is one credible way to run a tracking
 * pixel against a whole server, and stripping the referrer at least keeps it
 * from also learning which page linked to it. (An icon uploaded here is served
 * from our own bucket through a redirect and reveals nothing; the policy costs
 * nothing and covers the case where the value is a link somebody typed.)
 */
export function ServerIcon({
  name,
  iconUrl,
  className,
  textClassName,
  fallback,
}: {
  name: string;
  iconUrl: string | null | undefined;
  className?: string;
  /** Sizing for the monogram, which is text and does not scale with the box. */
  textClassName?: string;
  /**
   * Override the two letters.
   *
   * The communities directory has its own `monogram` — word initials rather
   * than the first two characters, and surrogate-pair-safe so a name starting
   * with an emoji does not render half a glyph. That is a better monogram, but
   * it is not the one the rail has always drawn, and quietly changing every
   * existing server's icon is not this change's to make. So both survive, and
   * the caller says which it wants.
   */
  fallback?: string;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const resolved = resolveUploadedImageUrl(iconUrl);

  if (resolved && resolved !== failedUrl) {
    return (
      <img
        src={resolved}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className={cn("h-full w-full object-cover", className)}
        onError={() => setFailedUrl(resolved)}
      />
    );
  }
  return (
    <span aria-hidden="true" className={cn(textClassName)}>
      {fallback ?? serverMonogram(name)}
    </span>
  );
}

/**
 * The wide image across the top of the channel-list column, with the server's
 * name over it.
 *
 * RENDERS NOTHING WITHOUT A BANNER, deliberately — not an empty band, not a
 * placeholder gradient. The header below it already names the server, so a
 * server that has set no banner keeps the layout it has always had and the
 * feature is invisible until somebody opts into it. That is also what makes the
 * fallback on a failed load correct rather than jarring: the band disappears and
 * the ordinary header is still there, saying the same thing.
 *
 * The name is drawn over a bottom-up scrim rather than over the raw image.
 * Contrast against an arbitrary photograph is not something a colour token can
 * promise, and a banner is precisely the image a user will pick for looking
 * good rather than for being legible underneath text.
 */
export function ServerBanner({
  name,
  bannerUrl,
}: {
  name: string;
  bannerUrl: string | null | undefined;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const resolved = resolveUploadedImageUrl(bannerUrl);

  if (!resolved || resolved === failedUrl) {
    return null;
  }

  return (
    <div
      data-server-banner=""
      className="relative h-[120px] shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink-3"
    >
      <img
        src={resolved}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover"
        onError={() => setFailedUrl(resolved)}
      />
      <span
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-t from-ink/85 via-ink/25 to-transparent"
      />
      {/* `aria-hidden` because the header underneath already announces the
          server by name, and a screen reader should not hear it twice. */}
      <p
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 truncate px-4 pb-3 font-display text-xl font-bold leading-tight text-paper drop-shadow-[var(--shadow-banner-text)]"
      >
        {name}
      </p>
    </div>
  );
}
