import type { CSSProperties } from "react";
import {
  STORY_LAYOUT,
  STORY_LAYER_IMAGE_SHAPES,
  STORY_LAYER_SCALE_MAX,
  STORY_LAYER_SCALE_MIN,
  STORY_LAYER_TEXT_SIZE_MAX,
  STORY_LAYER_TEXT_SIZE_MIN,
  STORY_LAYERS_MAX,
  STORY_LAYER_CALLS_MAX,
  STORY_LAYER_DRAWINGS_MAX,
  STORY_LAYER_IMAGES_MAX,
  STORY_LAYER_MENTIONS_MAX,
  type StoryLayer,
  type StoryLayerInput,
  type StoryLayerType,
} from "@pqp/shared";
import type { Stroke } from "./drawing";

/**
 * Story layers on the web, in one place: what the editor holds, how a layer is
 * placed on the 9:16 canvas, and how it goes to the wire.
 *
 * THE RULES EVERY CLIENT SHARES (so a story looks the same on web, iOS and
 * Android, at any canvas size):
 *
 * - `x`, `y` are the layer's CENTER, 0..1 of the canvas width and height.
 * - A layer is laid out at its natural size, then scaled by `scale` and
 *   rotated by `rotation` (radians, clockwise) around its own center.
 * - Natural sizes are fractions of the canvas WIDTH, so they follow it:
 *   text is `8% x size` of the width as a font size, laid out in at most
 *   84% of the width; a photo is 40% of the width (height by aspect; a circle
 *   is cropped to a square); a mention chip is 5% type; a call card is 82%.
 *   The values are `STORY_LAYOUT` in `@pqp/shared`; do not copy them here.
 * - Layer order is creation order for every type: a new drawing goes on TOP, and a second
 *   drawing session moves the single drawing back to the top (one undo step).
 * - Layers outside the canvas are clipped by it.
 */

// The numbers are STORY_LAYOUT's (packages/shared): one table for web, iOS and Android.
// In `cqw`, 1% of the canvas width.
export const TEXT_BASE_CQW = STORY_LAYOUT.textSize * 100;
export const TEXT_MAX_WIDTH_CQW = STORY_LAYOUT.textMaxWidth * 100;
export const IMAGE_BASE_CQW = STORY_LAYOUT.imageWidth * 100;
export const IMAGE_ROUNDED_CQW = STORY_LAYOUT.imageRoundedRadius * 100;
export const CALL_CARD_CQW = STORY_LAYOUT.callCardWidth * 100;
export const MENTION_BASE_CQW = STORY_LAYOUT.mentionFont * 100;

export interface LayerGeometry {
  id: string;
  /** Center, 0..1 of the canvas width. */
  x: number;
  /** Center, 0..1 of the canvas height. */
  y: number;
  scale: number;
  /** Radians, clockwise. */
  rotation: number;
}

export type TextLayerStyle = Pick<
  Extract<StoryLayerInput, { type: "text" }>,
  "font" | "color" | "background" | "align" | "size"
>;

export interface TextLayerFields {
  text: string;
  font: NonNullable<TextLayerStyle["font"]>;
  color: NonNullable<TextLayerStyle["color"]>;
  background: NonNullable<TextLayerStyle["background"]>;
  align: NonNullable<TextLayerStyle["align"]>;
  size: number;
}

export type ImageShape = (typeof STORY_LAYER_IMAGE_SHAPES)[number];

/** What the editor holds. Image and drawing layers keep their pixels locally until posting. */
export type EditorLayer =
  | (LayerGeometry & { type: "text" } & TextLayerFields)
  | (LayerGeometry & {
      type: "image";
      shape: ImageShape;
      blob: Blob;
      contentType: "image/jpeg" | "image/webp" | "image/png";
      previewUrl: string;
      width: number;
      height: number;
    })
  | (LayerGeometry & { type: "drawing"; strokes: Stroke[] })
  | (LayerGeometry & { type: "call"; serverId: string; channelId: string; channelName: string })
  | (LayerGeometry & { type: "mention"; userId: string; name: string });

export const DEFAULT_TEXT: Omit<TextLayerFields, "text"> = {
  font: "classic",
  color: "white",
  background: "none",
  align: "center",
  size: 1,
};

export function newLayerId(): string {
  return crypto.randomUUID();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clampScale(scale: number): number {
  return clamp(scale, STORY_LAYER_SCALE_MIN, STORY_LAYER_SCALE_MAX);
}

/** The wire bound is a hair above pi so a 32-bit pi passes; stay inside it. */
export function normalizeRotation(radians: number): number {
  const turn = Math.PI * 2;
  let value = radians % turn;
  if (value > Math.PI) {
    value -= turn;
  } else if (value < -Math.PI) {
    value += turn;
  }
  return value;
}

export function clampGeometry<T extends LayerGeometry>(layer: T): T {
  return {
    ...layer,
    x: clamp(layer.x, 0, 1),
    y: clamp(layer.y, 0, 1),
    scale: clampScale(layer.scale),
    rotation: normalizeRotation(layer.rotation),
  };
}

/**
 * Where and how a layer sits on the canvas. Shared by the editor and the viewer.
 *
 * `width: max-content` is load-bearing. The box is absolute at `left: x%`, and an absolute box
 * with an auto width shrinks to fit the room left BEFORE the container's right edge. Anything
 * inside that resolves a width against its parent (a photo's `max-width: 100%` from the reset, a
 * chip's `max-width`) then follows that leftover room: a photo at x = 0.8 drew at half size, and
 * one at x = 0.95 at a tenth. A layer's width is its own content's (a photo is 40cqw, a call
 * card 82cqw, text wraps at 84cqw), never a function of where it was put, so the box takes it
 * from the content and the position cannot squeeze it.
 */
export function layerStyle(geometry: LayerGeometry): CSSProperties {
  return {
    position: "absolute",
    width: "max-content",
    left: `${geometry.x * 100}%`,
    top: `${geometry.y * 100}%`,
    transform: `translate(-50%, -50%) rotate(${geometry.rotation}rad) scale(${geometry.scale})`,
    transformOrigin: "50% 50%",
  };
}

// ------------------------------------------------------------------ limits

export function layerCounts(layers: readonly { type: StoryLayerType }[]): Record<StoryLayerType, number> {
  const counts: Record<StoryLayerType, number> = { text: 0, image: 0, drawing: 0, call: 0, mention: 0 };
  for (const layer of layers) {
    counts[layer.type] += 1;
  }
  return counts;
}

export function canAddLayer(layers: readonly { type: StoryLayerType }[], type: StoryLayerType): boolean {
  if (layers.length >= STORY_LAYERS_MAX) {
    return false;
  }
  const counts = layerCounts(layers);
  switch (type) {
    case "image":
      return counts.image < STORY_LAYER_IMAGES_MAX;
    case "drawing":
      return counts.drawing < STORY_LAYER_DRAWINGS_MAX;
    case "call":
      return counts.call < STORY_LAYER_CALLS_MAX;
    case "mention":
      return counts.mention < STORY_LAYER_MENTIONS_MAX;
    default:
      return true;
  }
}

export function clampTextSize(size: number): number {
  return clamp(size, STORY_LAYER_TEXT_SIZE_MIN, STORY_LAYER_TEXT_SIZE_MAX);
}

// ------------------------------------------------------------------ history

/**
 * The editor's state: the layers back to front, the selection, and a bounded
 * undo stack. A drag or a pinch is ONE history entry however many pointer
 * events it took: the gesture edits a live copy and `commit` pushes it.
 */
export interface EditorState {
  layers: EditorLayer[];
  selectedId: string | null;
  past: EditorLayer[][];
  /** What undo stepped back over, newest first to redo. Any new edit clears it. */
  future: EditorLayer[][];
}

export const HISTORY_LIMIT = 40;

export const initialEditorState: EditorState = { layers: [], selectedId: null, past: [], future: [] };

export type EditorAction =
  | { type: "add"; layer: EditorLayer }
  /** Replace a layer's fields. `transient` skips the history entry (a gesture in flight). */
  | { type: "patch"; id: string; patch: Partial<EditorLayer>; transient?: boolean; toTop?: boolean }
  /** Push the pre-gesture layers as one undo step. Dispatched once at the start of a gesture. */
  | { type: "checkpoint" }
  | { type: "remove"; id: string }
  | { type: "forward"; id: string }
  | { type: "backward"; id: string }
  | { type: "select"; id: string | null }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "reset" };

/**
 * What the undo stack may hold in photo bytes. A snapshot keeps every photo it
 * had, so a session of adding and removing 8 MiB photos would otherwise keep
 * all of them in memory behind a Ctrl+Z nobody will press that far.
 */
export const HISTORY_BLOB_BUDGET = 48 * 1024 * 1024;

/** Photo bytes retained by a stack of snapshots, each photo counted once. */
export function retainedBlobBytes(past: readonly (readonly EditorLayer[])[]): number {
  const seen = new Set<Blob>();
  let total = 0;
  for (const snapshot of past) {
    for (const layer of snapshot) {
      if (layer.type === "image" && !seen.has(layer.blob)) {
        seen.add(layer.blob);
        total += layer.blob.size;
      }
    }
  }
  return total;
}

function push(past: EditorLayer[][], layers: EditorLayer[]): EditorLayer[][] {
  let next = [...past, layers];
  if (next.length > HISTORY_LIMIT) {
    next = next.slice(next.length - HISTORY_LIMIT);
  }
  // Oldest steps go first when the photos they hold are too much; the newest step always stays.
  while (next.length > 1 && retainedBlobBytes(next) > HISTORY_BLOB_BUDGET) {
    next = next.slice(1);
  }
  return next;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "add": {
      if (!canAddLayer(state.layers, action.layer.type)) {
        return state;
      }
      const added = clampGeometry(action.layer);
      return {
        // Creation order, the drawing included: it goes on top (a drawing is not selected: it has
        // no frame to move).
        layers: [...state.layers, added],
        selectedId: action.layer.type === "drawing" ? state.selectedId : action.layer.id,
        past: push(state.past, state.layers),
        future: [],
      };
    }
    case "checkpoint":
      return { ...state, past: push(state.past, state.layers), future: [] };
    case "patch": {
      const index = state.layers.findIndex((layer) => layer.id === action.id);
      if (index < 0) {
        return state;
      }
      const layers = state.layers.slice();
      layers[index] = clampGeometry({ ...layers[index]!, ...action.patch } as EditorLayer);
      if (action.toTop && index !== layers.length - 1) {
        // One history step for the change and the move: a drawing drawn on again surfaces.
        layers.push(...layers.splice(index, 1));
      }
      return {
        ...state,
        layers,
        past: action.transient ? state.past : push(state.past, state.layers),
        future: action.transient ? state.future : [],
      };
    }
    case "remove": {
      if (!state.layers.some((layer) => layer.id === action.id)) {
        return state;
      }
      return {
        layers: state.layers.filter((layer) => layer.id !== action.id),
        selectedId: state.selectedId === action.id ? null : state.selectedId,
        past: push(state.past, state.layers),
        future: [],
      };
    }
    case "forward":
    case "backward": {
      const index = state.layers.findIndex((layer) => layer.id === action.id);
      const target = action.type === "forward" ? state.layers.length - 1 : 0;
      if (index < 0 || index === target) {
        return state;
      }
      const layers = state.layers.slice();
      const [moved] = layers.splice(index, 1);
      layers.splice(target, 0, moved!);
      return { ...state, layers, past: push(state.past, state.layers), future: [] };
    }
    case "select":
      return state.selectedId === action.id ? state : { ...state, selectedId: action.id };
    case "undo": {
      const previous = state.past[state.past.length - 1];
      if (!previous) {
        return state;
      }
      const selectedId = previous.some((layer) => layer.id === state.selectedId) ? state.selectedId : null;
      return { layers: previous, selectedId, past: state.past.slice(0, -1), future: push(state.future, state.layers) };
    }
    case "redo": {
      const following = state.future[state.future.length - 1];
      if (!following) {
        return state;
      }
      const selectedId = following.some((layer) => layer.id === state.selectedId) ? state.selectedId : null;
      return { layers: following, selectedId, past: push(state.past, state.layers), future: state.future.slice(0, -1) };
    }
    case "reset":
      return initialEditorState;
  }
}

// ------------------------------------------------------------------ the wire

/** What `POST /api/stories` takes for one layer. Image and drawing layers declare their upload. */
export function toLayerInput(layer: EditorLayer, drawing?: { blob: Blob; width: number; height: number }): StoryLayerInput | null {
  const geometry = { id: layer.id, x: layer.x, y: layer.y, scale: layer.scale, rotation: layer.rotation };
  switch (layer.type) {
    case "text":
      return {
        ...geometry,
        type: "text",
        text: layer.text.trim(),
        font: layer.font,
        color: layer.color,
        background: layer.background,
        align: layer.align,
        size: layer.size,
      };
    case "image":
      return {
        ...geometry,
        type: "image",
        shape: layer.shape,
        upload: {
          contentType: layer.contentType,
          byteSize: layer.blob.size,
          width: layer.width,
          height: layer.height,
        },
      };
    case "drawing":
      return drawing
        ? {
            ...geometry,
            type: "drawing",
            upload: { contentType: "image/png", byteSize: drawing.blob.size, width: drawing.width, height: drawing.height },
          }
        : null;
    case "call":
      return { ...geometry, type: "call", serverId: layer.serverId, channelId: layer.channelId };
    case "mention":
      return { ...geometry, type: "mention", userId: layer.userId };
  }
}

/** The words a screen reader gets for a story: the text layers in reading order, then the caption. */
export function altTextFor(layers: readonly EditorLayer[], caption: string, mentionLabel: (name: string) => string): string {
  const parts: string[] = [];
  const reading = (a: EditorLayer, b: EditorLayer) => a.y - b.y || a.x - b.x;
  // What is written, top to bottom, then who is in it.
  for (const layer of layers.filter((entry) => entry.type === "text").sort(reading)) {
    if (layer.type === "text" && layer.text.trim()) {
      parts.push(layer.text.trim().replace(/\s+/g, " "));
    }
  }
  for (const layer of layers.filter((entry) => entry.type === "mention").sort(reading)) {
    if (layer.type === "mention") {
      parts.push(mentionLabel(layer.name));
    }
  }
  if (caption.trim()) {
    parts.push(caption.trim());
  }
  return parts.join(". ").slice(0, 500);
}

/** A read layer from the server, as the viewer and the preview draw it. */
export type ReadLayer = StoryLayer;

