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
 * - `restarting`: the stall watchdog's `sequence-stuck` reason — the playlist
 *   answers but its media sequence has not moved for 20s, which is what a
 *   dead egress that is about to be replaced looks like (see `hls-stall.ts`).
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
 */
export type HoldingScreenReason =
  | "restarting"
  | "reconnecting"
  | "silent"
  | "dead"
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
}): HoldingScreenReason {
  if (input.phase === "playing" && input.hasFrame) {
    return null;
  }
  if (input.phase === "dead") {
    return "dead";
  }
  if (input.authGraceActive) {
    return "silent";
  }
  if (input.stallReason === "sequence-stuck") {
    return "restarting";
  }
  return "reconnecting";
}
