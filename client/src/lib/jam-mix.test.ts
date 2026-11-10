import { describe, expect, it } from "vitest";
import { takesToTakeOut, takeToReplace } from "./jam-mix";
import { track } from "./jam-test-fixtures";

const a = track({ id: "a", instrument: "guitar", inMix: true, authorId: "me" });
const b = track({ id: "b", instrument: "guitar", inMix: false, authorId: "you" });
const c = track({ id: "c", instrument: "guitar", inMix: true, authorId: "you" });
const bass = track({ id: "d", instrument: "bass", inMix: true, authorId: "me" });

describe("using a take", () => {
  it("takes out every other in-mix take of its instrument, and nothing else", () => {
    expect(takesToTakeOut([a, b, c, bass], "b")).toEqual(["a", "c"]);
  });

  it("takes out nothing when it is the only one in", () => {
    expect(takesToTakeOut([a, b, bass], "a")).toEqual([]);
  });

  it("knows nothing about a take that is not there", () => {
    expect(takesToTakeOut([a], "zzz")).toEqual([]);
  });
});

describe("the take a new recording would replace", () => {
  it("is the poster's own in-mix take of the same instrument", () => {
    expect(takeToReplace([a, b, bass], { instrument: "guitar", viewerId: "me", canSwitchMix: true })?.id).toBe("a");
  });

  it("is nobody's when the poster may not switch the mix", () => {
    expect(takeToReplace([a], { instrument: "guitar", viewerId: "me", canSwitchMix: false })).toBeNull();
  });

  it("is not somebody else's take, nor one that is already out", () => {
    expect(takeToReplace([b, c], { instrument: "guitar", viewerId: "me", canSwitchMix: true })).toBeNull();
    expect(
      takeToReplace([track({ id: "x", instrument: "guitar", inMix: false, authorId: "me" })], {
        instrument: "guitar",
        viewerId: "me",
        canSwitchMix: true,
      }),
    ).toBeNull();
  });

  it("is nobody's for another instrument", () => {
    expect(takeToReplace([a], { instrument: "bass", viewerId: "me", canSwitchMix: true })).toBeNull();
  });
});
