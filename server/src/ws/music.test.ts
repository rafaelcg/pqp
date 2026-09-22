import { beforeEach, describe, expect, it } from "vitest";
import {
  MUSIC_POSITION_TOLERANCE_MS,
  musicAdvance,
  type MusicState,
} from "@pqp/shared";
import {
  adoptMusicState,
  adoptMusicWithAnchor,
  applyMusicWrite,
  endMusic,
  getMusicState,
  musicExpectedPositionMs,
  resetMusicForTests,
} from "./music.js";

const ROOM = "11111111-1111-4111-8111-111111111111";
const MANAGER = { userId: "u1", canManage: true, canAdd: true, roomSize: 4 };
const MEMBER = { userId: "u2", canManage: false, canAdd: true, roomSize: 4 };

const state = (overrides: Partial<MusicState> = {}): MusicState => ({
  current: {
    id: "t1",
    provider: "youtube",
    videoId: "dQw4w9WgXcQ",
    title: "Track",
    sourceUrl: null,
    thumbnailUrl: null,
    durationMs: null,
    addedByUserId: "u1",
    addedByName: "Ana",
  },
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

describe("applyMusicWrite", () => {
  beforeEach(() => resetMusicForTests());

  it("adopts a first write and hands a loser the held state", () => {
    expect(applyMusicWrite(ROOM, state({ rev: 3 }), MANAGER)).toEqual({
      kind: "accepted",
      state: state({ rev: 3 }),
    });
    const lost = applyMusicWrite(ROOM, state({ rev: 2 }), {
      userId: "u2",
      canManage: true,
      canAdd: true,
      roomSize: 4,
    });
    expect(lost.kind).toBe("stale");
    expect(getMusicState(ROOM)?.rev).toBe(3);
  });

  it("never drops a pause, even past the budget", () => {
    applyMusicWrite(ROOM, state({ rev: 1 }), MANAGER);
    let coalesced = 0;
    for (let rev = 2; rev < 40; rev++) {
      const write = applyMusicWrite(ROOM, state({ rev, positionMs: rev }), MANAGER);
      if (write.kind === "coalesced") {
        coalesced += 1;
      }
    }
    expect(coalesced).toBeGreaterThan(0);
    // The coalesced position is still what a joiner is handed.
    expect(getMusicState(ROOM)?.positionMs).toBe(39);
    const pause = applyMusicWrite(ROOM, state({ rev: 40, status: "paused" }), MANAGER);
    expect(pause.kind).toBe("accepted");
  });

  it("null tears the queue down", () => {
    applyMusicWrite(ROOM, state(), MANAGER);
    expect(applyMusicWrite(ROOM, null, MANAGER)).toEqual({
      kind: "accepted",
      state: null,
    });
    expect(getMusicState(ROOM)).toBeNull();
    expect(endMusic(ROOM)).toBe(false);
  });

  it("refuses a skip from somebody without MANAGE_MUSIC and hands the held state back", () => {
    applyMusicWrite(ROOM, state({ rev: 1 }), MANAGER);
    const skip = applyMusicWrite(ROOM, state({ rev: 2, current: null, actorId: "p2" }), MEMBER);
    expect(skip).toEqual({ kind: "refused", held: state({ rev: 1 }) });
    expect(getMusicState(ROOM)?.rev).toBe(1);
  });

  it("lets anybody who can speak append their own song", () => {
    applyMusicWrite(ROOM, state({ rev: 1 }), MANAGER);
    const mine = { ...state().current!, id: "t2", addedByUserId: "u2" };
    const write = applyMusicWrite(ROOM, state({ rev: 2, actorId: "p2", queue: [mine] }), MEMBER);
    expect(write.kind).toBe("accepted");
  });

  it("treats openControls as a manager promotion for a speaker", () => {
    applyMusicWrite(ROOM, state({ rev: 1, openControls: true }), MANAGER);
    const skip = applyMusicWrite(
      ROOM,
      state({ rev: 2, current: null, actorId: "p2", openControls: true }),
      MEMBER,
    );
    expect(skip.kind).toBe("accepted");
  });

  it("never coalesces a skip vote", () => {
    applyMusicWrite(ROOM, state({ rev: 1 }), MANAGER);
    for (let rev = 2; rev < 40; rev++) {
      applyMusicWrite(ROOM, state({ rev, positionMs: rev }), MANAGER);
    }
    const vote = applyMusicWrite(
      ROOM,
      state({ rev: 40, actorId: "p2", skipVotes: ["u2"] }),
      MEMBER,
    );
    expect(vote.kind).toBe("accepted");
    expect(getMusicState(ROOM)?.skipVotes).toEqual(["u2"]);
  });

  it("fills omitted fields from the held state so an old writer cannot wipe them", () => {
    const held = state({
      rev: 1,
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [state().current!],
    });
    applyMusicWrite(ROOM, held, MANAGER);
    const write = applyMusicWrite(
      ROOM,
      {
        current: held.current,
        queue: [],
        status: "playing",
        positionMs: 4_000,
        atMs: 0,
        rev: 2,
        actorId: "p1",
      },
      MANAGER,
    );
    expect(write.kind).toBe("accepted");
    expect(getMusicState(ROOM)).toMatchObject({
      positionMs: 4_000,
      openControls: true,
      repeat: "all",
      skipVotes: ["u3"],
      history: [state().current!],
    });
  });

  it("passes roomSize through so a vote can advance at the threshold", () => {
    const held = state({ rev: 1, skipVotes: ["u3"] });
    applyMusicWrite(ROOM, held, MANAGER);
    const next = { ...state({ ...musicAdvance(held), rev: 2 }), actorId: "p2" };
    const refused = applyMusicWrite(ROOM, next, { ...MEMBER, roomSize: 5 });
    expect(refused.kind).toBe("refused");
    const allowed = applyMusicWrite(ROOM, next, { ...MEMBER, roomSize: 4 });
    expect(allowed.kind).toBe("accepted");
  });
});

/*
 * The scenario the protocol agent reproduced over real sockets: six seats,
 * threshold three. One person votes and leaves, a second votes, a third
 * sends the advance. Two live voters must not clear a threshold sized for
 * the room they are in.
 */
describe("a skip vote from somebody who left", () => {
  beforeEach(() => resetMusicForTests());

  const playing = state({
    current: {
      id: "t1",
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      title: "Track",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 200_000,
      addedByUserId: "u1",
      addedByName: "Ana",
    },
    queue: [
      {
        id: "t2",
        provider: "youtube",
        videoId: "aaaaaaaaaaa",
        title: "Next",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 200_000,
        addedByUserId: "u1",
        addedByName: "Ana",
      },
    ],
    positionMs: 1_000,
  });

  it("does not count towards the threshold", () => {
    applyMusicWrite(ROOM, { ...playing, skipVotes: ["gone", "u3"] }, MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    const advance = { ...musicAdvance(held), rev: held.rev + 1, actorId: "p4", atMs: 0 };
    const refused = applyMusicWrite(ROOM, advance, {
      userId: "u4",
      canManage: false,
      canAdd: true,
      roomSize: 5,
      seatedUserIds: ["u1", "u2", "u3", "u4", "u5"],
    });
    expect(refused.kind).toBe("refused");
    expect(getMusicState(ROOM)?.current?.id).toBe("t1");
  });

  it("still advances once enough seated people have voted", () => {
    applyMusicWrite(ROOM, { ...playing, skipVotes: ["u2", "u3"] }, MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    const advance = { ...musicAdvance(held), rev: held.rev + 1, actorId: "p4", atMs: 0 };
    const accepted = applyMusicWrite(ROOM, advance, {
      userId: "u4",
      canManage: false,
      canAdd: true,
      roomSize: 5,
      seatedUserIds: ["u1", "u2", "u3", "u4", "u5"],
    });
    expect(accepted.kind).toBe("accepted");
    expect(getMusicState(ROOM)?.current?.id).toBe("t2");
  });
});

/*
 * The room's clock belongs to the server. A sample from somebody who is not
 * running the music may not move it forward past the tolerance, because the
 * end-of-track gate reads it and every client seeks to it.
 */
describe("the server's own clock for the room", () => {
  beforeEach(() => resetMusicForTests());

  const playing = (durationMs: number | null = 200_000) =>
    state({
      current: {
        id: "t1",
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        title: "Track",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs,
        addedByUserId: "u1",
        addedByName: "Ana",
      },
      queue: [],
      positionMs: 0,
    });

  const LISTENER = {
    userId: "u9",
    canManage: false,
    canAdd: false,
    roomSize: 3,
  };

  it("starts at zero when a track starts, and runs while it plays", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const now = Date.now();
    expect(musicExpectedPositionMs(ROOM, now)).toBe(0);
    expect(musicExpectedPositionMs(ROOM, now + 5_000)).toBe(5_000);
  });

  it("clamps a sample from somebody who is not running the music", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    const write = applyMusicWrite(
      ROOM,
      { ...held, positionMs: 3_000_000, rev: held.rev + 1, actorId: "p9" },
      LISTENER,
    );
    expect(write.kind).toBe("accepted");
    const after = getMusicState(ROOM) as MusicState;
    expect(after.positionMs).toBeLessThanOrEqual(MUSIC_POSITION_TOLERANCE_MS);
  });

  it("keeps the append that rode on the clamped write", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    const mine = {
      id: "t2",
      provider: "youtube" as const,
      videoId: "aaaaaaaaaaa",
      title: "Mine",
      sourceUrl: null,
      thumbnailUrl: null,
      durationMs: 120_000,
      addedByUserId: "u2",
      addedByName: "Bia",
    };
    const write = applyMusicWrite(
      ROOM,
      {
        ...held,
        queue: [mine],
        positionMs: 3_000_000,
        rev: held.rev + 1,
        actorId: "p2",
      },
      { userId: "u2", canManage: false, canAdd: true, roomSize: 3 },
    );
    expect(write.kind).toBe("accepted");
    const after = getMusicState(ROOM) as MusicState;
    expect(after.queue.map((track) => track.id)).toEqual(["t2"]);
    expect(after.positionMs).toBeLessThanOrEqual(MUSIC_POSITION_TOLERANCE_MS);
  });

  it("takes a manager's seek as the truth", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    applyMusicWrite(
      ROOM,
      { ...held, positionMs: 150_000, rev: held.rev + 1, actorId: "p1" },
      MANAGER,
    );
    const now = Date.now();
    expect(musicExpectedPositionMs(ROOM, now)).toBeGreaterThanOrEqual(150_000);
    expect(musicExpectedPositionMs(ROOM, now)).toBeLessThan(151_000);
  });

  /*
   * THE CLAMP BOUNDS ONE WRITE. THE ANCHOR IS WHAT IT IS BOUNDED AGAINST.
   *
   * 0.2(a) says the anchor moves for a manager's write and for a structural
   * change of CURRENT or STATUS, and for nothing else. An append is
   * structural in the sense the write limiter means (it must not be
   * coalesced), and moving the clock for it hands a member the creep the
   * clamp exists to stop: each append lands a tolerance ahead, the anchor
   * follows it there, and the next one starts from the new reading. Twenty
   * of them in a millisecond walk a 200 s track to its end, and the
   * end-of-track gate then opens for somebody holding no votes.
   */
  it("does not let a member's own appends walk the room's clock", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const now = Date.now();
    for (let i = 0; i < 20; i += 1) {
      const held = getMusicState(ROOM) as MusicState;
      const expected = musicExpectedPositionMs(ROOM, now) ?? 0;
      const write = applyMusicWrite(
        ROOM,
        {
          ...held,
          // One track on, one off: structural every time, and always the
          // member's own, so the rights check never refuses it.
          queue: i % 2 === 0
            ? [
                {
                  id: `q${i}`,
                  provider: "youtube" as const,
                  videoId: "aaaaaaaaaaa",
                  title: "Mine",
                  sourceUrl: null,
                  thumbnailUrl: null,
                  durationMs: 120_000,
                  addedByUserId: "u2",
                  addedByName: "Bia",
                },
              ]
            : [],
          positionMs: expected + MUSIC_POSITION_TOLERANCE_MS - 1,
          rev: held.rev + 1,
          actorId: "p2",
        },
        MEMBER,
      );
      expect(write.kind).toBe("accepted");
    }
    // The track has been on for a millisecond, whatever the samples said.
    expect(musicExpectedPositionMs(ROOM, now)).toBeLessThan(
      MUSIC_POSITION_TOLERANCE_MS,
    );
  });

  it("keeps the end-of-track gate shut while the track is still playing", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const now = Date.now();
    for (let i = 0; i < 40; i += 1) {
      const held = getMusicState(ROOM) as MusicState;
      const expected = musicExpectedPositionMs(ROOM, now) ?? 0;
      applyMusicWrite(
        ROOM,
        {
          ...held,
          queue: i % 2 === 0
            ? [
                {
                  id: `q${i}`,
                  provider: "youtube" as const,
                  videoId: "aaaaaaaaaaa",
                  title: "Mine",
                  sourceUrl: null,
                  thumbnailUrl: null,
                  durationMs: 120_000,
                  addedByUserId: "u2",
                  addedByName: "Bia",
                },
              ]
            : [],
          positionMs: expected + MUSIC_POSITION_TOLERANCE_MS - 1,
          rev: held.rev + 1,
          actorId: "p2",
        },
        MEMBER,
      );
    }
    const held = getMusicState(ROOM) as MusicState;
    const advanced = musicAdvance(held);
    const write = applyMusicWrite(
      ROOM,
      { ...advanced, atMs: 0, rev: held.rev + 1, actorId: "p2" },
      MEMBER,
    );
    expect(write.kind).toBe("refused");
  });

  /*
   * The same rule on the receiving side. A member's append accepted on the
   * other instance arrives here as an absolute state; if this machine
   * moved its clock to the sample that rode on it, the creep would simply
   * cross the bus.
   */
  it("does not move the clock for an append adopted from another instance", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const now = Date.now();
    const held = getMusicState(ROOM) as MusicState;
    adoptMusicState(ROOM, {
      ...held,
      queue: [
        {
          id: "t2",
          provider: "youtube",
          videoId: "aaaaaaaaaaa",
          title: "Mine",
          sourceUrl: null,
          thumbnailUrl: null,
          durationMs: 120_000,
          addedByUserId: "u2",
          addedByName: "Bia",
        },
      ],
      positionMs: 190_000,
      rev: held.rev + 1,
      actorId: "p2",
    });
    expect(musicExpectedPositionMs(ROOM, now)).toBeLessThan(
      MUSIC_POSITION_TOLERANCE_MS,
    );
  });

  it("still starts the clock over for a new track from another instance", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    applyMusicWrite(
      ROOM,
      { ...held, positionMs: 150_000, rev: held.rev + 1, actorId: "p1" },
      MANAGER,
    );
    const seeked = getMusicState(ROOM) as MusicState;
    adoptMusicState(ROOM, {
      ...seeked,
      current: {
        id: "t9",
        provider: "youtube",
        videoId: "bbbbbbbbbbb",
        title: "Next",
        sourceUrl: null,
        thumbnailUrl: null,
        durationMs: 200_000,
        addedByUserId: "u2",
        addedByName: "Bia",
      },
      positionMs: 0,
      rev: seeked.rev + 1,
      actorId: "p2",
    });
    expect(musicExpectedPositionMs(ROOM, Date.now())).toBeLessThan(1_000);
  });

  /*
   * THE CLOCK COMES WITH THE QUEUE, AND ONLY WITH IT.
   *
   * A row or a frame this instance refuses carries the clock that belongs
   * to the queue it refused. Adopting that clock beside a queue we kept
   * rolls the room back by whatever the refused write was worth, and every
   * honest sample afterwards is clamped to the older reading and broadcast.
   */
  it("keeps its own clock when it refuses the row's queue", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    applyMusicWrite(
      ROOM,
      { ...held, positionMs: 150_000, rev: held.rev + 1, actorId: "p1" },
      MANAGER,
    );
    const now = Date.now();
    const adopted = adoptMusicWithAnchor(
      ROOM,
      // Two revs behind: the row this instance has already moved past.
      { ...held, positionMs: 0, rev: 1, actorId: "p0" },
      { positionMs: 0, at: now },
    );
    expect(adopted).toBe(false);
    expect(musicExpectedPositionMs(ROOM, now)).toBeGreaterThanOrEqual(150_000);
  });

  it("takes the clock when it takes the queue", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    const now = Date.now();
    const adopted = adoptMusicWithAnchor(
      ROOM,
      { ...held, positionMs: 150_000, rev: held.rev + 1, actorId: "p9" },
      { positionMs: 150_000, at: now },
    );
    expect(adopted).toBe(true);
    expect(musicExpectedPositionMs(ROOM, now)).toBe(150_000);
  });

  it("accepts a sample that is behind, because a slow player never runs ahead", () => {
    applyMusicWrite(ROOM, playing(), MANAGER);
    const held = getMusicState(ROOM) as MusicState;
    applyMusicWrite(
      ROOM,
      { ...held, positionMs: 100_000, rev: held.rev + 1, actorId: "p1" },
      MANAGER,
    );
    const seeked = getMusicState(ROOM) as MusicState;
    applyMusicWrite(
      ROOM,
      { ...seeked, positionMs: 90_000, rev: seeked.rev + 1, actorId: "p9" },
      LISTENER,
    );
    expect((getMusicState(ROOM) as MusicState).positionMs).toBe(90_000);
  });
});
