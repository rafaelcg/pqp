/**
 * Keeping a stem's <video> on the audio clock. The video is always muted; its
 * sound is the stem, played by the engine. The picture follows.
 *
 * `decideVideo` is the pure rule, `attachVideo` runs it every animation frame.
 * The rule is the same shape as the watch party's camera follower: small
 * drift is pulled in by nudging `playbackRate` (at most 5 %, which nobody
 * sees), large drift is a seek, and a paused transport parks the picture on
 * the right frame.
 */

export interface VideoState {
  /** Where the video should be: the buffer time being HEARD now, seconds. */
  targetSec: number;
  currentSec: number;
  durationSec: number;
  transportPlaying: boolean;
  videoPaused: boolean;
}

export type VideoAction =
  | { kind: "none"; rate: number }
  | { kind: "rate"; rate: number }
  | { kind: "seek"; to: number; play: boolean }
  | { kind: "pause"; to: number | null };

export const SEEK_THRESHOLD_SEC = 0.3;
export const RATE_DEADBAND_SEC = 0.015;
export const MAX_RATE_NUDGE = 0.05;

export function decideVideo(s: VideoState): VideoAction {
  const duration = Number.isFinite(s.durationSec) && s.durationSec > 0 ? s.durationSec : Infinity;
  const inside = s.targetSec >= 0 && s.targetSec < duration;
  const clamped = Math.min(Math.max(0, s.targetSec), Number.isFinite(duration) ? duration : s.targetSec);
  if (!s.transportPlaying || !inside) {
    const off = Math.abs(s.currentSec - clamped) > 0.02;
    if (!s.videoPaused || off) return { kind: "pause", to: off ? clamped : null };
    return { kind: "none", rate: 1 };
  }
  const drift = s.currentSec - s.targetSec;
  if (s.videoPaused || Math.abs(drift) > SEEK_THRESHOLD_SEC) {
    return { kind: "seek", to: s.targetSec, play: true };
  }
  if (Math.abs(drift) <= RATE_DEADBAND_SEC) return { kind: "none", rate: 1 };
  // Pull the drift in over about a second, never faster than 5 %.
  const nudge = Math.max(-MAX_RATE_NUDGE, Math.min(MAX_RATE_NUDGE, drift));
  return { kind: "rate", rate: 1 - nudge };
}

export interface VideoClockSource {
  /** Buffer time (seconds) of this stem being heard now, or null when not placed. */
  heardBufferSec(): number | null;
  isPlaying(): boolean;
}

/**
 * Lock `video` to `clock` until the returned function is called. The element
 * is muted here and its `playsInline` set, because its sound is the stem's.
 */
export function attachVideo(video: HTMLVideoElement, clock: VideoClockSource): () => void {
  video.muted = true;
  video.playsInline = true;
  let raf = 0;
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    const target = clock.heardBufferSec();
    if (target !== null && video.readyState >= 1) {
      const action = decideVideo({
        targetSec: target,
        currentSec: video.currentTime,
        durationSec: video.duration,
        transportPlaying: clock.isPlaying(),
        videoPaused: video.paused,
      });
      switch (action.kind) {
        case "pause":
          if (!video.paused) video.pause();
          if (action.to !== null) video.currentTime = action.to;
          video.playbackRate = 1;
          break;
        case "seek":
          video.currentTime = action.to;
          video.playbackRate = 1;
          if (action.play && video.paused) void video.play().catch(() => undefined);
          break;
        case "rate":
        case "none":
          if (Math.abs(video.playbackRate - action.rate) > 1e-3) video.playbackRate = action.rate;
          break;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => {
    stopped = true;
    cancelAnimationFrame(raf);
    video.pause();
    video.playbackRate = 1;
  };
}
