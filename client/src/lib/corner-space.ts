/**
 * ROOM FOR A PHONE'S CORNER CARD, so it never covers what it is not attached to.
 *
 * A corner card is `position: fixed` along the bottom of a phone, full width, and the page under it
 * keeps its whole height: "A Jam abriu" sat on the lower half of the first-run card on the app's
 * home, and any card sits on the last row of whatever is behind it (launch screenshots, problem 8).
 *
 * The fix is to make the page shorter instead of the card smaller: while a corner card is up below
 * the `sm` breakpoint, `html` carries `--pqp-corner-space` (the tallest card's height plus its
 * margin) and `html[data-corner-space] #root` ends that far above the bottom of the window, which is
 * where the card is. Nothing is hidden behind it, the page scrolls inside what is left, and when the
 * card goes the page takes its height back. The rule is in `index.css`; from `sm` up the card is a
 * corner of a desktop window and takes no room.
 *
 * Cards stack at one spot (the queue shows one; the update notice may sit over it), so the space is
 * the tallest, not the sum.
 */

const VARIABLE = "--pqp-corner-space";
/** `bottom-3` of the card, and a breath between the page and it. */
const MARGIN_PX = 12 + 8;

const heights = new Map<object, number>();

function apply(): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const tallest = Math.max(0, ...heights.values());
  if (tallest <= 0) {
    root.style.removeProperty(VARIABLE);
    root.removeAttribute("data-corner-space");
    return;
  }
  root.style.setProperty(VARIABLE, `${Math.ceil(tallest + MARGIN_PX)}px`);
  root.setAttribute("data-corner-space", "");
}

/** The space a card asks for right now, in px (0 when none): for tests. */
export function cornerSpaceNow(): number {
  return Math.max(0, ...heights.values());
}

/**
 * Keep the page above `element` for as long as it is mounted. Follows the element's height (a card
 * that grows, a language that wraps) and lets go of it on cleanup. Returns the cleanup.
 */
export function reserveCornerSpace(element: HTMLElement): () => void {
  const key = element;
  const measure = () => {
    // The card's own box, not its entrance animation: `offsetHeight` ignores transforms.
    heights.set(key, element.offsetHeight);
    apply();
  };
  measure();
  let observer: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    observer = new ResizeObserver(measure);
    observer.observe(element);
  }
  return () => {
    observer?.disconnect();
    heights.delete(key);
    apply();
  };
}
