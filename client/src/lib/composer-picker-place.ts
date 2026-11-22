/**
 * Where a composer picker goes across, under the redesign at sm and up.
 *
 * The emoji and GIF pickers open upward from the composer. Their right edge
 * lines up with the button that opened them, so the panel appears where the
 * pointer is rather than at the far left of the pane. They never leave the
 * pane: the thread panel's composer is about 416px wide and the emoji picker
 * is 336px, so near the left the panel slides right, and in a pane narrower
 * than the panel it shrinks to the pane.
 */

export interface HorizontalBounds {
  left: number;
  right: number;
}

export interface EndAlignedPlacement {
  /** Left edge, in the same coordinates as the inputs. */
  left: number;
  width: number;
  /** Distance from the bounds' right edge to the panel's right edge. */
  right: number;
}

export function alignPanelEnd(
  anchorRight: number,
  bounds: HorizontalBounds,
  panelWidth: number,
  inset = 8,
): EndAlignedPlacement {
  const innerLeft = bounds.left + inset;
  const innerRight = bounds.right - inset;
  const width = Math.max(0, Math.min(panelWidth, innerRight - innerLeft));
  const wanted = anchorRight - width;
  const left = Math.min(Math.max(wanted, innerLeft), innerRight - width);
  return { left, width, right: bounds.right - (left + width) };
}
