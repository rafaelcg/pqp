import { beforeEach, describe, expect, it } from "vitest";
import { musicAdvance, type MusicState } from "@pqp/shared";
import {
  applyMusicWrite,
  endMusic,
  getMusicState,
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
