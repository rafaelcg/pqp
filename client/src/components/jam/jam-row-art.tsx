import { Music2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { JamRowMood } from "@/lib/jam-row-state";
import { jamRowMayAnimate } from "@/lib/jam-row-state";
import "./jam-row.css";

/**
 * The art behind the sidebar's Jam row, and the icon in front of it.
 *
 * The row is the door to a music room: a waveform in the colours of the
 * instruments (the same language as the song lanes) scrolls slowly behind the
 * right of the row, and scrolls faster the more is going on: hover, news, the
 * open page, a song playing (the bars pulse and the icon turns into an equaliser). Which face it wears is `jamRowMood`
 * (`lib/jam-row-state.ts`); hover and focus are CSS. Everything here is
 * `aria-hidden`: the row's name, count and "música nova" are real text.
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

const WAVE_INSTRUMENTS = ["vocals", "guitar", "drums", "keys", "bass", "other"] as const;
/** One loop of the waveform: 36 bars on a 6px pitch, six per instrument. */
const WAVE_BARS = 36;
const WAVE_PITCH = 6;
const WAVE_HEIGHT = 40;
const JAM_WAVE_PERIOD_PX = WAVE_BARS * WAVE_PITCH;

/** A fixed, smooth contour (two sines and a little grit), so the picture is the same on every render. */
const WAVE_HEIGHTS: readonly number[] = Array.from({ length: WAVE_BARS }, (_, i) => {
  const a = Math.sin((i / WAVE_BARS) * Math.PI * 6) * 0.5 + 0.5;
  const b = Math.sin((i / WAVE_BARS) * Math.PI * 14 + 1.3) * 0.5 + 0.5;
  const c = ((i * 7919) % 13) / 13;
  return Math.round((0.22 + 0.78 * (0.5 * a + 0.3 * b + 0.2 * c)) * 30);
});

/** Three loops side by side, so one loop can scroll out while the row stays covered up to 432px wide. */
function JamWave() {
  const loops = [0, 1, 2];
  return (
    <svg
      className="jam-wave-svg"
      viewBox={`0 0 ${JAM_WAVE_PERIOD_PX * loops.length} ${WAVE_HEIGHT}`}
      width={JAM_WAVE_PERIOD_PX * loops.length}
      height={WAVE_HEIGHT}
      focusable="false"
    >
      {loops.map((loop) =>
        WAVE_HEIGHTS.map((height, i) => (
          <rect
            key={`${loop}-${i}`}
            data-inst={WAVE_INSTRUMENTS[Math.floor(i / (WAVE_BARS / WAVE_INSTRUMENTS.length))]}
            x={loop * JAM_WAVE_PERIOD_PX + i * WAVE_PITCH}
            y={(WAVE_HEIGHT - height) / 2}
            width={3}
            height={height}
            rx={1.5}
          />
        )),
      )}
    </svg>
  );
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
    >
      <span className="jam-wave">
        <span className="jam-wave-scroll">
          <span className="jam-wave-beat">
            <JamWave />
          </span>
        </span>
      </span>
      <span className="jam-art-sheen" />
      {selected && <span className="jam-art-here" />}
    </span>
  );
}

/**
 * The yellow rounded square. A note while it is quiet; three bars standing in
 * for it while a song of this Jam is playing; the note gives a small hop when
 * there is news.
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
