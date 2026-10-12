import { useCallback, useEffect, useState, type RefObject } from "react";
import { readPlatformSignals } from "@/lib/downloads";
import {
  afterPictureInPictureRequest,
  isInPictureInPicture,
  pictureInPictureOnThisDevice,
  pictureInPictureSupport,
  registerAutoPictureInPicture,
  togglePictureInPicture,
  watchPictureInPicture,
  type PipVideo,
} from "@/lib/picture-in-picture";

/**
 * PiP for one share's `<video>`. `source` is what the element is playing (the
 * tile's stream, or the element itself for the control bar); null means there
 * is nothing to pop out, and a change of it re-reads the element. `available`
 * is false until both exist, and stays false on a platform with no API or on
 * a phone or tablet, so the control simply is not drawn there.
 *
 * Leaving PiP resumes playback: the PiP window's own pause button pauses the
 * element, and a live share has no inline play control to undo that. Losing
 * the stream or the tile while in PiP closes the window, so it never outlives
 * the share as a frozen last frame.
 */
export function usePictureInPicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  source: unknown,
): { available: boolean; active: boolean; toggle: () => void } {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & PipVideo) | null;
    const doc = typeof document === "undefined" ? undefined : document;
    if (!video || source == null) {
      setAvailable(false);
      setActive(false);
      if (!video || !doc) {
        return;
      }
      // Also after a request still in flight lands, unless the source came
      // back by then.
      let current = true;
      afterPictureInPictureRequest(video, () => {
        if (current && isInPictureInPicture(video, doc)) {
          void togglePictureInPicture(video, doc);
        }
      });
      return () => {
        current = false;
      };
    }
    setAvailable(
      pictureInPictureOnThisDevice(readPlatformSignals()) &&
        pictureInPictureSupport(video, doc) !== "none",
    );
    setActive(isInPictureInPicture(video, doc));
    const stopWatching = watchPictureInPicture(video, doc, (inPip) => {
      setActive(inPip);
      if (!inPip && video.paused) {
        void video.play().catch(() => {});
      }
    });
    return () => {
      stopWatching();
      // Chromium keeps the window open for an element that left the page,
      // showing its last frame. A stream swap keeps the element connected and
      // the window with it; only a tile that unmounted gets it closed, also
      // when its request was still in flight.
      setTimeout(() => {
        afterPictureInPictureRequest(video, () => {
          if (!video.isConnected && isInPictureInPicture(video, doc)) {
            void togglePictureInPicture(video, doc);
          }
        });
      }, 0);
    };
  }, [videoRef, source]);

  const toggle = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & PipVideo) | null;
    if (!video || typeof document === "undefined") {
      return;
    }
    void togglePictureInPicture(video, document);
  }, [videoRef]);

  return { available, active, toggle };
}

/**
 * Hands `video` to the browser as the share to pop out by itself when the
 * viewer leaves the tab. Null unregisters, so nothing opens once no remote
 * share is on the stage.
 */
export function useAutoPictureInPicture(video: HTMLVideoElement | null): void {
  useEffect(() => {
    if (
      !video ||
      typeof navigator === "undefined" ||
      !pictureInPictureOnThisDevice(readPlatformSignals())
    ) {
      return;
    }
    return registerAutoPictureInPicture(
      navigator.mediaSession,
      video as HTMLVideoElement & PipVideo,
      document,
    );
  }, [video]);
}
