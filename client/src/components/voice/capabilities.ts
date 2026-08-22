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

import {
  translateMessage,
  type MessageKey,
} from "@/lib/i18n/catalogue";

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

const SCREEN_SHARE_UNAVAILABLE_KEY: Record<
  ScreenShareUnavailableReason,
  MessageKey
> = {
  "no-api": "voice.screenShareUnsupported",
  "insecure-context": "voice.screenShareInsecure",
};

/**
 * Quiet, non-alarming explanation for a control the platform cannot honour.
 *
 * Resolved through the catalogue on every call rather than captured in a
 * module-level constant: a constant is evaluated at import time, which is
 * before the non-English catalogue chunk has finished loading, and would pin
 * the sentence to English for the rest of the session. `hooks/use-voice.ts`
 * calls this for the same reason — one key, so the greyed-out control and the
 * error path cannot drift apart in any language.
 */
export function screenShareUnavailableMessage(
  reason: ScreenShareUnavailableReason,
): string {
  return translateMessage(SCREEN_SHARE_UNAVAILABLE_KEY[reason]);
}

/**
 * How (or whether) this browser can show something fullscreen.
 *
 * - `element` — the standard Fullscreen API on any element.
 * - `expand` — no real fullscreen; the app grows the panel to fill the
 *   viewport itself.
 *
 * THERE IS NO `video` MODE ANY MORE, and that is the fix for a real bug. iOS
 * Safari's only native fullscreen is the video element's own
 * `webkitEnterFullscreen`, which hands the element to the operating system's
 * media player. That player renders files and HLS. It cannot render a
 * `MediaStream`, so on an iPhone it went fullscreen and showed **black** while
 * the call's audio carried on from its own <audio> sink: no error, no crash,
 * no picture. Reported from a real iPhone on 22 Aug 2026.
 *
 * So on any browser without element fullscreen we do it ourselves, in the
 * page, with CSS. It is not the OS chrome, and it cannot hide the browser's
 * own toolbars, but it fills the viewport and it shows the actual video, which
 * is the entire point of the button.
 *
 * `none` is gone too: `expand` needs no platform support at all, so there is
 * no browser left where the control has to be hidden.
 */
export type FullscreenMode = "element" | "expand";

interface FullscreenProbe {
  /** `document.fullscreenEnabled` — false inside an iframe without allowfullscreen. */
  documentFullscreenEnabled?: boolean;
  /** `element.requestFullscreen` */
  requestFullscreen?: unknown;
  /**
   * `element.webkitRequestFullscreen`.
   *
   * Safari only shipped the unprefixed Fullscreen API in 16.4. Before that a
   * Mac has full element fullscreen — under the prefix — and probing for the
   * standard name alone reports it as absent. That mattered: the fallback below
   * is the *video-only* iOS path, and `webkitEnterFullscreen` exists on desktop
   * Safari too, so an older Mac silently took the iOS branch and then threw
   * `InvalidStateError` on a MediaStream-backed <video> that has no fullscreen
   * support. The user clicked the button and nothing happened.
   */
  webkitRequestFullscreen?: unknown;
}

export function detectFullscreenMode(probe: FullscreenProbe): FullscreenMode {
  if (
    probe.documentFullscreenEnabled !== false &&
    (typeof probe.requestFullscreen === "function" ||
      typeof probe.webkitRequestFullscreen === "function")
  ) {
    return "element";
  }
  // Everything else, iPhone included, expands in the page. Deliberately not a
  // probe for `webkitEnterFullscreen`: it exists on an iPhone and it is
  // precisely the thing that renders a MediaStream as a black rectangle.
  return "expand";
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
