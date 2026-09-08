/**
 * Whether the seated-person row shows its "this opens their sound" glyph, and
 * whether it shows it all the time.
 *
 * WHY IT IS A DECISION AND NOT A HOVER CLASS. The row has opened the per-person
 * audio panel since the panel existed, and nothing on the row ever said so: a
 * moderator running a 510-member community asked for per-person volume and
 * wrote "acho que deve ter porém não achei". A control nobody can see is a
 * control nobody has.
 *
 * THREE ANSWERS, for the reason the channel row's pin has three states. A
 * person you cannot turn down (yourself, or anyone in a call you have not
 * joined) gets nothing, because the panel would govern nothing. A person you
 * HAVE turned down, or whose panel is open right now, gets the glyph
 * permanently: that is state, and state that only appears under the pointer is
 * state you cannot find again. Everyone else gets it on hover and on focus,
 * which is the same deal the pin and the gear on a channel row offer, and it
 * keeps a 180px column from spending pixels on every row at once.
 */
export type VoiceOccupantAudioAffordance = "hidden" | "hover" | "always";

export function voiceOccupantAudioAffordance(input: {
  /** Their voice volume, 0 to 1. Undefined when there is no voice track. */
  voiceVolume?: number;
  /** Their share's volume, 0 to 1. Undefined when they are not sharing. */
  shareVolume?: number;
  /** Whether the panel is open on this row right now. */
  menuOpen: boolean;
}): VoiceOccupantAudioAffordance {
  const { voiceVolume, shareVolume, menuOpen } = input;
  if (voiceVolume === undefined && shareVolume === undefined) {
    return "hidden";
  }
  if (menuOpen) {
    return "always";
  }
  const turnedDown =
    (voiceVolume !== undefined && voiceVolume < 1) ||
    (shareVolume !== undefined && shareVolume < 1);
  return turnedDown ? "always" : "hover";
}

/**
 * Which glyph the affordance draws. Silenced reads differently from merely
 * quieter, the way the panel's own rows already do it.
 */
export function voiceOccupantAudioSilenced(input: {
  voiceVolume?: number;
  shareVolume?: number;
}): boolean {
  const { voiceVolume, shareVolume } = input;
  if (voiceVolume === undefined && shareVolume === undefined) {
    return false;
  }
  // Silenced means every track you can hear them on is at zero, not just one:
  // somebody muted on voice while their share still plays is not silent.
  return (
    (voiceVolume === undefined || voiceVolume === 0) &&
    (shareVolume === undefined || shareVolume === 0)
  );
}

/**
 * Whether the row prepends its "their sound" item to the context menu.
 *
 * The same question the glyph asks, asked once so the two cannot drift: a row
 * that shows no affordance must not carry a menu item that opens a panel
 * governing nothing, and a row that shows one must be reachable by the gesture
 * people bring from Discord.
 */
export function voiceOccupantAudioInMenu(
  affordance: VoiceOccupantAudioAffordance,
): boolean {
  return affordance !== "hidden";
}
