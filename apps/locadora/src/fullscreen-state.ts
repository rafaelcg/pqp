/**
 * Is the frame in full screen right now?
 *
 * The host full-screens the iframe ELEMENT (`ui.fullscreen`), so this page never hears `fullscreenchange` and
 * `document.fullscreenElement` stays null in here. What the page can see is its own size, the screen's, and what
 * the host answered when it was asked.
 *
 * The first version read `display-mode: fullscreen` or "the window is the screen, to the pixel", and let that
 * overrule the host on every resize. Both tests fail on real machines:
 *  - a MacBook with a notch (or macOS keeping its menu bar) gives a full-screen window shorter than
 *    `screen.height`, and not every engine or shell matches `display-mode: fullscreen` for an element in full
 *    screen. The page then decided it was NOT in full screen one frame after the host said it was, and drew the
 *    windowed layout (side margins, the windowed default Encaixar, the HUD saying "Tela cheia") inside a
 *    full-screen frame. Reproduced in `e2e/locadora.spec.mts` with a screen taller than the window.
 *  - the other way round, a browser in F11 matches `display-mode: fullscreen` with the frame still in its pane.
 *
 * So the host's answer is the truth, and the size only tells an exit nobody asked us about (Escape, the host's own
 * control): the window shrinking well below the size it had in full screen. Before the host has answered at all
 * (the frame reloaded inside a full-screen window), a window that covers the screen's width and nearly all of its
 * height is full screen.
 */

export interface ViewportProbe {
  /** `innerWidth` / `innerHeight` of the frame's window, in CSS pixels. */
  viewW: number;
  viewH: number;
  /** `screen.width` / `screen.height`, in CSS pixels. */
  screenW: number;
  screenH: number;
}

/** A window this much shorter than the screen still covers it (a notch, a kept menu bar, a browser strip). */
export const COVER_HEIGHT_RATIO = 0.88;
/** Shrinking below this share of the full-screen size, in either direction, is leaving full screen. */
export const EXIT_SHRINK_RATIO = 0.9;

/** The window covers the screen: its whole width, and its height but for a notch or a menu bar. */
export function coversScreen(probe: ViewportProbe): boolean {
  const { viewW, viewH, screenW, screenH } = probe;
  if (!(viewW > 0 && viewH > 0 && screenW > 0 && screenH > 0)) return false;
  return viewW >= screenW - 2 && viewH >= screenH * COVER_HEIGHT_RATIO;
}

export interface FullscreenTracker {
  /** What the host answered to `ui.fullscreen`: the truth, from now on, until the window says otherwise. */
  hostSaid(on: boolean, probe: ViewportProbe): boolean;
  /** The window changed size: still full screen? */
  judge(probe: ViewportProbe): boolean;
}

export function createFullscreenTracker(): FullscreenTracker {
  /** null until the host has answered once: only then is the size alone the judge (a frame reloaded in full screen). */
  let host: boolean | null = null;
  let peakW = 0;
  let peakH = 0;

  return {
    hostSaid(on, probe) {
      host = on;
      peakW = on ? probe.viewW : 0;
      peakH = on ? probe.viewH : 0;
      return on;
    },
    judge(probe) {
      if (host === null) return coversScreen(probe);
      if (!host) return false;
      // the way in can take a few frames (the macOS animation): the window only grows then
      peakW = Math.max(peakW, probe.viewW);
      peakH = Math.max(peakH, probe.viewH);
      const shrunk = probe.viewW < peakW * EXIT_SHRINK_RATIO || probe.viewH < peakH * EXIT_SHRINK_RATIO;
      if (!shrunk) return true;
      host = false;
      return false;
    },
  };
}
