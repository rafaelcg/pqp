import { act } from "react";

/**
 * The crop step that now sits between picking a picture and uploading it, for
 * jsdom suites that pick a file and expect an upload.
 *
 * jsdom has no `createImageBitmap`, no canvas and no `ResizeObserver` (the
 * zoom slider measures its thumb with one). `stubCropStepBrowser` fills those
 * in, with a `createImageBitmap` that waits: `loadCropImage` resolves it with a
 * picture of the given size, `failCropImage` rejects it the way a browser does
 * for a file it cannot decode, and `frameAndSave` loads it and presses Save.
 * Nothing is moved, so the region is the starting one.
 */

export interface FakeBitmap {
  width: number;
  height: number;
  close: () => void;
  closed: boolean;
}

let pending: {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: unknown) => void;
} | null = null;

export function stubCropStepBrowser() {
  globalThis.createImageBitmap = (() =>
    new Promise<ImageBitmap>((resolve, reject) => {
      pending = { resolve, reject };
    })) as typeof createImageBitmap;
  // jsdom answers `getContext` with null and a "not implemented" error on the
  // console; the preview has nothing to draw in a test either way.
  HTMLCanvasElement.prototype.getContext = (() => null) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

function takePending() {
  const next = pending;
  if (!next) throw new Error("the crop step is not decoding a picture");
  pending = null;
  return next;
}

export async function loadCropImage(width = 800, height = 600): Promise<FakeBitmap> {
  const { resolve } = takePending();
  const bitmap: FakeBitmap = {
    width,
    height,
    closed: false,
    close() {
      bitmap.closed = true;
    },
  };
  await act(async () => {
    resolve(bitmap as unknown as ImageBitmap);
  });
  return bitmap;
}

export async function failCropImage() {
  const { reject } = takePending();
  await act(async () => {
    reject(new DOMException("The source image could not be decoded.", "InvalidStateError"));
  });
}

export async function frameAndSave(width?: number, height?: number): Promise<FakeBitmap> {
  const bitmap = await loadCropImage(width, height);
  const save = document.querySelector<HTMLButtonElement>("[data-crop-save]");
  if (!save) throw new Error("no Save in the crop step");
  await act(async () => {
    save.click();
  });
  return bitmap;
}
