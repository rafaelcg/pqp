/**
 * IS MY OWN WATCH-PARTY SCREEN SHARE ACTUALLY ON THE WIRE RIGHT NOW?
 *
 * The presenter is the source of a watch party. When their screen-share
 * publication to the SFU dies but their capture is still alive — the shape of
 * the 2026-09-16 incident, where an API restart's WS resume re-established the
 * voice socket but never the LiveKit screen publish — nothing on the client
 * noticed. The host's UI kept a fake "AO VIVO", a running timer and a viewer
 * count for 35 minutes while the media box sat idle and every viewer stared at
 * the holding screen.
 *
 * These two pure functions are the one place that decides, from four facts,
 * whether the presenter's own share is live, and whether the client should try
 * to re-establish it. `use-voice.ts` reads the four facts off the live session
 * and drives the UI and the auto-recovery from the answers; the split keeps the
 * decision unit-testable away from the hook's 6k lines and the LiveKit SDK.
 *
 * The rule is deliberately narrow: it speaks ONLY to this client's own screen
 * publication on the SFU. A viewer, a mesh call, a camera-only conversation and
 * anyone who is not the presenter all resolve to `idle`, so consulting it never
 * changes their behaviour.
 */

export type ScreenPublishState =
  /** Not the SFU presenter (viewer, mesh, or nothing being shared). */
  | "idle"
  /** Our screen publication is confirmed up on the SFU. */
  | "live"
  /**
   * We still intend to present (the capture is alive) but the publication is
   * not up — a reconnect dropped it, an ICE failure killed the sender, the
   * track got muted. This is the state that must show a truthful "reconnecting"
   * instead of a live badge, and the state auto-recovery acts on.
   */
  | "recovering"
  /**
   * The capture itself ended (the browser's "Stop sharing", the window closed).
   * Republishing is pointless — there is nothing to publish — so the host is
   * asked to pick a screen again. In practice the capture's own `onended` tears
   * the share down first; this exists so a recovery tick that races it does not
   * try to republish a dead track.
   */
  | "ended";

export function screenPublishState(input: {
  /** This room's media runs on the LiveKit SFU (watch parties always do). */
  usingSfu: boolean;
  /** This client holds a screen capture it intends to be broadcasting. */
  sharing: boolean;
  /** The captured video track's `readyState` is still `"live"`. */
  captureTrackLive: boolean;
  /** The SFU reports a live, unmuted ScreenShare publication for us. */
  publicationLive: boolean;
}): ScreenPublishState {
  if (!input.usingSfu || !input.sharing) {
    return "idle";
  }
  if (!input.captureTrackLive) {
    return "ended";
  }
  return input.publicationLive ? "live" : "recovering";
}

/**
 * Should the client re-publish the existing capture now?
 *
 * Only when we are genuinely `recovering`, the room is actually connected (a
 * publish into a room that is mid-reconnect throws or hangs), and no republish
 * is already in flight (so overlapping recovery ticks can never double-publish
 * or loop). A `live`, `idle` or `ended` state never republishes.
 */
export function shouldRepublishScreen(input: {
  state: ScreenPublishState;
  /** `sfu.isConnected()` — the LiveKit room is in the Connected state. */
  roomConnected: boolean;
  /** A republish this function already asked for has not finished yet. */
  republishInFlight: boolean;
}): boolean {
  return (
    input.state === "recovering" &&
    input.roomConnected &&
    !input.republishInFlight
  );
}
