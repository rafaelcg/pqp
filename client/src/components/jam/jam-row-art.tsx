import { Music2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JamRowMood } from "@/lib/jam-row-state";
import { jamRowMayAnimate } from "@/lib/jam-row-state";
import "./jam-row.css";

/**
 * The plate behind the sidebar's Jam row, and the icon in front of it.
 *
 * The plate is plain on purpose: a base, a hover step and the open-page step,
 * like every other row. A scrolling waveform and a coloured edge marker were
 * tried here and removed (2026-11-11): decoration in a list of channels read
 * as noise. The one thing that moves is the icon, which turns into a small
 * equaliser while a song of this Jam is playing. Which face it wears is
 * `jamRowMood` (`lib/jam-row-state.ts`). Everything here is `aria-hidden`:
 * the row's name, count and "música nova" are real text.
 */

/** True while the row is on screen and the tab is visible: only then may it animate. */
function useAlive(): [React.RefObject<HTMLSpanElement | null>, boolean] {
  const ref = useRef<HTMLSpanElement | null>(null);
  const [inView, setInView] = useState(true);
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const last = entries[entries.length - 1];
      if (last) {
        setInView(last.isIntersecting);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, jamRowMayAnimate(inView, pageVisible)];
}

export function JamRowArt({ mood, selected }: { mood: JamRowMood; selected: boolean }) {
  const [ref, alive] = useAlive();
  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-jam-art=""
      data-mood={mood}
      data-selected={selected ? "true" : "false"}
      data-alive={alive ? "true" : "false"}
      className="jam-row-art"
    />
  );
}

/**
 * The yellow rounded square. A note while it is quiet; three bars standing in
 * for it while a song of this Jam is playing.
 */
export function JamRowIcon({ mood }: { mood: JamRowMood }) {
  return (
    <span aria-hidden="true" data-jam-icon="" data-mood={mood} className="jam-row-icon">
      <Music2 className="jam-icon-note h-3 w-3" />
      <span className="jam-icon-eq">
        <span />
        <span />
        <span />
      </span>
    </span>
  );
}
