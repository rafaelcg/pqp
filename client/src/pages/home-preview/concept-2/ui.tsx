import { useEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useInView, useReducedMotion } from "../shared/motion";
import "../shared/mock.css";
import "./c2.css";

/**
 * The street-poster kit for the Lambe-lambe concept: sheets of paper, tape,
 * rubber stamps, halftone dots. Styling that needs gradients and clip paths
 * lives in `c2.css`; layout and type live in Tailwind at the call site.
 */

export const CONTAINER = "mx-auto w-full max-w-[1240px] px-5 sm:px-8";

/** Sets the rotation and the paste-in delay a `Paste` reads from CSS. */
function vars(r: string, delay = 0): CSSProperties {
  return { "--r": r, "--d": `${delay}ms` } as CSSProperties;
}

/**
 * Rotates its children by `r` and pastes them in the first time they scroll
 * into view. The rotation is part of the final state, so with reduced motion
 * (or before the observer fires, for a blink) the sheet is simply there.
 */
export function Paste({
  r = "0deg",
  delay = 0,
  className,
  children,
}: {
  r?: string;
  delay?: number;
  className?: string;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin: "0px 0px -8% 0px" });
  return (
    <div ref={ref} data-in={inView || reduced} className={cn("c2-paste relative", className)} style={vars(r, delay)}>
      {children}
    </div>
  );
}

const SHEET_TONES = {
  paper: "bg-paper text-ink c2-grain",
  lime: "bg-signal text-ink c2-grain",
  ink: "bg-ink-2 text-paper border-[6px] border-paper",
} as const;

/** One sheet of paper on the wall. Put tape and stamps beside it, in `Paste`. */
export function Sheet({
  tone = "paper",
  crease = false,
  torn = false,
  className,
  children,
}: {
  tone?: keyof typeof SHEET_TONES;
  crease?: boolean;
  torn?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "relative isolate",
        SHEET_TONES[tone],
        crease && "c2-crease",
        torn && "c2-torn-b",
        tone !== "ink" && !torn && "shadow-[0_1px_0_color-mix(in_oklch,black_30%,transparent),0_22px_40px_-22px_color-mix(in_oklch,black_85%,transparent)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/* One scroll listener drives every tape strip and stamp that drifts. */
interface Mover {
  anchor: HTMLElement;
  mover: HTMLElement;
  amp: number;
}
const movers = new Set<Mover>();
let frame = 0;
let listening = false;

function run() {
  frame = 0;
  const vh = window.innerHeight;
  movers.forEach((m) => {
    const rect = m.anchor.getBoundingClientRect();
    if (rect.bottom < -240 || rect.top > vh + 240) return;
    const t = Math.max(-1, Math.min(1, (rect.top + rect.height / 2 - vh / 2) / vh));
    m.mover.style.transform = `translate3d(0, ${(t * m.amp).toFixed(1)}px, 0)`;
  });
}
function schedule() {
  if (!frame) frame = requestAnimationFrame(run);
}
function addMover(m: Mover) {
  movers.add(m);
  if (!listening) {
    listening = true;
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
  }
  schedule();
}
function removeMover(m: Mover) {
  movers.delete(m);
  if (!movers.size && listening) {
    listening = false;
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", schedule);
  }
}

/**
 * Lets tape and stamps slide a few pixels against the sheet as the page
 * scrolls, as if they were stuck on by hand and not by a grid. Transform only.
 * `className` positions the (untransformed) anchor; reduced motion renders
 * the children in place with no listener at all.
 */
export function Drift({ amp = 14, className, children }: { amp?: number; className?: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  const anchor = useRef<HTMLDivElement>(null);
  const mover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reduced) return;
    const a = anchor.current;
    const m = mover.current;
    if (!a || !m) return;
    const entry: Mover = { anchor: a, mover: m, amp };
    addMover(entry);
    return () => {
      removeMover(entry);
      m.style.transform = "";
    };
  }, [reduced, amp]);
  return (
    <div ref={anchor} className={className}>
      <div ref={mover} className={reduced ? undefined : "will-change-transform"}>
        {children}
      </div>
    </div>
  );
}

/** A strip of masking tape. Decorative. */
export function Tape({
  tone = "light",
  w = 96,
  r = -4,
  className,
}: {
  tone?: "light" | "lime" | "dark";
  w?: number;
  r?: number;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("c2-tape", `c2-tape--${tone}`, className)}
      style={{ width: w, "--r": `${r}deg` } as CSSProperties}
    />
  );
}

/** A rubber stamp. It lands with a thump the first time it is on screen. */
export function Stamp({ children, r = -6, className }: { children: ReactNode; r?: number; className?: string }) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLSpanElement>({ rootMargin: "0px 0px -6% 0px" });
  return (
    <span
      ref={ref}
      data-in={inView || reduced}
      className={cn("c2-stamp", className)}
      style={{ "--r": `${r}deg` } as CSSProperties}
    >
      {children}
    </span>
  );
}

/**
 * Printed halftone: a grid of dots whose size follows a tone ramp, as in a
 * newspaper photo. Draws in `currentColor`, so set the colour with a text
 * class. The parent needs `relative` and `overflow-hidden`.
 */
export function Halftone({
  cols = 28,
  rows = 14,
  shape = "down",
  max = 4.6,
  className,
}: {
  cols?: number;
  rows?: number;
  shape?: "down" | "up" | "right" | "left" | "radial" | "corner";
  max?: number;
  className?: string;
}) {
  const dots = useMemo(() => {
    const out: ReactNode[] = [];
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const fx = cols > 1 ? x / (cols - 1) : 0;
        const fy = rows > 1 ? y / (rows - 1) : 0;
        let t: number;
        if (shape === "down") t = fy;
        else if (shape === "up") t = 1 - fy;
        else if (shape === "right") t = fx;
        else if (shape === "left") t = 1 - fx;
        else if (shape === "corner") t = (fx + fy) / 2;
        else t = 1 - Math.min(1, Math.hypot(fx - 0.5, fy - 0.5) * 2);
        const r = max * Math.sqrt(Math.max(0, t));
        if (r < 0.45) continue;
        out.push(<circle key={`${x}-${y}`} cx={x * 10 + 5 + (y % 2 ? 5 : 0)} cy={y * 10 + 5} r={r.toFixed(2)} />);
      }
    }
    return out;
  }, [cols, rows, shape, max]);
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${cols * 10} ${rows * 10}`}
      preserveAspectRatio="xMidYMid slice"
      className={cn("pointer-events-none absolute inset-0 h-full w-full", className)}
      fill="currentColor"
    >
      {dots}
    </svg>
  );
}

/** Small caps label. */
export function Kicker({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("font-display text-[12px] font-bold uppercase tracking-[0.2em]", className)}>{children}</p>
  );
}

/** The label every sample piece of content carries. */
export function ExampleTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border border-current px-1.5 py-px text-[10px] font-bold uppercase leading-4 tracking-[0.14em] opacity-75",
        className,
      )}
    >
      exemplo
    </span>
  );
}

const BTN_BASE =
  "inline-flex min-h-12 items-center justify-center gap-2 rounded-md border-2 px-5 py-2.5 text-center font-display text-[15px] font-bold uppercase leading-none tracking-[0.04em] transition-[transform,box-shadow,background-color,color] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 active:translate-x-[3px] active:translate-y-[3px] active:shadow-none motion-reduce:transition-none";

/** Buttons are cut-out labels with a hard offset shadow, like a screen print. */
export const BTN = {
  /** Lime, on the dark wall. */
  lime: cn(
    BTN_BASE,
    "border-signal bg-signal text-ink shadow-[4px_4px_0_0_var(--color-text)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-text)] focus-visible:ring-paper focus-visible:ring-offset-ink",
  ),
  /** Outline, on the dark wall. */
  line: cn(
    BTN_BASE,
    "border-paper text-paper shadow-[4px_4px_0_0_var(--color-accent)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-paper hover:text-ink hover:shadow-[6px_6px_0_0_var(--color-accent)] focus-visible:ring-signal focus-visible:ring-offset-ink",
  ),
  /** Black, on cream paper. */
  inkOnPaper: cn(
    BTN_BASE,
    "border-ink bg-ink text-paper shadow-[4px_4px_0_0_var(--color-accent)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-accent)] focus-visible:ring-ink focus-visible:ring-offset-paper",
  ),
  /** Black, on a lime sheet. */
  inkOnLime: cn(
    BTN_BASE,
    "border-ink bg-ink text-paper shadow-[4px_4px_0_0_var(--color-paper)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-paper)] focus-visible:ring-ink focus-visible:ring-offset-signal",
  ),
  /** Cream outline, on a lime sheet. */
  paperOnLime: cn(
    BTN_BASE,
    "border-ink bg-paper text-ink shadow-[4px_4px_0_0_var(--color-ink)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:shadow-[6px_6px_0_0_var(--color-ink)] focus-visible:ring-ink focus-visible:ring-offset-signal",
  ),
  /** Outline, on cream paper. */
  linePaper: cn(
    BTN_BASE,
    "border-ink text-ink shadow-[4px_4px_0_0_var(--color-ink)] hover:-translate-x-0.5 hover:-translate-y-0.5 hover:bg-ink hover:text-paper hover:shadow-[6px_6px_0_0_var(--color-ink)] focus-visible:ring-ink focus-visible:ring-offset-paper",
  ),
};

/** An inline link that reads as a marker underline. `on` picks the paper it sits on. */
export const LINK = {
  paper:
    "inline-flex min-h-10 items-center gap-1.5 font-semibold underline decoration-ink/40 decoration-2 underline-offset-4 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-paper",
  ink: "inline-flex min-h-10 items-center gap-1.5 font-semibold underline decoration-signal/60 decoration-2 underline-offset-4 transition-colors hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink",
  lime: "inline-flex min-h-10 items-center gap-1.5 font-semibold underline decoration-ink/50 decoration-2 underline-offset-4 transition-colors hover:decoration-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-signal",
};
