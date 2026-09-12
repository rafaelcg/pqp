import { describe, expect, it } from "vitest";
import {
  MUSIC_END_GRACE_MS,
  musicStateSchema,
  musicWriteAllowed,
  musicWriteIsStale,
  musicWriteIsStructural,
  parseMusicInput,
  type MusicState,
  type MusicTrack,
} from "./music.js";

const track = (id: string): MusicTrack => ({
  id,
  provider: "youtube",
  videoId: "dQw4w9WgXcQ",
  title: `Track ${id}`,
  sourceUrl: null,
  thumbnailUrl: null,
  durationMs: null,
  addedByUserId: "u1",
  addedByName: "Ana",
});

const state = (overrides: Partial<MusicState> = {}): MusicState => ({
  current: track("a"),
  queue: [],
  status: "playing",
  positionMs: 0,
  atMs: 0,
  rev: 1,
  actorId: "p1",
  ...overrides,
});

describe("parseMusicInput", () => {
  it("reads every YouTube link shape", () => {
    for (const url of [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10",
      "https://youtu.be/dQw4w9WgXcQ?si=abc",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "youtube.com/watch?v=dQw4w9WgXcQ",
    ]) {
      expect(parseMusicInput(url)).toEqual({
        kind: "youtube",
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
    }
  });

  it("reads playlists, watch-with-list, and treats a mix as its video", () => {
    expect(
      parseMusicInput("https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"),
    ).toEqual({
      kind: "youtube-playlist",
      listId: "PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
      videoId: null,
      url: "https://www.youtube.com/playlist?list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI",
    });
    expect(
      parseMusicInput("https://music.youtube.com/watch?v=tI9kSZgMLsc&list=PLFgquLnL59alCl_2TQvOiD5Vgm1hCaGSI"),
    ).toMatchObject({ kind: "youtube-playlist", videoId: "tI9kSZgMLsc" });
    expect(
      parseMusicInput("https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ"),
    ).toMatchObject({ kind: "youtube", videoId: "dQw4w9WgXcQ" });
  });

  it("reads every Spotify shape", () => {
    expect(parseMusicInput("spotify:album:5ht7ItJgpBH7W6vJ5BqpPr")).toEqual({
      kind: "spotify",
      entity: "album",
      id: "5ht7ItJgpBH7W6vJ5BqpPr",
      url: "https://open.spotify.com/album/5ht7ItJgpBH7W6vJ5BqpPr",
    });
    expect(
      parseMusicInput("https://open.spotify.com/playlist/37i9dQZF1DX0FOF1IUWK1W?si=x"),
    ).toMatchObject({ kind: "spotify", entity: "playlist", id: "37i9dQZF1DX0FOF1IUWK1W" });
    expect(
      parseMusicInput("https://open.spotify.com/embed/album/5ht7ItJgpBH7W6vJ5BqpPr"),
    ).toMatchObject({ kind: "spotify", entity: "album" });
    expect(parseMusicInput("https://spotify.link/abc")).toEqual({
      kind: "spotify-short",
      url: "https://spotify.link/abc",
    });
    expect(
      parseMusicInput("https://open.spotify.com/artist/0gxyHStUsqpMadRV0Di1Qt"),
    ).toMatchObject({ kind: "spotify", entity: "other" });
  });

  it("tells a Spotify track from an album", () => {
    expect(
      parseMusicInput("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "track" });
    expect(
      parseMusicInput("https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "track" });
    expect(
      parseMusicInput("https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "album" });
  });

  it("treats plain text as a search and other sites as unsupported", () => {
    expect(parseMusicInput("  legião urbana tempo perdido ")).toEqual({
      kind: "search",
      query: "legião urbana tempo perdido",
    });
    expect(parseMusicInput("https://soundcloud.com/x/y")).toBeNull();
    expect(parseMusicInput("")).toBeNull();
  });
});

describe("ordering", () => {
  it("higher rev wins, ties break on actorId", () => {
    expect(musicWriteIsStale(state({ rev: 2 }), state({ rev: 1 }))).toBe(true);
    expect(musicWriteIsStale(state({ rev: 1 }), state({ rev: 2 }))).toBe(false);
    expect(
      musicWriteIsStale(state({ actorId: "b" }), state({ actorId: "a" })),
    ).toBe(true);
    expect(musicWriteIsStale(null, state())).toBe(false);
    expect(musicWriteIsStale(state(), null)).toBe(false);
  });

  it("only a position change is coalescible", () => {
    expect(musicWriteIsStructural(state(), state({ positionMs: 5000 }))).toBe(false);
    expect(musicWriteIsStructural(state(), state({ status: "paused" }))).toBe(true);
    expect(musicWriteIsStructural(state(), state({ current: track("b") }))).toBe(true);
    expect(musicWriteIsStructural(state(), state({ queue: [track("b")] }))).toBe(true);
    expect(musicWriteIsStructural(null, state())).toBe(true);
    expect(musicWriteIsStructural(state(), null)).toBe(true);
  });
});

describe("schema", () => {
  it("caps the queue", () => {
    const queue = Array.from({ length: 51 }, (_, i) => track(String(i)));
    expect(musicStateSchema.safeParse(state({ queue })).success).toBe(false);
    expect(musicStateSchema.safeParse(state({ queue: queue.slice(0, 50) })).success).toBe(true);
  });
});

describe("musicWriteAllowed", () => {
  const manager = { userId: "u1", canManage: true, canAdd: true };
  const member = { userId: "u2", canManage: false, canAdd: true };
  const mine = (id: string): MusicTrack => ({ ...track(id), addedByUserId: "u2" });

  it("lets a manager do anything, including stopping", () => {
    expect(musicWriteAllowed(state(), null, manager)).toBe(true);
    expect(musicWriteAllowed(state(), state({ status: "paused" }), manager)).toBe(true);
  });

  it("lets a member start music with their own song when nothing is on", () => {
    expect(musicWriteAllowed(null, state({ current: mine("m") }), member)).toBe(true);
    expect(musicWriteAllowed(null, state(), member)).toBe(false);
    expect(musicWriteAllowed(null, state({ current: mine("m") }), { ...member, canAdd: false })).toBe(false);
  });

  it("lets a member append and remove their own, and nothing else", () => {
    const held = state({ queue: [track("b"), mine("m")] });
    expect(musicWriteAllowed(held, state({ queue: [track("b"), mine("m"), mine("n")] }), member)).toBe(true);
    expect(musicWriteAllowed(held, state({ queue: [track("b"), mine("m"), track("x")] }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ queue: [track("b")] }), member)).toBe(true);
    expect(musicWriteAllowed(held, state({ queue: [mine("m")] }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ queue: [mine("m"), track("b")] }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ status: "paused", queue: held.queue }), member)).toBe(false);
    expect(musicWriteAllowed(held, null, member)).toBe(false);
  });

  it("lets a member sample position and fill the duration", () => {
    const held = state();
    expect(musicWriteAllowed(held, state({ positionMs: 9000 }), member)).toBe(true);
    expect(
      musicWriteAllowed(held, state({ current: { ...track("a"), durationMs: 200000 } }), member),
    ).toBe(true);
  });

  it("lets a member advance only once the track has run out", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const queue = [track("b")];
    const advanced = state({ current: track("b"), queue: [], positionMs: 0 });
    expect(musicWriteAllowed(state({ current, queue, positionMs: 100_000 }), advanced, member)).toBe(false);
    expect(
      musicWriteAllowed(state({ current, queue, positionMs: 200_000 - MUSIC_END_GRACE_MS }), advanced, member),
    ).toBe(true);
    // No duration known yet: not for a member to decide.
    expect(musicWriteAllowed(state({ current: track("a"), queue, positionMs: 999_999 }), advanced, member)).toBe(false);
  });
});
