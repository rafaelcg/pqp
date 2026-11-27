import type { PublicJamSong } from "@pqp/shared";

/**
 * THE ONE FEATURED-SONG RULE, for the public site's hero (`jam-site/home.tsx`)
 * and for every door the app has into public jams (the "A Jam abriu" card, the
 * Novidades row, the directory strip, search and Cmd+K: `lib/jam-public-store.ts`).
 * They share it on purpose: when the app picked "the most heard" it opened a
 * closed song with no record button (user test round 2, N2).
 */

/**
 * How many of Em alta are read to pick the featured song: wide enough that a
 * closed hero still finds songs that take a part to point at (`pickWantingParts`).
 */
export const FEATURED_WINDOW = 12;

/**
 * Whether a song takes a part from a visitor: anything but `closed` (only the
 * starter adds there). An absent `joinMode`, a payload from a server older than
 * the field, reads as open, which is what every client assumed before.
 */
export function takesParts(song: Pick<PublicJamSong, "joinMode">): boolean {
  return song.joinMode !== "closed";
}

/** A song must have at least this many parts in the mix to be featured. */
export const FEATURED_MIN_PARTS = 2;
/** ...from at least this many different people: a one-person song is a draft, not a showcase. */
export const FEATURED_MIN_PEOPLE = 2;
/**
 * Half-life, in days, of the engagement that breaks a tie. The public payload carries LIFETIME
 * counters, not a windowed count, so "recent" is a decay: a play or a like counts in full the day a
 * song is published and half as much two weeks later. (A true window needs the server to count plays
 * per day: described in docs/JAM_SITE.md, not built.)
 */
export const FEATURED_HALF_LIFE_DAYS = 14;
/** A like says more than a play. */
export const FEATURED_LIKE_WEIGHT = 5;
/** A song its viewer started this recently is "just created": never the viewer's own hero. */
export const FEATURED_OWN_FRESH_MS = 24 * 60 * 60 * 1000;

/** What `pickFeatured` may be told about the moment and the viewer. */
export interface FeaturedOptions {
  /** Songs that must not be featured whatever they are (ids). */
  exclude?: ReadonlySet<string>;
  /**
   * The viewer, when known: a song they started themselves in the last day is not featured to
   * them. Matched on the handle when both sides have one, else on the display name.
   */
  viewer?: { handle?: string | null; name?: string | null } | null;
  /** Epoch ms, for tests. */
  now?: number;
}

/** The number of different people in a song's parts (by handle, else by name and picture). */
export function distinctPeople(song: Pick<PublicJamSong, "parts">): number {
  const seen = new Set<string>();
  for (const part of song.parts) {
    seen.add(part.person.handle ? `@${part.person.handle}` : `${part.person.name}|${part.person.avatarUrl ?? ""}`);
  }
  return seen.size;
}

type FeaturedCandidate = Pick<PublicJamSong, "parts" | "artist" | "joinMode" | "coverUrl"> &
  Partial<Pick<PublicJamSong, "id" | "plays" | "likes" | "publishedAt" | "startedBy">>;

function startedByViewer(song: FeaturedCandidate, options: FeaturedOptions): boolean {
  const viewer = options.viewer;
  const by = song.startedBy;
  if (!viewer || !by) return false;
  if (viewer.handle && by.handle) return viewer.handle.toLowerCase() === by.handle.toLowerCase();
  if (!viewer.name) return false;
  // The signed-in hint the site holds is the FIRST word of the display name.
  const first = (name: string) => name.trim().split(/\s+/)[0]!.toLowerCase();
  return first(by.name) === first(viewer.name);
}

/**
 * Whether a song has EARNED the featured slot. Hidden, removed and still-in-review songs never reach
 * the payload (the server's one "public" rule), so what is left to ask is whether the song looks like
 * a showcase: it has a cover, at least two parts in the mix from at least two different people, and
 * it is not the viewer's own song from the last day. A rough one-part upload is a song, not the
 * front page: on launch day the first stranger's upload must not be what every visitor meets.
 */
export function isFeaturable(song: FeaturedCandidate, options: FeaturedOptions = {}): boolean {
  if (!song.coverUrl) return false;
  if (song.parts.length < FEATURED_MIN_PARTS || distinctPeople(song) < FEATURED_MIN_PEOPLE) return false;
  if (song.id && options.exclude?.has(song.id)) return false;
  if (startedByViewer(song, options)) {
    const published = song.publishedAt ? Date.parse(song.publishedAt) : Number.NaN;
    const now = options.now ?? Date.now();
    if (!Number.isFinite(published) || now - published < FEATURED_OWN_FRESH_MS) return false;
  }
  return true;
}

/**
 * Engagement with the recent past weighing most: plays plus five times the likes, halved for every
 * `FEATURED_HALF_LIFE_DAYS` since the song was published. Never negative, never NaN: a payload from
 * an older server with no counters scores zero and the list order decides.
 */
export function featuredScore(song: Pick<FeaturedCandidate, "plays" | "likes" | "publishedAt">, now: number = Date.now()): number {
  const raw = Math.max(0, song.plays ?? 0) + FEATURED_LIKE_WEIGHT * Math.max(0, song.likes ?? 0);
  const published = song.publishedAt ? Date.parse(song.publishedAt) : Number.NaN;
  const ageDays = Number.isFinite(published) ? Math.max(0, (now - published) / 86_400_000) : 0;
  return raw * 0.5 ** (ageDays / FEATURED_HALF_LIFE_DAYS);
}

/**
 * The home's featured slot over a page in Em alta order. A song must EARN it (`isFeaturable`); among
 * the songs that did, the old preference holds: an original (`artist` null) that takes a part, else
 * any original, else a song that takes a part, else any. The showcase should not be somebody else's
 * hit when an original is on the page, and the button under it should lead somewhere: a visitor who
 * signs up to record on a closed song meets "Essa música tá fechada" in the app (user test round 1,
 * B2). A closed original still beats an open cover, because a cover as the showcase is the rights
 * risk; its page says plainly that it takes no part and offers to start one.
 *
 * Inside a preference class the song with the most recent engagement (`featuredScore`) wins, not the
 * newest, and a tie is the page's own order. NULL when nothing earned it: the home then shows no hero
 * and leads with how it works and the list, instead of featuring a weak song.
 *
 * The page is Em alta's (`top`: most liked, then newest), so the hero is always one of its first
 * `FEATURED_WINDOW` songs and never a song the list ranks nowhere near the top.
 */
export function pickFeatured<T extends FeaturedCandidate>(songs: readonly T[], options: FeaturedOptions = {}): T | null {
  const now = options.now ?? Date.now();
  const eligible = songs.filter((candidate) => isFeaturable(candidate, { ...options, now }));
  const original = (candidate: T) => candidate.artist === null;
  const classes: Array<(candidate: T) => boolean> = [
    (candidate) => original(candidate) && takesParts(candidate),
    original,
    takesParts,
    () => true,
  ];
  for (const inClass of classes) {
    const group = eligible.filter(inClass);
    if (group.length === 0) continue;
    let best = group[0]!;
    let bestScore = featuredScore(best, now);
    for (const candidate of group.slice(1)) {
      const score = featuredScore(candidate, now);
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    return best;
  }
  return null;
}

/** How many songs the "these want a part" entry shows. */
export const WANTING_MAX = 3;

/**
 * What the home points at when its hero takes no part (a closed song): up to
 * three other songs with a part to show that still want one, the ones that ASK
 * for an instrument first, then open songs (any part), in the order they came.
 * A `wanted` song with nothing missing is left out: it takes only the
 * instruments its starter listed, which the public payload does not carry, so
 * the entry could not say honestly what to record. Empty when the hero takes a
 * part itself (the entry is for a visitor who would otherwise have nothing to
 * record on) or when no song in the page qualifies.
 */
export function pickWantingParts<T extends Pick<PublicJamSong, "id" | "parts" | "needs" | "joinMode">>(
  songs: readonly T[],
  hero: Pick<PublicJamSong, "id" | "joinMode"> | null,
  max: number = WANTING_MAX,
): T[] {
  if (!hero || takesParts(hero)) return [];
  const candidates = songs.filter((song) => song.id !== hero.id && song.parts.length > 0 && takesParts(song));
  const asking = candidates.filter((song) => song.needs.length > 0);
  const open = candidates.filter((song) => song.needs.length === 0 && song.joinMode !== "wanted");
  return [...asking, ...open].slice(0, max);
}
