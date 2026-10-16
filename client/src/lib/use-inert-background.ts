import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";

/**
 * Make the page behind a modal surface truly unreachable: every other top-level child of `<body>`
 * gets `inert` (no focus, no clicks, out of the accessibility tree) while the modal is mounted.
 * `aria-modal` alone only helps a screen reader; a browser whose Tab order walks form fields first
 * (Safari) otherwise leaves a modal for the chat behind it.
 *
 * Only what is on the page at mount is made inert, so anything the modal opens later (a menu, a
 * dialog, a toast, all portalled to the body) stays usable. Returns `release`, for a modal that
 * hands focus back to the page BEFORE it unmounts: an inert element cannot take focus.
 */
export function useInertBackground(ref: RefObject<HTMLElement | null>): () => void {
  const marked = useRef<HTMLElement[]>([]);
  const release = useCallback(() => {
    for (const element of marked.current) {
      element.removeAttribute("inert");
    }
    marked.current = [];
  }, []);
  useLayoutEffect(() => {
    const own = ref.current;
    if (!own) {
      return;
    }
    for (const element of Array.from(document.body.children)) {
      if (
        !(element instanceof HTMLElement) ||
        element === own ||
        element.contains(own) ||
        own.contains(element) ||
        element.hasAttribute("inert") ||
        element.tagName === "SCRIPT"
      ) {
        continue;
      }
      element.setAttribute("inert", "");
      marked.current.push(element);
    }
    return release;
  }, [ref, release]);
  return release;
}
