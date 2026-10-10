/**
 * Which cut of a Baú video this screen plays.
 *
 * An author can attach a second, vertical (9:16) edit of an uploaded video
 * (`media.mobile`, behind the `bau_mobile_rendition` flag). A phone plays that
 * one; everything else plays the main, landscape one.
 *
 * THE RULE, in one place so the feed, the composer preview and the tests all
 * agree:
 *
 *   - a viewport at most `MOBILE_RENDITION_MAX_WIDTH` CSS px wide plays the
 *     vertical cut (a phone in portrait, or any window that narrow, where a
 *     landscape video would be a strip across the card); or
 *   - a touch-first screen (`pointer: coarse`) held in portrait plays it too
 *     (a large phone or a tablet upright).
 *
 * A phone turned sideways is wider than the cut-off and not portrait, so it
 * gets the landscape cut, which is the one that fills that screen. The choice
 * is made when the player mounts and not again: rotating mid-video must not
 * swap the file and restart it.
 */
export const MOBILE_RENDITION_MAX_WIDTH = 640;

export type RenditionViewport = {
  width: number;
  height: number;
  /** `(pointer: coarse)`: the primary pointer is a finger. */
  coarsePointer: boolean;
};

export function prefersMobileRendition(viewport: RenditionViewport): boolean {
  const { width, height, coarsePointer } = viewport;
  if (!(width > 0) || !(height > 0)) {
    // No layout yet (a test, a prerender): the main cut is the safe answer.
    return false;
  }
  if (width <= MOBILE_RENDITION_MAX_WIDTH) {
    return true;
  }
  return coarsePointer && height > width;
}

/** The URL the player gets: the vertical cut on a phone when there is one. */
export function communityHomeVideoUrl(
  media: {
    kind: string;
    url: string | null;
    mobile?: { url: string | null } | null;
  },
  viewport: RenditionViewport,
): { url: string | null; rendition: "main" | "mobile" } {
  const mobileUrl = media.kind === "video" ? media.mobile?.url : null;
  if (mobileUrl && prefersMobileRendition(viewport)) {
    return { url: mobileUrl, rendition: "mobile" };
  }
  return { url: media.url, rendition: "main" };
}

/** This window, now. Defensive: no `window` or no `matchMedia` is a desktop. */
export function readRenditionViewport(): RenditionViewport {
  if (typeof window === "undefined") {
    return { width: 0, height: 0, coarsePointer: false };
  }
  let coarsePointer = false;
  try {
    coarsePointer = window.matchMedia?.("(pointer: coarse)").matches ?? false;
  } catch {
    coarsePointer = false;
  }
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer,
  };
}
