/**
 * The cinema layout's pure decisions: whether it applies at all, and which
 * orientation it draws in. Kept free of React so the phone/desktop switch and
 * the live/audience switch are each one assertion, not a mounted component.
 */

export interface CinemaModeInput {
  /** A ready HLS playlist exists for this channel right now. */
  live: boolean;
  /**
   * The viewer has not joined this channel's call as a participant. Cinema
   * is an audience view; a participant gets the ordinary call stage, mute
   * and camera controls included.
   */
  audience: boolean;
}

/** Cinema replaces the ordinary stage only for a live stream's audience. */
export function shouldShowCinema({ live, audience }: CinemaModeInput): boolean {
  return live && audience;
}

export type CinemaOrientation = "phone" | "desktop";

/** Reuses the same `lg` breakpoint every other split in the app measures against. */
export function cinemaOrientation(isLgUp: boolean): CinemaOrientation {
  return isLgUp ? "desktop" : "phone";
}

export interface CinemaStagePerson {
  key: string;
  name: string;
  avatarUrl: string | null;
  speaking: boolean;
  isHost: boolean;
}

/**
 * Up to `limit` avatars for the presence line, oldest/self first so the
 * strip does not reshuffle every time someone else joins or leaves.
 */
export function presenceAvatars<T>(people: T[], limit = 8): T[] {
  return people.slice(0, limit);
}
