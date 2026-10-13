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
): Transform {
  const startGap = distance(from[0], from[1]);
  const factor = startGap > 0 ? distance(to[0], to[1]) / startGap : 1;
  const turn = angle(to[0], to[1]) - angle(from[0], from[1]);
  const fromMid = { x: (from[0].x + from[1].x) / 2, y: (from[0].y + from[1].y) / 2 };
  const toMid = { x: (to[0].x + to[1].x) / 2, y: (to[0].y + to[1].y) / 2 };
  return {
    x: start.x + (toMid.x - fromMid.x) / canvas.width,
    y: start.y + (toMid.y - fromMid.y) / canvas.height,
    scale: clampScale(start.scale * factor),
    rotation: normalizeRotation(start.rotation + turn),
  };
}

/**
 * The corner handle of a selected layer (a mouse's way of pinching): scale by
 * how far the handle is from the layer's center now against when it was
 * grabbed, and turn by how far it swung around it.
 */
export function handleDrag(
  start: Transform,
  center: Point,
  grabbed: Point,
  now: Point,
): Transform {
  const startRadius = distance(center, grabbed);
  const factor = startRadius > 0 ? distance(center, now) / startRadius : 1;
  const turn = angle(center, now) - angle(center, grabbed);
  return {
    ...start,
    scale: clampScale(start.scale * factor),
    rotation: normalizeRotation(start.rotation + turn),
  };
}

/** A scroll-wheel notch scales; the sign is the usual one (scroll up grows). */
export function wheelScale(scale: number, deltaY: number): number {
  return clampScale(scale * Math.exp(-deltaY * 0.0015));
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
export function keyboardTransform(start: Transform, key: string, shift: boolean): Transform | null {
  const step = shift ? 0.05 : 0.01;
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
      return { ...start, scale: clampScale(start.scale * 1.1) };
    case "-":
    case "_":
      return { ...start, scale: clampScale(start.scale / 1.1) };
    case "]":
      return { ...start, rotation: normalizeRotation(start.rotation + (Math.PI / 36)) };
    case "[":
      return { ...start, rotation: normalizeRotation(start.rotation - Math.PI / 36) };
    default:
      return null;
  }
}

/** A press that moved less than this (CSS px) and ended within `TAP_MS` is a tap, not a drag. */
export const TAP_SLOP = 5;
export const TAP_MS = 350;
