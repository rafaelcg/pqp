import { useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Rows that move, glide; rows that arrive, fade up. FLIP on the children of
 * a list container that carry `data-flip-key`: measure where each row was on
 * the previous render, where it is now, and play the difference back to zero
 * with the Web Animations API (transform and opacity only, so it stays on the
 * compositor).
 *
 * For the Conversas list, where a conversation that just got a message jumps
 * to the top: without this the row teleports and the eye loses it.
 *
 * The timing and curve are the theme's (`--duration-base`,
 * `--ease-emphasized`), read once per pass. Nothing at all runs under
 * `prefers-reduced-motion: reduce`, nor on the first render, nor when the
 * container is not on screen.
 */
/** Past this many rows the list just re-orders, without measuring anything. */
export const FLIP_MAX_ROWS = 120;

export function useFlipList(
  container: RefObject<HTMLElement | null>,
  /** Anything that changes when the order or the set of rows changes. */
  signature: string,
): void {
  const previous = useRef<Map<string, number> | null>(null);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root) {
      return;
    }
    const rows = Array.from(root.querySelectorAll<HTMLElement>("[data-flip-key]"));
    // A very long list is not animated at all: measuring hundreds of rows on
    // every reorder costs more than the glide is worth.
    if (rows.length > FLIP_MAX_ROWS) {
      previous.current = null;
      return;
    }
    // In the container's own scroll coordinates, so scrolling between two
    // passes is not mistaken for every row having moved.
    // Every read first, every write after: one layout pass, no thrash.
    const origin = root.getBoundingClientRect().top - root.scrollTop;
    const viewportHeight = window.innerHeight;
    const now = new Map<string, number>();
    const visible = new Set<HTMLElement>();
    for (const row of rows) {
      const rect = row.getBoundingClientRect();
      now.set(row.dataset.flipKey!, rect.top - origin);
      // Off screen either side: nobody can see it move.
      if (rect.bottom >= 0 && rect.top <= viewportHeight) {
        visible.add(row);
      }
    }
    const before = previous.current;
    previous.current = now;
    if (!before || prefersReducedMotion() || root.getClientRects().length === 0) {
      return;
    }
    const style = getComputedStyle(root);
    const duration = parseMs(style.getPropertyValue("--duration-base"), 200);
    const easing = style.getPropertyValue("--ease-emphasized").trim() || "ease-out";
    for (const row of visible) {
      if (typeof row.animate !== "function") {
        continue;
      }
      const key = row.dataset.flipKey!;
      const was = before.get(key);
      const is = now.get(key)!;
      if (was === undefined) {
        row.animate(
          [
            { opacity: 0, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
          { duration, easing },
        );
      } else if (Math.abs(was - is) > 1) {
        row.animate(
          [{ transform: `translateY(${was - is}px)` }, { transform: "translateY(0)" }],
          { duration, easing },
        );
      }
    }
    // Only a change of order or membership is worth a measuring pass.
  }, [container, signature]);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function parseMs(value: string, fallback: number): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("ms")) {
    return Number.parseFloat(trimmed) || fallback;
  }
  if (trimmed.endsWith("s")) {
    return (Number.parseFloat(trimmed) || fallback / 1000) * 1000;
  }
  return fallback;
}
