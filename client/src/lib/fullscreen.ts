/**
 * How the call stage fills a screen, per platform.
 *
 * Three ways exist and no device has all three:
 *
 * - `element`: `Element.requestFullscreen()` on the stage container. Desktop
 *   browsers, Android Chrome, iPadOS Safari. The whole stage goes, controls
 *   included, and the browser owns the exit (Escape, swipe, `fullscreenchange`).
 * - `video`: `HTMLVideoElement.webkitEnterFullscreen()`, the native player.
 *   The only true fullscreen an iPhone has: Safari never shipped element
 *   fullscreen there, so it is the one path that hides the tab bar and the
 *   address bar. Only the focused <video> goes; the call's audio keeps
 *   playing because it lives in separate <audio> elements
 *   (`voice-audio-sinks.tsx`), and the stage's own controls are not on
 *   screen, only the player's.
 * - `expand`: grow the stage inside the page (`fixed inset-0`). Needs no
 *   platform support, so it is the floor everything falls back to. Inside a
 *   browser tab it still shares the screen with the browser's chrome.
 *
 * WHY `video` IS OPT-IN. PR #48 saw the native player render a
 * MediaStream-backed <video> as a black rectangle on an iPhone, with the
 * audio still playing, and `capabilities.ts` has refused to probe for
 * `webkitEnterFullscreen` ever since. That was a field report, not a guess,
 * and nothing here can be verified on a real iPhone from a test runner. So
 * the path is built and wired, but a device only takes it when
 * `NATIVE_VIDEO_FULLSCREEN_KEY` is set in `localStorage`. Flip it on one
 * phone, watch a share, and if the picture is there the default can change
 * in one line (`allowNativeVideo`).
 */

export type StageFullscreenStrategy = "element" | "video" | "expand";

export const NATIVE_VIDEO_FULLSCREEN_KEY = "pqp:native-video-fullscreen";

export interface StrategyProbe {
  /** `detectFullscreenMode(...) === "element"`, see `capabilities.ts`. */
  elementFullscreen: boolean;
  /** `typeof video.webkitEnterFullscreen === "function"` on the focused video. */
  videoNativeFullscreen: boolean;
  /** Is there a focused <video> to hand over at all? Audio-only has none. */
  hasVideo: boolean;
  /** The opt-in above. */
  allowNativeVideo: boolean;
}

export function chooseFullscreenStrategy(
  probe: StrategyProbe,
): StageFullscreenStrategy {
  if (probe.elementFullscreen) {
    return "element";
  }
  if (probe.allowNativeVideo && probe.hasVideo && probe.videoNativeFullscreen) {
    return "video";
  }
  return "expand";
}

export function nativeVideoFullscreenAllowed(
  storage: Pick<Storage, "getItem"> | null = safeLocalStorage(),
): boolean {
  try {
    return storage?.getItem(NATIVE_VIDEO_FULLSCREEN_KEY) === "1";
  } catch {
    return false;
  }
}

function safeLocalStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The prefixed video-only API, iPhone Safari's and older desktop Safari's. */
export interface NativeFullscreenVideo extends HTMLVideoElement {
  webkitDisplayingFullscreen?: boolean;
  webkitSupportsFullscreen?: boolean;
  webkitEnterFullscreen?: () => void;
  webkitExitFullscreen?: () => void;
}

export function videoSupportsNativeFullscreen(
  video: HTMLVideoElement | null,
): boolean {
  if (!video) {
    return false;
  }
  const v = video as NativeFullscreenVideo;
  return (
    typeof v.webkitEnterFullscreen === "function" &&
    v.webkitSupportsFullscreen !== false
  );
}

/**
 * Hand the focused video to the native player. Throws `InvalidStateError` on
 * a Safari that has the method but no fullscreen for this element (a
 * MediaStream on an older Mac); the caller falls back to `expand`.
 */
export function enterNativeVideoFullscreen(video: HTMLVideoElement): void {
  (video as NativeFullscreenVideo).webkitEnterFullscreen?.();
}

export function exitNativeVideoFullscreen(video: HTMLVideoElement): void {
  (video as NativeFullscreenVideo).webkitExitFullscreen?.();
}

/**
 * A share is wider than it is tall, and a phone held upright is not. Ask for
 * landscape while fullscreen; every failure is ignored because most of them
 * are expected: iOS has no `lock` at all, desktops refuse it, and Chrome only
 * honours it while the document is fullscreen (which is why this is called
 * after entering, not before).
 */
export function lockLandscape(
  orientation: { lock?: (o: string) => Promise<void> } | undefined = screenOrientation(),
): void {
  try {
    const p = orientation?.lock?.("landscape");
    p?.catch(() => {
      // Refused or unsupported. The share still fills whatever the user holds.
    });
  } catch {
    // `lock` missing or throwing synchronously on an old engine.
  }
}

export function unlockOrientation(
  orientation: { unlock?: () => void } | undefined = screenOrientation(),
): void {
  try {
    orientation?.unlock?.();
  } catch {
    // Nothing was locked, or the platform never had it.
  }
}

function screenOrientation():
  | { lock?: (o: string) => Promise<void>; unlock?: () => void }
  | undefined {
  if (typeof screen === "undefined") {
    return undefined;
  }
  return (screen as { orientation?: { lock?: (o: string) => Promise<void>; unlock?: () => void } })
    .orientation;
}

/**
 * Installed to the home screen. Standalone is the only place an iPhone gives
 * the page the whole screen without a native player, which is what the
 * cinema hint on the stage is about.
 */
export function isStandaloneDisplayMode(
  env: {
    matchMedia?: (q: string) => { matches: boolean };
    navigatorStandalone?: boolean;
  } = {
    matchMedia:
      typeof window === "undefined" ? undefined : window.matchMedia?.bind(window),
    navigatorStandalone:
      typeof navigator === "undefined"
        ? undefined
        : (navigator as { standalone?: boolean }).standalone,
  },
): boolean {
  if (env.navigatorStandalone === true) {
    return true;
  }
  try {
    return env.matchMedia?.("(display-mode: standalone)").matches === true;
  } catch {
    return false;
  }
}
