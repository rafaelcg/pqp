import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PIN_MEDIA, PIN_QUERY } from "../hero-media";

/**
 * Scroll progress for the flagship's scenes, written as CSS custom properties
 * so React never re-renders per frame.
 *
 * One shared frame loop serves the whole page. It does not spin: a scroll or
 * resize asks for one animation frame, and only when at least one tracked
 * element is near the viewport (an IntersectionObserver keeps that set). Each
 * frame reads every rect first, then writes every value, and skips values that
 * did not change. An element that leaves the near set gets one last write so a
 * fast scroll never strands it halfway.
 */

/**
 * Pinned scenes run only here: wide screens that did not ask for less motion.
 * The values live in `hero-media.ts`, because the static first screen in
 * index.html pins at the same query and a test holds the two equal.
 */
export { PIN_MEDIA, PIN_QUERY };
const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/**
 * How progress is measured.
 * - `pin`: a tall wrapper with a sticky stage. 0 when its top reaches the top
 *   of the viewport, 1 when its bottom reaches the bottom.
 * - `through`: 0 when its top enters at the bottom of the viewport, 1 when its
 *   bottom leaves at the top.
 * - `enter`: 0 when its top enters at the bottom, 1 when its centre reaches
 *   the centre of the viewport. Good for things that should finish on arrival.
 */
export type ProgressMode = "pin" | "through" | "enter";

/** `in` and `out` are gentle (quadratic); `inOut` is a cubic S-curve. */
export type Ease = "linear" | "in" | "out" | "inOut";

/** A sub-range of progress, `[start, end]` or `[start, end, ease]`, each 0 to 1. */
export type ProgressRange = readonly [number, number] | readonly [number, number, Ease];

export type ProgressRanges = Readonly<Record<string, ProgressRange>>;

export interface SceneProgressOptions {
  mode?: ProgressMode;
  /** Named sub-ranges, each written as `--p-<name>` (0 to 1, eased). */
  ranges?: ProgressRanges;
  /** Track only while this media query matches. */
  media?: string;
  /** Mode to track in when `media` does not match. Without it the values rest. */
  otherwise?: ProgressMode;
  /** Value `--p` holds when not tracking (reduced motion, media off). Default 1. */
  rest?: number;
  /** Called from the frame loop with the raw progress. For DOM writes, not React state. */
  onProgress?: (p: number) => void;
}

type CompiledRange = { name: string; start: number; end: number; ease: Ease };

interface Tracker {
  el: HTMLElement;
  mode: ProgressMode;
  ranges: CompiledRange[];
  near: boolean;
  dirty: boolean;
  last: number;
  onProgress: RefObject<((p: number) => void) | undefined>;
}

const trackers = new Set<Tracker>();
const byElement = new Map<Element, Tracker>();
let io: IntersectionObserver | null = null;
let ro: ResizeObserver | null = null;
let frame = 0;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function ease(kind: Ease, t: number): number {
  switch (kind) {
    case "in":
      return t * t;
    case "out":
      return 1 - (1 - t) ** 2;
    case "inOut":
      return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    default:
      return t;
  }
}

function progressOf(mode: ProgressMode, rect: DOMRect, vh: number): number {
  if (mode === "pin") {
    const run = rect.height - vh;
    if (run <= 0) return rect.top <= 0 ? 1 : 0;
    return clamp01(-rect.top / run);
  }
  if (mode === "enter") return clamp01((vh - rect.top) / (vh * 0.5 + rect.height * 0.5));
  return clamp01((vh - rect.top) / (rect.height + vh));
}

function writeValues(
  el: HTMLElement,
  p: number,
  ranges: CompiledRange[],
  onProgress?: (p: number) => void,
) {
  el.style.setProperty("--p", p.toFixed(4));
  for (const r of ranges) {
    const span = r.end - r.start;
    const local = span <= 0 ? (p >= r.end ? 1 : 0) : clamp01((p - r.start) / span);
    el.style.setProperty(`--p-${r.name}`, ease(r.ease, local).toFixed(4));
  }
  onProgress?.(p);
}

function tick() {
  frame = 0;
  const vh = window.innerHeight;
  const work: [Tracker, DOMRect][] = [];
  // Reads first...
  for (const t of trackers) {
    if (t.near || t.dirty) work.push([t, t.el.getBoundingClientRect()]);
  }
  // ...then writes.
  for (const [t, rect] of work) {
    t.dirty = false;
    const p = progressOf(t.mode, rect, vh);
    if (Math.abs(p - t.last) < 0.0001) continue;
    t.last = p;
    writeValues(t.el, p, t.ranges, t.onProgress.current);
  }
}

function schedule() {
  if (frame) return;
  for (const t of trackers) {
    if (t.near || t.dirty) {
      frame = requestAnimationFrame(tick);
      return;
    }
  }
}

function scheduleAll() {
  for (const t of trackers) t.dirty = true;
  schedule();
}

function start() {
  if (io) return;
  io = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const t = byElement.get(entry.target);
        if (!t) continue;
        t.near = entry.isIntersecting;
        // Leaving: one more write so the value lands on 0 or 1.
        t.dirty = true;
      }
      schedule();
    },
    { rootMargin: "25% 0px 25% 0px" },
  );
  ro = new ResizeObserver(scheduleAll);
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", scheduleAll, { passive: true });
}

function stop() {
  io?.disconnect();
  ro?.disconnect();
  io = null;
  ro = null;
  window.removeEventListener("scroll", schedule);
  window.removeEventListener("resize", scheduleAll);
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
}

function register(
  el: HTMLElement,
  mode: ProgressMode,
  ranges: CompiledRange[],
  onProgress: RefObject<((p: number) => void) | undefined>,
) {
  start();
  const t: Tracker = { el, mode, ranges, near: false, dirty: false, last: -1, onProgress };
  trackers.add(t);
  byElement.set(el, t);
  io?.observe(el);
  ro?.observe(el);
  // Measure once now, so a reload or an anchor jump mid-page starts right.
  const p = progressOf(mode, el.getBoundingClientRect(), window.innerHeight);
  t.last = p;
  writeValues(el, p, ranges, onProgress.current);
  return () => {
    trackers.delete(t);
    byElement.delete(el);
    io?.unobserve(el);
    ro?.unobserve(el);
    if (trackers.size === 0) stop();
  };
}

function compileRanges(key: string): CompiledRange[] {
  const parsed = JSON.parse(key) as Record<string, ProgressRange> | null;
  if (!parsed) return [];
  return Object.entries(parsed).map(([name, r]) => ({
    name,
    start: r[0],
    end: r[1],
    ease: r[2] ?? "linear",
  }));
}

/**
 * Writes `--p` (0 to 1) on `ref`'s element as it scrolls, plus `--p-<name>`
 * for each named range. With reduced motion, or while `media` does not match
 * and there is no `otherwise`, the values hold `rest` (default 1, the final
 * state) and nothing is tracked.
 */
export function useSceneProgress<T extends HTMLElement>(
  ref: RefObject<T | null>,
  options: SceneProgressOptions = {},
) {
  const { mode = "through", ranges, media, otherwise, rest = 1, onProgress } = options;
  const rangesKey = JSON.stringify(ranges ?? null);
  const callback = useRef(onProgress);
  useEffect(() => {
    callback.current = onProgress;
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof window === "undefined") return;
    const compiled = compileRanges(rangesKey);
    const reduced = window.matchMedia(REDUCED_QUERY);
    const mq = media ? window.matchMedia(media) : null;
    let release: (() => void) | null = null;

    const apply = () => {
      release?.();
      release = null;
      const active: ProgressMode | null = reduced.matches
        ? null
        : !mq || mq.matches
          ? mode
          : (otherwise ?? null);
      if (active && typeof IntersectionObserver !== "undefined") {
        release = register(el, active, compiled, callback);
      } else {
        writeValues(el, rest, compiled, callback.current);
      }
    };

    apply();
    reduced.addEventListener("change", apply);
    mq?.addEventListener("change", apply);
    return () => {
      reduced.removeEventListener("change", apply);
      mq?.removeEventListener("change", apply);
      release?.();
    };
  }, [ref, mode, media, otherwise, rest, rangesKey]);
}

/** True while a media query matches. Follows changes live. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);
  return matches;
}

/** True where pinned scenes run (lg and up, motion allowed). */
export function usePinnedScenes(): boolean {
  return useMediaQuery(PIN_QUERY);
}

/** True for a mouse or trackpad that can hover (a clip then plays on hover). */
export function useFinePointer(): boolean {
  return useMediaQuery("(hover: hover) and (pointer: fine)");
}

/**
 * CSS for a value that moves from `from` to `to` as `progress` goes 0 to 1.
 * `mix("0.8", "1")` gives `calc(0.8 + (1 - 0.8) * var(--p))`; lengths and
 * angles work the same (`mix("40px", "0px", "var(--p-frame)")`).
 */
export function mix(from: string, to: string, progress = "var(--p)"): string {
  return `calc(${from} + (${to} - ${from}) * ${progress})`;
}

/**
 * CSS for a sub-range of a progress value, 0 before `start`, 1 after `end`,
 * linear between. For one-off beats without declaring a named range.
 */
export function within(start: number, end: number, progress = "var(--p)"): string {
  return `clamp(0, calc((${progress} - ${start}) / ${end - start}), 1)`;
}
