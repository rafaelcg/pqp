/**
 * Pure math and decisions behind the attachment lightbox — deliberately kept
 * out of the component so a fit calculation or a copy-format choice can be
 * pinned without mounting React or touching the clipboard.
 */

export interface Size {
  width: number;
  height: number;
}

export interface FitBox extends Size {
  /** `1` means the image is shown at its own pixels; below that, it was shrunk. */
  scale: number;
}

/**
 * `contain`-fit an image's natural size inside a box, never upscaling.
 *
 * `viewport` is already the available rectangle — the caller has subtracted
 * the top bar, the bottom hint and the margins, so this function only ever
 * does the one thing: the largest box that keeps the aspect ratio and does
 * not overflow either dimension. A degenerate input (either side <= 0, which
 * happens for one render while the image has not reported its natural size
 * yet) returns the viewport itself so a caller never divides by zero.
 */
export function computeFit(natural: Size, viewport: Size): FitBox {
  if (
    natural.width <= 0 ||
    natural.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return { width: viewport.width, height: viewport.height, scale: 1 };
  }
  const scale = Math.min(
    1,
    viewport.width / natural.width,
    viewport.height / natural.height,
  );
  return {
    width: Math.round(natural.width * scale),
    height: Math.round(natural.height * scale),
    scale,
  };
}

/**
 * Whether the zoom control has anything to do. A `fit` that already equals
 * the natural size (a small screenshot, a sticker) has no 1:1 to offer —
 * showing a toggle that does nothing is worse than not showing one.
 */
export function canZoomToActualSize(natural: Size, fit: FitBox): boolean {
  return fit.scale < 1 && natural.width > 0 && natural.height > 0;
}

/**
 * How far a zoomed image may be dragged before it shows blank space past its
 * own edge. Symmetric around 0, and 0 exactly when the content already fits
 * the viewport on that axis (nothing to pan).
 */
export function clampPanOffset(
  offset: number,
  contentSize: number,
  viewportSize: number,
): number {
  const max = Math.max(0, (contentSize - viewportSize) / 2);
  if (max === 0) {
    return 0;
  }
  return Math.min(max, Math.max(-max, offset));
}

/**
 * The next index a left/right press or swipe lands on, or `null` at an end.
 * No wraparound: arriving back at the first attachment after the last is a
 * surprise, not a feature, for a strip that usually has two or three images.
 */
export function nextLightboxIndex(
  current: number,
  total: number,
  direction: -1 | 1,
): number | null {
  const next = current + direction;
  if (next < 0 || next >= total) {
    return null;
  }
  return next;
}

/** "2 / 5" as numbers, so the caller only has to format the slash and a key. */
export function navCounter(
  current: number,
  total: number,
): { position: number; total: number } {
  return { position: current + 1, total };
}

export type CopyImageReason = "png" | "convert" | "gif";

export interface CopyImagePlan {
  /** PNG is the one format every browser's clipboard accepts; anything else
   * has to go through a canvas first. */
  needsConversion: boolean;
  /** A GIF's animation cannot survive the clipboard, so the link rides along
   * as a second format in the same write — a paste target that wants text
   * still gets somewhere useful. */
  includeLinkText: boolean;
  reason: CopyImageReason;
}

/**
 * What copying an image should do, from its content type alone. Kept pure so
 * the decision — convert or not, carry the link or not — is testable without
 * a blob, a canvas or a real clipboard.
 */
export function planImageCopy(contentType: string): CopyImagePlan {
  const type = contentType.trim().toLowerCase();
  if (type === "image/gif") {
    return { needsConversion: true, includeLinkText: true, reason: "gif" };
  }
  if (type === "image/png") {
    return { needsConversion: false, includeLinkText: false, reason: "png" };
  }
  return { needsConversion: true, includeLinkText: false, reason: "convert" };
}

/** Human "1920 × 1080" — absent either side, there is nothing to show. */
export function formatDimensions(
  width: number | null,
  height: number | null,
): string | null {
  if (!width || !height) {
    return null;
  }
  return `${width} × ${height}`;
}
