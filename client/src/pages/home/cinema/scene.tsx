import { type CSSProperties, createContext, type ReactNode, type Ref, useContext, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import "./cinema.css";
import { PIN_MEDIA, type ProgressRanges, usePinnedScenes, useSceneProgress } from "./progress";

const SceneContext = createContext<{ pinned: boolean }>({ pinned: false });

/**
 * Inside a Scene: whether it is pinned right now (lg and up, motion allowed).
 * Use it to give the pinned layout its scroll-linked styles and the stacked
 * layout none.
 */
export function useScene() {
  return useContext(SceneContext);
}

/**
 * A pinned scroll scene. At lg and up (motion allowed) it is a runway
 * `height` tall with a sticky, full-screen stage, and writes `--p` (0 to 1
 * through the pin) plus `--p-<name>` for each named range on the runway, so
 * children can style themselves with `calc()` on those vars.
 *
 * Below lg, or with reduced motion, it is an ordinary block and its content
 * stacks. `below="rest"` (default) holds every value at its final state;
 * `below="track"` keeps them moving as the block crosses the viewport
 * (finishing when its centre reaches the centre of the screen).
 */
export function Scene({
  children,
  height = "200vh",
  ranges,
  below = "rest",
  as = "div",
  id,
  label,
  labelledBy,
  className,
  stageClassName,
  stageRef,
  onProgress,
  attrs,
}: {
  children: ReactNode;
  /** Height of the runway at lg, a CSS length (for example "220vh"). */
  height?: string;
  ranges?: ProgressRanges;
  below?: "rest" | "track";
  as?: "div" | "section";
  id?: string;
  /** Accessible name for a section landmark. */
  label?: string;
  labelledBy?: string;
  className?: string;
  stageClassName?: string;
  stageRef?: Ref<HTMLDivElement>;
  /** Raw progress per frame, for DOM writes (never React state). */
  onProgress?: (p: number) => void;
  /**
   * `data-*` attributes for the root element, so a stylesheet can find one
   * scene (the hero's `data-home-hero`).
   */
  attrs?: Readonly<Record<`data-${string}`, string | undefined>>;
}) {
  const ref = useRef<HTMLElement>(null);
  const pinned = usePinnedScenes();
  useSceneProgress(ref, {
    mode: "pin",
    media: PIN_MEDIA,
    otherwise: below === "track" ? "enter" : undefined,
    ranges,
    onProgress,
  });
  const value = useMemo(() => ({ pinned }), [pinned]);
  const Tag = as as "div";
  return (
    <SceneContext.Provider value={value}>
      <Tag
        {...attrs}
        ref={ref as Ref<HTMLDivElement>}
        id={id}
        aria-label={label}
        aria-labelledby={labelledBy}
        className={cn("cin-scene relative", className)}
        style={{ "--scene-h": height } as CSSProperties}
      >
        <div ref={stageRef} className={cn("cin-stage relative", stageClassName)}>
          {children}
        </div>
      </Tag>
    </SceneContext.Provider>
  );
}

const NO_REF = { current: null };

/**
 * Moves its content vertically against the scroll for depth. `speed` is the
 * share of the viewport height travelled across the whole pass (0.15 moves it
 * 7.5vh either side of its place); negative speeds move with the scroll. At
 * the middle of the pass, and with reduced motion, it sits exactly where the
 * layout put it.
 */
export function Parallax({
  children,
  speed = 0.15,
  className,
  innerClassName,
  progress,
}: {
  children: ReactNode;
  speed?: number;
  className?: string;
  innerClassName?: string;
  /** Follow a scene's progress (a CSS expression) instead of tracking itself. */
  progress?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const own = progress === undefined;
  useSceneProgress(own ? ref : NO_REF, { mode: "through", rest: 0.5 });
  const p = own ? "var(--p, 0.5)" : progress;
  return (
    <div ref={ref} className={className}>
      <div
        className={innerClassName}
        style={{ transform: `translate3d(0, calc((0.5 - ${p}) * ${speed * 100}vh), 0)` }}
      >
        {children}
      </div>
    </div>
  );
}
