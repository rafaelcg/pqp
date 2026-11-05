/**
 * Would a live preview of our own share be a picture of itself?
 *
 * Share the whole screen, then blow the preview up to fill the window (or the
 * screen, in fullscreen): the capture now contains the pqp window, the pqp
 * window contains the preview, and the preview shows the capture. Each frame
 * is drawn from the previous one, one capture latency deeper, so the picture
 * becomes a tunnel of nested copies that lags, smears and strobes. That is
 * the report "when I click my own preview while sharing my screen it starts
 * bugging" (feedback #130, Windows desktop app, whole screen).
 *
 * Only the presenter's own local preview is affected. Viewers get the capture
 * as encoded, and the preview is a second decode of it on this machine.
 *
 * What we can know about the surface:
 * - `displaySurface === "monitor"`: a whole screen. Always includes us.
 * - `"browser"`: a tab. The page asks for `selfBrowserSurface: "exclude"`, so
 *   it is never our own tab.
 * - `"window"`: one window. It can be the pqp window only if the person
 *   picked it on purpose, which we cannot tell from here; trusted.
 * - absent: Electron has shipped display tracks without a surface
 *   (electron/electron#39226). Its picker only ever lists screens and
 *   windows, and the track label is the capturer id (`screen:0:0` or
 *   `window:123:0`) when Chromium keeps it, so the label is read first. With
 *   neither, the desktop shell is treated as possibly mirroring, because the
 *   cost of a wrong yes is one click on "show anyway" and the cost of a wrong
 *   no is the tunnel.
 */
export interface ShareSurfaceHints {
  displaySurface?: string | null;
  label?: string | null;
  /** True in the Electron shell, where an absent surface is not "a browser". */
  desktopApp: boolean;
}

export function shareMayCaptureThisWindow(hints: ShareSurfaceHints): boolean {
  switch (hints.displaySurface) {
    case "monitor":
      return true;
    case "browser":
    case "window":
      return false;
    default:
      break;
  }
  const label = hints.label ?? "";
  if (label.startsWith("screen:")) {
    return true;
  }
  if (label.startsWith("window:")) {
    return false;
  }
  return hints.desktopApp;
}

/** The hints, read off the live video track of a stream. Never throws. */
export function readShareSurfaceHints(
  stream: MediaStream | null,
  desktopApp: boolean,
): ShareSurfaceHints {
  let displaySurface: string | null = null;
  let label: string | null = null;
  try {
    const track = stream?.getVideoTracks?.()[0];
    if (track) {
      const surface = track.getSettings?.().displaySurface;
      displaySurface = typeof surface === "string" ? surface : null;
      label = typeof track.label === "string" ? track.label : null;
    }
  } catch {
    // A track handed over by a shell or an older engine need not implement
    // either; unknown falls to the rule above.
  }
  return { displaySurface, label, desktopApp };
}

/** The slice of `window` the fullscreen test reads, so a test can hand one in. */
export interface ScreenFillView {
  innerWidth: number;
  innerHeight: number;
  screen: { width: number; height: number };
  document?: { fullscreenElement?: Element | null };
}

/**
 * Is the pqp window itself filling its screen (F11, the shell's fullscreen, or
 * any element fullscreen)? Then a whole-screen share holds a picture of the
 * preview at full size even though the share tile in the grid is small: the
 * grid IS the screen. A merely maximized window leaves the taskbar out of the
 * page, so it does not count. A window fullscreen on another monitor than the
 * one being shared is not a loop and cannot be told apart from here, which is
 * why the guard has a "show anyway".
 */
export function windowFillsScreen(view: ScreenFillView): boolean {
  if (view.document?.fullscreenElement) {
    return true;
  }
  const { width, height } = view.screen;
  if (!(width > 0) || !(height > 0)) {
    return false;
  }
  return view.innerWidth >= width - 1 && view.innerHeight >= height - 1;
}
