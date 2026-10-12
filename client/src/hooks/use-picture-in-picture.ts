import { useCallback, useEffect, useState, type RefObject } from "react";
import {
  isInPictureInPicture,
  pictureInPictureSupport,
  togglePictureInPicture,
  watchPictureInPicture,
  type PipVideo,
} from "@/lib/picture-in-picture";

/**
 * PiP for one share tile's `<video>`. `available` is false until the element
 * exists and has a stream, and stays false on a platform with no API, so the
 * control simply is not drawn there.
 *
 * Leaving PiP resumes playback: the PiP window's own pause button pauses the
 * element, and a live share has no inline play control to undo that. Losing
 * the stream while in PiP closes the window, so it never outlives the share
 * as a frozen last frame.
 */
export function usePictureInPicture(
  videoRef: RefObject<HTMLVideoElement | null>,
  stream: MediaStream | null,
): { available: boolean; active: boolean; toggle: () => void } {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    const video = videoRef.current as (HTMLVideoElement & PipVideo) | null;
    const doc = typeof document === "undefined" ? undefined : document;
    if (!video || !stream) {
      setAvailable(false);
      if (video && doc && isInPictureInPicture(video, doc)) {
        void togglePictureInPicture(video, doc);
      }
      setActive(false);
      return;
    }
    setAvailable(pictureInPictureSupport(video, doc) !== "none");
    setActive(isInPictureInPicture(video, doc));
    return watchPictureInPicture(video, doc, (inPip) => {
      setActive(inPip);
      if (!inPip && video.paused) {
        void video.play().catch(() => {});
      }
    });
  }, [videoRef, stream]);

  const toggle = useCallback(() => {
    const video = videoRef.current as (HTMLVideoElement & PipVideo) | null;
    if (!video || typeof document === "undefined") {
      return;
    }
    void togglePictureInPicture(video, document);
  }, [videoRef]);

  return { available, active, toggle };
}
