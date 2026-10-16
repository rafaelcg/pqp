import { STORY_LAYER_SCALE_MIN, STORY_SAFE_AREA } from "@pqp/shared";
import { clamp, clampScale, normalizeRotation, type LayerGeometry } from "./layers";

/**
 * The maths of moving a layer, with no DOM in it. The canvas turns pointer
 * events into these calls and applies what comes back, so the same rules
 * serve a mouse, a finger, two fingers and the keyboard.
 */

export interface Point {
  x: number;
  y: number;
}
/** The canvas in CSS pixels. */
export interface Box {
  width: number;
  height: number;
}
export type Transform = Pick<LayerGeometry, "x" | "y" | "scale" | "rotation">;

const distance = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const angle = (a: Point, b: Point) => Math.atan2(b.y - a.y, b.x - a.x);

/** One pointer: the layer follows it, by the distance it moved in canvas units. */
export function dragTo(start: Transform, from: Point, to: Point, canvas: Box): Transform {
  return {
    ...start,
    x: start.x + (to.x - from.x) / canvas.width,
    y: start.y + (to.y - from.y) / canvas.height,
  };
}

/**
 * Two pointers: the layer scales by how the gap between them changed, turns by
 * how the line between them turned, and follows their midpoint.
 */
export function pinch(
  start: Transform,
  from: readonly [Point, Point],
  to: readonly [Point, Point],
  canvas: Box,
  fit?: Natural | null,
): Transform {
  const startGap = distance(from[0], from[1]);
  const factor = startGap > 0 ? distance(to[0], to[1]) / startGap : 1;
  const turn = angle(to[0], to[1]) - angle(from[0], from[1]);
  const fromMid = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const toMid = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  const rotation = normalizeRotation(start.rotation + turn);
  return {
    x: start.x + (toMid.x - fromMid.x) / canvas.width,
    y: start.y + (toMid.y - fromMid.y) / canvas.height,
    scale: clampScaleToFit(start.scale * factor, fit, rotation, canvas, start),
    rotation,
  };
}

/** How far (radians) the handle has to swing around the layer before it starts to turn it: 10 degrees. */
export const HANDLE_ROTATE_DEAD_ZONE = Math.PI / 18;

/**
 * The corner handle of a selected layer (a mouse's way of pinching), predictable on purpose:
 *
 * - Dragged in or out it SCALES, by how far the handle is from the layer's center now against
 *   when it was grabbed. A small sideways wobble does not turn the layer: it only starts to turn
 *   once the handle has swung past `HANDLE_ROTATE_DEAD_ZONE`, and then follows the swing from
 *   the edge of that zone (no jump), so scaling in a straight line stays straight.
 * - With Shift held it only TURNS (free, no dead zone, the scale stays put).
 */
export function handleDrag(
  start: Transform,
  center: Point,
  grabbed: Point,
  now: Point,
  options: { shift?: boolean; fit?: Natural | null; canvas?: Box } = {},
): Transform {
  const startRadius = distance(center, grabbed);
  const factor = startRadius > 0 ? distance(center, now) / startRadius : 1;
  // The swing around the center, wrapped to -pi..pi so crossing the back of the layer is not a lap.
  const swing = Math.atan2(Math.sin(angle(center, now) - angle(center, grabbed)), Math.cos(angle(center, now) - angle(center, grabbed)));
  if (options.shift) {
    return { ...start, rotation: normalizeRotation(start.rotation + swing) };
  }
  const beyond = swing - clamp(swing, -HANDLE_ROTATE_DEAD_ZONE, HANDLE_ROTATE_DEAD_ZONE);
  const rotation = normalizeRotation(start.rotation + beyond);
  return {
    ...start,
    scale: options.canvas
      ? clampScaleToFit(start.scale * factor, options.fit, rotation, options.canvas, start)
      : clampScale(start.scale * factor),
    rotation,
  };
}

// ------------------------------------------------------------------ keeping a layer on the canvas

/** A layer's natural size (scale 1) in CSS pixels, measured from where it is drawn. */
export interface Natural {
  width: number;
  height: number;
}

/** The size of the box that holds a `width` x `height` rectangle turned by `rotation`. */
export function turnedSize(width: number, height: number, rotation: number): Natural {
  const cos = Math.abs(Math.cos(rotation));
  const sin = Math.abs(Math.sin(rotation));
  return { width: width * cos + height * sin, height: width * sin + height * cos };
}

/**
 * The biggest scale at which the layer (turned by `rotation`) still fits inside the canvas. A
 * layer can never be scaled past the canvas it is on: the handle would leave the frame and the
 * words would run off it. Never below the shared minimum, and unknown natural size means no limit
 * beyond the shared maximum.
 */
export function maxScaleToFit(natural: Natural | null | undefined, rotation: number, canvas: Box): number {
  if (!natural || !(natural.width > 0) || !(natural.height > 0)) {
    return clampScale(Infinity);
  }
  const turned = turnedSize(natural.width, natural.height, rotation);
  return clampScale(Math.min(canvas.width / turned.width, canvas.height / turned.height));
}

/** What a viewer's chrome can cover, as shares of the canvas (`STORY_SAFE_AREA`); none by default. */
export interface Inset {
  x: number;
  top: number;
  bottom: number;
}
export const NO_INSET: Inset = { x: 0, top: 0, bottom: 0 };

/** The canvas less its inset: where a layer is meant to sit. */
export function usableBox(canvas: Box, inset: Inset = NO_INSET): Box {
  return { width: canvas.width * (1 - 2 * inset.x), height: canvas.height * (1 - inset.top - inset.bottom) };
}

/**
 * The center (0..1 of the canvas) moved the least it takes for a layer of `natural` size at `scale`,
 * turned by `rotation`, to lie inside the canvas less `inset`. A layer wider (or taller) than that
 * is centered in it on that axis. Used for words that were sized to fit: a center chosen for a
 * small layer would otherwise leave the big one hanging off the top.
 */
export function clampCenterInside(
  center: { x: number; y: number },
  natural: Natural,
  scale: number,
  rotation: number,
  canvas: Box,
  inset: Inset = NO_INSET,
): { x: number; y: number } {
  const turned = turnedSize(natural.width * scale, natural.height * scale, rotation);
  const along = (value: number, size: number, span: number, from: number, to: number) => {
    const half = size / 2 / span;
    return half >= (to - from) / 2 ? (from + to) / 2 : clamp(value, from + half, to - half);
  };
  return {
    x: along(center.x, turned.width, canvas.width, inset.x, 1 - inset.x),
    y: along(center.y, turned.height, canvas.height, inset.top, 1 - inset.bottom),
  };
}

export interface TextFit {
  /** The biggest scale the words may have (the slider's end). */
  maxScale: number;
  /** The scale to draw: the one asked for, held to `maxScale`. */
  scale: number;
  /** Where to draw it. */
  center: { x: number; y: number };
}

/**
 * What the text editor shows for words of `natural` size (at scale 1) asked to be at `scale`, around
 * `center`. NEW words are fitted to the canvas less `inset` (the viewer's chrome band) and moved just
 * far enough to lie inside it. Words already on the canvas are held to the canvas itself: when they
 * are bigger than it (a long text, or an old story) they shrink until they fit and then have their
 * center clamped into it, so one pass always ends with the words inside; when they fit they stay
 * where the author put them, even partly off an edge, and only a change of size moves them.
 */
export function fitTextEdit(input: {
  natural: Natural;
  canvas: Box;
  rotation: number;
  scale: number;
  center: { x: number; y: number };
  /** The scale the words had when the edit began (an existing layer's own). */
  startScale: number;
  inset: Inset;
  isNew: boolean;
  maxScaleCap: number;
}): TextFit {
  const limit = maxScaleToFit(input.natural, input.rotation, usableBox(input.canvas, input.inset));
  const maxScale = Math.min(input.maxScaleCap, limit);
  const scale = Math.min(input.scale, maxScale);
  const changed = Math.abs(scale - input.startScale) > 1e-6 || scale < input.scale - 1e-6;
  const center =
    input.isNew || changed
      ? clampCenterInside(input.center, input.natural, scale, input.rotation, input.canvas, input.inset)
      : input.center;
  return { maxScale, scale, center };
}

/**
 * `start`: where the layer was when the gesture began. A layer that did not fit the canvas then
 * (an old story, a long text) is never forced smaller by a gesture that does not make it bigger:
 * it only cannot grow past the larger of the fit and where it began. A layer that DID fit is
 * held to the fit at its new rotation, so turning it cannot push it past the canvas.
 */
export function clampScaleToFit(
  scale: number,
  natural: Natural | null | undefined,
  rotation: number,
  canvas: Box,
  start?: { scale: number; rotation: number },
): number {
  const fitNow = Math.max(STORY_LAYER_SCALE_MIN, maxScaleToFit(natural, rotation, canvas));
  const wasOversized = Boolean(start && start.scale > maxScaleToFit(natural, start.rotation, canvas) + 1e-6);
  const cap = wasOversized ? Math.max(fitNow, start!.scale) : fitNow;
  return clamp(clampScale(scale), STORY_LAYER_SCALE_MIN, clampScale(cap));
}

// ------------------------------------------------------------------ the safe area

/** The safe rectangle of the canvas in CSS pixels (`STORY_SAFE_AREA`). */
export function safeRect(canvas: Box): { left: number; top: number; right: number; bottom: number } {
  return {
    left: canvas.width * STORY_SAFE_AREA.x,
    right: canvas.width * (1 - STORY_SAFE_AREA.x),
    top: canvas.height * STORY_SAFE_AREA.top,
    bottom: canvas.height * (1 - STORY_SAFE_AREA.bottom),
  };
}

/**
 * Whether a layer (its center, natural size, scale and rotation) reaches into the band within
 * `near` pixels of the safe rectangle's edge, or out of it: the moment to show the guide.
 */
export function nearSafeEdge(
  transform: Transform,
  natural: Natural | null | undefined,
  canvas: Box,
  near = 14,
): { near: boolean; outside: boolean } {
  if (!natural) {
    return { near: false, outside: false };
  }
  const size = turnedSize(natural.width * transform.scale, natural.height * transform.scale, transform.rotation);
  const cx = transform.x * canvas.width;
  const cy = transform.y * canvas.height;
  const edges = { left: cx - size.width / 2, right: cx + size.width / 2, top: cy - size.height / 2, bottom: cy + size.height / 2 };
  const safe = safeRect(canvas);
  const outside = edges.left < safe.left || edges.right > safe.right || edges.top < safe.top || edges.bottom > safe.bottom;
  const close =
    edges.left < safe.left + near || edges.right > safe.right - near || edges.top < safe.top + near || edges.bottom > safe.bottom - near;
  return { near: close, outside };
}

/** A scroll-wheel notch scales; the sign is the usual one (scroll up grows). */
export function wheelScale(scale: number, deltaY: number, fit?: { natural: Natural | null; rotation: number; canvas: Box }): number {
  const next = scale * Math.exp(-deltaY * 0.0015);
  return fit ? clampScaleToFit(next, fit.natural, fit.rotation, fit.canvas, { scale, rotation: fit.rotation }) : clampScale(next);
}

// ------------------------------------------------------------------ snapping

/** How close (in canvas units) a layer's center has to come to a center line to be pulled onto it. */
export const SNAP_DISTANCE = 0.014;
/** How close (radians) a rotation has to come to a multiple of 45 degrees. */
export const SNAP_ANGLE = Math.PI / 50;

export interface Snapped extends Transform {
  /** The vertical center line is engaged (x snapped to 0.5). */
  guideX: boolean;
  /** The horizontal center line is engaged (y snapped to 0.5). */
  guideY: boolean;
  /** Rotation is sitting on a multiple of 45 degrees. */
  guideAngle: boolean;
}

export function snap(transform: Transform, options: { rotate?: boolean } = {}): Snapped {
  let { x, y, rotation } = transform;
  const guideX = Math.abs(x - 0.5) < SNAP_DISTANCE;
  const guideY = Math.abs(y - 0.5) < SNAP_DISTANCE;
  if (guideX) {
    x = 0.5;
  }
  if (guideY) {
    y = 0.5;
  }
  let guideAngle = false;
  if (options.rotate) {
    const step = Math.PI / 4;
    const nearest = Math.round(rotation / step) * step;
    if (Math.abs(rotation - nearest) < SNAP_ANGLE) {
      rotation = normalizeRotation(nearest);
      guideAngle = true;
    }
  }
  return { ...transform, x, y, rotation, guideX, guideY, guideAngle };
}

// ------------------------------------------------------------------ the trash

/** The trash target: bottom center of the canvas, sized by the canvas width. */
export function trashZone(canvas: Box): { center: Point; radius: number } {
  return { center: { x: canvas.width / 2, y: canvas.height - canvas.width * 0.16 }, radius: canvas.width * 0.14 };
}

export function overTrash(pointer: Point, canvas: Box): boolean {
  const zone = trashZone(canvas);
  return distance(pointer, zone.center) <= zone.radius;
}

// ------------------------------------------------------------------ keyboard

/** Arrow keys move by 1% of the canvas (5% with Shift); + and - scale by 10%; [ and ] turn by 5 degrees. */
export function keyboardTransform(
  start: Transform,
  key: string,
  shift: boolean,
  fit?: { natural: Natural | null; canvas: Box },
): Transform | null {
  const step = shift ? 0.05 : 0.01;
  const scaled = (value: number, rotation: number) =>
    fit ? clampScaleToFit(value, fit.natural, rotation, fit.canvas, start) : clampScale(value);
  switch (key) {
    case "ArrowLeft":
      return { ...start, x: clamp(start.x - step, 0, 1) };
    case "ArrowRight":
      return { ...start, x: clamp(start.x + step, 0, 1) };
    case "ArrowUp":
      return { ...start, y: clamp(start.y - step, 0, 1) };
    case "ArrowDown":
      return { ...start, y: clamp(start.y + step, 0, 1) };
    case "+":
    case "=":
      return { ...start, scale: scaled(start.scale * 1.1, start.rotation) };
    case "-":
    case "_":
      return { ...start, scale: scaled(start.scale / 1.1, start.rotation) };
    case "]": {
      const rotation = normalizeRotation(start.rotation + Math.PI / 36);
      return { ...start, rotation, scale: scaled(start.scale, rotation) };
    }
    case "[": {
      const rotation = normalizeRotation(start.rotation - Math.PI / 36);
      return { ...start, rotation, scale: scaled(start.scale, rotation) };
    }
    default:
      return null;
  }
}

/** A press that moved less than this (CSS px) and ended within `TAP_MS` is a tap, not a drag. */
export const TAP_SLOP = 5;
export const TAP_MS = 350;
