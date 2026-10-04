import { useSyncExternalStore } from "react";

/**
 * Whether the call stage's controls fade out while one stream fills it.
 *
 * On by default, the way every video player behaves: a person watching a
 * share does not want a bar across the bottom of it. Off is for somebody who
 * would rather the bar never moved (a screen reader user, a shared kiosk, a
 * habit). The rules for WHEN the controls may go are in
 * `components/voice/stage-chrome.ts`; this is only the person's veto.
 *
 * Device-local, in the same family as the music toggles beside it in the voice
 * settings: it describes how this screen behaves, not who the person is.
 */

const STORAGE_KEY = "pqp:auto-hide-stage-controls";

let current: boolean | null = null;
const listeners = new Set<(value: boolean) => void>();

function parseAutoHide(raw: unknown): boolean | null {
  if (raw === "1" || raw === "true") {
    return true;
  }
  if (raw === "0" || raw === "false") {
    return false;
  }
  return null;
}

function readStored(): boolean | null {
  try {
    return parseAutoHide(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null;
  }
}

function ensureLoaded(): boolean {
  if (current === null) {
    current = readStored() ?? true;
  }
  return current;
}

/** True when the stage may fade its controls over an idle stream. */
export function autoHideStageControls(): boolean {
  return ensureLoaded();
}

export function setAutoHideStageControls(enabled: boolean): void {
  const changed = ensureLoaded() !== enabled;
  current = enabled;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  } catch {
    // Not stored is still set for this session.
  }
  if (!changed) {
    return;
  }
  for (const listener of listeners) {
    listener(enabled);
  }
}

export function subscribeAutoHideStageControls(
  listener: (value: boolean) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: forget the in-memory copy so the next read hits storage again. */
export function resetAutoHideStageControlsForTests(): void {
  current = null;
  listeners.clear();
}

export function useAutoHideStageControls(): boolean {
  return useSyncExternalStore(
    subscribeAutoHideStageControls,
    autoHideStageControls,
    autoHideStageControls,
  );
}
