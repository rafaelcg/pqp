/**
 * "Your share went out with no sound, and macOS is why."
 *
 * A one-bit store, kept out of the voice controller's state on purpose: the
 * controller's state is a type every call fixture spells out, and this is a
 * card for one platform that appears at most once per share. The controller
 * raises it (`use-voice.ts`, after a macOS share whose computer sound did not
 * open) and clears it when the next share starts; `MacShareAudioPermissionNotice`
 * reads it.
 *
 * What raises it (`lib/mac-shell-share-audio.ts`): the capture rejected over
 * its sound and the shell took it back without sound (Chromium probes the
 * CoreAudio Tap when it opens it, and a missing "System Audio Recording"
 * grant fails the open), or the audio track came back `ended` (Electron's
 * documented silent failure of the same grant).
 */

export interface MacShareAudioPermissionState {
  /** A monotonic id, so closing one card does not close the next share's. */
  at: number;
}

let current: MacShareAudioPermissionState | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) {
    listener();
  }
}

export function raiseMacShareAudioPermission(): void {
  counter += 1;
  current = { at: counter };
  emit();
}

export function clearMacShareAudioPermission(): void {
  if (current === null) {
    return;
  }
  current = null;
  emit();
}

export function subscribeMacShareAudioPermission(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getMacShareAudioPermission(): MacShareAudioPermissionState | null {
  return current;
}

export function resetMacShareAudioPermissionForTests(): void {
  current = null;
  counter = 0;
  listeners.clear();
}
