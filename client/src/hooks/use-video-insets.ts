import { useEffect, useState, type RefObject } from "react";

/** How far the drawn picture sits in from each edge of its box, in px. */
export interface VideoInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

const NONE: VideoInsets = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * Where a `<video>` with `object-fit: contain` actually draws inside its box.
 *
 * A 16:9 share in a taller tile is letterboxed: black bands above and below.
 * A tile's control row belongs on the picture, the way a video player's bar
 * does, not in a band of black that reads as empty stage. This answers how
 * far in that is, from the video's own size and its box; `cover` fills the
 * box, so it answers zero. Kept current as the box resizes and as the stream
 * changes resolution mid-share (`resize` on the element).
 */
export function computeVideoInsets(input: {
  boxWidth: number;
  boxHeight: number;
  videoWidth: number;
  videoHeight: number;
  fit: string;
}): VideoInsets {
  const { boxWidth, boxHeight, videoWidth, videoHeight, fit } = input;
  if (fit !== "contain" || !videoWidth || !videoHeight || !boxWidth || !boxHeight) {
    return NONE;
  }
  const scale = Math.min(boxWidth / videoWidth, boxHeight / videoHeight);
  const x = Math.max(0, Math.round((boxWidth - videoWidth * scale) / 2));
  const y = Math.max(0, Math.round((boxHeight - videoHeight * scale) / 2));
  return { top: y, bottom: y, left: x, right: x };
}

export function useVideoInsets(
  boxRef: RefObject<HTMLElement | null>,
  /** Anything that can swap the element or its fit: the stream, the fit. */
  deps: readonly unknown[],
): VideoInsets {
  const [insets, setInsets] = useState<VideoInsets>(NONE);
  useEffect(() => {
    const box = boxRef.current;
    if (!box) {
      return;
    }
    let video: HTMLVideoElement | null = null;
    const read = () => {
      const next = box.querySelector("video");
      if (next !== video) {
        video?.removeEventListener("resize", read);
        video?.removeEventListener("loadedmetadata", read);
        video = next;
        video?.addEventListener("resize", read);
        video?.addEventListener("loadedmetadata", read);
      }
      const rect = box.getBoundingClientRect();
      const value = video
        ? computeVideoInsets({
            boxWidth: rect.width,
            boxHeight: rect.height,
            videoWidth: video.videoWidth,
            videoHeight: video.videoHeight,
            fit: getComputedStyle(video).objectFit,
          })
        : NONE;
      setInsets((previous) =>
        previous.top === value.top &&
        previous.bottom === value.bottom &&
        previous.left === value.left &&
        previous.right === value.right
          ? previous
          : value,
      );
    };
    read();
    const observers: { disconnect: () => void }[] = [];
    if (typeof ResizeObserver !== "undefined") {
      const resize = new ResizeObserver(read);
      resize.observe(box);
      observers.push(resize);
    }
    if (typeof MutationObserver !== "undefined") {
      // The `<video>` can be swapped under the same box (a player rebuilt,
      // a self preview hidden and shown again).
      const mutation = new MutationObserver(read);
      mutation.observe(box, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["class"],
      });
      observers.push(mutation);
    }
    return () => {
      for (const observer of observers) observer.disconnect();
      video?.removeEventListener("resize", read);
      video?.removeEventListener("loadedmetadata", read);
    };
    // `deps` is the caller's list of what can change the picture.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxRef, ...deps]);
  return insets;
}
