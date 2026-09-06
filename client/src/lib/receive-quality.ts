import { useSyncExternalStore } from "react";

/**
 * The largest picture this device asks the SFU for, remembered per device.
 *
 * WHY THIS EXISTS. A 100-viewer watch party on 5 Sep 2026 cost 323 GB of SFU
 * downstream in three and a half hours, and most of those viewers were on
 * phones drawing a 1080p share into a 390-pixel-wide element. The presenter
 * now publishes simulcast layers (`video-quality.ts`), so for the first time
 * there is a smaller copy on the server to ask for, and this is the asking.
 *
 * PURELY LOCAL, on purpose, the same call `participant-rail-preference` makes:
 * "this is a phone on mobile data" describes a device, not a person, and the
 * same account on a desktop should get the desktop default without the phone
 * having to be undone first.
 *
 * AUTO IS ADAPTIVE, NOT "HIGH". With `adaptiveStream` on the room, LiveKit
 * measures the element the video is drawn into and asks the SFU for the
 * smallest layer that covers it. A fixed choice is a ceiling laid over that:
 * `RemoteTrackPublication.setVideoQuality` names the highest layer this side
 * will accept, and the adaptive measurement still shrinks below it when the
 * element is small. See `livekit-session.ts` for the library-version note.
 *
 * MESH IGNORES THIS ENTIRELY. A mesh presenter encodes one stream per peer and
 * `RTCRtpReceiver` has no size parameter, so on that transport the menu hides
 * the selector and keeps the sentence that says the sender chooses.
 */

export const RECEIVE_QUALITIES = ["auto", "1080p", "720p", "360p"] as const;

export type ReceiveQuality = (typeof RECEIVE_QUALITIES)[number];

const STORAGE_KEY = "pqp:receive-quality";

/** Storage hands back `unknown`; this is the only door in. */
export function parseReceiveQuality(raw: unknown): ReceiveQuality | null {
  return RECEIVE_QUALITIES.includes(raw as ReceiveQuality)
    ? (raw as ReceiveQuality)
    : null;
}

/** What decides a device's default before anybody has opened the menu. */
export interface ReceiveDeviceSignals {
  /** `(pointer: coarse)`: a finger, so a phone or a tablet. */
  coarsePointer: boolean;
  /** The viewport is narrower than a laptop, whatever the pointer. */
  smallViewport: boolean;
  /** The user agent says iPhone, iPad or Android. */
  mobileUserAgent: boolean;
}

/** Below this, a window is a phone or a tablet in portrait, not a desktop. */
const SMALL_VIEWPORT_MAX_PX = 900;

/**
 * Read the three signals off the browser. Each one is wrapped because none
 * exists in a node test, in an old WebView, or in some Electron partitions.
 */
export function readReceiveDeviceSignals(): ReceiveDeviceSignals {
  let coarsePointer = false;
  let smallViewport = false;
  let mobileUserAgent = false;
  try {
    coarsePointer =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches;
  } catch {
    coarsePointer = false;
  }
  try {
    smallViewport =
      typeof window !== "undefined" &&
      typeof window.innerWidth === "number" &&
      window.innerWidth > 0 &&
      window.innerWidth < SMALL_VIEWPORT_MAX_PX;
  } catch {
    smallViewport = false;
  }
  try {
    mobileUserAgent =
      typeof navigator !== "undefined" &&
      /iPhone|iPad|iPod|Android/i.test(navigator.userAgent ?? "");
  } catch {
    mobileUserAgent = false;
  }
  return { coarsePointer, smallViewport, mobileUserAgent };
}

/**
 * Phones and tablets start at 720p; desktops start on auto.
 *
 * 720p rather than 360p because a phone held sideways is a 720-line screen,
 * and the whole point of auto is that the element decides: a phone on auto
 * would already land near 720p in landscape and near 360p in portrait. The
 * fixed 720p is a *ceiling* for the device on top of that, so a tablet drawn
 * at full width never asks for the 1080p layer by accident. A desktop has the
 * pixels and usually the link, so it gets the adaptive default and can pick
 * 1080p by name. Anyone can pick 1080p.
 */
export function defaultReceiveQuality(
  signals: ReceiveDeviceSignals,
): ReceiveQuality {
  return signals.coarsePointer || signals.smallViewport || signals.mobileUserAgent
    ? "720p"
    : "auto";
}

export function loadReceiveQuality(
  signals: ReceiveDeviceSignals = readReceiveDeviceSignals(),
): ReceiveQuality {
  try {
    const stored = parseReceiveQuality(localStorage.getItem(STORAGE_KEY));
    if (stored) {
      return stored;
    }
  } catch {
    // Storage denied (privacy mode, an Electron partition without quota):
    // fall through to the device default, which is the app working.
  }
  return defaultReceiveQuality(signals);
}

export function saveReceiveQuality(quality: ReceiveQuality): void {
  try {
    localStorage.setItem(STORAGE_KEY, quality);
  } catch {
    // The choice still applies for the session; only the memory of it is lost.
  }
}

// -------------------------------------------------------------------- store

/**
 * One in-memory copy, shared by the menu that sets it and the session that
 * applies it, so neither has to be threaded through the call stage's props.
 * Lazily read so a test can stub storage before the first read.
 */
let current: ReceiveQuality | null = null;
const listeners = new Set<(quality: ReceiveQuality) => void>();

export function getReceiveQuality(): ReceiveQuality {
  if (current === null) {
    current = loadReceiveQuality();
  }
  return current;
}

export function setReceiveQuality(quality: ReceiveQuality): void {
  if (quality === current) {
    return;
  }
  current = quality;
  saveReceiveQuality(quality);
  for (const listener of listeners) {
    listener(quality);
  }
}

export function subscribeReceiveQuality(
  listener: (quality: ReceiveQuality) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetReceiveQualityForTests(): void {
  current = null;
  listeners.clear();
}

export function useReceiveQuality(): ReceiveQuality {
  return useSyncExternalStore(subscribeReceiveQuality, getReceiveQuality);
}
