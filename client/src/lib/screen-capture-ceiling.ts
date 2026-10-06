/**
 * The constraints that actually bring a screen capture down to a height.
 *
 * `constrainScreenCapture` (`livekit-session.ts`) lays `height: { max }` over
 * the capture's own constraints, which still carry the `width: { max: 1920 }`
 * the share was opened with (`screenCaptureOptions`). Measured in Chrome
 * (`client/e2e/share-fast-start/constraint-probe.mjs`, the fake display
 * device, the product's own getDisplayMedia options): with that width ceiling
 * left in, `height: { max: 720 }` is accepted without an error and does
 * nothing. Settings and frames stay 1920x1080. The same request without the
 * width, or with the width scaled to the same ratio (1280 for 720), gives
 * 1280x720 frames. So every large-room cap and every republish under a lower
 * height has been publishing the full capture under a ceiling meant for 720p.
 *
 * The fix keeps a width ceiling (an ultrawide must not come back wider than
 * it was allowed) but scales it to the height: the capture's aspect ratio,
 * read from its settings (a ratio survives every rescale), times the height,
 * never above the width ceiling it already had. A capture that reports no
 * size gets no width ceiling at all, which is the one shape measured to work.
 */
export function screenCaptureCeiling(
  base: MediaTrackConstraints,
  heightMax: number,
  settings: { width?: number; height?: number } | null,
): MediaTrackConstraints {
  const widthCeiling = numericMax(base.width);
  const { width: _width, height: _height, ...rest } = base;
  // Ceilings only, on both sides: an `ideal` or `min` left over from the
  // request that opened the share pulls against the new height exactly the
  // way the old width ceiling did, and ceilings are the shape measured to work.
  const next: MediaTrackConstraints = {
    ...rest,
    height: { max: heightMax },
  };
  const w = settings?.width;
  const h = settings?.height;
  if (w && h && w > 0 && h > 0) {
    const scaled = Math.ceil((heightMax * w) / h);
    next.width = {
      max: widthCeiling === null ? scaled : Math.min(scaled, widthCeiling),
    };
  }
  return next;
}

function numericMax(value: MediaTrackConstraints["width"]): number | null {
  if (typeof value === "number") {
    return value;
  }
  if (value && typeof value === "object" && typeof value.max === "number") {
    return value.max;
  }
  return null;
}
