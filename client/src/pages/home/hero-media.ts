/**
 * The hero's media and layout values, as plain data.
 *
 * Two things draw the first screen of "/": the live hero (`index.tsx`), and
 * the static copy that `src/lib/prerender-hero.ts` writes into index.html at
 * build time. They must draw the same picture in the same box, or the swap
 * from one to the other flashes or shifts. `vite.config.ts` imports
 * `prerender-hero.ts` at config time, so that file stays import-free and keeps
 * its own copy of these values. The parity test
 * (`src/lib/prerender-hero-parity.test.tsx`) compares the two.
 *
 * So this file imports nothing (no React, no `t()`, no CSS), and a change here
 * is a change to the copy in `prerender-hero.ts` too.
 */

/* --------------------------------------------------------------- Queries */

/** Pinned scenes run only on wide screens (`cinema/progress.ts`). */
export const PIN_MEDIA = "(min-width: 1024px)";

/** ...that did not ask for less motion. The hero pins exactly here. */
export const PIN_QUERY = `${PIN_MEDIA} and (prefers-reduced-motion: no-preference)`;

/**
 * Phones and tablets: below lg a clip's frame is never wider than 960px, so
 * `Clip` draws the small files (`cinema/clip.tsx`, read once at mount).
 * Save-Data asks for them at any width; no media query can read that.
 */
export const SMALL_QUERY = "(max-width: 1023px)";

/* ----------------------------------------------------------------- Frame */

/** The hero footage, `call-join`, is recorded at 1920 by 1200: 16:10. */
export const HERO_ASPECT = { css: "16 / 10", ratio: 16 / 10 } as const;

/** Unpinned, the frame's body: 4:3 on phones, 16:10 from sm. Pinned, `HERO_ASPECT`. */
export const HERO_BODY_UNPINNED = "aspect-[4/3] sm:aspect-[16/10]";

/** Where the footage sits in its box: the top left on phones, the top from sm. */
export const HERO_OBJECT_POSITION = "object-left-top sm:object-top";

/**
 * The pinned frame's final width: as wide as the screen allows with room to
 * breathe. The copy has stepped back by then, so the height only leaves room
 * for the header (4rem), the window bar (2.5rem), the caption (2rem) and a
 * little air (1.5rem): on a short screen the caption still ends inside it.
 */
export const HERO_FRAME_WIDTH = `min(92vw, 1440px, calc((100svh - 10rem) * ${HERO_ASPECT.ratio.toFixed(4)}))`;

/** Pinned it ends as wide as the screen allows; below lg it fills the container. */
export const HERO_SIZES = "(min-width: 1024px) min(92vw, 1440px), 100vw";

/**
 * Phones (below md): a light crop that keeps the whole call in the frame, the
 * channel list with the Lobby, the chat and the "6 na chamada" bar together.
 * Only the server rail and the members list drop out. In percent of the
 * footage's width (`x`) and height (`y`), and how far to crop in (`zoom`).
 */
export const HERO_FOCUS = { x: 15, y: 58, zoom: 1.25 } as const;

/* --------------------------------------------------------------- Picture */

/**
 * The picture the hero draws first, in each of its four states. `Clip` picks
 * one at mount:
 *
 * - `motion`: motion allowed, 1024px and up. The loop's first frame, with a
 *   srcset (what `clipPoster("call-join")` returns).
 * - `motionSmall`: motion allowed, below 1024px or with Save-Data. The small
 *   copy and no srcset (what `smallStill()` makes of `motion.src`).
 * - `reduced`: reduced motion, 1024px and up. The six-person room, not the
 *   loop's first frame, which is a lobby with one person (what
 *   `stillImg("call-join")` returns).
 * - `reducedSmall`: reduced motion, below 1024px or with Save-Data.
 *
 * The small states are not passed to `Clip`: it derives them from `src`
 * through the tables in `cinema/stills.ts`, so these two record what it draws.
 */
export const HERO_PICTURE = {
  motion: {
    src: "/media/home/call-join.webp",
    srcSet: "/media/home/call-join-960.webp 960w, /media/home/call-join.webp 1920w",
    width: 1920,
    height: 1200,
  },
  motionSmall: { src: "/media/home/call-join-960.webp" },
  reduced: {
    src: "/media/home/still-call-join.webp",
    srcSet:
      "/media/home/still-call-join-960.webp 960w, /media/home/still-call-join-1440.webp 1440w, /media/home/still-call-join.webp 2880w",
    width: 2880,
    height: 1800,
  },
  reducedSmall: { src: "/media/home/still-call-join-960.webp" },
} as const;

/**
 * With reduced motion the hero plays nothing until asked, and then this:
 * explicit files, so it skips the manifest gate (`cinema/clip.tsx`). Its
 * poster is the room still, as in `HERO_PICTURE.reduced`.
 */
export const HERO_REDUCED_SOURCES = {
  webm: "/media/home/call-join.webm",
  mp4: "/media/home/call-join.mp4",
  webmSmall: "/media/home/call-join-960.webm",
  mp4Small: "/media/home/call-join-960.mp4",
  poster: "/media/home/still-call-join.webp",
  posterSmall: "/media/home/still-call-join-960.webp",
} as const;

/** The painted rooftop at dusk behind the first screen (`HeroSky`). */
export const HERO_SKY = {
  avifSrcSet: "/images/hero/hero-800.avif 800w, /images/hero/hero-1200.avif 1200w, /images/hero/hero-1536.avif 1536w",
  src: "/images/hero/hero-1200.webp",
  srcSet: "/images/hero/hero-800.webp 800w, /images/hero/hero-1200.webp 1200w, /images/hero/hero-1536.webp 1536w",
  sizes: "100vw",
  width: 1536,
  height: 1024,
} as const;

/* -------------------------------------------------------------- Download */

/**
 * Room for the download line's tallest state; the line itself may be shorter.
 * On a Mac it first offers both builds with a note (63px with a mouse, 84px
 * with touch) and settles on one link, so a Mac with a coarse pointer gets the
 * taller reserve. Below sm (a phone) the line is drawn under the footage
 * and its caption instead, with no reserve: above the frame, an iPhone's 44px
 * pill pushed the top of the call off a 664px Safari screen. The static first
 * screen (`src/lib/prerender-hero.ts`) must follow that order and the phone
 * paddings when it is rewritten for this hero (T1).
 */
export const HERO_DOWNLOAD_BOX = "min-h-[4rem]";
export const HERO_DOWNLOAD_BOX_MAC_TOUCH = "[@media(pointer:coarse)]:min-h-[5.25rem]";
