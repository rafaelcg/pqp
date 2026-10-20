/**
 * THIS MACHINE'S MUSIC LEVEL.
 *
 * The track plays on each listener's own machine through the YouTube iframe,
 * so the level is personal: it is never sent over the socket and never
 * reaches anybody else. Pure functions here, the shared store in
 * `music-local-playback.ts`, the glyph and the sliders in
 * `music-speaker-control.tsx`.
 *
 * Mute is YouTube's own `mute()` and leaves the level alone, which is what
 * lets an unmute come back where it was. The one case that needs memory is a
 * level dragged all the way to 0 and then "unmuted": silence again is not
 * what the click meant, so it goes back to the last level that was audible.
 */

export const MUSIC_VOLUME_KEY = "pqp:music-volume";
export const MUSIC_VOLUME_RESTORE_KEY = "pqp:music-volume-restore";

/** Slider, keyboard and wheel all move in this many percent. */
export const MUSIC_VOLUME_STEP = 5;
export const MUSIC_VOLUME_DEFAULT = 40;

export interface MusicVolumeModel {
  /** 0 to 100, kept while muted. */
  volume: number;
  muted: boolean;
  /** The last level above zero: what an unmute from silence goes back to. */
  restoreVolume: number;
}

export type MusicVolumeGlyph = "muted" | "low" | "medium" | "high";

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return MUSIC_VOLUME_DEFAULT;
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

/** One step up or down on the 5 percent grid, snapping off-grid values first. */
export function stepVolume(
  value: number,
  direction: 1 | -1,
  step: number = MUSIC_VOLUME_STEP,
): number {
  const current = clampVolume(value);
  const next =
    direction > 0
      ? (Math.floor(current / step) + 1) * step
      : (Math.ceil(current / step) - 1) * step;
  return clampVolume(next);
}

export function initialVolumeModel(
  volume: number = MUSIC_VOLUME_DEFAULT,
  restoreVolume: number = MUSIC_VOLUME_DEFAULT,
): MusicVolumeModel {
  const level = clampVolume(volume);
  const restore = clampVolume(restoreVolume);
  return {
    volume: level,
    muted: false,
    restoreVolume: level > 0 ? level : restore > 0 ? restore : MUSIC_VOLUME_DEFAULT,
  };
}

/** What the speaker shows and the slider sits at. */
export function shownVolume(model: MusicVolumeModel): number {
  return model.muted ? 0 : model.volume;
}

/** A level chosen on purpose always unmutes, and a level above zero is remembered. */
export function withVolume(model: MusicVolumeModel, value: number): MusicVolumeModel {
  const volume = clampVolume(value);
  return {
    volume,
    muted: false,
    restoreVolume: volume > 0 ? volume : model.restoreVolume,
  };
}

export function withMuted(model: MusicVolumeModel, muted: boolean): MusicVolumeModel {
  if (!muted) {
    // Unmuting at a level of zero would only be silence again.
    return model.volume === 0
      ? withVolume(model, model.restoreVolume)
      : { ...model, muted: false };
  }
  if (model.muted) {
    return model;
  }
  return {
    ...model,
    muted: true,
    restoreVolume: model.volume > 0 ? model.volume : model.restoreVolume,
  };
}

export function toggledMuted(model: MusicVolumeModel): MusicVolumeModel {
  return withMuted(model, shownVolume(model) !== 0);
}

/**
 * Wheel, keyboard shortcut or anything else that nudges by whole steps.
 * Down while already silent stays silent; up from muted starts at the level
 * that was kept, one step higher.
 */
export function nudgedVolume(model: MusicVolumeModel, steps: number): MusicVolumeModel {
  if (steps === 0) {
    return model;
  }
  const direction = steps > 0 ? 1 : -1;
  if (model.muted && direction < 0) {
    return model;
  }
  let level = model.volume;
  for (let i = 0; i < Math.abs(steps); i += 1) {
    level = stepVolume(level, direction);
  }
  return withVolume(model, level);
}

export function volumeGlyph(shown: number): MusicVolumeGlyph {
  if (shown <= 0) {
    return "muted";
  }
  if (shown <= 33) {
    return "low";
  }
  if (shown <= 66) {
    return "medium";
  }
  return "high";
}

/**
 * Wheel deltas as steps. A mouse notch is 100 pixels and a trackpad sends
 * dozens of small ones, so small deltas add up until they reach the
 * threshold: one notch is one step, however hard it was spun, and a slow
 * two-finger scroll does not run through the whole range.
 */
export const MUSIC_WHEEL_THRESHOLD = 40;

export function wheelSteps(
  carry: number,
  deltaY: number,
  deltaMode = 0,
): { steps: 1 | -1 | 0; carry: number } {
  const pixels = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 100 : deltaY;
  const total = carry + pixels;
  if (Math.abs(total) < MUSIC_WHEEL_THRESHOLD) {
    return { steps: 0, carry: total };
  }
  // Wheel up (negative deltaY) is louder.
  return { steps: total < 0 ? 1 : -1, carry: 0 };
}

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A per-device convenience: without storage the level lasts the session.
  }
}

function parseStored(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") {
    return null;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampVolume(parsed) : null;
}

/** The saved level, or the default when there is none, or storage will not answer. */
export function readMusicVolume(): number {
  return parseStored(readStored(MUSIC_VOLUME_KEY)) ?? MUSIC_VOLUME_DEFAULT;
}

export function writeMusicVolume(value: number): void {
  writeStored(MUSIC_VOLUME_KEY, String(clampVolume(value)));
}

export function readStoredVolumeModel(): MusicVolumeModel {
  return initialVolumeModel(
    readMusicVolume(),
    parseStored(readStored(MUSIC_VOLUME_RESTORE_KEY)) ?? MUSIC_VOLUME_DEFAULT,
  );
}

export function writeStoredVolumeModel(model: MusicVolumeModel): void {
  writeMusicVolume(model.volume);
  writeStored(MUSIC_VOLUME_RESTORE_KEY, String(clampVolume(model.restoreVolume)));
}
