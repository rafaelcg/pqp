import { type RefObject, useEffect, useRef, useState } from "react";

/**
 * True while the element intersects the viewport, false again once it leaves.
 * The page's `useInView` only ever turns on (an entrance plays once); this one
 * goes both ways, so a Breu's loops run only while it is on screen.
 *
 * Starts false. Where IntersectionObserver does not exist it answers true, so
 * Breu still moves rather than freezing for good.
 */
export function useOnScreen<T extends Element>(rootMargin = "0px"): readonly [RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [onScreen, setOnScreen] = useState(() => typeof IntersectionObserver === "undefined");

  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setOnScreen(entry.isIntersecting);
      },
      { rootMargin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [rootMargin]);

  return [ref, onScreen] as const;
}
