import type { ReactNode } from "react";
import {
  STARTING_SOON_CROSSFADE_MS,
  STARTING_SOON_LINE_KEYS,
  useRotatingLineIndex,
} from "@/lib/stream-starting-soon";
import { useTranslation } from "@/lib/i18n";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";

const VIDEO_WEBM = "/media/bubbles-loop.webm";
const VIDEO_MP4 = "/media/bubbles-loop.mp4";
const POSTER = "/media/bubbles-poster.jpg";

/**
 * The holding screen a watch-party audience sees whenever there is no
 * picture yet: the party is live but nobody has a frame, an egress is
 * warming up (up to ~45 s), or the player is reconnecting after a stall. A
 * looping bubble film behind a headline that rotates every 6 s through a
 * small set of playful pt-BR lines (`voice.watchParty.startingSoon.line1..7`)
 * says the wait is normal rather than leaving a black box or a flat sentence
 * on screen.
 *
 * Presentation only: this draws nothing that reads the player's own state
 * (the stall watchdog, retry timings, `phase`) and takes no action on its
 * own. A caller passes `caption` for a specific status line (kept verbatim,
 * e.g. `voice.hls.stalled`) and `children` for anything else that has to sit
 * on top (a host's "share your screen" button, a per-viewer detail) — both
 * render in the normal pointer-events layer, above the film.
 *
 * The film itself is inert: `pointer-events-none` on the video and the
 * gradient, so a click anywhere on this screen reaches whatever the caller
 * put there instead, never the loop. `prefers-reduced-motion` swaps the
 * video for its poster frame — the rotating text still changes, because that
 * is content, not motion, but it swaps instead of crossfading.
 */
export function StreamStartingSoon({
  className,
  caption,
  children,
}: {
  className?: string;
  /** A specific status line, under the headline, smaller and quieter. */
  caption?: ReactNode;
  /** Extra content below the caption (body copy, a call to action). */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const reducedMotion = usePrefersReducedMotion();
  const activeIndex = useRotatingLineIndex(STARTING_SOON_LINE_KEYS.length);

  return (
    <div className={cn("absolute inset-0 overflow-hidden", className)}>
      {reducedMotion ? (
        <img
          src={POSTER}
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        />
      ) : (
        <video
          className="pointer-events-none absolute inset-0 h-full w-full object-cover"
          autoPlay
          muted
          loop
          playsInline
          poster={POSTER}
          aria-hidden="true"
        >
          <source src={VIDEO_WEBM} type="video/webm" />
          <source src={VIDEO_MP4} type="video/mp4" />
        </video>
      )}
      {/* Darkens the film evenly enough that white text stays legible over
          both the sparse and the dense end of the loop. */}
      <div
        className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/50 via-black/35 to-black/60"
        aria-hidden="true"
      />
      <div className="relative flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        {/* Tall enough for the longest line at two lines, on a phone, so a
            wrap never overlaps the caption drawn under it. */}
        <div className="relative min-h-[2.75em] w-full max-w-sm sm:min-h-[2.25em]">
          {STARTING_SOON_LINE_KEYS.map((key, index) => (
            <p
              key={key}
              aria-hidden={index !== activeIndex}
              className={cn(
                "absolute inset-0 flex items-center justify-center font-display text-lg font-bold leading-tight text-paper sm:text-xl",
                reducedMotion
                  ? "transition-none"
                  : "transition-opacity ease-in-out",
                index === activeIndex ? "opacity-100" : "opacity-0",
              )}
              style={
                reducedMotion
                  ? undefined
                  : { transitionDuration: `${STARTING_SOON_CROSSFADE_MS}ms` }
              }
            >
              {t(key)}
            </p>
          ))}
        </div>
        {caption ? (
          <p className="text-xs text-paper-muted">{caption}</p>
        ) : null}
        {children}
      </div>
    </div>
  );
}
