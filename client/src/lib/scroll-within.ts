/**
 * Scroll ONE container so a node inside it is in view, and nothing else.
 *
 * `Element.scrollIntoView` does not scroll a container, it scrolls every
 * scrollable ancestor of the node until the node is where it was asked to be.
 * `overflow: hidden` counts as scrollable to script, and the app shell is
 * `overflow: hidden`. So whenever the transcript could not travel far enough
 * on its own (a NEW divider three messages from the end cannot be centred),
 * the browser made up the difference by scrolling the shell, and the whole app
 * slid up under a black band (2026-09-23). The transcript is the only thing a
 * jump inside the transcript is allowed to move.
 */

export type RevealBlock = "center" | "start" | "nearest";

/** What `scrollTopToReveal` needs, in the container's own coordinates. */
export interface RevealGeometry {
  /** The container's current `scrollTop`. */
  scrollTop: number;
  /** The container's `clientHeight`: the height of what it shows. */
  clientHeight: number;
  /** The container's `scrollHeight`. */
  scrollHeight: number;
  /** The node's top edge, relative to the container's visible top edge. */
  nodeTop: number;
  /** The node's height. */
  nodeHeight: number;
}

/**
 * The `scrollTop` that shows the node the way `block` asks, clamped to what the
 * container can actually reach. Clamped rather than handed on: the distance a
 * container cannot cover is exactly the distance `scrollIntoView` would have
 * given to an ancestor.
 */
export function scrollTopToReveal(
  geometry: RevealGeometry,
  block: RevealBlock,
): number {
  const { scrollTop, clientHeight, scrollHeight, nodeTop, nodeHeight } =
    geometry;
  let target: number;
  if (block === "start") {
    target = scrollTop + nodeTop;
  } else if (block === "center") {
    target = scrollTop + nodeTop - (clientHeight - nodeHeight) / 2;
  } else if (nodeTop < 0) {
    target = scrollTop + nodeTop;
  } else if (nodeTop + nodeHeight > clientHeight) {
    // Taller than the view: its top is what the reader needs to see.
    target =
      nodeHeight > clientHeight
        ? scrollTop + nodeTop
        : scrollTop + nodeTop + nodeHeight - clientHeight;
  } else {
    return scrollTop;
  }
  const max = Math.max(0, scrollHeight - clientHeight);
  return Math.min(max, Math.max(0, Math.round(target)));
}

/** `scrollTopToReveal`, applied to a live container. */
export function scrollWithin(
  container: HTMLElement,
  node: Element,
  options: { block?: RevealBlock; behavior?: ScrollBehavior } = {},
): void {
  const box = container.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  const top = scrollTopToReveal(
    {
      scrollTop: container.scrollTop,
      clientHeight: container.clientHeight,
      scrollHeight: container.scrollHeight,
      // `clientTop` is the top border: the visible area starts under it.
      nodeTop: rect.top - box.top - container.clientTop,
      nodeHeight: rect.height,
    },
    options.block ?? "nearest",
  );
  if (top === container.scrollTop) {
    return;
  }
  if (options.behavior === "smooth") {
    container.scrollTo({ top, behavior: "smooth" });
  } else {
    container.scrollTop = top;
  }
}
