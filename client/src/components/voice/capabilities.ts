/**
 * Platform capability probes for the voice UI.
 *
 * A missing browser API is not an error. iOS Safari has no `getDisplayMedia`
 * and no element fullscreen; rendering either as a red failure banner makes a
 * working app look broken, and it teaches people to ignore the colour that is
 * supposed to mean "something went wrong". Everything here is a pure function
 * over an injected shape so the unsupported platforms can be reproduced in a
 * Node test rather than only on a real iPhone.
 */

export type ScreenShareUnavailableReason = "no-api" | "insecure-context";

interface ScreenShareProbe {
  /**
   * `navigator.mediaDevices`, which is itself undefined off a secure origin.
   * Typed as a bare object so a test can hand over an iOS-shaped stand-in.
   */
  mediaDevices?: object | null;
  isSecureContext?: boolean;
}

function defaultScreenShareProbe(): ScreenShareProbe {
  return {
    mediaDevices:
      typeof navigator === "undefined" ? undefined : navigator.mediaDevices,
    isSecureContext:
      typeof globalThis === "undefined"
        ? undefined
        : (globalThis as { isSecureContext?: boolean }).isSecureContext,
  };
}

/**
 * True when this browser can capture a screen at all. False on iOS Safari (any
 * version, any wrapper — the API simply does not exist) and on insecure
 * origins.
 */
export function supportsScreenShare(
  probe: ScreenShareProbe = defaultScreenShareProbe(),
): boolean {
  const devices = probe.mediaDevices as
    { getDisplayMedia?: unknown } | null | undefined;
  return typeof devices?.getDisplayMedia === "function";
}

/**
 * Why screen capture is unavailable, or `null` when it is available. Callers
 * use this to pick the wording; nothing here is an error condition.
 */
export function screenShareUnavailableReason(
  probe: ScreenShareProbe = defaultScreenShareProbe(),
): ScreenShareUnavailableReason | null {
  if (supportsScreenShare(probe)) {
    return null;
  }
  // `mediaDevices` is absent entirely on plain HTTP, which is a fixable
  // deployment problem rather than a platform limit — say so differently.
  if (!probe.mediaDevices && probe.isSecureContext === false) {
    return "insecure-context";
  }
  return "no-api";
}

const SCREEN_SHARE_UNAVAILABLE_MESSAGE: Record<
  ScreenShareUnavailableReason,
  string
> = {
  "no-api": "Screen sharing isn't supported by this browser.",
  "insecure-context": "Screen sharing needs a secure (HTTPS) connection.",
};

/** Quiet, non-alarming explanation for a control the platform cannot honour. */
export function screenShareUnavailableMessage(
  reason: ScreenShareUnavailableReason,
): string {
  return SCREEN_SHARE_UNAVAILABLE_MESSAGE[reason];
}

/**
 * How (or whether) this browser can show something fullscreen.
 *
 * - `element` — the standard Fullscreen API on any element.
 * - `video` — iOS Safari's video-only `webkitEnterFullscreen`, the only
 *   fullscreen it has.
 * - `none` — no fullscreen at all; the control must not be rendered, because a
 *   button that does nothing is worse than no button.
 */
export type FullscreenMode = "element" | "video" | "none";

interface FullscreenProbe {
  /** `document.fullscreenEnabled` — false inside an iframe without allowfullscreen. */
  documentFullscreenEnabled?: boolean;
  /** `element.requestFullscreen` */
  requestFullscreen?: unknown;
  /** `video.webkitEnterFullscreen` */
  webkitEnterFullscreen?: unknown;
}

export function detectFullscreenMode(probe: FullscreenProbe): FullscreenMode {
  if (
    probe.documentFullscreenEnabled !== false &&
    typeof probe.requestFullscreen === "function"
  ) {
    return "element";
  }
  if (typeof probe.webkitEnterFullscreen === "function") {
    return "video";
  }
  return "none";
}

/**
 * Can this browser route audio to a chosen output (earpiece vs loudspeaker,
 * headset vs speakers)?
 *
 * Answering honestly needs two things, not one: the `setSinkId` method *and*
 * output devices to point it at. iOS Safari 18.4+ ships `setSinkId` but
 * `enumerateDevices()` never returns an `audiooutput`, so there is nothing
 * selectable and no earpiece/loudspeaker toggle is possible. Chrome and Firefox
 * on Android do not ship `setSinkId` at all. Callers must therefore check
 * `outputDeviceCount` before offering any routing UI.
 */
export function supportsAudioOutputRouting(probe: {
  setSinkId?: unknown;
  outputDeviceCount: number;
}): boolean {
  return typeof probe.setSinkId === "function" && probe.outputDeviceCount > 0;
}
