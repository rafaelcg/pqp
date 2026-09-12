import { describe, expect, it } from "vitest";
import {
  musicStateSchema,
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

  it("tells a Spotify track from an album", () => {
    expect(
      parseMusicInput("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "track" });
    expect(
      parseMusicInput("https://open.spotify.com/intl-pt/track/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "track" });
    expect(
      parseMusicInput("https://open.spotify.com/album/4uLU6hMCjMI75M1A2tKUQC"),
    ).toMatchObject({ kind: "spotify", entity: "other" });
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
