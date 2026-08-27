import { browserStorage } from "./arrival";

/** Remembered once they close the strip above the user row. */
export const DOWNLOAD_HINT_STORAGE_KEY = "pqp:download-hint-dismissed";

/**
 * Whether this browser already hid the in-app download strip.
 *
 * Missing or hostile storage shows the strip: a reminder that comes back is
 * cheaper than one that never appears because we could not read the flag.
 */
export function isDownloadHintDismissed(
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
): boolean {
  try {
    return storage?.getItem(DOWNLOAD_HINT_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Persist the dismiss. Callers still hide the strip in React state for this
 * session even when the write fails (quota, private mode, locked-down store).
 */
export function dismissDownloadHint(
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
): void {
  try {
    storage?.setItem(DOWNLOAD_HINT_STORAGE_KEY, "1");
  } catch {
    // Session-only hide lives in the component that called this.
  }
}
