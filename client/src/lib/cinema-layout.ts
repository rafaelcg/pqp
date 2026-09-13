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
  /**
   * This channel is a watch party. Once somebody holds a SEAT in one, the
   * SFU screen share is the one and only picture — never true alongside
   * `live`/`audience` on purpose.
   *
   * THE 2026-09-13 INCIDENT. A viewer watched the party over HLS, pressed
   * Entrar and got two pictures at two delays with two soundtracks: the
   * seatless `WatchChannelStage` correctly unmounts the instant a seat is
   * taken (`inThisCall` in `watch-stage.tsx`), but `CallStage` landed the
   * new participant straight into ITS OWN cinema view — `audienceMode`
   * defaults to `watchingHls` the moment the room's `liveStream` arrives, a
   * beat after the seat itself — which mounts a SECOND, independent
   * `HlsWatchPlayer` while `VoiceAudioSinks` keeps playing that same
   * presenter's screen audio over WebRTC regardless (`audibleScreenPeerIds`
   * has no idea a cinema tile exists). Two of everything, roughly ten
   * seconds apart.
   *
   * Cinema-as-a-landing-view was a real feature for whatever the ordinary
   * (non-watch-party) case turns out to be; a watch party is not that case.
   * `hasAudio`/HLS egress only ever runs on a `watch_party` channel
   * (`liveHlsForcesSfu`), so this flag is the one that actually matters in
   * practice — `live` alone was never a safe gate for it.
   */
  isWatchParty?: boolean;
}

/**
 * Cinema replaces the ordinary stage only for a live stream's audience, and
 * never at all once a seat in a watch party is held — see `isWatchParty`.
 */
export function shouldShowCinema({
  live,
  audience,
  isWatchParty = false,
}: CinemaModeInput): boolean {
  if (isWatchParty) {
    return false;
  }
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
