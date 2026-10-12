/**
 * Picture-in-Picture for a live `<video>`: the shared screen a viewer wants to
 * keep watching from another tab or app.
 *
 * Two platform surfaces, one answer. Chromium (Chrome, Edge, Opera, Android
 * Chrome, the Electron shell) and Safari 13.1+ ship the standard API
 * (`requestPictureInPicture`, `document.pictureInPictureElement`). Older
 * Safari only has its presentation modes on the element. Firefox has neither:
 * it offers its own overlay toggle on any video, so nothing here renders a
 * control there and the browser's own one stays the way in.
 *
 * Only one element per document can be in PiP. Asking for a second one swaps
 * the window over, so "one PiP when several people share" holds by
 * construction and no caller has to coordinate.
 *
 * Kept free of React and of the DOM globals so the rules pin under vitest's
 * `node` environment with fake elements.
 */
import { hasSafariPresentationMode, isPipAvailable } from "@/lib/hls-live-edge";

export type PictureInPictureSupport = "standard" | "webkit" | "none";

export interface PipVideo {
  disablePictureInPicture?: boolean;
  requestPictureInPicture?: () => Promise<unknown>;
  webkitSupportsPresentationMode?: (mode: string) => boolean;
  webkitPresentationMode?: string;
  webkitSetPresentationMode?: (mode: string) => void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PipDocument {
  pictureInPictureEnabled?: boolean;
  pictureInPictureElement?: unknown;
  exitPictureInPicture?: () => Promise<void>;
}

export function pictureInPictureSupport(
  video: PipVideo | null,
  doc: PipDocument | undefined,
): PictureInPictureSupport {
  if (!video || !doc) {
    return "none";
  }
  if (
    typeof video.requestPictureInPicture === "function" &&
    isPipAvailable({
      pictureInPictureEnabled: Boolean(doc.pictureInPictureEnabled),
      disablePictureInPicture: Boolean(video.disablePictureInPicture),
    })
  ) {
    return "standard";
  }
  if (
    hasSafariPresentationMode(video) &&
    typeof video.webkitSetPresentationMode === "function"
  ) {
    return "webkit";
  }
  return "none";
}

export function isInPictureInPicture(
  video: PipVideo,
  doc: PipDocument | undefined,
): boolean {
  return (
    (doc !== undefined && doc.pictureInPictureElement === video) ||
    video.webkitPresentationMode === "picture-in-picture"
  );
}

const PIP_EVENTS = [
  "enterpictureinpicture",
  "leavepictureinpicture",
  "webkitpresentationmodechanged",
] as const;

/**
 * Calls `onChange` with the element's PiP state whenever it may have moved.
 * Duplicate answers are filtered, so a listener sees each transition once.
 */
export function watchPictureInPicture(
  video: PipVideo,
  doc: PipDocument | undefined,
  onChange: (inPip: boolean) => void,
): () => void {
  let last = isInPictureInPicture(video, doc);
  const listener = () => {
    const next = isInPictureInPicture(video, doc);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  };
  for (const type of PIP_EVENTS) {
    video.addEventListener(type, listener);
  }
  return () => {
    for (const type of PIP_EVENTS) {
      video.removeEventListener(type, listener);
    }
  };
}

export type PictureInPictureToggle =
  | "entered"
  | "exited"
  | "unsupported"
  | "refused";

/**
 * Enter PiP, or leave it when this element already holds the window. Must run
 * inside the click that asked for it: the platform refuses a request with no
 * user gesture behind it, and that refusal is reported, never thrown.
 */
export async function togglePictureInPicture(
  video: PipVideo,
  doc: PipDocument | undefined,
): Promise<PictureInPictureToggle> {
  const support = pictureInPictureSupport(video, doc);
  try {
    if (support === "standard" && doc) {
      if (doc.pictureInPictureElement === video) {
        await doc.exitPictureInPicture?.();
        return "exited";
      }
      await video.requestPictureInPicture!();
      return "entered";
    }
    if (support === "webkit") {
      const leaving = video.webkitPresentationMode === "picture-in-picture";
      video.webkitSetPresentationMode!(
        leaving ? "inline" : "picture-in-picture",
      );
      return leaving ? "exited" : "entered";
    }
    return "unsupported";
  } catch (err) {
    console.warn("[voice] picture-in-picture refused", err);
    return "refused";
  }
}

export interface PipMediaSession {
  setActionHandler(
    action: string,
    handler: ((details?: unknown) => void) | null,
  ): void;
}

/**
 * Lets the browser open PiP on `video` by itself when the viewer leaves the
 * tab: the Media Session `enterpictureinpicture` action. Chrome 120+ desktop
 * fires it, with no user gesture needed, for a page that is capturing the mic
 * or camera, and closes the window again when the tab comes back. The viewer
 * can turn it off per site (Chrome's "Automatic picture-in-picture" site
 * setting). Safari, Firefox and older Chromium do not know the action and
 * `setActionHandler` throws, so this registers nothing there and the manual
 * control is the way in.
 *
 * A window the viewer already opened, on this share or another one, is left
 * where it is.
 */
export function registerAutoPictureInPicture(
  mediaSession: PipMediaSession | undefined,
  video: PipVideo,
  doc: PipDocument | undefined,
): () => void {
  if (!mediaSession || pictureInPictureSupport(video, doc) !== "standard") {
    return () => {};
  }
  try {
    mediaSession.setActionHandler("enterpictureinpicture", () => {
      if (doc?.pictureInPictureElement) {
        return;
      }
      void togglePictureInPicture(video, doc);
    });
  } catch {
    return () => {};
  }
  return () => {
    try {
      mediaSession.setActionHandler("enterpictureinpicture", null);
    } catch {
      // Unregistering an action the browser accepted cannot fail in practice.
    }
  };
}
