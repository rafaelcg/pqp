/**
 * Place a floating panel next to an anchor without leaving the viewport.
 *
 * Prefer opening above (the composer and a message reaction both sit on a
 * surface that has more room up than down). Flip below when the top of the
 * window is too close, and shrink when neither side has the panel's full
 * height — a short window with the anchor in the middle.
 */

export const ANCHORED_PANEL_GAP = 8;
export const ANCHORED_PANEL_PAD = 8;

/** Matches `.emoji-mart-shell em-emoji-picker` (21rem × 340px). */
export const EMOJI_PICKER_SIZE = { width: 336, height: 340 } as const;

export interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PanelSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export interface AnchoredPanelPlacement {
  top: number;
  left: number;
  maxHeight: number;
  maxWidth: number;
}

export function placeAnchoredPanel(
  anchor: AnchorRect,
  panel: PanelSize,
  viewport: ViewportSize,
  prefer: "above" | "below" = "above",
): AnchoredPanelPlacement {
  const gap = ANCHORED_PANEL_GAP;
  const pad = ANCHORED_PANEL_PAD;

  const spaceAbove = Math.max(0, anchor.top - pad - gap);
  const spaceBelow = Math.max(0, viewport.height - anchor.bottom - pad - gap);

  const fitsAbove = spaceAbove >= panel.height;
  const fitsBelow = spaceBelow >= panel.height;

  const openAbove =
    prefer === "above"
      ? fitsAbove || (!fitsBelow && spaceAbove >= spaceBelow)
      : !fitsBelow && (fitsAbove || spaceAbove > spaceBelow);

  const available = openAbove ? spaceAbove : spaceBelow;
  const maxHeight = Math.max(0, Math.min(panel.height, available));
  const maxWidth = Math.max(
    0,
    Math.min(panel.width, viewport.width - 2 * pad),
  );

  const top = openAbove
    ? anchor.top - gap - maxHeight
    : anchor.bottom + gap;

  const left = Math.min(
    Math.max(pad, anchor.left),
    Math.max(pad, viewport.width - maxWidth - pad),
  );

  return { top, left, maxHeight, maxWidth };
}
