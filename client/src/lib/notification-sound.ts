/**
 * Who makes the noise when an OS banner is raised: the app or the OS.
 *
 * A banner only appears while the window is away, so the sound has exactly one
 * owner. When the app plays its own cue for the event, the banner is created
 * silent so the two do not double. When the app plays nothing for it, the
 * banner must NOT be silent or the event arrives with no sound at all, which
 * is what user bug report 123 was: `silent` followed the master switch alone, an ordinary
 * channel message has no app cue by design, and so every "all messages" banner
 * on the desktop app was mute.
 *
 * Pure so the rule can be read and tested without the sound engine.
 */

import type { SoundCue, SoundState } from "@/lib/sounds";

/** What the activity flush plays for a burst, mirrored here so it is one rule. */
export function cueForBurstActivity(input: {
  mentions: number;
  systemKind?: string | null;
  kind?: string | null;
}): SoundCue | null {
  if (input.mentions > 0) {
    return "mention";
  }
  if (input.systemKind === "nudge") {
    return "nudge";
  }
  if (input.kind === "dm" || input.kind === "group") {
    return "message";
  }
  // An ordinary channel message has no cue of its own.
  return null;
}

/**
 * Whether the app itself will make a sound for this cue right now: the master
 * switch is on and the cue's own switch is on. `null` (the event has no app
 * cue, e.g. a stream starting) means the app makes none.
 */
export function appWillPlayCue(sounds: SoundState, cue: SoundCue | null): boolean {
  if (cue === null || !sounds.enabled) {
    return false;
  }
  return sounds[cue] === true;
}

/**
 * The `silent` flag for the banner.
 *
 * - Window in front: the app is on screen and owns the sound, never the OS.
 * - Window away and the app plays a cue: silent, the cue is the sound.
 * - Window away and the app plays nothing: not silent, the OS default sound
 *   (it keeps its own Do Not Disturb and volume) is the only sound there is.
 */
export function bannerSilent(input: {
  windowFocused: boolean;
  sounds: SoundState;
  cue: SoundCue | null;
}): boolean {
  if (input.windowFocused) {
    return true;
  }
  return appWillPlayCue(input.sounds, input.cue);
}
