import { describe, expect, it } from "vitest";
import { createStorySchema } from "@pqp/shared";
import {
  DEFAULT_TEXT,
  HISTORY_BLOB_BUDGET,
  HISTORY_LIMIT,
  altTextFor,
  canAddLayer,
  clampGeometry,
  editorReducer,
  initialEditorState,
  layerStyle,
  normalizeRotation,
  retainedBlobBytes,
  toLayerInput,
  type EditorLayer,
  type EditorState,
} from "./layers";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function text(n: number, over: Partial<Extract<EditorLayer, { type: "text" }>> = {}): EditorLayer {
  return { id: uuid(n), type: "text", x: 0.5, y: 0.5, scale: 1, rotation: 0, text: `t${n}`, ...DEFAULT_TEXT, ...over };
}
function mention(n: number, userId = uuid(900 + n)): EditorLayer {
  return { id: uuid(n), type: "mention", x: 0.5, y: 0.5, scale: 1, rotation: 0, userId, name: `Ana${n}` };
}
function image(n: number): EditorLayer {
  return {
    id: uuid(n),
    type: "image",
    x: 0.5,
    y: 0.5,
    scale: 1,
    rotation: 0,
    shape: "rect",
    blob: new Blob([new Uint8Array(10)], { type: "image/jpeg" }),
    contentType: "image/jpeg",
    previewUrl: "blob:x",
    width: 100,
    height: 200,
  };
}

function run(...actions: Parameters<typeof editorReducer>[1][]): EditorState {
  return actions.reduce(editorReducer, initialEditorState);
}

describe("editorReducer", () => {
  it("adds back to front and selects the new layer", () => {
    const state = run({ type: "add", layer: text(1) }, { type: "add", layer: text(2) });
    expect(state.layers.map((layer) => layer.id)).toEqual([uuid(1), uuid(2)]);
    expect(state.selectedId).toBe(uuid(2));
  });

  it("puts a drawing at the bottom of the stack (index 0, under everything placed) and keeps the selection", () => {
    const drawing: EditorLayer = { id: uuid(9), type: "drawing", x: 0.5, y: 0.5, scale: 1, rotation: 0, strokes: [] };
    const state = run({ type: "add", layer: text(1) }, { type: "add", layer: text(2) }, { type: "add", layer: drawing });
    expect(state.layers.map((layer) => layer.id)).toEqual([uuid(9), uuid(1), uuid(2)]);
    expect(state.selectedId).toBe(uuid(2));
  });

  it("undo steps back one action at a time", () => {
    const state = run({ type: "add", layer: text(1) }, { type: "add", layer: text(2) }, { type: "undo" });
    expect(state.layers.map((layer) => layer.id)).toEqual([uuid(1)]);
    expect(run({ type: "undo" }).layers).toEqual([]);
  });

  it("redo brings back what undo stepped over, and any new edit clears it", () => {
    const undone = run({ type: "add", layer: text(1) }, { type: "add", layer: text(2) }, { type: "undo" });
    expect(undone.future).toHaveLength(1);
    const redone = editorReducer(undone, { type: "redo" });
    expect(redone.layers.map((layer) => layer.id)).toEqual([uuid(1), uuid(2)]);
    expect(redone.future).toEqual([]);
    // Undo twice, redo once: one step still waiting.
    const twice = editorReducer(editorReducer(redone, { type: "undo" }), { type: "undo" });
    const once = editorReducer(twice, { type: "redo" });
    expect(once.layers.map((layer) => layer.id)).toEqual([uuid(1)]);
    expect(once.future).toHaveLength(1);
    // A new edit ends the redo line, whatever kind it is.
    expect(editorReducer(once, { type: "add", layer: text(3) }).future).toEqual([]);
    expect(editorReducer(once, { type: "patch", id: uuid(1), patch: { rotation: 1 } }).future).toEqual([]);
    expect(editorReducer(once, { type: "remove", id: uuid(1) }).future).toEqual([]);
    expect(editorReducer(once, { type: "checkpoint" }).future).toEqual([]);
    // A gesture in flight (transient) does not.
    expect(editorReducer(once, { type: "patch", id: uuid(1), patch: { x: 0.6 }, transient: true }).future).toHaveLength(1);
    // Nothing to redo is a no-op.
    expect(editorReducer(redone, { type: "redo" })).toBe(redone);
  });

  it("a gesture is one undo step: a checkpoint, then transient patches", () => {
    const state = run(
      { type: "add", layer: text(1) },
      { type: "checkpoint" },
      { type: "patch", id: uuid(1), patch: { x: 0.6 }, transient: true },
      { type: "patch", id: uuid(1), patch: { x: 0.7 }, transient: true },
      { type: "patch", id: uuid(1), patch: { x: 0.8 }, transient: true },
    );
    expect(state.layers[0]!.x).toBeCloseTo(0.8);
    const undone = editorReducer(state, { type: "undo" });
    expect(undone.layers[0]!.x).toBe(0.5);
  });

  it("a plain patch records itself", () => {
    const state = run({ type: "add", layer: text(1) }, { type: "patch", id: uuid(1), patch: { rotation: 1 } });
    expect(editorReducer(state, { type: "undo" }).layers[0]!.rotation).toBe(0);
  });

  it("removing the selected layer clears the selection, and undo brings it back", () => {
    const removed = run({ type: "add", layer: text(1) }, { type: "remove", id: uuid(1) });
    expect(removed.layers).toEqual([]);
    expect(removed.selectedId).toBeNull();
    expect(editorReducer(removed, { type: "undo" }).layers).toHaveLength(1);
  });

  it("brings a layer to the front and sends it to the back", () => {
    const base = run({ type: "add", layer: text(1) }, { type: "add", layer: text(2) }, { type: "add", layer: text(3) });
    expect(editorReducer(base, { type: "forward", id: uuid(1) }).layers.map((l) => l.id)).toEqual([uuid(2), uuid(3), uuid(1)]);
    expect(editorReducer(base, { type: "backward", id: uuid(3) }).layers.map((l) => l.id)).toEqual([uuid(3), uuid(1), uuid(2)]);
    expect(editorReducer(base, { type: "forward", id: uuid(3) })).toBe(base);
  });

  it("keeps geometry inside the wire bounds", () => {
    const state = run({ type: "add", layer: text(1, { x: 4, y: -2, scale: 99, rotation: 7 }) });
    const layer = state.layers[0]!;
    expect(layer.x).toBe(1);
    expect(layer.y).toBe(0);
    expect(layer.scale).toBe(5);
    expect(Math.abs(layer.rotation)).toBeLessThanOrEqual(Math.PI);
  });

  it("bounds the undo stack", () => {
    let state = run({ type: "add", layer: text(1) });
    for (let i = 0; i < HISTORY_LIMIT + 10; i += 1) {
      state = editorReducer(state, { type: "patch", id: uuid(1), patch: { x: (i % 10) / 10 } });
    }
    expect(state.past.length).toBe(HISTORY_LIMIT);
  });

  it("lets go of the oldest undo steps when the photos they hold are too many bytes", () => {
    const big = (n: number): EditorLayer => ({
      ...(image(n) as Extract<EditorLayer, { type: "image" }>),
      blob: { size: 20 * 1024 * 1024 } as Blob,
    });
    let state = initialEditorState;
    for (let i = 1; i <= 6; i += 1) {
      state = editorReducer(state, { type: "add", layer: big(i) });
      state = editorReducer(state, { type: "remove", id: uuid(i) });
    }
    expect(retainedBlobBytes(state.past)).toBeLessThanOrEqual(HISTORY_BLOB_BUDGET);
    // The newest step is always kept: one undo still works.
    expect(editorReducer(state, { type: "undo" }).layers.length).toBe(1);
  });

  it("counts a photo once however many steps hold it", () => {
    const one = image(1) as Extract<EditorLayer, { type: "image" }>;
    expect(retainedBlobBytes([[one], [one], [one]])).toBe(one.blob.size);
  });

  it("refuses a sixth photo, a second call and a sixth mention", () => {
    let state = initialEditorState;
    for (let i = 1; i <= 7; i += 1) {
      state = editorReducer(state, { type: "add", layer: image(i) });
    }
    expect(state.layers.filter((layer) => layer.type === "image")).toHaveLength(6);
    expect(canAddLayer(state.layers, "image")).toBe(false);
    let people = initialEditorState;
    for (let i = 1; i <= 6; i += 1) {
      people = editorReducer(people, { type: "add", layer: mention(i) });
    }
    expect(people.layers).toHaveLength(5);
  });

  it("stops at twenty layers", () => {
    let state = initialEditorState;
    for (let i = 1; i <= 25; i += 1) {
      state = editorReducer(state, { type: "add", layer: text(i) });
    }
    expect(state.layers).toHaveLength(20);
  });
});

describe("normalizeRotation / clampGeometry", () => {
  it("wraps into -pi..pi", () => {
    expect(normalizeRotation(Math.PI * 2 + 0.5)).toBeCloseTo(0.5, 6);
    expect(normalizeRotation(-Math.PI * 2 - 0.5)).toBeCloseTo(-0.5, 6);
  });
  it("is idempotent", () => {
    const once = clampGeometry({ id: "a", x: 2, y: 2, scale: 0, rotation: 9 });
    expect(clampGeometry(once)).toEqual(once);
  });
});

describe("layerStyle", () => {
  it("places the center, then turns and scales around it", () => {
    const style = layerStyle({ id: "a", x: 0.25, y: 0.75, scale: 2, rotation: 0.5 });
    expect(style.left).toBe("25%");
    expect(style.top).toBe("75%");
    expect(style.transform).toBe("translate(-50%, -50%) rotate(0.5rad) scale(2)");
  });
});

describe("toLayerInput", () => {
  it("makes layers the server's strict schema accepts", () => {
    const layers = [text(1), mention(2), image(3)]
      .map((layer) => toLayerInput(layer))
      .filter((layer): layer is NonNullable<typeof layer> => layer !== null);
    const parsed = createStorySchema.safeParse({
      kind: "text",
      background: "night",
      layers,
      audiences: { serverIds: [uuid(500)], friends: false },
    });
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("declares an image's real byte size and a drawing's upload", () => {
    const input = toLayerInput(image(3));
    expect(input).toMatchObject({ type: "image", upload: { byteSize: 10, width: 100, height: 200 } });
    const drawing: EditorLayer = { id: uuid(4), type: "drawing", x: 0.5, y: 0.5, scale: 1, rotation: 0, strokes: [] };
    expect(toLayerInput(drawing)).toBeNull();
    expect(toLayerInput(drawing, { blob: new Blob([new Uint8Array(7)]), width: 810, height: 1440 })).toMatchObject({
      type: "drawing",
      upload: { contentType: "image/png", byteSize: 7 },
    });
  });

  it("sends the trimmed text", () => {
    expect(toLayerInput(text(1, { text: "  oi  " }))).toMatchObject({ text: "oi" });
  });
});

describe("altTextFor", () => {
  it("reads the text top to bottom, then the people, then the caption", () => {
    const layers = [text(1, { text: "segundo", y: 0.6 }), text(2, { text: "primeiro", y: 0.2 }), mention(3)];
    const alt = altTextFor(layers, "legenda", (name) => `com ${name}`);
    expect(alt).toBe("primeiro. segundo. com Ana3. legenda");
  });

  it("is empty with nothing to say and never longer than the wire allows", () => {
    expect(altTextFor([image(1)], "", (n) => n)).toBe("");
    expect(altTextFor([text(1, { text: "x".repeat(900) })], "", (n) => n).length).toBe(500);
  });
});
