import { useEffect, useState } from "react";

/**
 * The desktop viewer's card, sized from the window rather than a fixed
 * 366x650. The canvas is 9:16 (the composer draws on the same one), the reply
 * bar sits under it at the same width, and the pair is about 92% of the
 * window's height. Phone width never comes through here.
 *
 * `zoom` is how much the header and the reply bar are scaled with the card, so
 * a 2560x1440 window does not wear a 366 px card's 14 px type. It is 1 at and
 * below the old size and capped, because the controls only need to stay
 * proportionate, not grow forever.
 */

export const STORY_FOOTER_PX = 64;
const BASE_WIDTH = 366;
const HEIGHT_SHARE = 0.92;
const MAX_ZOOM = 1.6;
/** Side room: two arrows and the gaps; at xl also the two neighbours. */
const SIDE_ROOM = 144;
const SIDE_ROOM_XL = 456;
const XL = 1280;
const MIN_WIDTH = 240;

export interface StoryCardSize {
  /** Canvas width, which is also the card's and the reply bar's. */
  width: number;
  /** Canvas plus reply bar. */
  height: number;
  zoom: number;
}

export function storyCardSize(windowWidth: number, windowHeight: number): StoryCardSize {
  const availableHeight = windowHeight * HEIGHT_SHARE;
  const availableWidth = Math.max(
    MIN_WIDTH,
    windowWidth - (windowWidth >= XL ? SIDE_ROOM_XL : SIDE_ROOM),
  );
  // The reply bar scales with the card and the card depends on what the bar
  // leaves, so settle it in a few passes.
  let zoom = 1;
  let width = MIN_WIDTH;
  for (let pass = 0; pass < 4; pass += 1) {
    width = Math.max(
      MIN_WIDTH,
      Math.min(availableWidth, ((availableHeight - STORY_FOOTER_PX * zoom) * 9) / 16),
    );
    zoom = Math.min(MAX_ZOOM, Math.max(1, width / BASE_WIDTH));
  }
  width = Math.floor(width);
  return {
    width,
    height: Math.round((width * 16) / 9 + STORY_FOOTER_PX * zoom),
    zoom: Math.round(zoom * 1000) / 1000,
  };
}

function read(): StoryCardSize {
  if (typeof window === "undefined") {
    return storyCardSize(1280, 800);
  }
  return storyCardSize(window.innerWidth, window.innerHeight);
}

export function useStoryCardSize(): StoryCardSize {
  const [size, setSize] = useState(read);
  useEffect(() => {
    function onResize() {
      setSize((current) => {
        const next = read();
        return next.width === current.width && next.height === current.height ? current : next;
      });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}
