import { useEffect, useState } from "react";

/**
 * The desktop viewer's card, sized from the window rather than a fixed
 * 366x650. The card is the 9:16 canvas and nothing else (the composer draws on
 * the same one): the header and the reply row are drawn over it, at one
 * compact size, so a big window gets a bigger picture and not bigger buttons.
 * The card is about 92% of the window's height. Phone width never comes
 * through here.
 *
 * The neighbours (the previous and next person, dimmed and shorter, centred on
 * the card) are sized from the card too, so the row of three reads as one
 * piece at every window size.
 */

const HEIGHT_SHARE = 0.92;
/** The arrows are 28 px; two of them, the four gaps and the window's margin. */
const ARROWS_AND_GAPS = 56 + 48 + 48;
const SIDE_ROOM = 144;
const XL = 1280;
/** Least room kept for the card beside the arrows on a very narrow window. */
const MIN_WIDTH = 240;
const TINY_WIDTH = 1;
/** A neighbour is this much of the card's width, within these bounds. */
const NEIGHBOUR_SHARE = 0.38;
const NEIGHBOUR_MIN = 112;
const NEIGHBOUR_MAX = 240;

export interface StoryCardSize {
  /** The card's width: the canvas. */
  width: number;
  /** The card's height: the canvas, 9:16. */
  height: number;
  /** A neighbour card, 9:16 too. Shown only at xl and up (`showNeighbours`). */
  neighbourWidth: number;
  neighbourHeight: number;
  showNeighbours: boolean;
}

export function storyCardSize(windowWidth: number, windowHeight: number): StoryCardSize {
  const byHeight = Math.max(TINY_WIDTH, (windowHeight * HEIGHT_SHARE * 9) / 16);
  const neighbourWidth = Math.round(
    Math.min(NEIGHBOUR_MAX, Math.max(NEIGHBOUR_MIN, byHeight * NEIGHBOUR_SHARE)),
  );
  const showNeighbours = windowWidth >= XL;
  const sideRoom = showNeighbours ? 2 * neighbourWidth + ARROWS_AND_GAPS : SIDE_ROOM;
  // Height wins on a short window: only a sliver is kept so the arithmetic
  // never goes negative, never a width that would push the card off-screen.
  const width = Math.floor(
    Math.max(TINY_WIDTH, Math.min(byHeight, Math.max(MIN_WIDTH, windowWidth - sideRoom))),
  );
  return {
    width,
    height: Math.round((width * 16) / 9),
    neighbourWidth,
    neighbourHeight: Math.round((neighbourWidth * 16) / 9),
    showNeighbours,
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
        return next.width === current.width &&
          next.neighbourWidth === current.neighbourWidth &&
          next.showNeighbours === current.showNeighbours
          ? current
          : next;
      });
    }
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return size;
}
