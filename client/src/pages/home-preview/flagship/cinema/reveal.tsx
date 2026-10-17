import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useInView } from "../../shared/motion";
import "./cinema.css";

/**
 * Brings content in the first time it scrolls into view: a fade with a rise
 * (`rise`), a rise with a slight scale (`scale`), or a top-down clip wipe
 * (`wipe`). With `stagger`, each direct child enters in turn instead of the
 * block as a whole. With reduced motion nothing is ever hidden.
 */
export function Reveal({
  children,
  as = "div",
  variant = "rise",
  stagger = false,
  delay = 0,
  className,
  style,
}: {
  children: ReactNode;
  as?: "div" | "section" | "ul" | "ol" | "figure" | "header";
  variant?: "rise" | "scale" | "wipe";
  /** Stagger direct children: true for 90 ms steps, or a step in ms. */
  stagger?: boolean | number;
  /** Delay before the first item, in ms. */
  delay?: number;
  className?: string;
  style?: CSSProperties;
}) {
  const [ref, inView] = useInView<HTMLDivElement>({ rootMargin: "0px 0px -10% 0px" });
  const [done, setDone] = useState(false);
  const Tag = as as "div";
  const step = typeof stagger === "number" ? stagger : 90;
  // Once every item has arrived, hand transitions back to the content.
  useEffect(() => {
    if (!inView) return;
    const id = window.setTimeout(() => setDone(true), delay + (stagger ? step * 12 : 0) + 1000);
    return () => window.clearTimeout(id);
  }, [inView, delay, stagger, step]);
  return (
    <Tag
      ref={ref}
      data-variant={variant}
      data-stagger={stagger ? "" : undefined}
      data-in={inView ? "" : undefined}
      data-done={done ? "" : undefined}
      className={cn("cin-reveal", className)}
      style={{ ...style, "--reveal-delay": `${delay}ms`, "--reveal-step": `${step}ms` } as CSSProperties}
    >
      {children}
    </Tag>
  );
}

/**
 * An endless horizontal row, CSS only: the content is drawn twice and slides
 * by half its width. Pauses on hover, off screen and in a hidden tab; still
 * with reduced motion. The second copy is hidden from screen readers and
 * inert, so links inside are reached once.
 */
export function Marquee({
  children,
  seconds = 40,
  reverse = false,
  className,
  trackClassName,
}: {
  children: ReactNode;
  /** One full loop, in seconds. */
  seconds?: number;
  reverse?: boolean;
  className?: string;
  trackClassName?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    let onScreen = true;
    const update = () => setPaused(!onScreen || document.visibilityState !== "visible");
    const io = new IntersectionObserver(([e]) => {
      onScreen = e.isIntersecting;
      update();
    });
    io.observe(el);
    document.addEventListener("visibilitychange", update);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return (
    <div
      ref={ref}
      data-paused={paused ? "" : undefined}
      data-reverse={reverse ? "" : undefined}
      className={cn("cin-marquee overflow-hidden", className)}
      style={{ "--marquee-s": `${seconds}s` } as CSSProperties}
    >
      <div className={cn("cin-marquee-track flex w-max", trackClassName)}>
        <div className="flex shrink-0 items-center">{children}</div>
        <div className="flex shrink-0 items-center" aria-hidden inert>
          {children}
        </div>
      </div>
    </div>
  );
}
