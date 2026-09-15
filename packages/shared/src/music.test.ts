import { describe, expect, it } from "vitest";
import {
  MUSIC_END_GRACE_MS,
  completeMusicState,
  musicAdvance,
  musicSkipVotesNeeded,
  musicStateSchema,
  musicWriteAllowed,
  musicWriteIsStale,
  musicWriteIsStructural,
  parseMusicInput,
  setMusicMessageSchema,
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
  openControls: false,
  repeat: "off",
  skipVotes: [],
  history: [],
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
    expect(musicWriteIsStructural(state(), state({ skipVotes: ["u2"] }))).toBe(true);
    expect(musicWriteIsStructural(state(), state({ openControls: true }))).toBe(true);
    expect(musicWriteIsStructural(state(), state({ repeat: "all" }))).toBe(true);
    expect(musicWriteIsStructural(state(), state({ history: [track("z")] }))).toBe(true);
  });
});

describe("schema", () => {
  it("caps the queue", () => {
    const queue = Array.from({ length: 51 }, (_, i) => track(String(i)));
    expect(musicStateSchema.safeParse(state({ queue })).success).toBe(false);
    expect(musicStateSchema.safeParse(state({ queue: queue.slice(0, 50) })).success).toBe(true);
  });

  it("fills new fields when an old-shape frame arrives", () => {
    const parsed = musicStateSchema.parse({
      current: track("a"),
      queue: [],
      status: "playing",
      positionMs: 0,
      atMs: 0,
      rev: 1,
      actorId: "p1",
    });
    expect(parsed.openControls).toBe(false);
    expect(parsed.repeat).toBe("off");
    expect(parsed.skipVotes).toEqual([]);
    expect(parsed.history).toEqual([]);
  });

  it("keeps omitted write fields undefined so they can be filled from held", () => {
    const parsed = setMusicMessageSchema.parse({
      type: "set-music",
      state: {
        current: track("a"),
        queue: [],
        status: "playing",
        positionMs: 0,
        atMs: 0,
        rev: 1,
        actorId: "p1",
      },
    });
    expect(parsed.state?.openControls).toBeUndefined();
    expect(parsed.state?.repeat).toBeUndefined();
    expect(parsed.state?.skipVotes).toBeUndefined();
    expect(parsed.state?.history).toBeUndefined();
    const held = state({
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [track("z")],
    });
    expect(completeMusicState(held, parsed.state!)).toMatchObject({
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [track("z")],
    });
  });
});

describe("musicSkipVotesNeeded", () => {
  it("is half the room, at least two", () => {
    expect(musicSkipVotesNeeded(1)).toBe(2);
    expect(musicSkipVotesNeeded(2)).toBe(2);
    expect(musicSkipVotesNeeded(3)).toBe(2);
    expect(musicSkipVotesNeeded(4)).toBe(2);
    expect(musicSkipVotesNeeded(5)).toBe(3);
  });
});

describe("musicAdvance", () => {
  it("pops the queue and prepends the finished track to history", () => {
    const next = musicAdvance(state({ queue: [track("b"), track("c")] }));
    expect(next.current?.id).toBe("b");
    expect(next.queue.map((t) => t.id)).toEqual(["c"]);
    expect(next.history.map((t) => t.id)).toEqual(["a"]);
    expect(next.skipVotes).toEqual([]);
    expect(next.status).toBe("playing");
    expect(next.positionMs).toBe(0);
  });

  it("pauses when the queue is empty", () => {
    const next = musicAdvance(state());
    expect(next.current).toBeNull();
    expect(next.status).toBe("paused");
    expect(next.history[0]?.id).toBe("a");
  });

  it("keeps the same track on repeat one", () => {
    const next = musicAdvance(state({ repeat: "one", queue: [track("b")] }));
    expect(next.current?.id).toBe("a");
    expect(next.queue.map((t) => t.id)).toEqual(["b"]);
    expect(next.status).toBe("playing");
    expect(next.skipVotes).toEqual([]);
  });

  it("rotates the finished track to the end on repeat all", () => {
    const next = musicAdvance(state({ repeat: "all", queue: [track("b"), track("c")] }));
    expect(next.current?.id).toBe("b");
    expect(next.queue.map((t) => t.id)).toEqual(["c", "a"]);
  });

  it("caps history at ten and drops a duplicate videoId", () => {
    const older = Array.from({ length: 10 }, (_, i) => ({
      ...track(`h${i}`),
      videoId: `id${i}xxxxx`.slice(0, 11),
    }));
    const held = state({
      current: { ...track("a"), videoId: "id0xxxxx".slice(0, 11) },
      history: older,
    });
    // videoId of current matches older[0]; that row is dropped, current goes first, last is trimmed.
    const next = musicAdvance(held);
    expect(next.history).toHaveLength(10);
    expect(next.history[0]?.id).toBe("a");
    expect(next.history.filter((t) => t.videoId === next.history[0]?.videoId)).toHaveLength(1);
  });
});

describe("musicWriteAllowed", () => {
  const manager = { userId: "u1", canManage: true, canAdd: true, roomSize: 4 };
  const member = { userId: "u2", canManage: false, canAdd: true, roomSize: 4 };
  const silent = { userId: "u2", canManage: false, canAdd: false, roomSize: 4 };
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
    const held = state({ current, queue, positionMs: 100_000 });
    const advanced = { ...state({ ...musicAdvance(held), rev: 2 }), actorId: "p2" };
    expect(musicWriteAllowed(held, advanced, member)).toBe(false);
    expect(
      musicWriteAllowed(state({ current, queue, positionMs: 200_000 - MUSIC_END_GRACE_MS }), advanced, member),
    ).toBe(true);
    // No duration known yet: not for a member to decide.
    expect(
      musicWriteAllowed(state({ current: track("a"), queue, positionMs: 999_999 }), advanced, member),
    ).toBe(false);
  });

  it("lets a member add only their own skip vote", () => {
    const held = state();
    expect(musicWriteAllowed(held, state({ skipVotes: ["u2"] }), member)).toBe(true);
    expect(musicWriteAllowed(held, state({ skipVotes: ["u2"], positionMs: 9000 }), member)).toBe(true);
    expect(musicWriteAllowed(held, state({ skipVotes: ["u3"] }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ skipVotes: ["u2", "u3"] }), member)).toBe(false);
    expect(musicWriteAllowed(state({ skipVotes: ["u3"] }), state({ skipVotes: [] }), member)).toBe(false);
    expect(musicWriteAllowed(state({ skipVotes: ["u3"] }), state({ skipVotes: ["u2"] }), member)).toBe(false);
  });

  it("lets a member advance at the vote threshold and refuses one below", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const queue = [track("b")];
    const held = state({ current, queue, skipVotes: ["u3"], positionMs: 0 });
    const advanced = { ...state({ ...musicAdvance(held), rev: 2 }), actorId: "p2" };
    // room of 4 needs 2 votes; held has one, this write is the second.
    expect(musicWriteAllowed(held, advanced, { ...member, roomSize: 4 })).toBe(true);
    expect(musicWriteAllowed(state({ current, queue, skipVotes: [], positionMs: 0 }), advanced, { ...member, roomSize: 4 })).toBe(false);
  });

  it("clears votes when the track changes through an advance", () => {
    const held = state({ queue: [track("b")], skipVotes: ["u3", "u4"] });
    expect(musicAdvance(held).skipVotes).toEqual([]);
    expect(musicAdvance(held).current?.id).toBe("b");
  });

  it("promotes a speaker when openControls is on, and never a non-speaker", () => {
    const held = state({ openControls: true });
    expect(musicWriteAllowed(held, state({ status: "paused", openControls: true }), member)).toBe(true);
    expect(musicWriteAllowed(held, state({ status: "paused", openControls: true }), silent)).toBe(false);
  });

  it("does not let a member flip openControls, repeat or history", () => {
    const held = state();
    expect(musicWriteAllowed(held, state({ openControls: true }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ repeat: "all" }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ history: [track("z")] }), member)).toBe(false);
  });
});
