import { useEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * A waveform as a row of bars. Bars are plain elements, not a canvas: the
 * count follows the width (`useBarCount`), every bar is a token-coloured box,
 * and the entrance is a CSS stagger that switches off under reduced motion.
 */

/** How many bars of `pitch` px (bar plus gap) fit across the element. */
export function useBarCount(pitch: number, max = 240): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }
    const measure = () => {
      const next = Math.max(0, Math.min(max, Math.floor(element.clientWidth / pitch)));
      setCount((before) => (before === next ? before : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [pitch, max]);
  return [ref, count];
}

export function JamBars({
  bars,
  className,
  barClassName = "bg-on-inst",
  animate = false,
  minPercent = 8,
}: {
  /** Heights in 0..1. */
  bars: readonly number[];
  className?: string;
  barClassName?: string;
  /** Stagger the bars growing in (the first paint of a tile). */
  animate?: boolean;
  /** The shortest a bar is drawn, so silence is still a line. */
  minPercent?: number;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-[2px]", className)} aria-hidden="true">
      {bars.map((height, index) => (
        <span
          key={index}
          className={cn("min-w-0 flex-1 rounded-full", barClassName, animate && "jam-bar-in")}
          style={
            {
              height: `${Math.max(minPercent, Math.round(height * 100))}%`,
              "--jam-b": Math.min(index, 40),
            } as CSSProperties
          }
        />
      ))}
    </div>
  );
}
