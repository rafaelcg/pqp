/**
 * The stills in /media/home/ and their smaller copies, so every picture on the
 * page is served at the width it is drawn.
 *
 * - 16:10 stills (`still-<name>.webp`, 2880 by 1800) have `-960` and `-1440`.
 * - Phone stills (`still-phone-<x>.webp`, 1170 by 2532) have `-640`.
 * - A clip's poster (`<clip>.webp`, its first frame, 1920 by 1200) has `-960`.
 *
 * The tables list only files that exist, so nothing here ever points at a
 * missing copy: a still that is not listed (or a picture from elsewhere) is
 * used as it is.
 */

const MEDIA = "/media/home/";

type Kind = "wide" | "phone" | "plain";

/** Every still in /media/home/, with the size of its base file. */
const STILLS = {
  appearance: { kind: "wide", width: 2880, height: 1800 },
  "call-join": { kind: "wide", width: 2880, height: 1800 },
  chat: { kind: "wide", width: 2880, height: 1800 },
  hero: { kind: "wide", width: 2880, height: 1800 },
  import: { kind: "wide", width: 2880, height: 1800 },
  profile: { kind: "wide", width: 2880, height: 1800 },
  "raise-hand": { kind: "wide", width: 2880, height: 1800 },
  share: { kind: "wide", width: 2880, height: 1800 },
  "phone-call": { kind: "phone", width: 1170, height: 2532 },
  "phone-chat": { kind: "phone", width: 1170, height: 2532 },
  "phone-servers": { kind: "phone", width: 1170, height: 2532 },
  // Tall crops of one panel: no smaller copies.
  members: { kind: "plain", width: 480, height: 1280 },
  "voice-list": { kind: "plain", width: 656, height: 1520 },
} as const satisfies Record<string, { kind: Kind; width: number; height: number }>;

export type StillName = keyof typeof STILLS;

/** Clips whose first frame has a `-960` poster beside it. */
const POSTERS = ["appearance", "call-join", "chat", "profile", "raise-hand", "share"] as const;
export type PosterName = (typeof POSTERS)[number];

/** Everything an `<img>` needs; spread it on one, or pass it as a Clip still. */
export interface StillImg {
  src: string;
  srcSet: string;
  sizes: string;
  width: number;
  height: number;
  alt: string;
}

function widths(name: StillName): { file: string; w: number }[] {
  const s = STILLS[name];
  const base = `${MEDIA}still-${name}`;
  if (s.kind === "wide") {
    return [
      { file: `${base}-960.webp`, w: 960 },
      { file: `${base}-1440.webp`, w: 1440 },
      { file: `${base}.webp`, w: s.width },
    ];
  }
  if (s.kind === "phone") {
    return [
      { file: `${base}-640.webp`, w: 640 },
      { file: `${base}.webp`, w: s.width },
    ];
  }
  return [{ file: `${base}.webp`, w: s.width }];
}

/**
 * A still from /media/home/ by name (`"share"` is `still-share.webp`,
 * `"phone-call"` is `still-phone-call.webp`), with its srcset, the base file's
 * size for the box, and `alt`. `sizes` is how wide it is drawn (default
 * `100vw`); give the real width so phones fetch the small copy.
 */
export function stillImg(name: StillName, alt: string, sizes = "100vw"): StillImg {
  const set = widths(name);
  const s = STILLS[name];
  return {
    src: `${MEDIA}still-${name}.webp`,
    srcSet: set.map((f) => `${f.file} ${f.w}w`).join(", "),
    sizes,
    width: s.width,
    height: s.height,
    alt,
  };
}

/** A clip's own poster (its first frame), 960 and 1920 wide. */
export function clipPoster(name: PosterName, alt: string, sizes = "100vw"): StillImg {
  return {
    src: `${MEDIA}${name}.webp`,
    srcSet: `${MEDIA}${name}-960.webp 960w, ${MEDIA}${name}.webp 1920w`,
    sizes,
    width: 1920,
    height: 1200,
    alt,
  };
}

const STILL_RE = /^\/media\/home\/still-([a-z0-9-]+?)(?:-(?:640|960|1440))?\.webp$/;
const POSTER_RE = /^\/media\/home\/([a-z0-9-]+?)(?:-960)?\.webp$/;

function stillNameOf(url: string): StillName | null {
  const m = STILL_RE.exec(url);
  return m && m[1] in STILLS ? (m[1] as StillName) : null;
}

/**
 * The srcset for a /media/home/ still or clip poster URL, when it has smaller
 * copies. Undefined for anything else.
 */
export function srcSetFor(url: string): string | undefined {
  const still = stillNameOf(url);
  if (still) return STILLS[still].kind === "plain" ? undefined : stillImg(still, "").srcSet;
  const poster = POSTER_RE.exec(url)?.[1];
  if (poster && (POSTERS as readonly string[]).includes(poster)) return clipPoster(poster as PosterName, "").srcSet;
  return undefined;
}

/**
 * The phone-sized copy of a /media/home/ still or clip poster URL: `-960` for
 * a 16:10 still or a poster, `-640` for a phone still. Anything without a
 * smaller copy comes back unchanged.
 */
export function smallStill(url: string): string {
  const still = stillNameOf(url);
  if (still) return widths(still)[0].file;
  const poster = POSTER_RE.exec(url)?.[1];
  if (poster && (POSTERS as readonly string[]).includes(poster)) return `${MEDIA}${poster}-960.webp`;
  return url;
}
