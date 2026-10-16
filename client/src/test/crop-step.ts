import { act } from "react";

/**
 * The crop step that now sits between picking a picture and uploading it, for
 * jsdom suites that pick a file and expect an upload.
 *
 * jsdom has no object URLs, no `ResizeObserver` (the zoom slider measures its
 * thumb with one) and decodes no images. `stubCropStepBrowser` fills in the
 * first two, and `frameAndSave` plays the browser's part for the third: it
 * reports the picture's size through a `load` event, then presses Save.
 * Nothing is moved, so the region is the starting one.
 */
export function stubCropStepBrowser() {
  URL.createObjectURL = () => "blob:crop-step";
  URL.revokeObjectURL = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

export async function loadCropImage(width = 800, height = 600) {
  const image = document.querySelector<HTMLImageElement>("[data-crop-image]");
  if (!image) throw new Error("the crop step is not open");
  Object.defineProperty(image, "naturalWidth", { value: width, configurable: true });
  Object.defineProperty(image, "naturalHeight", { value: height, configurable: true });
  await act(async () => {
    image.dispatchEvent(new Event("load"));
  });
}

export async function frameAndSave(width?: number, height?: number) {
  await loadCropImage(width, height);
  const save = document.querySelector<HTMLButtonElement>("[data-crop-save]");
  if (!save) throw new Error("no Save in the crop step");
  await act(async () => {
    save.click();
  });
}
