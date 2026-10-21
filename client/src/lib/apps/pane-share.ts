/**
 * SHARING THE APP PANE (`capabilities.share === 'pane'`, D14).
 *
 * The share itself is the voice channel's own: the same publish, the same
 * viewers, the same stop. All this file does is produce the picture that goes
 * into it. Three paths, in the order they are tried:
 *
 *  1. REGION CAPTURE (Chromium). The page asks for its own tab, then crops the
 *     capture to the pane's box with `CropTarget`, so the chat column, the
 *     channel list and everything else stay out of what the audience sees. The
 *     crop follows the element, so a resize of the window does not unfix it.
 *  2. THE WHOLE TAB (Safari, Firefox and any Chromium without `CropTarget`):
 *     the person is steered at a tab and the chat is in it. The strip says so.
 *  3. THE DESKTOP SHELL: its own picker, through the existing share request;
 *     the crop does not apply to a window or a screen.
 *
 * Never on a phone (RFC "Unverified": a phone cannot do it, and the strip does
 * not offer it there).
 */

interface CropTargetStatic {
  fromElement(element: Element): Promise<unknown>;
}

interface CroppableTrack extends MediaStreamTrack {
  cropTo(target: unknown): Promise<void>;
}

function cropTargetClass(): CropTargetStatic | null {
  const candidate = (globalThis as { CropTarget?: CropTargetStatic }).CropTarget;
  return candidate && typeof candidate.fromElement === "function" ? candidate : null;
}

/** Whether this browser can crop a tab capture to an element. */
export function supportsRegionCapture(): boolean {
  // `cropTo` lives on `BrowserCaptureMediaStreamTrack`, the class a tab
  // capture's video track is, and not on the plain `MediaStreamTrack` (looking
  // there says "no" in the very browsers that can do it).
  const captureTrack = (globalThis as { BrowserCaptureMediaStreamTrack?: { prototype: object } })
    .BrowserCaptureMediaStreamTrack;
  return cropTargetClass() !== null && captureTrack !== undefined && "cropTo" in captureTrack.prototype;
}

export interface PaneCaptureOptions {
  maxFrameRate?: number;
  getDisplayMedia?: (options: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

export interface PaneCapture {
  stream: MediaStream;
  /** The picture is the pane alone. False: the person chose some other surface, shared as it is. */
  cropped: boolean;
}

/**
 * Open the capture and crop it to `element`. Rejects with whatever the browser
 * says when the person cancels the picker (the caller treats that as "no").
 * A crop that cannot be applied (they picked another tab, or a screen) is not
 * an error: they get what they chose.
 */
export async function openPaneCapture(
  element: HTMLElement,
  options: PaneCaptureOptions = {},
): Promise<PaneCapture> {
  const ask =
    options.getDisplayMedia ??
    ((constraints: DisplayMediaStreamOptions) =>
      navigator.mediaDevices.getDisplayMedia(constraints));
  const constraints = {
    video: { frameRate: { ideal: options.maxFrameRate ?? 30 } },
    // No sound from the browser, on purpose. The tab's own sound holds every voice of the call (measured: a tab
    // capture of the pqp tab carries a tone played by a call's <audio>, `restrictOwnAudio` or not), so asking for it
    // would send the call back to the people speaking. The app's own sound is handed over through the bridge
    // instead (`share.audio`, `lib/apps/share-audio.ts`) and published with this picture. This was `false` before
    // too, and nothing replaced it: a game shared into a call arrived as a picture only.
    audio: false,
    // Chromium-only hints; an unknown member is ignored elsewhere.
    preferCurrentTab: true,
    selfBrowserSurface: "include",
    surfaceSwitching: "exclude",
  } as DisplayMediaStreamOptions;
  const stream = await ask(constraints);
  const track = stream.getVideoTracks()[0] as CroppableTrack | undefined;
  const crop = cropTargetClass();
  if (!track || !crop || typeof track.cropTo !== "function") {
    return { stream, cropped: false };
  }
  try {
    // Produced before the crop is applied, as the spec asks: the target names
    // the element, and cropTo applies it to this track.
    const target = await crop.fromElement(element);
    await track.cropTo(target);
    return { stream, cropped: true };
  } catch {
    return { stream, cropped: false };
  }
}
