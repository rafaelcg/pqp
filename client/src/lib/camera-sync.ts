import { useSyncExternalStore } from "react";

/**
 * THE PRESENTER'S CAMERA, HELD TO THE FILM BY WALL CLOCK.
 *
 * WHY IT DRIFTED. The audience sees the camera through a second playlist and
 * a second hls.js instance (`WatchCameraPip`), and nothing ever lined the two
 * up: each sat at its own live edge with its own cushion, its own buffer and
 * its own stalls. Measured with the real player on a synthetic film and
 * camera (`client/e2e/camera-sync/`, numbers in the PR that added this):
 *
 *  - a conventional party starts 1.5 to 2.5 s apart, depending on where in
 *    each playlist's segment the two players happened to attach;
 *  - a LOW LATENCY party starts about 13 s apart, by construction: the film
 *    plays ~7 s behind its edge (`LlLatencyGovernor`) while the camera, a
 *    conventional rendition on the ordinary cushion, plays 20 s behind its own
 *    (`HLS_LIVE_SYNC_DURATION_COUNT` x 4 s). That is Rafael's screenshot from
 *    the 2026-10-03 party: the film mid-chase, the face reacting to something
 *    thirteen seconds earlier;
 *  - every stall of the camera after that adds its own length, for good,
 *    because nothing pays it back.
 *
 * WHAT IT DOES. Every `CAMERA_SYNC_TICK_MS` it reads the wall clock of the
 * frame each player is showing (`#EXT-X-PROGRAM-DATE-TIME` of the fragment
 * under the playhead plus the offset into it, which is hls.js's own
 * `playingDate`), and moves the CAMERA toward the FILM, never the other way:
 * the film carries the audio and the whole audience's sense of where the show
 * is, and the camera is muted and cheap to move.
 *
 *  - under `CAMERA_SYNC_ENTER_MS` it does nothing (and keeps doing nothing
 *    until a drift crosses it: hysteresis, so a reading that wobbles around a
 *    threshold never flips the rate back and forth);
 *  - up to `CAMERA_SYNC_SEEK_MS` it nudges the camera's playback rate by at
 *    most `CAMERA_SYNC_MAX_NUDGE` (5 %) around whatever rate the film is
 *    playing at (the film's own catch-up runs at up to 1.15x, and a camera at
 *    1.0x beside it would fall behind by itself), until the drift is under
 *    `CAMERA_SYNC_EXIT_MS`;
 *  - past it, it seeks the camera by the drift, at most once every
 *    `CAMERA_SYNC_SEEK_COOLDOWN_MS` and `CAMERA_SYNC_SEEK_BUDGET` times a
 *    minute, never closer than `CAMERA_SYNC_EDGE_MARGIN_MS` to the newest
 *    media the camera's playlist lists (a camera parked on its own edge
 *    starves). When the film is nearer real time than the camera can ever be,
 *    the camera waits at that margin rather than chasing a frame that does not
 *    exist yet, and is never sped up into its edge either.
 *
 * WHAT IT NEVER DOES: touch the film's element, its rate, its buffer or its
 * hls.js; act while either picture is paused, buffering or seeking, or while
 * the page is hidden; or run at all with the `watch_camera_sync` flag off,
 * which leaves the camera byte for byte as it was (`useWatchCameraSync`).
 *
 * WHAT IT CANNOT FIX. It aligns what the two playlists SAY. Both are stamped
 * from the media box's clock as the media arrives (LiveKit egress for the
 * ladder and the camera, `pqp-remux` epoch plus media time for LL), so they
 * agree to within that box's jitter; a camera whose PROGRAM-DATE-TIME were
 * wrong would be held wrong, and the rig proves exactly that it follows the
 * stamps (`camPdtErrorMs` in `hls-server.mjs`).
 */

/** How often the controller looks. Cheap: two getters and a comparison. */
export const CAMERA_SYNC_TICK_MS = 1_000;
/**
 * A drift past this starts a correction. Tight, because the presenter's VOICE
 * is in the film's audio and their FACE is in the camera: this is lip sync,
 * and a face more than about a tenth of a second behind its own voice reads
 * as wrong. The readings jitter by about 15 ms, so this is still a band.
 */
export const CAMERA_SYNC_ENTER_MS = 120;
/** A correction in progress stops once the drift is back under this. */
export const CAMERA_SYNC_EXIT_MS = 40;
/** Past this the camera is seeked instead of nudged. */
export const CAMERA_SYNC_SEEK_MS = 1_000;
/** The most a nudge moves the camera's rate, as a fraction (5 %). */
export const CAMERA_SYNC_MAX_NUDGE = 0.05;
/** The least a nudge moves it while it is correcting, so the tail converges. */
export const CAMERA_SYNC_MIN_NUDGE = 0.01;
/** Drift (ms) that earns the full nudge: proportional below it. */
export const CAMERA_SYNC_FULL_NUDGE_AT_MS = 500;
/** No second seek sooner than this after the last one. */
export const CAMERA_SYNC_SEEK_COOLDOWN_MS = 4_000;
/** Readings right after a seek describe the old position; skip them. */
export const CAMERA_SYNC_SETTLE_MS = 1_500;
/** At most this many seeks in `CAMERA_SYNC_SEEK_WINDOW_MS`, then nudges only. */
export const CAMERA_SYNC_SEEK_BUDGET = 4;
export const CAMERA_SYNC_SEEK_WINDOW_MS = 60_000;
/** Never seek the camera closer than this to the newest media it lists. */
export const CAMERA_SYNC_EDGE_MARGIN_MS = 1_500;
/**
 * Never speed the camera up when it is this close to that newest media. On a
 * low latency party the film sits only a few seconds from the camera's edge
 * (measured: 0.7 to 4.7 s, a segment's worth), so a wider guard left the
 * face 200 ms behind the voice for good.
 */
export const CAMERA_SYNC_NO_SPEEDUP_EDGE_MS = 1_000;
/** A seek shorter than this is not worth a cut in the picture. */
export const CAMERA_SYNC_MIN_SEEK_MS = 300;

export interface CameraSyncInput {
  now: number;
  /** The page is visible. A hidden page is left alone, rate released. */
  visible: boolean;
  /** The film is playing: not paused, not buffering, not seeking. */
  filmPlaying: boolean;
  /** The same of the camera. */
  cameraPlaying: boolean;
  /** Wall clock (epoch ms) of the frame the film is showing, or null. */
  filmWallMs: number | null;
  /** Wall clock of the frame the camera is showing, or null. */
  cameraWallMs: number | null;
  /** The film's own `playbackRate` (its catch-up may run it above 1). */
  filmRate: number;
  /**
   * Wall clock of the END of the newest media the camera's playlist lists,
   * or null when unknown. Bounds a forward seek and the speed-up.
   */
  cameraEdgeWallMs: number | null;
}

export type CameraSyncDecision =
  /** Leave the camera alone, at this rate (1 when released). */
  | { kind: "rate"; rate: number; driftMs: number | null; reason: CameraSyncReason }
  /** Move the camera's `currentTime` by `bySeconds` (and play at `rate`). */
  | { kind: "seek"; bySeconds: number; rate: number; driftMs: number; reason: CameraSyncReason };

export type CameraSyncReason =
  | "idle"
  | "not-playing"
  | "hidden"
  | "no-clock"
  | "settling"
  | "in-sync"
  | "nudge"
  | "seek"
  | "at-edge"
  | "seek-budget";

const clamp = (value: number, low: number, high: number) =>
  Math.min(high, Math.max(low, value));

/** Rates get written only on a real change: two decimals and a half. */
function roundRate(rate: number): number {
  return Math.round(rate * 200) / 200;
}

/**
 * The camera rate that closes `driftMs` (camera minus film; positive is a
 * camera ahead) at the film's own rate. Proportional up to the full nudge,
 * with a floor so the last hundred milliseconds do not take a minute.
 */
export function nudgeRate(driftMs: number, filmRate: number): number {
  const magnitude = clamp(
    Math.abs(driftMs) / CAMERA_SYNC_FULL_NUDGE_AT_MS,
    0,
    1,
  ) * CAMERA_SYNC_MAX_NUDGE;
  const nudge = Math.max(CAMERA_SYNC_MIN_NUDGE, magnitude);
  // Ahead: slow down. Behind: speed up.
  return roundRate(filmRate * (driftMs > 0 ? 1 - nudge : 1 + nudge));
}

/**
 * One controller per mounted camera player. Pure: it is handed readings and
 * answers what to do; the component applies it.
 */
export class CameraSyncController {
  private correcting = false;
  private lastSeekAt = Number.NEGATIVE_INFINITY;
  private seekTimes: number[] = [];
  private budgetSpentLogged = false;
  /** The last decision, for `pqpCameraSync()` in the console. */
  last: CameraSyncDecision | null = null;
  seeks = 0;

  observe(input: CameraSyncInput): CameraSyncDecision {
    const decision = this.decide(input);
    this.last = decision;
    return decision;
  }

  /** True once, the first time the seek budget runs out (for one log line). */
  takeBudgetSpentNotice(): boolean {
    if (this.budgetSpentLogged || !this.budgetSpent(Date.now())) {
      return false;
    }
    this.budgetSpentLogged = true;
    return true;
  }

  private budgetSpent(now: number): boolean {
    this.seekTimes = this.seekTimes.filter(
      (at) => now - at < CAMERA_SYNC_SEEK_WINDOW_MS,
    );
    return this.seekTimes.length >= CAMERA_SYNC_SEEK_BUDGET;
  }

  private release(reason: CameraSyncReason, driftMs: number | null = null): CameraSyncDecision {
    this.correcting = false;
    return { kind: "rate", rate: 1, driftMs, reason };
  }

  private decide(input: CameraSyncInput): CameraSyncDecision {
    const { now } = input;
    if (!input.visible) {
      return this.release("hidden");
    }
    if (!input.filmPlaying || !input.cameraPlaying) {
      return this.release("not-playing");
    }
    if (
      input.filmWallMs === null ||
      input.cameraWallMs === null ||
      !Number.isFinite(input.filmWallMs) ||
      !Number.isFinite(input.cameraWallMs)
    ) {
      return this.release("no-clock");
    }
    const filmRate =
      Number.isFinite(input.filmRate) && input.filmRate > 0 ? input.filmRate : 1;
    if (now - this.lastSeekAt < CAMERA_SYNC_SETTLE_MS) {
      // The camera's own reading still describes where it was.
      return { kind: "rate", rate: roundRate(filmRate), driftMs: null, reason: "settling" };
    }
    const driftMs = input.cameraWallMs - input.filmWallMs;
    const magnitude = Math.abs(driftMs);
    const edge = input.cameraEdgeWallMs;
    const nearEdge =
      edge !== null &&
      Number.isFinite(edge) &&
      edge - input.cameraWallMs < CAMERA_SYNC_NO_SPEEDUP_EDGE_MS;

    if (magnitude > CAMERA_SYNC_SEEK_MS) {
      const canSeek =
        now - this.lastSeekAt >= CAMERA_SYNC_SEEK_COOLDOWN_MS && !this.budgetSpent(now);
      if (canSeek) {
        // Where the camera should be, bounded by what it can actually play.
        let targetWall = input.filmWallMs;
        if (edge !== null && Number.isFinite(edge)) {
          targetWall = Math.min(targetWall, edge - CAMERA_SYNC_EDGE_MARGIN_MS);
        }
        const byMs = targetWall - input.cameraWallMs;
        // Only ever toward the film. A camera behind it whose edge clamp
        // lands BEHIND where it already is (it has been playing toward its
        // newest segment) must not be pulled back to the margin on every
        // cooldown: that is a seek loop with the face jumping each time.
        const towardFilm = Math.sign(byMs) === -Math.sign(driftMs);
        if (towardFilm && Math.abs(byMs) >= CAMERA_SYNC_MIN_SEEK_MS) {
          this.lastSeekAt = now;
          this.seekTimes.push(now);
          this.seeks += 1;
          this.correcting = true;
          return {
            kind: "seek",
            bySeconds: byMs / 1000,
            rate: roundRate(filmRate),
            driftMs,
            reason: "seek",
          };
        }
        // The film is nearer real time than the camera can be: wait at the
        // margin, at the film's rate, rather than run into the edge.
        return { kind: "rate", rate: roundRate(filmRate), driftMs, reason: "at-edge" };
      }
      if (driftMs < 0 && nearEdge) {
        return { kind: "rate", rate: roundRate(filmRate), driftMs, reason: "at-edge" };
      }
      // Out of seeks (or cooling down): the nudge is all that is left.
      this.correcting = true;
      return {
        kind: "rate",
        rate: nudgeRate(driftMs, filmRate),
        driftMs,
        reason: this.budgetSpent(now) ? "seek-budget" : "nudge",
      };
    }

    if (this.correcting ? magnitude < CAMERA_SYNC_EXIT_MS : magnitude < CAMERA_SYNC_ENTER_MS) {
      this.correcting = false;
      return { kind: "rate", rate: roundRate(filmRate), driftMs, reason: "in-sync" };
    }
    if (driftMs < 0 && nearEdge) {
      // Behind, and up against the newest media: speeding up only starves it.
      this.correcting = false;
      return { kind: "rate", rate: roundRate(filmRate), driftMs, reason: "at-edge" };
    }
    this.correcting = true;
    return { kind: "rate", rate: nudgeRate(driftMs, filmRate), driftMs, reason: "nudge" };
  }
}

/**
 * The wall clock of what an hls.js player is showing, from its own
 * `playingDate`, or null when it has none (no PROGRAM-DATE-TIME, nothing
 * loaded, the native engine).
 */
export function hlsPlayingWallMs(player: { playingDate?: Date | null } | null | undefined): number | null {
  try {
    const date = player?.playingDate;
    const ms = date instanceof Date ? date.getTime() : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

/** The slice of hls.js the edge reading needs. */
export interface HlsLevelsLike {
  levels?: Array<{
    details?: {
      fragments?: Array<{ programDateTime?: number | null; duration?: number }>;
    } | null;
  }> | null;
  currentLevel?: number;
}

/**
 * The wall clock of the END of the newest fragment the camera's playlist
 * lists, or null. The camera is one rendition, so the first level with
 * details is the one.
 */
export function hlsEdgeWallMs(player: HlsLevelsLike | null | undefined): number | null {
  try {
    const levels = player?.levels ?? [];
    const level =
      (typeof player?.currentLevel === "number" && player.currentLevel >= 0
        ? levels[player.currentLevel]
        : undefined) ?? levels.find((candidate) => candidate?.details);
    const fragments = level?.details?.fragments ?? [];
    const last = fragments[fragments.length - 1];
    if (!last || typeof last.programDateTime !== "number") {
      return null;
    }
    const end = last.programDateTime + (last.duration ?? 0) * 1000;
    return Number.isFinite(end) ? end : null;
  } catch {
    return null;
  }
}

/** `HTMLMediaElement.HAVE_FUTURE_DATA`. */
const HAVE_FUTURE_DATA = 3;

/** Playing in the sense the controller needs: moving, with media ahead. */
export function elementPlaying(video: HTMLVideoElement | null | undefined): boolean {
  return Boolean(
    video &&
      !video.paused &&
      !video.seeking &&
      !video.ended &&
      video.readyState >= HAVE_FUTURE_DATA,
  );
}

// ------------------------------------------------------------ the flag

/**
 * `watch_camera_sync` (runtime flag, per server, `server/src/lib/flags.ts`),
 * answered on `GET /api/live-hls/config` as `cameraSync`. Reaches the player
 * the way `party_fast_start` does (`lib/party-fast-start.ts`): the app shell
 * writes the selected server's answer here and the camera subscribes, so a
 * player that mounted before the config landed adopts it the moment it does.
 *
 * OFF until the config says `true`, which is the flag's own default: it is
 * turned on one server at a time from the dashboard after a person has checked
 * it on a real party. An API that predates the flag sends no field, and that
 * is off too. Off, nothing here runs and the camera plays exactly as before.
 */
let syncActive = false;
const listeners = new Set<() => void>();

export function setWatchCameraSync(on: boolean): void {
  if (syncActive === on) {
    return;
  }
  syncActive = on;
  for (const listener of [...listeners]) {
    listener();
  }
}

export function watchCameraSyncActive(): boolean {
  return syncActive;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWatchCameraSync(): boolean {
  return useSyncExternalStore(subscribe, watchCameraSyncActive, () => syncActive);
}

/** What the config answer means for this flag: only an explicit true is on. */
export function cameraSyncFromConfig(config: { cameraSync?: boolean } | null | undefined): boolean {
  return config?.cameraSync === true;
}
