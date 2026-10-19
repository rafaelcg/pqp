/**
 * The arithmetic behind the crop step that follows picking an avatar or a
 * banner in Perfil.
 *
 * Kept apart from the dialog so all of it is testable without a DOM. A crop
 * fails by arithmetic: a pan that lets the frame slide off the picture, a zoom
 * that jumps when it should stay under the finger, a width and a height
 * transposed. None of those throws; each just uploads the wrong picture.
 *
 * ONE MODEL. A view is the picture (its size AFTER EXIF orientation, which is
 * what `createImageBitmap(…, { imageOrientation: "from-image" })` and an
 * `<img>` both draw), the frame's shape, a zoom and the point of the picture
 * at the centre of the frame. Zoom 1 is the largest rectangle of the frame's
 * shape that fits inside the picture, so at zoom 1 the frame is always full
 * and the result is exactly the old automatic centre crop. Zooming in shows a
 * smaller rectangle. The frame never shows anything outside the picture, so
 * there is never an empty edge to fill.
 */

/** Zoom 1 is "the whole picture that fits"; 4 is a quarter of it across. */
export const MIN_CROP_ZOOM = 1;
export const MAX_CROP_ZOOM = 4;

export interface CropView {
  /** The picture's width in its own pixels, after orientation. */
  imageWidth: number;
  imageHeight: number;
  /** The frame's shape, width ÷ height: 1 for an avatar, 3 for a banner. */
  aspect: number;
  zoom: number;
  /** The picture point at the centre of the frame, in picture pixels. */
  centerX: number;
  centerY: number;
}

/** A rectangle of the picture, in the picture's own pixels. */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The same rectangle as fractions of the picture (0 to 1).
 *
 * This is what crosses from the dialog to the canvas. The dialog measures the
 * picture through an `<img>` and the upload decodes it again through
 * `createImageBitmap`; both orient it the same way, but a fraction is right
 * whatever size the second decode reports, where a pixel rectangle would only
 * be right if the two agreed to the pixel.
 */
export type CropRegion = CropRect;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The rectangle the frame shows at zoom 1: the largest one of the frame's
 * shape that fits inside the picture. Unrounded, so a view can be panned by
 * less than a pixel without drifting.
 */
function coverSize(view: Pick<CropView, "imageWidth" | "imageHeight" | "aspect">): {
  width: number;
  height: number;
} {
  if (view.imageWidth / view.imageHeight > view.aspect) {
    // Wider than the frame: full height, the sides are cut.
    return { width: view.imageHeight * view.aspect, height: view.imageHeight };
  }
  return { width: view.imageWidth, height: view.imageWidth / view.aspect };
}

/** What the frame shows at this zoom, in picture pixels. */
export function visibleSize(view: CropView): { width: number; height: number } {
  const cover = coverSize(view);
  return { width: cover.width / view.zoom, height: cover.height / view.zoom };
}

/**
 * A view brought back inside its limits: zoom between 1 and 4, and the centre
 * far enough from every edge that the frame stays on the picture.
 */
export function clampView(view: CropView): CropView {
  const zoom = clamp(
    Number.isFinite(view.zoom) ? view.zoom : MIN_CROP_ZOOM,
    MIN_CROP_ZOOM,
    MAX_CROP_ZOOM,
  );
  const sized = { ...view, zoom };
  const { width, height } = visibleSize(sized);
  return {
    ...sized,
    centerX: clamp(view.centerX, width / 2, view.imageWidth - width / 2),
    centerY: clamp(view.centerY, height / 2, view.imageHeight - height / 2),
  };
}

/** Where every crop starts: zoom 1, centred. The old automatic crop. */
export function initialCropView(
  imageWidth: number,
  imageHeight: number,
  aspect: number,
): CropView {
  return {
    imageWidth,
    imageHeight,
    aspect,
    zoom: MIN_CROP_ZOOM,
    centerX: imageWidth / 2,
    centerY: imageHeight / 2,
  };
}

/**
 * Drag the picture by `dx`, `dy` CSS pixels inside a frame `frameWidth` CSS
 * pixels wide.
 *
 * The picture follows the pointer, so the point at the centre moves the other
 * way: drag right and you see more of the left of the picture. One CSS pixel
 * of drag is `visible width ÷ frame width` picture pixels, which is why a pan
 * feels the same speed at every zoom.
 */
export function panView(
  view: CropView,
  dx: number,
  dy: number,
  frameWidth: number,
): CropView {
  if (frameWidth <= 0) {
    return view;
  }
  const scale = visibleSize(view).width / frameWidth;
  return clampView({
    ...view,
    centerX: view.centerX - dx * scale,
    centerY: view.centerY - dy * scale,
  });
}

/**
 * Change the zoom, keeping one point of the frame over the same point of the
 * picture.
 *
 * `focusX` and `focusY` are fractions of the frame (0.5, 0.5 is its centre,
 * which is what the slider and the keyboard use). The wheel and a pinch pass
 * the pointer's position, so the picture grows from under the cursor or the
 * fingers instead of sliding away from them.
 */
export function zoomView(
  view: CropView,
  nextZoom: number,
  focusX = 0.5,
  focusY = 0.5,
): CropView {
  const before = visibleSize(view);
  const zoom = clamp(nextZoom, MIN_CROP_ZOOM, MAX_CROP_ZOOM);
  const after = visibleSize({ ...view, zoom });
  // The picture point under the focus, before the change.
  const pointX = view.centerX - before.width / 2 + focusX * before.width;
  const pointY = view.centerY - before.height / 2 + focusY * before.height;
  return clampView({
    ...view,
    zoom,
    centerX: pointX - focusX * after.width + after.width / 2,
    centerY: pointY - focusY * after.height + after.height / 2,
  });
}

/**
 * One wheel notch as a zoom multiplier. Exponential, so zooming in and back
 * out by the same distance lands where it started, and a trackpad's stream of
 * small deltas feels the same as a mouse's few large ones.
 */
export function wheelZoomFactor(deltaY: number): number {
  return Math.exp(-deltaY * 0.002);
}

/** The part of the picture the frame shows, in whole picture pixels. */
export function cropRect(view: CropView): CropRect {
  const clamped = clampView(view);
  const { width, height } = visibleSize(clamped);
  const w = clamp(Math.round(width), 1, clamped.imageWidth);
  const h = clamp(Math.round(height), 1, clamped.imageHeight);
  return {
    x: clamp(Math.round(clamped.centerX - width / 2), 0, clamped.imageWidth - w),
    y: clamp(Math.round(clamped.centerY - height / 2), 0, clamped.imageHeight - h),
    width: w,
    height: h,
  };
}

/** The same part as fractions of the picture. See `CropRegion`. */
export function cropRegion(view: CropView): CropRegion {
  const clamped = clampView(view);
  const { width, height } = visibleSize(clamped);
  return {
    x: (clamped.centerX - width / 2) / clamped.imageWidth,
    y: (clamped.centerY - height / 2) / clamped.imageHeight,
    width: width / clamped.imageWidth,
    height: height / clamped.imageHeight,
  };
}

/**
 * A region applied to a decoded picture of `width` × `height`, in whole
 * pixels and never past an edge. What the canvas draws from.
 */
export function regionToRect(
  region: CropRegion,
  width: number,
  height: number,
): CropRect {
  const w = clamp(Math.round(region.width * width), 1, width);
  const h = clamp(Math.round(region.height * height), 1, height);
  return {
    x: clamp(Math.round(region.x * width), 0, width - w),
    y: clamp(Math.round(region.y * height), 0, height - h),
    width: w,
    height: h,
  };
}

/**
 * Where to draw the whole picture inside a frame `frameWidth` CSS pixels wide
 * so the frame shows exactly this view: a size and an offset for an `<img>`
 * positioned in the frame's top-left corner.
 */
export function imageLayout(
  view: CropView,
  frameWidth: number,
): { width: number; height: number; left: number; top: number } {
  const clamped = clampView(view);
  const visible = visibleSize(clamped);
  const scale = frameWidth / visible.width;
  return {
    width: clamped.imageWidth * scale,
    height: clamped.imageHeight * scale,
    left: -(clamped.centerX - visible.width / 2) * scale,
    top: -(clamped.centerY - visible.height / 2) * scale,
  };
}
