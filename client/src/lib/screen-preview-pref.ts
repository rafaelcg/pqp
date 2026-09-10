import { useSyncExternalStore } from "react";

/**
 * Whether the person sharing a screen also plays it back locally.
 *
 * A live `<video>` of your own capture still composites and decodes on this
 * machine, which is CPU a watch-party host is already spending on encode.
 * Viewers still get the picture; this only skips drawing it twice for the
 * person who is looking at the original.
 *
 * Shown until somebody says otherwise: hiding the preview by default would
 * look like the share had failed.
 */

const STORAGE_KEY = "pqp:hide-screen-preview";

let current: boolean | null = null;
const listeners = new Set<(value: boolean) => void>();

function parseHideScreenPreview(raw: unknown): boolean | null {
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return null;
}

function readStoredHideScreenPreview(): boolean | null {
  try {
    return parseHideScreenPreview(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function ensureLoaded(): boolean {
  if (current === null) {
    current = readStoredHideScreenPreview() ?? false;
  }
  return current;
}

/** True when the local preview should not mount a live `<video>`. */
export function hideScreenPreview(): boolean {
  return ensureLoaded();
}

export function setHideScreenPreview(hide: boolean): void {
  const changed = ensureLoaded() !== hide;
  current = hide;
  try {
    localStorage.setItem(STORAGE_KEY, hide ? "1" : "0");
  } catch {
    // Not stored is still set for this session.
  }
  if (!changed) {
    return;
  }
  for (const listener of listeners) {
    listener(hide);
  }
}

export function subscribeHideScreenPreview(
  listener: (value: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetHideScreenPreviewForTests(): void {
  current = null;
  listeners.clear();
}

export function useHideScreenPreview(): boolean {
  return useSyncExternalStore(
    subscribeHideScreenPreview,
    hideScreenPreview,
    hideScreenPreview,
  );
}
