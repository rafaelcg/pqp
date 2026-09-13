import { SERVER_BANNER_HEIGHT, SERVER_BANNER_WIDTH } from "@pqp/shared";
import { useState, type ReactNode } from "react";
import { resolveUploadedImageUrl } from "@/lib/avatar";
import { cn } from "@/lib/utils";

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
          server by name, and a screen reader should not hear it twice.

          `text-white`, not `text-paper`: a photograph's own brightness has
          nothing to do with the app's light/dark preference, so text drawn
          over one needs a colour that stays light regardless of which theme
          is active — `text-paper` is the ordinary body-text role and reads
          as dark ink in a light theme, which on a bright photo is dark text
          on top of this same dark scrim. `marketing-nav.tsx`'s hero state and
          `landing-page.tsx` use the same literal white over their own hero
          photography for the same reason. */}
      <p
        aria-hidden="true"
        className="absolute inset-x-0 bottom-0 truncate px-4 pb-3 font-display text-xl font-bold leading-tight text-white drop-shadow-[var(--shadow-banner-text)]"
      >
        {name}
      </p>
    </div>
  );
}

/**
 * The channel sidebar's own header background: the server's banner behind
 * the icon/name/role/actions row when one is set, and the row's ordinary
 * background when it is not — or when the image fails to load.
 *
 * NOT `ServerBanner`. That component draws the server's name a second time,
 * over the image, which is correct for the settings-dialog preview (a
 * standalone thumbnail of what the banner looks like) and was exactly the bug
 * in the channel sidebar: the same name stacked three times — in the banner,
 * over the banner, and again in the row below. This component never draws a
 * name; it only ever wraps the caller's own row, so there is one name, drawn
 * once, by the caller.
 *
 * `children` is a render prop, not a plain node, because the caller's row has
 * to answer to the same fact this component already tracks: whether there is
 * a photograph behind it right now. A banner is "the image a user will pick
 * for looking good rather than for being legible underneath text" (the same
 * reason `ServerBanner` scrims its own name), so the row's default ink-on-paper
 * colours — correct against the plain `bg-channel` row — are exactly wrong
 * over an arbitrary photo and have to flip to light text with a shadow. Only
 * this component knows, this render, whether the image resolved and loaded;
 * the caller cannot compute that itself without duplicating the state below.
 *
 * The `else` branch (no `bannerUrl`, or the image 404s after mount) always
 * renders `children` too, in a plain wrapper with no image and no
 * aspect-ratio box — a load failure must not take the icon, the name and the
 * action buttons off the screen with it, and `hasBanner` flips back to
 * `false` so they read correctly once it does.
 */
export function ServerHeaderBanner({
  bannerUrl,
  children,
}: {
  bannerUrl: string | null | undefined;
  children: (hasBanner: boolean) => ReactNode;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const resolved = resolveUploadedImageUrl(bannerUrl);

  if (!resolved || resolved === failedUrl) {
    return (
      <div className="shrink-0 border-b border-ink-4/60 bg-channel">
        {children(false)}
      </div>
    );
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
        className="absolute inset-0 bg-gradient-to-t from-ink/90 via-ink/45 to-transparent"
      />
      <div className="absolute inset-x-0 bottom-0">{children(true)}</div>
    </div>
  );
}
