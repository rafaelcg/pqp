/**
 * Mute and deafen, the way the voice controls behave.
 *
 * Deafening turns the mic off for as long as you cannot hear. Undeafen puts
 * the mic back to the choice from before that, including a mute set while
 * deafened. Pressing unmute while deafened also brings hearing back.
 *
 * The user-panel buttons, the in-call mute button, the window shortcut and
 * the desktop global shortcut all end in `toggleMute` / `toggleDeafen` on
 * the voice controller. That controller applies these transitions, so the
 * four doors cannot disagree.
 */

export interface MicDeafen {
  /** Effective mic state: the button, the roster and the track. */
  muted: boolean;
  deafened: boolean;
  /**
   * Mic choice to restore when deafen ends. `false` means it was open.
   * `null` only while this person can hear.
   */
  muteBeforeDeafen: boolean | null;
}

export interface MicLocks {
  canSpeak: boolean;
  serverMuted: boolean;
}

function locked(locks: MicLocks): boolean {
  return !locks.canSpeak || locks.serverMuted;
}

export function deafenToggle(state: MicDeafen, locks: MicLocks): MicDeafen {
  if (state.deafened) {
    // A missing memory stays muted. Undeafen must not open the mic by surprise.
    const restoreMuted = state.muteBeforeDeafen !== false;
    return {
      deafened: false,
      muteBeforeDeafen: null,
      muted: restoreMuted || locked(locks),
    };
  }
  return {
    deafened: true,
    muteBeforeDeafen: state.muted || locked(locks),
    muted: true,
  };
}

/** Unmute while deafened also undeafens. A speak lock does not move. */
export function muteToggle(state: MicDeafen, locks: MicLocks): MicDeafen {
  if (!locks.canSpeak) {
    return state;
  }
  if (state.deafened) {
    return {
      deafened: false,
      muteBeforeDeafen: null,
      muted: locks.serverMuted,
    };
  }
  if (locks.serverMuted) {
    return { ...state, muteBeforeDeafen: null, muted: true };
  }
  return { deafened: false, muteBeforeDeafen: null, muted: !state.muted };
}

/**
 * An explicit mute while deafened sticks after undeafen.
 * An explicit unmute while deafened also undeafens, unless a lock refuses it.
 */
export function muteSet(
  state: MicDeafen,
  muted: boolean,
  locks: MicLocks,
): MicDeafen {
  if (locked(locks)) {
    return {
      deafened: state.deafened,
      muteBeforeDeafen: state.deafened ? true : null,
      muted: true,
    };
  }
  if (state.deafened && !muted) {
    return { deafened: false, muteBeforeDeafen: null, muted: false };
  }
  if (state.deafened && muted) {
    return { deafened: true, muteBeforeDeafen: true, muted: true };
  }
  return { deafened: false, muteBeforeDeafen: null, muted };
}

/**
 * A moderator mute, or a seat that lost SPEAK, keeps the mic off after
 * undeafen. Clearing the lock is not itself an unmute.
 */
export function micLock(state: MicDeafen, locks: MicLocks): MicDeafen {
  if (!locked(locks)) {
    return state;
  }
  return {
    deafened: state.deafened,
    muted: true,
    muteBeforeDeafen: state.deafened ? true : state.muteBeforeDeafen,
  };
}
