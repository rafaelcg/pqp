/**
 * When the presenter should capture and publish 60 fps for a watch party.
 *
 * A 24 fps YouTube film on a 60 Hz display looks smooth on the host because
 * the compositor presents it at refresh. Capture at 30 picks those frames
 * unevenly (3:2 judder) and the audience sees a slideshow the host never
 * saw. Capture at 60 keeps the same cadence. A 60 fps HLS rung is wasted if
 * the published track is 30: egress `videorate` just duplicates frames. The
 * opposite is also true: capturing 60 into a 30 fps ladder costs uplink for
 * motion nobody encodes. Auto follows the ladder when HLS is on, and 60
 * otherwise so a regular share still matches the host's screen.
 */

export interface HlsLadderRungFps {
  framerate?: number;
}

export const SCREEN_FRAME_RATES = ["auto", "30", "60"] as const;

export type ScreenFrameRate = (typeof SCREEN_FRAME_RATES)[number];

export const DEFAULT_SCREEN_FRAME_RATE: ScreenFrameRate = "auto";

/** Storage and query strings hand back `unknown`; this is the only door in. */
export function parseScreenFrameRate(raw: unknown): ScreenFrameRate {
  return SCREEN_FRAME_RATES.includes(raw as ScreenFrameRate)
    ? (raw as ScreenFrameRate)
    : DEFAULT_SCREEN_FRAME_RATE;
}

/** 60 when HLS is on for this server and any named rung is 50 fps or above. */
export function hlsCaptureMaxFrameRate(
  ladder: readonly HlsLadderRungFps[] | null | undefined,
  enabled?: boolean,
): 30 | 60 {
  if (enabled !== true) {
    return 30;
  }
  if (!ladder || ladder.length === 0) {
    return 30;
  }
  return ladder.some((rung) => (rung.framerate ?? 30) >= 50) ? 60 : 30;
}

/**
 * What getDisplayMedia should ask for.
 *
 * Auto follows `hlsLadderMax` (30 on the default 720p30 ladder, 60 when
 * any rung is 60 fps). An explicit 30 or 60 is the presenter saying so,
 * even if that disagrees with the ladder.
 */
export function screenCaptureMaxFrameRate(input: {
  preference: ScreenFrameRate;
  hlsLadderMax: 30 | 60;
}): 30 | 60 {
  if (input.preference === "60") {
    return 60;
  }
  if (input.preference === "30") {
    return 30;
  }
  return input.hlsLadderMax;
}

/**
 * What the SFU encode ceiling should be, given a capture that already ran.
 * `getSettings().frameRate` is what the browser actually delivered, which
 * can be under the ask; we only raise the publish to 60 when it really is.
 */
export function publishMaxFrameRateFromTrack(track: {
  getSettings?: () => { frameRate?: number };
}): 30 | 60 {
  const fps =
    typeof track.getSettings === "function"
      ? track.getSettings().frameRate
      : undefined;
  return typeof fps === "number" && Number.isFinite(fps) && fps >= 50
    ? 60
    : 30;
}
