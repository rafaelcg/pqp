import { useLayoutEffect, useState, type RefObject } from "react";

/**
 * True while the element's content is wider than its box.
 *
 * The measure block already proven in `ui/marquee-text.tsx`: compare
 * `scrollWidth` to `clientWidth` after layout, and again whenever the box's
 * own size changes (a `ResizeObserver` on the element itself, not the
 * window — a sidebar resize handle changes the box without changing the
 * viewport). The `+ 1` is not cosmetic: sub-pixel layout makes `scrollWidth`
 * exceed `clientWidth` by a fraction even on a box that fits perfectly.
 */
export function useIsTruncated(
  ref: RefObject<HTMLElement | null>,
  dep: string,
): boolean {
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const measure = () => setTruncated(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, dep]);

  return truncated;
}
