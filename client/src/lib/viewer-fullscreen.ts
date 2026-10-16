/**
 * What a viewer's SFU subscription should measure its picture in, and when.
 *
 * WHY THIS EXISTS (bug 123, 2026-10-16: "em tela cheia sai do fullhd para hd",
 * on the Windows desktop app). The room runs `adaptiveStream`, and the library
 * asks the SFU for the smallest simulcast layer that covers the element the
 * share is drawn into. It measures that element in CSS pixels times a
 * `pixelDensity` that, when unset, is 1 for every display up to a device pixel
 * ratio of 2 (`RemoteVideoTrack.getPixelDensity`, livekit-client 2.21.0). CSS
 * pixels are not screen pixels on the machines a lot of people share from and
 * watch on: a 1080p laptop at Windows' recommended 150% scaling is a 1280x720
 * CSS viewport, so a fullscreen share asks the SFU for 720 lines, the SFU
 * (which picks the first layer at least 0.9 of the height asked for, see
 * `share-fast-start.ts`) hands over the 720p copy, and a monitor with 1080
 * real lines shows an upscaled HD picture exactly where the viewer asked to see
 * the best one. At 125% the request is 864 lines, which still reaches the 1080p
 * layer, so this bites from about 150% on a 1080p panel, and on any display
 * whose fullscreen CSS height is 800 lines or less (a 1440p panel at 200%).
 *
 * THE FIX IS SCOPED TO FULLSCREEN ON PURPOSE. Counting real pixels for every
 * tile would hand the 1080p copy to a windowed 700-line tile on a Retina
 * laptop, and the 323 GB watch party of 5 Sep 2026 is the reason `adaptiveStream`
 * is on at all. A viewer who fills their screen has asked for the best picture
 * that screen can show, which is the one moment the real pixel count is the
 * right number.
 *
 * `fullscreen` is "the call stage fills the screen by either route": the
 * document has a fullscreen element (the `element` strategy of `lib/fullscreen.ts`)
 * or the stage reported itself expanded in the page (the `expand` strategy,
 * which is also where a shell whose embedder refuses element fullscreen lands).
 */

/** The one field of livekit-client's `AdaptiveStreamSettings` this file sets. */
export interface AdaptivePixelDensitySettings {
  pixelDensity?: number | "screen";
}

/** The Fullscreen API under both spellings. */
interface FullscreenDocument {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
}

/** `"screen"` (the real device pixel ratio) while fullscreen, else the library's own default. */
export function fullscreenPixelDensity(
  fullscreen: boolean,
): "screen" | undefined {
  return fullscreen ? "screen" : undefined;
}

let stageExpanded = false;
const stageListeners = new Set<() => void>();

/**
 * The stage reports its in-page fill here (`useStageFullscreen`). Whether the
 * browser-level fullscreen is on is read from the document, never reported.
 */
export function reportStageExpanded(expanded: boolean): void {
  if (stageExpanded === expanded) {
    return;
  }
  stageExpanded = expanded;
  for (const listener of [...stageListeners]) {
    listener();
  }
}

/**
 * Tell `listener` whenever the answer to `isViewerFullscreen` may have changed:
 * either fullscreen event, or the stage filling the page. Returns the way out.
 *
 * It exists so the session can ask the library to re-measure at the moment of
 * the change. A resize of the stage does that on its own in nearly every case,
 * but "nearly" is the failure mode: an expanded stage that was already the size
 * of the page would never resize, and would keep asking for CSS pixels.
 */
export function subscribeViewerFullscreen(
  listener: () => void,
  doc: Pick<Document, "addEventListener" | "removeEventListener"> | undefined = typeof document ===
  "undefined"
    ? undefined
    : document,
): () => void {
  stageListeners.add(listener);
  doc?.addEventListener("fullscreenchange", listener);
  doc?.addEventListener("webkitfullscreenchange", listener);
  return () => {
    stageListeners.delete(listener);
    doc?.removeEventListener("fullscreenchange", listener);
    doc?.removeEventListener("webkitfullscreenchange", listener);
  };
}

/**
 * Ask the library to re-measure an element it observes. `handleResize` is the
 * hook `HTMLElementInfo.observe` puts on the element for its ResizeObserver;
 * absent (an element it never observed, a build that renamed it) is a no-op,
 * and the stage's own resize still does the job.
 */
export function nudgeElementMeasure(element: object): void {
  const hook = (element as { handleResize?: unknown }).handleResize;
  if (typeof hook === "function") {
    try {
      hook.call(element);
    } catch {
      // A measurement that cannot be nudged is measured on the next resize.
    }
  }
}

export function isViewerFullscreen(
  doc: FullscreenDocument | undefined = typeof document === "undefined"
    ? undefined
    : (document as FullscreenDocument),
): boolean {
  if (stageExpanded) {
    return true;
  }
  if (!doc) {
    return false;
  }
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) !== null;
}

/**
 * The object handed to `new Room({ adaptiveStream })`.
 *
 * A getter and not a value, because livekit-client keeps the SAME object for
 * every remote video track it creates and reads `pixelDensity` each time it
 * re-measures an element (verified in `RemoteVideoTrack.getPixelDensity`), so
 * one object follows the stage in and out of fullscreen with nothing to
 * re-register. The stage's own resize is what triggers the re-measure; this
 * only has to answer correctly when it is asked.
 */
export function createAdaptiveStreamSettings(
  fullscreen: () => boolean = isViewerFullscreen,
): AdaptivePixelDensitySettings {
  return {
    get pixelDensity() {
      return fullscreenPixelDensity(fullscreen());
    },
  };
}
