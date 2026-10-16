// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CropRegion } from "@/lib/image-crop";
import { failCropImage, loadCropImage, stubCropStepBrowser } from "@/test/crop-step";
import { ImageCropDialog, type ImageCropShape } from "./image-crop-dialog";

/**
 * The crop step itself: what Save hands back, the keys on the frame, and the
 * two notes (an animated GIF, a picture this browser cannot open). The
 * arithmetic is pinned in `lib/image-crop.test.ts`; this pins the wiring.
 */

stubCropStepBrowser();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// jsdom lays nothing out. The frame is given a width so a key press has a
// distance in picture pixels.
Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
  configurable: true,
  get(this: HTMLElement) {
    return this.hasAttribute("data-crop-frame") ? 300 : 0;
  },
});

let root: Root | null = null;
let host: HTMLElement | null = null;
const onCancel = vi.fn();
const onConfirm = vi.fn<(region: CropRegion, picture: ImageBitmap) => void>();

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.clearAllMocks();
});

async function open(shape: ImageCropShape, type = "image/png") {
  const file = new File([new Uint8Array([1])], "me", { type });
  await act(async () => {
    root!.render(
      <ImageCropDialog
        file={file}
        shape={shape}
        onCancel={onCancel}
        onConfirm={onConfirm}
      />,
    );
  });
}

const frame = () => document.querySelector<HTMLElement>("[data-crop-frame]")!;
const save = () => document.querySelector<HTMLButtonElement>("[data-crop-save]")!;

function press(key: string) {
  act(() => {
    frame().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

async function saved(): Promise<CropRegion> {
  await act(async () => save().click());
  expect(onConfirm).toHaveBeenCalledTimes(1);
  return onConfirm.mock.calls[0][0];
}

describe("the crop step", () => {
  it("cannot be saved before the picture has loaded", async () => {
    await open("avatar");
    expect(save().disabled).toBe(true);
    await loadCropImage(800, 600);
    expect(save().disabled).toBe(false);
  });

  it("saves the centre of the picture when nothing was moved", async () => {
    await open("avatar");
    await loadCropImage(800, 600);
    const region = await saved();
    // A 600px square from the middle of an 800px-wide photo.
    expect(region.x).toBeCloseTo(100 / 800);
    expect(region.y).toBeCloseTo(0);
    expect(region.width).toBeCloseTo(600 / 800);
    expect(region.height).toBeCloseTo(1);
  });

  it("decodes the picture once and hands that decode to the upload", async () => {
    const decode = vi.spyOn(globalThis, "createImageBitmap");
    await open("avatar");
    const bitmap = await loadCropImage(800, 600);
    await saved();
    // A full-resolution decode is hundreds of megabytes for a phone photo:
    // the upload crops from this one instead of decoding the file again.
    expect(decode).toHaveBeenCalledTimes(1);
    expect(onConfirm.mock.calls[0][1]).toBe(bitmap);
    expect(document.querySelector("[data-crop-image]")).toBeNull();
    expect(save().disabled).toBe(true);
    // Handed on, so closing it is the upload's job, not the dialog's.
    await act(async () => {
      root!.render(
        <ImageCropDialog file={null} shape="avatar" onCancel={onCancel} onConfirm={onConfirm} />,
      );
    });
    expect(bitmap.closed).toBe(false);
    decode.mockRestore();
  });

  it("releases the decode when the step closes without saving", async () => {
    await open("avatar");
    const bitmap = await loadCropImage(800, 600);
    await act(async () => {
      root!.render(
        <ImageCropDialog file={null} shape="avatar" onCancel={onCancel} onConfirm={onConfirm} />,
      );
    });
    expect(bitmap.closed).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("draws the banner's frame at the banner's shape", async () => {
    await open("banner");
    expect(frame().style.aspectRatio).toMatch(/^3( \/ 1)?$/);
    await loadCropImage(1200, 1200);
    const region = await saved();
    // Full width, a third of the height, from the middle.
    expect(region.width).toBeCloseTo(1);
    expect(region.height).toBeCloseTo(1 / 3);
    expect(region.y).toBeCloseTo(1 / 3);
  });

  it("zooms and moves with the keys, and 0 starts over", async () => {
    await open("avatar");
    await loadCropImage(1000, 1000);
    press("+");
    press("+");
    press("ArrowRight");
    const zoomed = await saved();
    expect(zoomed.width).toBeCloseTo(1 / 1.21);
    // Moving the picture right shows more of its left side.
    expect(zoomed.x).toBeLessThan((1 - zoomed.width) / 2);

    // Save hands back once per pick, so the reset gets a fresh one.
    onConfirm.mockClear();
    await open("avatar");
    await loadCropImage(1000, 1000);
    press("+");
    press("ArrowLeft");
    press("0");
    const reset = await saved();
    expect(reset).toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });

  it("hands nothing back on Cancel or Escape", async () => {
    await open("avatar");
    await loadCropImage();
    const cancel = [...document.querySelectorAll("button")].find((b) =>
      /^(Cancel|Cancelar)$/.test(b.textContent?.trim() ?? ""),
    )!;
    await act(async () => cancel.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says an animated GIF is saved as a still, and says nothing for a PNG", async () => {
    await open("avatar", "image/gif");
    expect(document.querySelector("[data-crop-gif]")).not.toBeNull();
    await open("avatar", "image/png");
    expect(document.querySelector("[data-crop-gif]")).toBeNull();
  });

  it("says when this browser cannot open the picture, and keeps Save off", async () => {
    await open("avatar", "image/heic");
    await failCropImage();
    expect(document.querySelector('[role="alert"]')?.textContent).toMatch(
      /can't open|não consegue/,
    );
    expect(save().disabled).toBe(true);
  });
});
