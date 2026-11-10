import type { JamInstrument, JamSongSummary, JamTrack } from "@pqp/shared";
import { JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";

/**
 * The wall's rules, with no React in them: what a tile says a song needs, which
 * songs a filter keeps, how big each tile is, and the bars a tile draws.
 *
 * THE WALL TAKES SECTIONS. Everything here works on a list of songs, so the
 * public songs from jam.pqp.gg can become a second section later by handing
 * the wall a second `JamWallSection` (a title and a list) without touching a
 * rule in this file.
 */

/** What a song is asking of the person looking at it. */
export type JamNeed =
  /** The author wants specific instruments and some are still missing. */
  | { kind: "missing"; instruments: JamInstrument[] }
  /** Anybody may add any instrument. */
  | { kind: "open" }
  /** Nobody is being waited for: closed by its author, or everything wanted is there. */
  | { kind: "ready" }
  /** The song exists and has no track yet. */
  | { kind: "empty" };

export function songNeed(
  song: Pick<JamSongSummary, "joinMode" | "wantedInstruments" | "instruments" | "trackCount">,
): JamNeed {
  if (song.trackCount === 0) {
    return { kind: "empty" };
  }
  if (song.joinMode === "closed") {
    return { kind: "ready" };
  }
  if (song.joinMode === "wanted") {
    const missing = song.wantedInstruments.filter(
      (instrument) => !song.instruments.includes(instrument),
    );
    return missing.length > 0 ? { kind: "missing", instruments: missing } : { kind: "ready" };
  }
  return { kind: "open" };
}

export type JamWallFilter = "all" | "missing" | "ready";

/**
 * "Falta alguém" keeps every song somebody could still add to: the ones asking
 * for an instrument, the open ones and the ones with nothing on them yet.
 * "Prontas" keeps the rest.
 */
export function filterSongs(
  songs: readonly JamSongSummary[],
  filter: JamWallFilter,
): JamSongSummary[] {
  if (filter === "all") {
    return [...songs];
  }
  return songs.filter((song) => {
    const ready = songNeed(song).kind === "ready";
    return filter === "ready" ? ready : !ready;
  });
}

/** Most recently touched first, the order the server's `activity` sort gives. */
export function sortByActivity(songs: readonly JamSongSummary[]): JamSongSummary[] {
  return [...songs].sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) {
      return a.updatedAt < b.updatedAt ? 1 : -1;
    }
    return a.id < b.id ? -1 : 1;
  });
}

export type JamTileSize = "hero" | "wide" | "small";

export interface JamTilePlan {
  song: JamSongSummary;
  size: JamTileSize;
}

/**
 * How big each tile is. The most active song is the hero (2 by 2), one in
 * every four after it is wide (2 by 1) and the rest are small. A fixed rhythm
 * on purpose: a tile that changed size when somebody else's song moved would
 * make the wall jump under a finger, so a size follows the position and
 * nothing else. With one song the hero stands alone; with a handful the grid
 * (`grid-auto-flow: dense`) fills the gaps the spans leave.
 */
export function planTiles(songs: readonly JamSongSummary[]): JamTilePlan[] {
  return songs.map((song, index) => ({
    song,
    size: index === 0 ? "hero" : index % 4 === 3 ? "wide" : "small",
  }));
}

/** Tailwind span classes per size; the grid is 2 columns, 3 from md, 4 from lg. */
export const JAM_TILE_SPAN: Record<JamTileSize, string> = {
  hero: "col-span-2 row-span-2",
  wide: "col-span-2",
  small: "",
};

/**
 * `count` bar heights in 0..1 from a recording's peaks (up to 400 numbers over
 * the whole file). Each bar is the loudest peak in its slice, scaled so the
 * loudest bar of the song reaches the top and a quiet one still reads.
 */
export function barsFromPeaks(peaks: readonly number[], count: number): number[] {
  if (count <= 0) {
    return [];
  }
  if (peaks.length === 0) {
    return new Array<number>(count).fill(0);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const from = Math.floor((i * peaks.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / count));
    let peak = 0;
    for (let j = from; j < to && j < peaks.length; j++) {
      peak = Math.max(peak, peaks[j] ?? 0);
    }
    out.push(peak);
  }
  const loudest = Math.max(...out);
  return loudest > 0 ? out.map((value) => value / loudest) : out;
}

/**
 * A stand-in waveform for a tile whose peaks have not arrived: the same bars
 * every time for the same seed, so the tile does not flicker as it fills in.
 */
export function seededBars(seed: string, count: number): number[] {
  let state = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    state = Math.imul(state ^ seed.charCodeAt(i), 16777619);
  }
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // a soft hill with some grain, never flat and never a wall
    const hill = 0.55 + 0.35 * Math.sin((i / count) * Math.PI * 2.4 + (state % 7));
    out.push(Math.min(1, Math.max(0.12, hill * (0.6 + 0.4 * ((state >>> 8) % 100) / 100))));
  }
  return out;
}

/** "2:14", for a song's length in ms. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** The distinct instruments a song has, newest information first. */
export function tileInstrument(song: Pick<JamSongSummary, "instruments">): JamInstrument {
  return song.instruments[0] ?? "other";
}

/** A section of the wall: a heading and the songs under it. */
export interface JamWallSection {
  id: string;
  songs: readonly JamSongSummary[];
}

/** Has anything on this channel moved since the person last looked? */
export function jamHasNews(
  songs: readonly Pick<JamSongSummary, "updatedAt">[],
  seenAt: string | null,
): boolean {
  if (songs.length === 0) {
    return false;
  }
  if (seenAt === null) {
    return true;
  }
  return songs.some((song) => song.updatedAt > seenAt);
}

export function latestActivity(songs: readonly Pick<JamSongSummary, "updatedAt">[]): string | null {
  let latest: string | null = null;
  for (const song of songs) {
    if (latest === null || song.updatedAt > latest) {
      latest = song.updatedAt;
    }
  }
  return latest;
}

/**
 * The lanes of an open song: grouped by instrument in the band's usual order,
 * the take that is in the mix first in its group, then the rest by votes and
 * age, so a competing take sits right under the one it competes with.
 */
export function orderTracks(tracks: readonly JamTrack[]): JamTrack[] {
  const rank = (instrument: JamInstrument) => JAM_INSTRUMENT_ORDER.indexOf(instrument);
  return [...tracks].sort((a, b) => {
    if (a.instrument !== b.instrument) {
      return rank(a.instrument) - rank(b.instrument);
    }
    if (a.inMix !== b.inMix) {
      return a.inMix ? -1 : 1;
    }
    if (a.voteCount !== b.voteCount) {
      return b.voteCount - a.voteCount;
    }
    return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
  });
}

/** Instruments that have more than one live take: the ones a vote means something on. */
export function competingInstruments(tracks: readonly Pick<JamTrack, "instrument">[]): Set<JamInstrument> {
  const seen = new Set<JamInstrument>();
  const competing = new Set<JamInstrument>();
  for (const track of tracks) {
    if (seen.has(track.instrument)) {
      competing.add(track.instrument);
    }
    seen.add(track.instrument);
  }
  return competing;
}

/**
 * The jam channels that were in a server's channel list and are not any more
 * (deleted, hidden by a lost VIEW, or the person was removed): what the store
 * holds for them must go. Only a server whose list is present is judged, so
 * switching servers (a different list) never reads as everything vanishing.
 */
export function jamChannelsGone(
  before: ReadonlyMap<string, ReadonlySet<string>>,
  channels: readonly { id: string; type: string; serverId: string | null }[],
): { gone: string[]; next: Map<string, Set<string>> } {
  const next = new Map<string, Set<string>>([...before].map(([serverId, ids]) => [serverId, new Set(ids)]));
  const seenServers = new Set<string>();
  const nowJam = new Map<string, Set<string>>();
  for (const channel of channels) {
    if (!channel.serverId) {
      continue;
    }
    seenServers.add(channel.serverId);
    if (channel.type === "jam") {
      const ids = nowJam.get(channel.serverId) ?? new Set<string>();
      ids.add(channel.id);
      nowJam.set(channel.serverId, ids);
    }
  }
  const gone: string[] = [];
  for (const serverId of seenServers) {
    const now = nowJam.get(serverId) ?? new Set<string>();
    for (const id of before.get(serverId) ?? []) {
      if (!now.has(id)) {
        gone.push(id);
      }
    }
    next.set(serverId, now);
  }
  return { gone, next };
}

/**
 * The song's timeline as the lanes draw it: from 0 to the end of the latest
 * in-mix track (the engine's own rule, `songDurationMs`), at least a second so
 * an empty song still has a width.
 */
export function songTimeline(tracks: readonly JamTrack[]): { startMs: number; endMs: number } {
  let end = 0;
  for (const track of tracks) {
    if (!track.inMix) {
      continue;
    }
    end = Math.max(end, track.offsetMs + track.durationMs - track.trimEndMs);
  }
  return { startMs: 0, endMs: Math.max(1000, end) };
}
