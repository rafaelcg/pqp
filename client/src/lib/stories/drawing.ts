import { STORY_IMAGE_MAX_EDGE } from "@pqp/shared";

/**
 * The draw tool. A drawing is kept as STROKES (vectors in canvas units), not as
 * pixels, for two reasons: undo is dropping the last stroke, and the drawing can
 * be painted at any size, the editor's own and the 810x1440 PNG that goes up.
 *
 * Coordinates are normalized: x and y are 0..1 of the canvas width and height.
 * A stroke's width is a fraction of the canvas WIDTH, so a thick marker stays
 * thick when the canvas is smaller on a phone.
 */

export type DrawTool = "pen" | "marker" | "highlighter" | "eraser";
export const DRAW_TOOLS: readonly DrawTool[] = ["pen", "marker", "highlighter", "eraser"];

export interface Stroke {
  tool: DrawTool;
  /** A palette token (`STORY_LAYER_COLORS`); ignored by the eraser. */
  color: string;
  /** Fraction of the canvas width. */
  width: number;
  /** x0, y0, x1, y1, ... normalized. */
  points: number[];
}

/** Base width of each tool as a fraction of the canvas width, at size 1. */
export const TOOL_BASE_WIDTH: Record<DrawTool, number> = {
  pen: 0.008,
  marker: 0.026,
  highlighter: 0.05,
  eraser: 0.04,
};
export const SIZE_MIN = 0.5;
export const SIZE_MAX = 2.5;
export const HIGHLIGHTER_ALPHA = 0.4;
/** Two samples closer than this (normalized) are one: keeps strokes small. */
export const MIN_POINT_DISTANCE = 0.002;

export function strokeWidthFor(tool: DrawTool, size: number): number {
  return TOOL_BASE_WIDTH[tool] * Math.min(SIZE_MAX, Math.max(SIZE_MIN, size));
}

/** Add a sample unless it is on top of the last one. Returns the same array when it did nothing. */
export function appendPoint(points: number[], x: number, y: number): number[] {
  const n = points.length;
  if (n >= 2) {
    const dx = x - points[n - 2]!;
    const dy = y - points[n - 1]!;
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) {
      return points;
    }
  }
  return [...points, x, y];
}

/**
 * The same rule on a buffer the caller owns: a stroke in progress takes hundreds of
 * samples, and copying the array for each one is quadratic. Returns whether it added.
 */
export function appendPointInPlace(points: number[], x: number, y: number): boolean {
  const n = points.length;
  if (n >= 2) {
    const dx = x - points[n - 2]!;
    const dy = y - points[n - 1]!;
    if (dx * dx + dy * dy < MIN_POINT_DISTANCE * MIN_POINT_DISTANCE) {
      return false;
    }
  }
  points.push(x, y);
  return true;
}

/** Painting needs only this much of a 2D context, so it can be tested with a recorder. */
export interface PaintContext {
  canvas: { width: number; height: number };
  clearRect(x: number, y: number, w: number, h: number): void;
  save(): void;
  restore(): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  stroke(): void;
  fill(): void;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  lineWidth: number;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  fillStyle: string | CanvasGradient | CanvasPattern;
  globalAlpha: number;
  globalCompositeOperation: GlobalCompositeOperation;
}

export function paintStrokes(
  context: PaintContext,
  strokes: readonly Stroke[],
  resolveColor: (token: string) => string,
): void {
  const width = context.canvas.width;
  const height = context.canvas.height;
  context.clearRect(0, 0, width, height);
  for (const stroke of strokes) {
    const { points } = stroke;
    if (points.length < 2) {
      continue;
    }
    context.save();
    context.lineCap = "round";
    context.lineJoin = "round";
    context.lineWidth = Math.max(1, stroke.width * width);
    const color = stroke.tool === "eraser" ? "black" : resolveColor(stroke.color);
    context.strokeStyle = color;
    context.fillStyle = color;
    if (stroke.tool === "eraser") {
      context.globalCompositeOperation = "destination-out";
    } else if (stroke.tool === "highlighter") {
      context.globalAlpha = HIGHLIGHTER_ALPHA;
    }
    if (points.length === 2) {
      context.beginPath();
      context.arc(points[0]! * width, points[1]! * height, context.lineWidth / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.beginPath();
      context.moveTo(points[0]! * width, points[1]! * height);
      // Quadratic smoothing through the midpoints: a hand-drawn line, not a polyline.
      for (let i = 2; i < points.length - 2; i += 2) {
        const mx = (points[i]! + points[i + 2]!) / 2;
        const my = (points[i + 1]! + points[i + 3]!) / 2;
        context.quadraticCurveTo(points[i]! * width, points[i + 1]! * height, mx * width, my * height);
      }
      const last = points.length - 2;
      context.lineTo(points[last]! * width, points[last + 1]! * height);
      context.stroke();
    }
    context.restore();
  }
}

/** The drawing is empty when nothing is left on it (everything was erased counts as a drawing). */
export function hasInk(strokes: readonly Stroke[]): boolean {
  return strokes.some((stroke) => stroke.tool !== "eraser" && stroke.points.length >= 2);
}

/** The canvas size a drawing is exported at: 9:16 with the long side at the story image limit. */
export function exportSize(): { width: number; height: number } {
  const height = STORY_IMAGE_MAX_EDGE;
  return { width: Math.round((height * 9) / 16), height };
}

export async function renderDrawingBlob(
  strokes: readonly Stroke[],
  resolveColor: (token: string) => string,
): Promise<{ blob: Blob; width: number; height: number } | null> {
  if (!hasInk(strokes)) {
    return null;
  }
  const { width, height } = exportSize();
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  paintStrokes(context, strokes, resolveColor);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  return blob ? { blob, width, height } : null;
}

/** A palette token's real color, read from the story tokens on the page. */
export function colorFromTokens(token: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--story-c-${token}`).trim();
  return value || "white";
}
