import { describe, expect, it } from "vitest";
import { oneAtATime, switchTakeIn, takesToTakeOut, takeToReplace } from "./jam-mix";
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

describe("switching the mix", () => {
  it("takes the others out together, from what is known after the first write", async () => {
    let known = [a, b, c, bass];
    const calls: Array<[string, boolean]> = [];
    const put = async (id: string, inMix: boolean) => {
      calls.push([id, inMix]);
      if (id === "b") {
        // a frame that arrived while the write was out: a third take went in meanwhile
        known = [...known, track({ id: "late", instrument: "guitar", inMix: true, authorId: "you" })];
      }
    };
    const outcome = await switchTakeIn("b", put, () => known);
    expect(outcome).toBe("swapped");
    expect(calls[0]).toEqual(["b", true]);
    expect(calls.slice(1).map(([id]) => id).sort()).toEqual(["a", "c", "late"]);
    expect(calls.slice(1).every(([, inMix]) => inMix === false)).toBe(true);
  });

  it("says partial when one take-out fails, and still tries the rest", async () => {
    const tried: string[] = [];
    const outcome = await switchTakeIn(
      "b",
      async (id) => {
        tried.push(id);
        if (id === "a") {
          throw new Error("no");
        }
      },
      () => [a, b, c],
    );
    expect(outcome).toBe("partial");
    expect(tried).toContain("c");
  });

  it("lets only one change run at a time: a second tap while one is out does nothing", async () => {
    const serial = oneAtATime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let ran = 0;
    const first = serial(async () => {
      ran += 1;
      await gate;
      return "first";
    });
    const second = await serial(async () => {
      ran += 1;
      return "second";
    });
    expect(second).toBeUndefined();
    release();
    expect(await first).toBe("first");
    expect(ran).toBe(1);
    // and it is free again afterwards
    expect(await serial(async () => "third")).toBe("third");
  });
});
