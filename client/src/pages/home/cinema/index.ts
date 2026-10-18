/**
 * The homepage's motion kit. Sections build on these and never re-implement
 * them: progress (one shared frame loop writing CSS vars), pinned scenes,
 * real footage, device frames and the reveal. There is no pointer effect:
 * nothing tilts toward the cursor and nothing is pulled to it (rules in
 * `ui.tsx`).
 */
export {
  PIN_MEDIA,
  PIN_QUERY,
  mix,
  useFinePointer,
  useMediaQuery,
  usePinnedScenes,
  useSceneProgress,
  within,
  type Ease,
  type ProgressMode,
  type ProgressRange,
  type ProgressRanges,
  type SceneProgressOptions,
} from "./progress";
export { Parallax, Scene, useScene } from "./scene";
export { Clip, type ClipFocus, type ClipName, type ClipSources, type Still } from "./clip";
export { useClipGroup } from "./clip-group";
export { clipPoster, smallStill, srcSetFor, stillImg, type PosterName, type StillImg, type StillName } from "./stills";
export { BrowserFrame, PhoneFrame } from "./frames";
export { Reveal } from "./reveal";
