import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/use-reduced-motion";
import { heroVideoAllowed } from "@/lib/hero-video";
import { cn } from "@/lib/utils";

/**
 * The landing hero's backdrop: a still painting, and on a wide screen with a
 * pointer and a decent connection, the same scene as a short loop fading in
 * over it.
 *
 * THE STILL IS A CSS BACKGROUND (`.hero-bg-art` in `index.css`), not an
 * `<img>`, on purpose: the prerendered first screen in `index.html` uses the
 * same class, so both pick the same AVIF or WebP at the same size and the
 * second one is a cache hit. See `lib/prerender-hero.ts`.
 *
 * THE VIDEO is 585 kB, so it is opt-in by device rather than opt-out:
 *
 *   - never on a phone or tablet (`hover: none` or a coarse pointer), where it
 *     is most of the page's weight for a backdrop under a scrim;
 *   - never with Data Saver on or on a 3G or slower connection;
 *   - never with reduced motion (as before);
 *   - and never before the page has finished loading and the browser is idle,
 *     so it cannot be what the first paint waits for. `preload="none"` keeps
 *     the browser from fetching it on its own; the effect below asks for it
 *     when it is time.
 *
 * The still stays under the video the whole time, as the poster.
 */
export function HeroBackground() {
  const reducedMotion = usePrefersReducedMotion();
  const [wantVideo, setWantVideo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const video = useRef<HTMLVideoElement>(null);

  // Decide once the page is done, not at mount: the landing renders while the
  // hero picture and the screenshot may still be arriving.
  useEffect(() => {
    if (reducedMotion || !heroVideoAllowed()) {
      return;
    }
    let cancelled = false;
    let idleId: number | undefined;
    let timerId: number | undefined;
    const ask = () => {
      if (cancelled) return;
      if (typeof window.requestIdleCallback === "function") {
        idleId = window.requestIdleCallback(() => setWantVideo(true), {
          timeout: 3000,
        });
      } else {
        timerId = window.setTimeout(() => setWantVideo(true), 1500);
      }
    };
    if (document.readyState === "complete") {
      ask();
    } else {
      window.addEventListener("load", ask, { once: true });
    }
    return () => {
      cancelled = true;
      window.removeEventListener("load", ask);
      if (idleId !== undefined) window.cancelIdleCallback?.(idleId);
      if (timerId !== undefined) window.clearTimeout(timerId);
    };
  }, [reducedMotion]);

  // `autoplay` alone is not enough: a tab that mounts in the background leaves
  // the element idle and Chrome does not revisit that on its own. Ask directly,
  // and ask again whenever the tab comes forward.
  useEffect(() => {
    const el = video.current;
    if (!el) return;
    const start = () => {
      if (el.readyState === 0) el.load();
      void el.play().catch(() => {
        // Autoplay refused (Low Power Mode, strict settings): the still stands in.
      });
    };
    start();
    document.addEventListener("visibilitychange", start);
    return () => document.removeEventListener("visibilitychange", start);
  }, [wantVideo]);

  return (
    <div className="hero-parallax pointer-events-none absolute inset-0" aria-hidden>
      <div className="hero-bg-art absolute inset-0" />
      {wantVideo && !reducedMotion && (
        <video
          ref={video}
          src="/images/hero-background.mp4"
          className={cn(
            "absolute inset-0 h-full w-full object-cover object-center transition-opacity duration-[1200ms] ease-out",
            playing ? "opacity-100" : "opacity-0",
          )}
          autoPlay
          muted
          loop
          playsInline
          preload="none"
          onPlaying={() => setPlaying(true)}
        />
      )}
    </div>
  );
}
