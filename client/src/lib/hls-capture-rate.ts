/**
 * When the presenter should capture and publish 60 fps for a watch party.
 *
 * A 60 fps HLS rung is wasted if the published track is 30: egress
 * `videorate` just duplicates frames. The opposite is also true: capturing
 * 60 into a 30 fps ladder costs uplink and SFU for motion nobody encodes.
 * So the capture ceiling follows the configured ladder, and only that.
 */

export interface HlsLadderRungFps {
  framerate?: number;
}

/** 60 when any named rung is 50 fps or above; 30 otherwise. */
export function hlsCaptureMaxFrameRate(
  ladder: readonly HlsLadderRungFps[] | null | undefined,
): 30 | 60 {
  if (!ladder || ladder.length === 0) {
    return 30;
  }
  return ladder.some((rung) => (rung.framerate ?? 30) >= 50) ? 60 : 30;
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
