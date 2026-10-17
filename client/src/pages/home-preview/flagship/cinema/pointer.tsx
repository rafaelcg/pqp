import { type CSSProperties, type PointerEvent, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "../../shared/motion";
import "./cinema.css";
import { useFinePointer } from "./progress";

/**
 * Pointer effects for a mouse or trackpad. Both are off on touch screens and
 * with reduced motion, where the content simply sits still. Each move asks
 * for one animation frame, reads one rect, writes a few CSS vars.
 */

function usePointerFrame(apply: (el: HTMLElement, x: number, y: number) => void, enabled: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const point = useRef<{ x: number; y: number } | null>(null);
  const applyRef = useRef(apply);
  useEffect(() => {
    applyRef.current = apply;
  });
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!enabled || e.pointerType !== "mouse") return;
    point.current = { x: e.clientX, y: e.clientY };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const el = ref.current;
      const p = point.current;
      if (el && p) applyRef.current(el, p.x, p.y);
    });
  };
  const onPointerLeave = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    point.current = null;
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-active");
    for (const name of ["--rx", "--ry", "--mgx", "--mgy"]) el.style.removeProperty(name);
  };
  return { ref, onPointerMove, onPointerLeave };
}

/**
 * Tilts its content toward the pointer in 3D (up to `max` degrees) with a
 * soft lime spotlight that follows the cursor, and springs back on leave.
 * Give it the card's radius class so the spotlight follows the corners.
 */
export function Tilt({
  children,
  className,
  max = 6,
  spotlight = true,
  perspective = 1100,
}: {
  children: ReactNode;
  className?: string;
  /** Largest tilt in degrees. */
  max?: number;
  spotlight?: boolean;
  /** CSS perspective distance in px. */
  perspective?: number;
}) {
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;
  const handlers = usePointerFrame((el, x, y) => {
    const r = el.getBoundingClientRect();
    const nx = Math.min(1, Math.max(0, (x - r.left) / r.width));
    const ny = Math.min(1, Math.max(0, (y - r.top) / r.height));
    el.style.setProperty("--ry", `${((nx - 0.5) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--rx", `${((0.5 - ny) * 2 * max).toFixed(2)}deg`);
    el.style.setProperty("--mx", `${(nx * 100).toFixed(1)}%`);
    el.style.setProperty("--my", `${(ny * 100).toFixed(1)}%`);
    el.setAttribute("data-active", "");
  }, enabled);

  return (
    <div
      ref={handlers.ref}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
      className={cn("relative", enabled && "cin-tilt", className)}
      style={enabled ? ({ "--tilt-persp": `${perspective}px` } as CSSProperties) : undefined}
    >
      {children}
      {enabled && spotlight && <span aria-hidden className="cin-tilt-spot" />}
    </div>
  );
}

/**
 * Wraps a call to action so it drifts a few pixels toward the pointer while
 * hovered and settles back on leave. The wrapper moves, never the button, so
 * the button keeps its own hover lift.
 */
export function Magnetic({
  children,
  className,
  strength = 0.25,
  max = 8,
}: {
  children: ReactNode;
  className?: string;
  /** Share of the pointer's offset from the centre that the content follows. */
  strength?: number;
  /** Largest drift in px. */
  max?: number;
}) {
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  const enabled = fine && !reduced;
  const handlers = usePointerFrame((el, x, y) => {
    const r = el.getBoundingClientRect();
    const clampMax = (v: number) => Math.max(-max, Math.min(max, v));
    // Measured with the current drift included, so subtract it back out.
    const cx = r.left + r.width / 2 - (Number.parseFloat(el.style.getPropertyValue("--mgx")) || 0);
    const cy = r.top + r.height / 2 - (Number.parseFloat(el.style.getPropertyValue("--mgy")) || 0);
    el.style.setProperty("--mgx", `${clampMax((x - cx) * strength).toFixed(2)}px`);
    el.style.setProperty("--mgy", `${clampMax((y - cy) * strength).toFixed(2)}px`);
    el.setAttribute("data-active", "");
  }, enabled);

  return (
    <div
      ref={handlers.ref}
      onPointerMove={handlers.onPointerMove}
      onPointerLeave={handlers.onPointerLeave}
      className={cn(enabled ? "cin-magnetic" : "inline-flex", className)}
    >
      {children}
    </div>
  );
}
