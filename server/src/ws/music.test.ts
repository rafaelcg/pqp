import { beforeEach, describe, expect, it } from "vitest";
import type { MusicState } from "@pqp/shared";
import {
  applyMusicWrite,
  endMusic,
  getMusicState,
  resetMusicForTests,
} from "./music.js";

const ROOM = "11111111-1111-4111-8111-111111111111";

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
  ...overrides,
});

describe("applyMusicWrite", () => {
  beforeEach(() => resetMusicForTests());

  it("adopts a first write and hands a loser the held state", () => {
    expect(applyMusicWrite(ROOM, state({ rev: 3 }), "u1")).toEqual({
      kind: "accepted",
      state: state({ rev: 3 }),
    });
    const lost = applyMusicWrite(ROOM, state({ rev: 2 }), "u2");
    expect(lost.kind).toBe("stale");
    expect(getMusicState(ROOM)?.rev).toBe(3);
  });

  it("never drops a pause, even past the budget", () => {
    applyMusicWrite(ROOM, state({ rev: 1 }), "u1");
    let coalesced = 0;
    for (let rev = 2; rev < 40; rev++) {
      const write = applyMusicWrite(ROOM, state({ rev, positionMs: rev }), "u1");
      if (write.kind === "coalesced") {
        coalesced += 1;
      }
    }
    expect(coalesced).toBeGreaterThan(0);
    // The coalesced position is still what a joiner is handed.
    expect(getMusicState(ROOM)?.positionMs).toBe(39);
    const pause = applyMusicWrite(ROOM, state({ rev: 40, status: "paused" }), "u1");
    expect(pause.kind).toBe("accepted");
  });

  it("null tears the queue down", () => {
    applyMusicWrite(ROOM, state(), "u1");
    expect(applyMusicWrite(ROOM, null, "u1")).toEqual({
      kind: "accepted",
      state: null,
    });
    expect(getMusicState(ROOM)).toBeNull();
    expect(endMusic(ROOM)).toBe(false);
  });
});
