/**
 * Frame rate per simulcast layer while `share_high_motion_guard` holds a
 * screen share below what the presenter asked for.
 *
 * WHY. A pqp screen share on the media server is three encodes, not one: the
 * top layer plus 720p and 360p copies, and every one of them runs at the
 * capture's frame rate (`publishScreenVideo`). LiveKit negotiates H.264 as
 * Constrained Baseline (`profile-level-id=42e01f`), which Chromium does not
 * hardware-encode on Windows (`kPlatformH264CbpEncoding` is off by default
 * there) or on macOS, so the three are three OpenH264 encoders on the CPU.
 * Dynacast does not help in the case that matters: it only switches off
 * layers ABOVE the best quality anybody watches, and a viewer watching the
 * full picture keeps both smaller copies running.
 *
 * Measured 2026-10-01 on the real livekit-client publish against a local
 * LiveKit, a window capture of a GPU-bound stand-in game (tools/share-diagnostic):
 * encoder time summed over the layers went from 1455 to 1066 ms per second
 * (27 % less) with the two smaller layers at 30, and the top layer, which is
 * what a viewer of the full picture receives, kept its 58 fps and 1078 lines.
 *
 * So whenever the guard has stepped a share down, the smaller copies drop to
 * 30 first and for free; the top layer keeps the level's own rate. With no
 * ceiling nothing changes: a share that is not starved is left exactly as
 * published. A watch party's ingest never gets here (the session refuses a
 * ceiling while the plan feeds HLS, and that share is a single layer anyway).
 */

export const GUARDED_LOWER_LAYER_FPS = 30;

type EncodingLike = Pick<RTCRtpEncodingParameters, "scaleResolutionDownBy">;

/**
 * The frame-rate ceiling for each encoding, in the order given.
 *
 * The top layer is the one scaled down least (no `scaleResolutionDownBy`
 * counts as 1); on a tie the last one wins, which is where livekit-client puts
 * its full-size layer.
 */
export function guardedLayerFramerates(
  encodings: readonly EncodingLike[],
  topFps: number,
  guarded: boolean,
): number[] {
  let top = -1;
  let topScale = Number.POSITIVE_INFINITY;
  encodings.forEach((encoding, index) => {
    const scale =
      typeof encoding.scaleResolutionDownBy === "number" &&
      encoding.scaleResolutionDownBy > 0
        ? encoding.scaleResolutionDownBy
        : 1;
    if (scale <= topScale) {
      topScale = scale;
      top = index;
    }
  });
  return encodings.map((_, index) =>
    guarded && index !== top
      ? Math.min(topFps, GUARDED_LOWER_LAYER_FPS)
      : topFps,
  );
}
