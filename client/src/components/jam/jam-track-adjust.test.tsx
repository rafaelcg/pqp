// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JamEngine } from "@/lib/jam";
import { track } from "@/lib/jam-test-fixtures";
import { TrackAdjust } from "./jam-track-adjust";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function setup() {
  const updateStem = vi.fn();
  const previewGain = vi.fn();
  const engine = { player: { updateStem } } as unknown as JamEngine;
  const stored = track({ gain: 1 });
  act(() =>
    root.render(
      <TrackAdjust
        track={stored}
        title="Adjusting your guitar recording"
        band={[]}
        engine={engine}
        previewGain={previewGain}
        onSave={async () => undefined}
        onDone={() => undefined}
      />,
    ),
  );
  return { updateStem, previewGain, stored };
}

function turnDown(times: number) {
  const slider = host.querySelector<HTMLElement>('[role="slider"][aria-label="Recording volume"]');
  expect(slider).not.toBeNull();
  for (let i = 0; i < times; i++) {
    act(() => {
      slider!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
  }
}

describe("adjusting a posted track's volume", () => {
  it("previews the volume through the mix, for that track only, and leaves the engine's gain to the mix", () => {
    const { updateStem, previewGain, stored } = setup();
    turnDown(25);
    expect(previewGain).toHaveBeenLastCalledWith(stored.id, 0.75);
    // timing may go straight to the engine, the volume never does: a mute or a frame would overwrite it
    for (const [, patch] of updateStem.mock.calls) {
      expect(patch).not.toHaveProperty("gain");
    }
  });

  it("closing with an unsaved volume drops the preview and puts the stored volume back on the stem at once", () => {
    const { updateStem, previewGain, stored } = setup();
    turnDown(25);
    updateStem.mockClear();
    act(() => root.unmount());
    expect(previewGain).toHaveBeenLastCalledWith(stored.id, null);
    // synchronously, not through the hook's next render: when the whole panel is gone
    // under a studio the engine keeps its stems and nothing else would reset this one
    expect(updateStem).toHaveBeenCalledWith(stored.id, expect.objectContaining({ gain: stored.gain }));
    root = createRoot(host);
  });
});

describe("the adjust box", () => {
  it("says in one visible line that nothing changes for everyone until Guardar, with Save and Close in the header, where the box opens", () => {
    setup();
    const note = host.querySelector<HTMLElement>("[data-jam-adjust-note]")!;
    expect(note.textContent).toBe("Nothing changes for everyone until you press Save.");
    const header = host.querySelector<HTMLElement>("[data-jam-adjust-header]")!;
    expect(header.contains(note)).toBe(true);
    expect(header.querySelector("[data-jam-adjust-save]")).not.toBeNull();
    expect(header.querySelector("[data-jam-adjust-close]")).not.toBeNull();
    // nothing sticks over the editor's own content any more
    expect(host.querySelector("[data-jam-adjust-footer]")).toBeNull();
  });
});
