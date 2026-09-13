import { SERVER_BANNER_HEIGHT, SERVER_BANNER_WIDTH } from "@pqp/shared";
import { useEffect, useState } from "react";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

/**
 * How long a failed banner load stays failed before the `<img>` gets another
 * try.
 *
 * Bounded, not exponential: this is a decorative image, not a request worth
 * backing off aggressively for, and the failure this guards against is
 * ordinary — a CDN blip, a dropped connection — not a permanently dead URL,
 * which keeps failing and simply keeps retrying on this same interval. 20s is
 * long enough that a real outage does not hammer anything, short enough that
 * a viewer who leaves the header on screen sees the banner come back within
 * the same sitting rather than needing a reload.
 */
const BANNER_RETRY_MS = 20_000;

/**
 * The failed-URL bit `ServerBannerStrip` keeps, with the retry built in: once
 * a URL fails, a timer clears the failure after `BANNER_RETRY_MS` so the next
 * render's `<img>` gets a fresh attempt. If it fails again `onError` sets it
 * right back and the timer restarts — a permanently dead URL just keeps
 * retrying on this interval rather than wedging shut, and a URL that recovers
 * is showing again within one interval with no remount and no reload
 * required.
 */
function useRetryableImageFailure(): [string | null, (url: string) => void] {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!failedUrl) {
      return;
    }
    const timer = setTimeout(() => setFailedUrl(null), BANNER_RETRY_MS);
    return () => clearTimeout(timer);
  }, [failedUrl]);

  return [failedUrl, setFailedUrl];
}

/**
 * A server's icon and its banner, and the monogram both fall back to.
 *
 * One file for the pair because they fail the same way and must fail
 * identically: a picture set by a server owner, rendered to everyone who is in
 * the room, from a URL nobody else reviewed. A broken or slow-to-fail one has
 * to land on the same two letters the server had before it uploaded anything —
 * never a broken-image icon in a 72px rail, never an empty banner band above the
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
 * The tall banner with the server's name drawn over it.
 *
 * NOT what the channel sidebar draws above its header any more — see
 * `ServerBannerStrip` below. This component's only caller today is the
 * Server Settings preview, where the name over the artwork is correct
 * because the artwork is the subject being previewed. RENDERS NOTHING
 * WITHOUT A BANNER, deliberately — not an empty band, not a placeholder
 * gradient.
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
      className="relative w-full shrink-0 overflow-hidden border-b border-ink-4/60 bg-ink-3"
      style={{
        aspectRatio: `${SERVER_BANNER_WIDTH} / ${SERVER_BANNER_HEIGHT}`,
      }}
    >
      <img
        src={resolved}
        alt=""
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover object-center"
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

/**
 * The 72px decorative strip above the channel sidebar's identity row.
 *
 * A short band, never a text backdrop: `object-fit: cover`, no text, no
 * scrim, `aria-hidden`, rendered only when a banner has actually loaded. The
 * identity row below it is a normal sibling that keeps the column's own
 * background and never changes shape whether this strip is present or not —
 * the server's name is drawn exactly once, by that row, never here.
 *
 * RENDERS NOTHING WITHOUT A BANNER, for the same reason `ServerBanner` does:
 * the feature stays invisible until an owner opts into it, and a failed load
 * (see `useRetryableImageFailure`) falls back to that same nothing rather
 * than an empty grey band.
 */
export function ServerBannerStrip({
  bannerUrl,
}: {
  bannerUrl: string | null | undefined;
}) {
  const [failedUrl, setFailedUrl] = useRetryableImageFailure();
  const resolved = resolveUploadedImageUrl(bannerUrl);

  if (!resolved || resolved === failedUrl) {
    return null;
  }

  return (
    <div
      data-server-banner-strip=""
      className="h-18 w-full shrink-0 overflow-hidden border-b border-border bg-surface-2"
    >
      <img
        src={resolved}
        alt=""
        aria-hidden="true"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="h-full w-full object-cover object-center"
        onError={() => setFailedUrl(resolved)}
      />
    </div>
  );
}
