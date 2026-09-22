import { describe, expect, it } from "vitest";
import {
  MUSIC_AUTOPLAY_MAX_MS,
  MUSIC_AUTOPLAY_MIN_MS,
  MUSIC_END_GRACE_MS,
  MUSIC_MAX_DURATION_MS,
  completeMusicState,
  musicAdvance,
  musicAutoplayCandidate,
  musicAutoplayCandidates,
  musicSkipVotesNeeded,
  musicStateSchema,
  musicServerWriteAllowed,
  musicWriteAllowed,
  musicWriteIsStale,
  musicWriteIsStructural,
  parseMusicInput,
  setMusicMessageSchema,
  type MusicResolved,
  type MusicState,
  type MusicStateWrite,
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

/**
 * `musicAdvance` answers without `rev` / `actorId` / `atMs`, because those
 * belong to whoever writes it. A test that hands its answer straight to
 * `musicWriteAllowed` is skipping the step a real client does, and the
 * types say so even though `vitest` never asked.
 */
const written = (
  next: Omit<MusicState, "rev" | "actorId" | "atMs">,
  overrides: Partial<Pick<MusicState, "rev" | "actorId" | "atMs">> = {},
): MusicState => ({ atMs: 0, rev: 2, actorId: "p2", ...next, ...overrides });

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
  autoplay: false,
  ...overrides,
});

describe("parseMusicInput", () => {
  it("reads a watch URL with a trailing slash, which YouTube serves", () => {
    expect(parseMusicInput("https://www.youtube.com/watch/?v=dQw4w9WgXcQ")).toEqual({
      kind: "youtube",
      videoId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it("keeps reading the other shapes with a trailing slash", () => {
    for (const url of [
      "https://www.youtube.com/shorts/dQw4w9WgXcQ/",
      "https://www.youtube.com/embed/dQw4w9WgXcQ/",
    ]) {
      expect(parseMusicInput(url)).toEqual({
        kind: "youtube",
        videoId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      });
    }
  });

  /*
   * A paste that did not survive the clipboard is not a search. It used to
   * fall through to one and come back with an unrelated song.
   */
  it("refuses text that starts with a scheme and does not parse", () => {
    expect(parseMusicInput("https://")).toBeNull();
    expect(parseMusicInput("https://%%%")).toBeNull();
  });

  it("still searches for text that merely contains a colon or a scheme", () => {
    expect(parseMusicInput("Rush 2112: Overture")).toEqual({
      kind: "search",
      query: "Rush 2112: Overture",
    });
    expect(parseMusicInput("bohemian rhapsody http://")).toEqual({
      kind: "search",
      query: "bohemian rhapsody http://",
    });
    // "ht!tp" is not a scheme, so this is ordinary text with a colon in it.
    expect(parseMusicInput("ht!tp://not a url###")).toEqual({
      kind: "search",
      query: "ht!tp://not a url###",
    });
  });

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
    expect(musicWriteIsStructural(state(), state({ autoplay: true }))).toBe(true);
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
    // Omitted, not wiped: completeMusicState fills false so an old frame
    // cannot turn the room's autoplay off.
    expect(parsed.autoplay).toBeUndefined();
    expect(completeMusicState(null, parsed).autoplay).toBeUndefined();
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
    expect(parsed.state?.autoplay).toBeUndefined();
    const held = state({
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [track("z")],
      autoplay: true,
    });
    expect(completeMusicState(held, parsed.state!)).toMatchObject({
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [track("z")],
      autoplay: true,
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

  /*
   * Sampling stayed anybody's, because every write carries the writer's own
   * player position and refusing the sample would refuse the append it
   * rides on. The duration fill did not stay anybody's: it is the other
   * operand of the end-of-track gate. See "filling in a track's missing
   * duration" below.
   */
  it("lets a member sample position, but not fill somebody else's duration", () => {
    const held = state();
    expect(musicWriteAllowed(held, state({ positionMs: 9000 }), member)).toBe(true);
    expect(
      musicWriteAllowed(held, state({ current: { ...track("a"), durationMs: 200000 } }), member),
    ).toBe(false);
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

  /*
   * What "Todo mundo controla" hands over, and what it does not. The rule
   * is one line: everything a manager may write except the three room
   * switches. A verb list instead of that rule refuses skip-back and the
   * end-of-track add, which both rewrite history.
   */
  describe("a speaker promoted by openControls", () => {
    const held = state({
      current: { ...track("a"), durationMs: 200_000 },
      queue: [track("b"), track("c")],
      history: [track("old")],
      openControls: true,
    });
    const promoted = (incoming: MusicState) =>
      musicWriteAllowed(held, incoming, member);

    it("may do what the room switch promises", () => {
      expect(promoted({ ...held, status: "paused" })).toBe(true);
      expect(promoted(written(musicAdvance(held)))).toBe(true);
      expect(promoted({ ...held, queue: [track("c"), track("b")] })).toBe(true);
      expect(promoted({ ...held, queue: [track("c")] })).toBe(true);
      expect(promoted({ ...held, positionMs: 120_000 })).toBe(true);
      expect(musicWriteAllowed(held, null, member)).toBe(true);
    });

    it("may take the two paths that rewrite history", () => {
      // Skip-back: the first Tocadas row becomes current, the displaced
      // track goes to the front of the queue, history loses its head.
      expect(
        promoted({
          ...held,
          current: track("old"),
          queue: [held.current as MusicTrack, ...held.queue],
          history: [],
          positionMs: 0,
        }),
      ).toBe(true);
      // The end-of-track add: current into history and the queue's front.
      expect(
        promoted({
          ...held,
          current: track("new"),
          queue: [held.current as MusicTrack, ...held.queue],
          history: [held.current as MusicTrack, ...held.history],
          positionMs: 0,
        }),
      ).toBe(true);
    });

    it("may not touch the three room switches", () => {
      expect(promoted({ ...held, openControls: false })).toBe(false);
      expect(promoted({ ...held, repeat: "one" })).toBe(false);
      expect(promoted({ ...held, autoplay: true })).toBe(false);
    });

    it("still refuses somebody who cannot speak", () => {
      expect(musicWriteAllowed(held, { ...held, status: "paused" }, silent)).toBe(false);
    });
  });

  /*
   * The end-of-track gate used to read a sample that anybody seated could
   * write, so a member could satisfy it at will. It reads the server's own
   * clock now, and the duration is not theirs to invent.
   */
  describe("the end-of-track gate", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const held = state({ current, queue: [track("b")], positionMs: 190_000 });
    const advance = () => written(musicAdvance(held));

    it("ignores a held sample the server's clock does not agree with", () => {
      expect(
        musicWriteAllowed(held, advance(), { ...member, expectedPositionMs: 10_000 }),
      ).toBe(false);
    });

    it("opens once the server's clock is inside the grace, stale sample or not", () => {
      const stale = state({ current, queue: [track("b")], positionMs: 0 });
      expect(
        musicWriteAllowed(stale, written(musicAdvance(stale)), {
          ...member,
          expectedPositionMs: 200_000 - MUSIC_END_GRACE_MS,
        }),
      ).toBe(true);
    });

    it("falls back to the held sample when no clock is given, which is the client drawing", () => {
      expect(musicWriteAllowed(held, advance(), member)).toBe(true);
    });
  });

  describe("filling in a track's missing duration", () => {
    const nullDuration = track("a");
    const held = state({ current: nullDuration, queue: [track("b")] });
    const filled = (durationMs: number) =>
      state({ current: { ...nullDuration, durationMs }, queue: [track("b")] });

    it("is the manager's, or the adder's", () => {
      expect(musicWriteAllowed(held, filled(200_000), manager)).toBe(true);
      // `track()` is added by u1, and the manager fixture is u1.
      expect(
        musicWriteAllowed(held, filled(200_000), { ...member, userId: "u1" }),
      ).toBe(true);
    });

    it("is refused from anybody else, so the gate cannot be invented", () => {
      expect(musicWriteAllowed(held, filled(1), member)).toBe(false);
      expect(musicWriteAllowed(held, filled(200_000), member)).toBe(false);
    });
  });

  /*
   * The vote threshold's denominator is the live room, so its numerator has
   * to be live too. A vote from somebody who left is not counted.
   */
  describe("skip votes from people who have left", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const held = state({ current, queue: [track("b")], skipVotes: ["gone1", "gone2"] });
    const seated = { userId: "u2", canManage: false, canAdd: true, roomSize: 6, seatedUserIds: ["u1", "u2", "u3", "u4", "u5", "u6"] };

    it("does not let two departed votes plus the sender clear a room of six", () => {
      expect(musicWriteAllowed(held, written(musicAdvance(held)), seated)).toBe(false);
    });

    it("counts the votes of people still seated", () => {
      const live = state({ current, queue: [track("b")], skipVotes: ["u3", "u4"] });
      expect(musicWriteAllowed(live, written(musicAdvance(live)), seated)).toBe(true);
    });

    it("falls back to counting every held vote when the seats are not known", () => {
      const { seatedUserIds: _omitted, ...withoutSeats } = seated;
      expect(musicWriteAllowed(held, written(musicAdvance(held)), withoutSeats)).toBe(true);
    });
  });

  it("does not let a member flip openControls, repeat, autoplay or history", () => {
    const held = state();
    expect(musicWriteAllowed(held, state({ openControls: true }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ repeat: "all" }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ autoplay: true }), member)).toBe(false);
    expect(musicWriteAllowed(held, state({ history: [track("z")] }), member)).toBe(false);
  });

  it("lets a member autoplay-advance their own related track when the queue ran out", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const held = state({
      current,
      queue: [],
      autoplay: true,
      positionMs: 200_000 - MUSIC_END_GRACE_MS,
      skipVotes: ["u3"],
    });
    const pick: MusicTrack = {
      ...mine("auto"),
      videoId: "nextSongxx1",
      title: "Parecida",
      autoplayed: true,
    };
    const incoming = {
      ...state({
        ...musicAdvance(held),
        current: pick,
        status: "playing" as const,
        positionMs: 0,
        autoplay: true,
        rev: 2,
      }),
      actorId: "p2",
    };
    expect(musicWriteAllowed(held, incoming, member)).toBe(true);
    expect(incoming.history[0]?.id).toBe("a");
    expect(incoming.skipVotes).toEqual([]);
  });

  it("refuses a member autoplay-advance outside the ran-out empty-queue rule", () => {
    const current = { ...track("a"), durationMs: 200_000 };
    const pick: MusicTrack = {
      ...mine("auto"),
      videoId: "nextSongxx1",
      autoplayed: true,
    };
    const incomingOf = (held: MusicState) =>
      state({
        ...musicAdvance(held),
        current: pick,
        status: "playing",
        positionMs: 0,
        autoplay: true,
        rev: 2,
        actorId: "p2",
      });

    const ready = state({
      current,
      queue: [],
      autoplay: true,
      positionMs: 200_000 - MUSIC_END_GRACE_MS,
    });
    expect(musicWriteAllowed(ready, incomingOf(ready), member)).toBe(true);
    expect(
      musicWriteAllowed(state({ ...ready, autoplay: false }), incomingOf(ready), member),
    ).toBe(false);
    expect(
      musicWriteAllowed(state({ ...ready, queue: [track("b")] }), incomingOf(ready), member),
    ).toBe(false);
    expect(
      musicWriteAllowed(state({ ...ready, positionMs: 0 }), incomingOf(ready), member),
    ).toBe(false);
    expect(
      musicWriteAllowed(
        ready,
        state({ ...incomingOf(ready), current: { ...pick, addedByUserId: "u1" } }),
        member,
      ),
    ).toBe(false);
    expect(
      musicWriteAllowed(
        ready,
        state({ ...incomingOf(ready), current: { ...pick, autoplayed: undefined } }),
        member,
      ),
    ).toBe(false);
    expect(
      musicWriteAllowed(ready, state({ ...incomingOf(ready), history: [] }), member),
    ).toBe(false);
  });
});

describe("musicAutoplayCandidate", () => {
  const resolved = (
    videoId: string,
    durationMs: number | null = 180_000,
  ): MusicResolved => ({
    provider: "youtube",
    videoId,
    title: videoId,
    sourceUrl: null,
    thumbnailUrl: null,
    durationMs,
  });

  it("drops the finishing id, history, queue, and non-song lengths", () => {
    const finishing = "finish00001";
    const held = state({
      current: { ...track("a"), videoId: finishing },
      queue: [{ ...track("q"), videoId: "queued00001" }],
      history: [{ ...track("h"), videoId: "history0001" }],
    });
    const related = [
      resolved(finishing),
      resolved("history0001"),
      resolved("queued00001"),
      resolved("short000001", MUSIC_AUTOPLAY_MIN_MS - 1),
      resolved("long0000001", MUSIC_AUTOPLAY_MAX_MS + 1),
      resolved("unknown0001", null),
      resolved("pick0000001", 180_000),
    ];
    expect(musicAutoplayCandidate(related, held)?.videoId).toBe("unknown0001");
  });

  it("returns null when every related video is blocked or the wrong length", () => {
    const held = state({ current: { ...track("a"), videoId: "finish00001" } });
    expect(
      musicAutoplayCandidate(
        [resolved("finish00001"), resolved("clip0000001", 10_000)],
        held,
      ),
    ).toBeNull();
    expect(musicAutoplayCandidate([], held)).toBeNull();
  });

  it("returns several song-length picks in related order", () => {
    const held = state({ current: { ...track("a"), videoId: "finish00001" } });
    const related = [
      resolved("finish00001"),
      resolved("pick0000001", 180_000),
      resolved("short000001", MUSIC_AUTOPLAY_MIN_MS - 1),
      resolved("pick0000002", 200_000),
      resolved("pick0000003", 90_000),
    ];
    expect(musicAutoplayCandidates(related, held, 3).map((video) => video.videoId)).toEqual([
      "pick0000001",
      "pick0000002",
      "pick0000003",
    ]);
    expect(musicAutoplayCandidates(related, held, 1)).toEqual([
      musicAutoplayCandidate(related, held),
    ]);
  });
});

describe("a duration no music track has", () => {
  /*
   * A 24/7 live mix answers `getDuration()` with how long the STREAM has
   * been up, so the room was handed 1209:42:45 and a seek bar measured
   * against fifty days. The duration is the other operand of the
   * end-of-track gate, so a value like that also means the gate never
   * opens and the room never advances on its own.
   *
   * The bound is deliberately far above any real mix (twelve hours) and
   * far below a stream that has been live for days: it is there to catch
   * a category error, not to judge long videos.
   */
  const live = MUSIC_MAX_DURATION_MS + 1;
  const held = state();
  const withDuration = (durationMs: number): MusicState => ({
    ...held,
    current: { ...(held.current as MusicTrack), durationMs },
    rev: held.rev + 1,
    actorId: "p2",
  });

  it("refuses a fill past the ceiling, from anybody", () => {
    const incoming = withDuration(live);
    expect(
      musicWriteAllowed(held, incoming, {
        userId: "u1",
        canManage: true,
        canAdd: true,
        roomSize: 3,
      }),
    ).toBe(false);
  });

  it("still takes an honest long mix", () => {
    const incoming = withDuration(MUSIC_MAX_DURATION_MS - 1);
    expect(
      musicWriteAllowed(held, incoming, {
        userId: "u1",
        canManage: true,
        canAdd: true,
        roomSize: 3,
      }),
    ).toBe(true);
  });
});

describe("a duration the client made up", () => {
  /*
   * A TRACK'S DECLARED LENGTH IS THE OTHER OPERAND OF THE END-OF-TRACK
   * GATE, AND IT ARRIVES FROM A CLIENT.
   *
   * The ceiling added for live streams looked only at `incoming.current`,
   * and only while the held duration was still null, so a member could
   * queue a track declaring any length at all and it sailed through the
   * ordinary append path. The low end was never checked: a track declaring
   * zero satisfies `gatePosition >= 0 - 20000` from the instant it starts,
   * and `matchesAdvance` + `ranOut` never consult `canAdd`, so ANY seated
   * person — a listen-only seat with no rights whatsoever — could then
   * write the advance and take the room's track away with no votes, or
   * end the room outright when the queue was empty.
   */
  const bogus = (durationMs: number | null): MusicState => ({
    ...state(),
    current: { ...(state().current as MusicTrack), durationMs },
  });

  const LISTENER = {
    userId: "nobody",
    canManage: false,
    canAdd: false,
    roomSize: 10,
    expectedPositionMs: 0,
  };

  it("refuses a zero-length track, so nobody can skip on it with no votes", () => {
    const held = bogus(0);
    const advanced = musicAdvance(held);
    expect(
      musicWriteAllowed(
        held,
        { ...advanced, atMs: 0, rev: 2, actorId: "pz" },
        LISTENER,
      ),
    ).toBe(false);
  });

  it("refuses one shorter than the grace, for the same reason", () => {
    const held = bogus(MUSIC_END_GRACE_MS - 1);
    const advanced = musicAdvance(held);
    expect(
      musicWriteAllowed(
        held,
        { ...advanced, atMs: 0, rev: 2, actorId: "pz" },
        LISTENER,
      ),
    ).toBe(false);
  });

  it("lets a short track end once its clock genuinely reaches the end", () => {
    const held = bogus(10_000);
    const advanced = musicAdvance(held);
    expect(
      musicWriteAllowed(
        held,
        { ...advanced, atMs: 0, rev: 2, actorId: "pz" },
        { ...LISTENER, expectedPositionMs: 9_000 },
      ),
    ).toBe(true);
  });

  it("refuses a queued track that declares an impossible length", () => {
    const held = state();
    const queued: MusicTrack = {
      ...(state().current as MusicTrack),
      id: "q1",
      durationMs: MUSIC_MAX_DURATION_MS + 1,
    };
    expect(
      musicWriteAllowed(
        held,
        { ...held, queue: [queued], rev: 2, actorId: "p2" },
        {
          userId: "u1",
          canManage: true,
          canAdd: true,
          roomSize: 3,
        },
      ),
    ).toBe(false);
  });

  it("leaves an ordinary track and an unknown duration alone", () => {
    const held = state();
    const queued: MusicTrack = {
      ...(state().current as MusicTrack),
      id: "q1",
      durationMs: 210_000,
    };
    const rights = {
      userId: "u1",
      canManage: true,
      canAdd: true,
      roomSize: 3,
    };
    expect(
      musicWriteAllowed(
        held,
        { ...held, queue: [queued], rev: 2, actorId: "p2" },
        rights,
      ),
    ).toBe(true);
    expect(
      musicWriteAllowed(
        held,
        {
          ...held,
          queue: [{ ...queued, durationMs: null }],
          rev: 2,
          actorId: "p2",
        },
        rights,
      ),
    ).toBe(true);
  });
});

describe("a room that already holds an impossible duration", () => {
  /*
   * THE BOUND IS ON WHAT A WRITE INTRODUCES, NOT ON WHAT IT CARRIES.
   *
   * Every write is an absolute state, so it repeats every track already in
   * the room. Checking all of them meant a room that had been handed a
   * bogus duration before this rule existed — a live stream's uptime, say —
   * would have EVERY later write refused, including the skip that would
   * have got rid of the track. The room would be stuck until it emptied.
   *
   * So a track keeps whatever length it already had, and only a new or
   * changed one is bounded. The gate is safe either way: it needs a
   * positive duration and caps the grace at half of it, so a legacy zero
   * still ends nothing and a legacy fifty days still never comes due.
   */
  const legacy: MusicTrack = {
    ...(state().current as MusicTrack),
    id: "legacy",
    durationMs: MUSIC_MAX_DURATION_MS * 100,
  };
  const rights = {
    userId: "u1",
    canManage: true,
    canAdd: true,
    roomSize: 3,
  };

  it("lets the room go on writing around it", () => {
    const held = state({ queue: [legacy] });
    expect(
      musicWriteAllowed(
        held,
        { ...held, positionMs: 5_000, rev: 2, actorId: "p2" },
        rights,
      ),
    ).toBe(true);
  });

  it("lets somebody skip it away", () => {
    const held = state({ queue: [legacy] });
    const advanced = musicAdvance(held);
    expect(
      musicWriteAllowed(
        held,
        { ...advanced, atMs: 0, rev: 2, actorId: "p2" },
        rights,
      ),
    ).toBe(true);
  });

  it("still refuses to CHANGE a duration to an impossible one", () => {
    const held = state({ queue: [legacy] });
    expect(
      musicWriteAllowed(
        held,
        {
          ...held,
          queue: [{ ...legacy, durationMs: MUSIC_MAX_DURATION_MS * 200 }],
          rev: 2,
          actorId: "p2",
        },
        rights,
      ),
    ).toBe(false);
  });

  it("still refuses a new track with one", () => {
    const held = state();
    expect(
      musicWriteAllowed(
        held,
        {
          ...held,
          queue: [{ ...legacy, id: "fresh" }],
          rev: 2,
          actorId: "p2",
        },
        rights,
      ),
    ).toBe(false);
  });
});

describe("the gate with no trusted clock", () => {
  /*
   * FAIL CLOSED ON THE SERVER, NOT OPEN.
   *
   * `gatePosition` fell back to `held.positionMs` whenever the server had
   * no anchor for the room — the documented cold-row case, counted as
   * `musicCluster.anchorMissing`. That sample is the last one ANYBODY
   * seated wrote, which is the whole reason the anchor exists, so in that
   * window a listen-only seat could write a position near the end and then
   * advance with no votes: exactly the bypass the anchor closed, reopened
   * by its own absence.
   *
   * The server always says who is writing (`peerId`), so it can be told
   * apart from the client, which calls this only to decide what to draw
   * and has no clock of its own. Without a trusted clock the room falls
   * back to votes, which is safe and still lets it move on.
   */
  const held = state({
    current: { ...(state().current as MusicTrack), durationMs: 200_000 },
    positionMs: 190_000,
  });
  const advanced = { ...musicAdvance(held), atMs: 0, rev: 2, actorId: "pz" };

  it("refuses an advance a seat claimed its way to, with no anchor", () => {
    expect(
      musicServerWriteAllowed(held, advanced, {
        userId: "nobody",
        canManage: false,
        canAdd: false,
        roomSize: 10,
        seatedUserIds: [],
        peerId: "pz",
        expectedPositionMs: null,
      }),
    ).toBe(false);
  });

  it("takes it once the server's own clock says the track is over", () => {
    expect(
      musicServerWriteAllowed(held, advanced, {
        userId: "nobody",
        canManage: false,
        canAdd: false,
        roomSize: 10,
        seatedUserIds: [],
        peerId: "pz",
        expectedPositionMs: 190_000,
      }),
    ).toBe(true);
  });

  it("leaves the client's own drawing alone", () => {
    // No `peerId`: this is the client asking what to show, and it has only
    // the held sample to go on.
    expect(
      musicWriteAllowed(held, advanced, {
        userId: "nobody",
        canManage: false,
        canAdd: false,
        roomSize: 10,
      }),
    ).toBe(true);
  });

  it("counts no departed votes when the server names no seats", () => {
    const voted = state({
      current: { ...(state().current as MusicTrack), durationMs: 200_000 },
      skipVotes: ["gone-1", "gone-2", "gone-3", "gone-4"],
    });
    expect(
      musicServerWriteAllowed(
        voted,
        { ...musicAdvance(voted), atMs: 0, rev: 2, actorId: "pz" },
        {
          userId: "nobody",
          canManage: false,
          canAdd: false,
          roomSize: 10,
          peerId: "pz",
          expectedPositionMs: 0,
          // The server always knows who is seated; saying nothing here is
          // a bug, and no held vote may carry the threshold on it.
          seatedUserIds: [],
        },
      ),
    ).toBe(false);
  });
});

describe("the server's own door", () => {
  /*
   * The trusted context is not optional here, and that is the whole point.
   * On `MusicRights` those three fields are optional so the client can ask
   * the same question with none of them, which is right for drawing and
   * wrong for deciding: a server caller that left one out still compiled
   * and quietly got the lenient reading. One of them already had — the
   * permission re-check in `voice.ts` passed neither a peer id nor a
   * clock.
   */
  it("fails closed on a room with no clock, without being asked to", () => {
    const held = state({
      current: { ...(state().current as MusicTrack), durationMs: 200_000 },
      positionMs: 190_000,
      queue: [track("b")],
    });
    expect(
      musicServerWriteAllowed(held, written(musicAdvance(held)), {
        userId: "nobody",
        canManage: false,
        canAdd: false,
        roomSize: 10,
        peerId: "p2",
        expectedPositionMs: null,
        seatedUserIds: [],
      }),
    ).toBe(false);
  });

  it("agrees with the rule it delegates to when the clock is there", () => {
    const held = state({
      current: { ...(state().current as MusicTrack), durationMs: 200_000 },
      positionMs: 0,
      queue: [track("b")],
    });
    const write = written(musicAdvance(held));
    const server = musicServerWriteAllowed(held, write, {
      userId: "nobody",
      canManage: false,
      canAdd: false,
      roomSize: 10,
      peerId: "p2",
      expectedPositionMs: 190_000,
      seatedUserIds: [],
    });
    expect(server).toBe(true);
    expect(
      musicWriteAllowed(held, write, {
        userId: "nobody",
        canManage: false,
        canAdd: false,
        roomSize: 10,
        peerId: "p2",
        expectedPositionMs: 190_000,
        seatedUserIds: [],
      }),
    ).toBe(server);
  });
});

describe("filling in a duration nobody asked you to", () => {
  /*
   * THE FILL RULE GUARDED `current` AND LEFT THE QUEUE OPEN.
   *
   * A duration may go from null to a value so the room's own writer can
   * fill in what oEmbed did not carry, and that is restricted to the
   * manager or the person who added the track — for `current`. The
   * queue went through `sameTracks`, which allows exactly that transition
   * for anybody. So a listen-only seat could give a queued track a length
   * of 1 ms, wait for it to become current, and a millisecond later the
   * end-of-track gate is satisfied: the track is taken away from the room
   * with no votes and no rights, by somebody who cannot even speak.
   */
  const mine = track("q1");
  const theirs: MusicTrack = { ...track("q2"), addedByUserId: "u2" };
  const held = state({ queue: [mine, theirs] });
  const seat = {
    userId: "nobody",
    canManage: false,
    canAdd: false,
    roomSize: 4,
  };

  const fill = (index: number, durationMs: number): MusicStateWrite => {
    const queue = [...held.queue];
    queue[index] = { ...(queue[index] as MusicTrack), durationMs };
    return { ...held, queue, rev: 2, actorId: "p9" };
  };

  it("refuses a queued fill from somebody with no claim on the track", () => {
    expect(musicWriteAllowed(held, fill(0, 200_000), seat)).toBe(false);
  });

  it("lets the person who added it fill it", () => {
    expect(
      musicWriteAllowed(held, fill(1, 200_000), { ...seat, userId: "u2" }),
    ).toBe(true);
  });

  it("lets a manager fill any of them", () => {
    expect(
      musicWriteAllowed(held, fill(0, 200_000), { ...seat, canManage: true }),
    ).toBe(true);
  });

  it("still takes an ordinary sample that changes no duration", () => {
    expect(
      musicWriteAllowed(held, { ...held, positionMs: 9_000, rev: 2, actorId: "p9" }, seat),
    ).toBe(true);
  });
});

describe("a vote that carries, with the infinity on", () => {
  /*
   * The room voted the track out and the queue is empty. With "Continuar
   * com parecidas" on, the answer is a related track, not the end of the
   * music — but the server only accepted an autoplayed advance when the
   * track had RUN OUT, so the one write that would have kept the room
   * going was refused and the only thing a client could do was end it.
   */
  const current = { ...(state().current as MusicTrack), durationMs: 200_000 };
  const held = state({ current, queue: [], autoplay: true, skipVotes: ["u2"] });
  const pick: MusicTrack = {
    ...track("related"),
    addedByUserId: "u1",
    autoplayed: true,
  };
  const advanced: MusicStateWrite = {
    ...musicAdvance(held),
    current: pick,
    queue: [],
    status: "playing",
    positionMs: 0,
    atMs: 0,
    rev: 2,
    actorId: "p1",
  };

  it("takes the related pick the votes asked for", () => {
    expect(
      musicWriteAllowed(held, advanced, {
        userId: "u1",
        canManage: false,
        canAdd: true,
        roomSize: 3,
        peerId: "p1",
        expectedPositionMs: 1_000,
        seatedUserIds: ["u1", "u2", "u3"],
      }),
    ).toBe(true);
  });

  it("still refuses it when the votes are not there", () => {
    expect(
      musicWriteAllowed(state({ current, queue: [], autoplay: true }), advanced, {
        userId: "u1",
        canManage: false,
        canAdd: true,
        roomSize: 9,
        peerId: "p1",
        expectedPositionMs: 1_000,
        seatedUserIds: ["u1"],
      }),
    ).toBe(false);
  });
});

