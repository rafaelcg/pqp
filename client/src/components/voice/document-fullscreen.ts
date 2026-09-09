/**
 * The three DOM calls every fullscreen surface in this app needs, and the
 * WebKit spellings of them.
 *
 * They existed twice, character for character, in `call-stage.tsx` and
 * `screen-share-view.tsx`, and the watch player needed them a third time.
 * Three copies of a platform shim is three places to forget Safari, so they
 * live here once. The interesting part of fullscreen is not here: it is
 * `element-fullscreen.ts`, which knows that an Electron shell can answer a
 * request neither way and leave the promise pending forever.
 */

export interface WebkitFullscreenElement extends HTMLElement {
  webkitRequestFullscreen?: () => Promise<void> | void;
}

export interface WebkitFullscreenDocument extends Document {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
  /** Safari before 16.4 answers only to the prefixed name. */
  webkitFullscreenEnabled?: boolean;
}

/** `document`, told about the prefixed names, for capability probes. */
export function fullscreenDocument(): WebkitFullscreenDocument {
  return document as WebkitFullscreenDocument;
}

export function currentFullscreenElement(): Element | null {
  const doc = fullscreenDocument();
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

export async function requestElementFullscreen(
  element: HTMLElement,
): Promise<void> {
  const webkit = element as WebkitFullscreenElement;
  if (typeof element.requestFullscreen === "function") {
    await element.requestFullscreen();
    return;
  }
  if (typeof webkit.webkitRequestFullscreen === "function") {
    await webkit.webkitRequestFullscreen();
    return;
  }
  throw new Error("no element fullscreen API");
}

export async function exitDocumentFullscreen(): Promise<void> {
  const doc = fullscreenDocument();
  if (typeof doc.exitFullscreen === "function") {
    await doc.exitFullscreen();
    return;
  }
  await doc.webkitExitFullscreen?.();
}
