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
  /**
   * The link is metered or slow: the Network Information API says cellular,
   * an effective type of 3G or worse, or the user turned on data saving.
   * Optional because the callers that predate it pass the three above.
   */
  cellular?: boolean;
}

/** Below this, a window is a phone or a tablet in portrait, not a desktop. */
const SMALL_VIEWPORT_MAX_PX = 900;

/** `navigator.connection` as far as this file reads it. Chromium and Android only. */
interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: "change", listener: () => void) => void;
  removeEventListener?: (type: "change", listener: () => void) => void;
}

function networkInformation(): NetworkInformationLike | null {
  try {
    if (typeof navigator === "undefined") {
      return null;
    }
    const nav = navigator as Navigator & {
      connection?: NetworkInformationLike;
      mozConnection?: NetworkInformationLike;
      webkitConnection?: NetworkInformationLike;
    };
    return nav.connection ?? nav.mozConnection ?? nav.webkitConnection ?? null;
  } catch {
    return null;
  }
}

const SLOW_EFFECTIVE_TYPES = new Set(["slow-2g", "2g", "3g"]);

/** The cellular signal, from the shape the API hands over. Pure. */
export function isCellularConnection(
  connection: NetworkInformationLike | null | undefined,
): boolean {
  if (!connection) {
    return false;
  }
  return (
    connection.type === "cellular" ||
    SLOW_EFFECTIVE_TYPES.has(connection.effectiveType ?? "") ||
    connection.saveData === true
  );
}

/**
 * Read the four signals off the browser. Each one is wrapped because none
 * exists in a node test, in an old WebView, or in some Electron partitions.
 * Safari and Firefox have no `navigator.connection`, so on those the
 * cellular signal is simply false and the device default stands.
 */
export function readReceiveDeviceSignals(): ReceiveDeviceSignals {
  let coarsePointer = false;
  let smallViewport = false;
  let mobileUserAgent = false;
  let cellular = false;
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
  try {
    cellular = isCellularConnection(networkInformation());
  } catch {
    cellular = false;
  }
  return { coarsePointer, smallViewport, mobileUserAgent, cellular };
}

/**
 * Phones and tablets start at 720p; desktops start on auto; anything on
 * mobile data starts at 360p.
 *
 * 720p rather than 360p because a phone held sideways is a 720-line screen,
 * and the whole point of auto is that the element decides: a phone on auto
 * would already land near 720p in landscape and near 360p in portrait. The
 * fixed 720p is a *ceiling* for the device on top of that, so a tablet drawn
 * at full width never asks for the 1080p layer by accident. A desktop has the
 * pixels and usually the link, so it gets the adaptive default and can pick
 * 1080p by name. Anyone can pick 1080p.
 *
 * CELLULAR WINS OVER THE OTHER THREE. A metered link is a fact about the
 * bill, not the screen: a phone on 5G still pays per byte, and a laptop
 * tethered to one pays the same. 360p of a share is readable text at phone
 * size and a quarter of the 720p layer's bytes. It is a default, so the
 * person who wants 720p on the bus picks it once and it stays picked.
 */
export function defaultReceiveQuality(
  signals: ReceiveDeviceSignals,
): ReceiveQuality {
  if (signals.cellular) {
    return "360p";
  }
  return signals.coarsePointer || signals.smallViewport || signals.mobileUserAgent
    ? "720p"
    : "auto";
}

/** The choice remembered on this device, if the user ever made one. */
export function readStoredReceiveQuality(): ReceiveQuality | null {
  try {
    return parseReceiveQuality(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage denied (privacy mode, an Electron partition without quota):
    // the device default is the app working.
    return null;
  }
}

export function loadReceiveQuality(
  signals: ReceiveDeviceSignals = readReceiveDeviceSignals(),
): ReceiveQuality {
  return readStoredReceiveQuality() ?? defaultReceiveQuality(signals);
}

/**
 * Why the standing quality is what it is, when it was not the user's pick.
 * `null` means either the user chose it or it is the plain device default.
 * The menu turns `"cellular"` into one sentence, because a phone that opens
 * the menu on 360p with no memory of choosing it reads as a broken setting.
 */
export type ReceiveQualityReason = "cellular" | null;

/**
 * The reason for a default, given the signals. Pure, so the store and the
 * tests agree on it.
 */
export function receiveQualityReason(
  signals: ReceiveDeviceSignals,
  explicit: boolean,
): ReceiveQualityReason {
  if (explicit) {
    return null;
  }
  return signals.cellular ? "cellular" : null;
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
/** True once a stored choice was read or the menu was used. Never unset. */
let explicit = false;
let reason: ReceiveQualityReason = null;
const listeners = new Set<(quality: ReceiveQuality) => void>();

/**
 * The connection watcher, started on the first read. A phone that leaves
 * Wi-Fi mid-call fires `change` on `navigator.connection`; if the user never
 * picked a size, the default is recomputed and the session follows it like
 * any other change. A picked size is never touched: the whole promise of the
 * menu is that a choice stays chosen.
 */
let watching: NetworkInformationLike | null = null;
function onConnectionChange() {
  const signals = readReceiveDeviceSignals();
  reason = receiveQualityReason(signals, explicit);
  if (explicit) {
    return;
  }
  const next = defaultReceiveQuality(signals);
  if (next === current) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener(next);
  }
}

function watchConnection(): void {
  if (watching) {
    return;
  }
  const connection = networkInformation();
  if (!connection || typeof connection.addEventListener !== "function") {
    return;
  }
  try {
    connection.addEventListener("change", onConnectionChange);
    watching = connection;
  } catch {
    // An API that exists but refuses listeners: the first read still counts.
  }
}

function ensureLoaded(): ReceiveQuality {
  if (current === null) {
    const stored = readStoredReceiveQuality();
    const signals = readReceiveDeviceSignals();
    explicit = stored !== null;
    current = stored ?? defaultReceiveQuality(signals);
    reason = receiveQualityReason(signals, explicit);
    watchConnection();
  }
  return current;
}

export function getReceiveQuality(): ReceiveQuality {
  return ensureLoaded();
}

/** Why the standing quality is a default rather than a choice. See the type. */
export function getReceiveQualityReason(): ReceiveQualityReason {
  ensureLoaded();
  return reason;
}

export function setReceiveQuality(quality: ReceiveQuality): void {
  ensureLoaded();
  // Choosing the size the default already was is still a choice: the reason
  // line goes away and a connection change no longer moves it. Choosing the
  // size already chosen is nothing, and nobody is told.
  const changed = quality !== current || reason !== null;
  explicit = true;
  reason = null;
  current = quality;
  saveReceiveQuality(quality);
  if (!changed) {
    return;
  }
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
  explicit = false;
  reason = null;
  listeners.clear();
  if (watching) {
    try {
      watching.removeEventListener?.("change", onConnectionChange);
    } catch {
      // Gone already.
    }
    watching = null;
  }
}

export function useReceiveQuality(): ReceiveQuality {
  return useSyncExternalStore(subscribeReceiveQuality, getReceiveQuality);
}

export function useReceiveQualityReason(): ReceiveQualityReason {
  return useSyncExternalStore(subscribeReceiveQuality, getReceiveQualityReason);
}
