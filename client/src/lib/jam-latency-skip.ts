/**
 * "I do not want to calibrate" is an answer per pair of devices, not per visit.
 *
 * The studio's first screen explains the latency check and offers a skip. Without
 * a memory, anybody who never calibrates would meet that full-page screen on every
 * recording. The skip is remembered under the engine's own device-pair key
 * (`LatencyStatus.key`: input, output and rate), so a different headset or
 * interface asks again and the same one does not. Per viewer and per device on
 * purpose (`localStorage`); every access is wrapped because storage can throw.
 */

const PREFIX = "pqp:jam-latency-skip:";

type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;

function browserStore(): Store {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function isCheckSkipped(deviceKey: string, store: Store = browserStore()): boolean {
  try {
    return store?.getItem(PREFIX + deviceKey) === "1";
  } catch {
    return false;
  }
}

export function rememberCheckSkipped(deviceKey: string, store: Store = browserStore()): void {
  try {
    store?.setItem(PREFIX + deviceKey, "1");
  } catch {
    // Asked again next time; nothing is lost.
  }
}

/** Calibrating (or asking to) ends a skip: the person changed their mind. */
export function forgetCheckSkipped(deviceKey: string, store: Store = browserStore()): void {
  try {
    store?.removeItem(PREFIX + deviceKey);
  } catch {
    // Same.
  }
}
