/** Personal ducking of the YouTube embed under speech. No audio through us. */

export const MUSIC_DUCK_TARGET = 0.35;
export const MUSIC_DUCK_ATTACK_MS = 200;
export const MUSIC_DUCK_RELEASE_MS = 800;
export const MUSIC_DUCK_TICK_MS = 50;

/**
 * One step of the envelope. Speech ramps 1 → 0.35 over 200 ms; quiet ramps
 * back over 800 ms. Re-triggering mid-release continues from the current
 * gain rather than jumping back to 1.
 */
export function stepDuckGain(
  currentGain: number,
  speaking: boolean,
  dtMs: number,
): number {
  const target = speaking ? MUSIC_DUCK_TARGET : 1;
  if (dtMs <= 0) {
    return clampGain(currentGain);
  }
  const span = 1 - MUSIC_DUCK_TARGET;
  const duration = speaking ? MUSIC_DUCK_ATTACK_MS : MUSIC_DUCK_RELEASE_MS;
  const delta = (span * dtMs) / duration;
  if (speaking) {
    return clampGain(Math.max(target, currentGain - delta));
  }
  return clampGain(Math.min(target, currentGain + delta));
}

/**
 * Timestamp form of the same envelope. `gainAtEdge` is the gain when
 * speech last started or stopped, so a re-trigger during release does not
 * restart from 1.
 */
export function duckGain(
  now: number,
  speakingSince: number | null,
  quietSince: number | null,
  gainAtEdge = speakingSince != null ? 1 : MUSIC_DUCK_TARGET,
): number {
  if (speakingSince != null) {
    return stepDuckGain(gainAtEdge, true, now - speakingSince);
  }
  if (quietSince != null) {
    return stepDuckGain(gainAtEdge, false, now - quietSince);
  }
  return 1;
}

export function musicShouldDuck(input: {
  duckEnabled: boolean;
  deafened: boolean;
  speakingPeerCount: number;
  transmitting: boolean;
}): boolean {
  if (!input.duckEnabled || input.deafened) {
    return false;
  }
  return input.speakingPeerCount > 0 || input.transmitting;
}

function clampGain(value: number): number {
  return Math.min(1, Math.max(MUSIC_DUCK_TARGET, value));
}
