import { lazy } from "react";

/**
 * Modo 2005's surfaces, as lazy components. The import below is the only path
 * into `retro-chunk.tsx`, so the look's components, sounds and stylesheet stay
 * out of the main bundle and nobody outside the look downloads them.
 */
const load = () => import("./retro-chunk");

export const RetroLayer = lazy(() =>
  load().then((chunk) => ({ default: chunk.RetroLayer })),
);
export const RetroContacts = lazy(() =>
  load().then((chunk) => ({ default: chunk.RetroContacts })),
);
export const RetroWindowChrome = lazy(() =>
  load().then((chunk) => ({ default: chunk.RetroWindowChrome })),
);
export const RetroLogFrame = lazy(() =>
  load().then((chunk) => ({ default: chunk.RetroLogFrame })),
);
