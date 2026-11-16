import { useEffect, useState, type CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * A waveform as a row of bars. Bars are plain elements, not a canvas: the
 * count follows the width (`useBarCount`), every bar is a token-coloured box,
 * and the entrance is a CSS stagger that switches off under reduced motion.
 */

/**
 * How many bars of `pitch` px (bar plus gap) fit across the element.
 *
 * The first value is a CALLBACK ref, not a ref object: the element it measures
 * may mount later than the component that asks (a tile that swaps its picture
 * for another layout, a cover that is removed), and a ref object read once in an
 * effect never saw the new element, so the waveform stayed at zero bars for good.
 */
export function useBarCount<T extends HTMLElement = HTMLDivElement>(
  pitch: number,
  max = 240,
): [(node: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [count, setCount] = useState(0);
  useEffect(() => {
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
  }, [element, pitch, max]);
  return [setElement, count];
}

/** The width of an element, followed as it resizes (a callback ref, so it also follows an element that mounts later). */
export function useElementWidth<T extends HTMLElement = HTMLDivElement>(): [(node: T | null) => void, number] {
  const [element, setElement] = useState<T | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!element) {
      return;
    }
    const measure = () => setWidth(element.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return [setElement, width];
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
          className={cn("min-w-0 max-w-[4px] flex-1 rounded-full", barClassName, animate && "jam-bar-in")}
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
