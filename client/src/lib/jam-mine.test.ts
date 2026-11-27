import type { JamPublicMyPart } from "@pqp/shared";
import { describe, expect, it } from "vitest";
import { mineIsEmpty, minePartState, orderMineParts, waitingOn } from "./jam-mine";
import { parsePublicJamPath } from "./jam-public-links";

const part = (over: Partial<JamPublicMyPart> = {}): JamPublicMyPart => ({
  trackId: "t1",
  songId: "11111111-1111-4111-8111-111111111111",
  title: "Lua cheia",
  instrument: "guitar",
  state: "waiting",
  startedBy: "Ana",
  sentAt: "2026-11-26T12:00:00.000Z",
  answeredAt: null,
  ...over,
});

describe("what a sent part says about itself (round 3, N-3)", () => {
  it("waiting names who is being waited for, and falls back to the plain words with no name", () => {
    expect(minePartState(part())).toEqual({ key: "jam.mine.state.waiting", name: "Ana" });
    expect(minePartState(part({ startedBy: null }))).toEqual({ key: "jam.mine.state.waitingAnon", name: null });
    expect(minePartState(part({ startedBy: "   " }))).toEqual({ key: "jam.mine.state.waitingAnon", name: null });
  });

  it("in says it is in the song, whoever started it", () => {
    expect(minePartState(part({ state: "in" }))).toEqual({ key: "jam.mine.state.in", name: null });
  });

  it("refused says who did not put it in, or says it without a name", () => {
    expect(minePartState(part({ state: "refused" }))).toEqual({ key: "jam.mine.state.refused", name: "Ana" });
    expect(minePartState(part({ state: "refused", startedBy: null }))).toEqual({ key: "jam.mine.state.refusedAnon", name: null });
  });
});

describe("the order and the empty state", () => {
  it("lists what still waits first, then what went in, then refusals, each in the server's order", () => {
    const parts = [
      part({ trackId: "a", state: "refused" }),
      part({ trackId: "b", state: "in" }),
      part({ trackId: "c", state: "waiting" }),
      part({ trackId: "d", state: "waiting" }),
      part({ trackId: "e", state: "in" }),
    ];
    expect(orderMineParts(parts).map((one) => one.trackId)).toEqual(["c", "d", "b", "e", "a"]);
  });

  it("is empty only when the person started nothing and sent nothing", () => {
    expect(mineIsEmpty([], [])).toBe(true);
    expect(mineIsEmpty([{}], [])).toBe(false);
    expect(mineIsEmpty([], [{}])).toBe(false);
  });

  it("counts the parts waiting on one of the songs they started", () => {
    const inbox = [{ songId: "a" }, { songId: "b" }, { songId: "a" }];
    expect(waitingOn("a", inbox)).toBe(2);
    expect(waitingOn("c", inbox)).toBe(0);
  });
});

describe("its address", () => {
  it("is /app/jam/mine, next to a song's and the start sheet's", () => {
    expect(parsePublicJamPath("/app/jam/mine")).toEqual({ kind: "mine" });
    expect(parsePublicJamPath("/app/jam/mine/")).toEqual({ kind: "mine" });
    expect(parsePublicJamPath("/app/jam/new")).toEqual({ kind: "new" });
    expect(parsePublicJamPath("/app/jam/not-a-song")).toBeNull();
  });
});
