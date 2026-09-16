import type { HlsStallReason } from "@/lib/hls-stall";

/**
 * What the holding screen over the watch-party player says, mapped from the
 * player's own `phase` and the stall watchdog's `lastReason` — nothing new is
 * measured here, this only reads what `hls-watch-player.tsx` already tracks.
 *
 * From the 2026-09-12 post-mortem (`docs/plans/WATCH_PARTY_POSTMORTEM_2026-09-12.md`
 * item C3): "bolhas" x30, nobody could tell whether a black screen meant the
 * presenter had not started, the egress restarted, the network dropped, or
 * nothing at all was wrong. Four different situations, one silent spinner.
 *
 * - `restarting`: the stall watchdog's `sequence-stuck` or `playlist-gone`
 *   reason — either the playlist answers but its media sequence has not
 *   moved for 20s (a dead egress about to be replaced; see `hls-stall.ts`),
 *   or our own playlist proxy answered 404/410 (the previous session is
 *   already gone and a fresh master is what reconnect is polling for).
 *   The reconnect that follows fetches a fresh session, typically inside the
 *   restart window the copy names.
 * - `reconnecting`: any other stall (a network drop) or a fatal media error.
 *   Honest about not knowing why, unlike `restarting`.
 * - `silent`: pitfall 16 (`CLAUDE.md`) — a Clerk JWT dead for a few seconds
 *   around its ~60s refresh window vetoes a playlist request that carries a
 *   perfectly good `?t=` capability. The player recovers on its own almost
 *   immediately, so this is asked to show NOTHING rather than flash a stall
 *   overlay for a failure the person never needs to know happened. `authGrace`
 *   is the caller's promise that the failure is still fresh; past it (three
 *   seconds, `AUTH_GRACE_MS`) a stall that has not resolved is a real one and
 *   falls through to `reconnecting`/`restarting` like any other.
 * - `dead`: the watchdog gave up (`HlsStallWatch` `dead` decision) — the
 *   existing retry-button overlay, unchanged.
 * - `null`: nothing to say — a frame is playing.
 *
 * `restarting` is checked BEFORE the "a frame is playing" guard below
 * (`BROADCAST_PIPELINE.md` B1.3): the player no longer tears hls.js down for
 * a `sequence-stuck` egress, so `phase` stays `"playing"` and the last frame
 * stays on screen — `hasFrame` and `phase` alone would say nothing is wrong.
 * `stallReason` is the one signal that still says so, and `onPlaying`
 * already clears it the moment a frame actually arrives again, so this
 * cannot linger past the episode it describes.
 *
 * A REPLAY (`mode: "vod"`) GETS A DIFFERENT VOCABULARY ENTIRELY, not just a
 * different label on the same states. A finished broadcast's playlist is a
 * fixed, ended `#EXT-X-MEDIA-SEQUENCE`: it is SUPPOSED to stop advancing the
 * moment the whole thing is buffered, which is exactly what `restarting`
 * exists to call a dead egress. Handing a VOD player the live vocabulary
 * restarts a perfectly healthy playback loop every ~20s and, after three of
 * those, calls a fine recording "A transmissão caiu" -- copy that describes a
 * live show falling over, not a clip that finished downloading. So a replay
 * never sees `restarting` or the live flavour of `reconnecting`: ordinary
 * buffering (no frame yet, nothing wrong) is `buffering`, plain and mute, and
 * the watchdog giving up for real is `unavailable` -- "the recording is gone",
 * never "the stream died". Note this also means the `mode === "vod"` check
 * runs BEFORE the `stallReason === "sequence-stuck"` check below, so a
 * replay never reaches the live `restarting` branch at all.
 */
export type HoldingScreenReason =
  | "restarting"
  | "reconnecting"
  | "silent"
  | "dead"
  | "buffering"
  | "unavailable"
  | null;

/** How long a fresh auth failure is given to resolve itself before the
 *  holding screen starts speaking about it. */
export const AUTH_GRACE_MS = 3_000;

/** The restart copy's countdown starts here and counts down on the stall tick. */
export const RESTART_COUNTDOWN_SECONDS = 10;

export function resolveHoldingScreenReason(input: {
  phase: "playing" | "reconnecting" | "dead";
  hasFrame: boolean;
  stallReason: HlsStallReason;
  /** True for `AUTH_GRACE_MS` after a playlist request came back 401. */
  authGraceActive: boolean;
  /** A finished broadcast's replay, not a live watch party. Defaults to
   *  `"live"` so every existing caller keeps today's vocabulary. */
  mode?: "live" | "vod";
}): HoldingScreenReason {
  if (input.phase === "dead") {
    return input.mode === "vod" ? "unavailable" : "dead";
  }
  if (input.authGraceActive) {
    return "silent";
  }
  if (input.mode === "vod") {
    // A replay still needs the "a frame is playing" guard -- it is simply
    // never followed by the live `restarting`/`reconnecting` branches below.
    if (input.phase === "playing" && input.hasFrame) {
      return null;
    }
    return "buffering";
  }
  if (input.stallReason === "sequence-stuck" || input.stallReason === "playlist-gone") {
    return "restarting";
  }
  if (input.phase === "playing" && input.hasFrame) {
    return null;
  }
  return "reconnecting";
}
