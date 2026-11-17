import { describe, expect, it } from "vitest";
import { oneAtATime, replaceInMix, switchTakeIn, takesToTakeOut, takeToReplace } from "./jam-mix";
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

/**
 * A server for the mix: it holds who is in, applies a write, and can lose the
 * REPLY of a write (applied but thrown), or refuse it (not applied, thrown).
 */
function fakeServer(initial: Record<string, boolean>, script: Array<"ok" | "lost" | "refused"> = []) {
  const inMix = new Map(Object.entries(initial));
  const calls: Array<[string, boolean]> = [];
  const put = async (id: string, value: boolean) => {
    calls.push([id, value]);
    const mode = script.shift() ?? "ok";
    if (mode === "refused") {
      throw new Error("refused");
    }
    inMix.set(id, value);
    if (mode === "lost") {
      throw new Error("reply lost");
    }
  };
  const reread = async () =>
    [...inMix].map(([id, on]) => track({ id, instrument: "guitar", inMix: on, authorId: "me" }));
  return { inMix, calls, put, reread };
}

describe("a new take replacing the old one", () => {
  it("is new in, old out, and reads nothing when nothing went wrong", async () => {
    const s = fakeServer({ old: true, new: false });
    let reads = 0;
    const outcome = await replaceInMix("new", "old", s.put, async () => (reads++, s.reread()));
    expect(outcome).toBe("replaced");
    expect(s.calls).toEqual([["new", true], ["old", false]]);
    expect(reads).toBe(0);
  });

  it("believes a write whose reply was lost only after reading the mix: new in landed, so old goes out", async () => {
    const s = fakeServer({ old: true, new: false }, ["lost"]);
    expect(await replaceInMix("new", "old", s.put, s.reread)).toBe("replaced");
    expect([s.inMix.get("new"), s.inMix.get("old")]).toEqual([true, false]);
    // the new take was not written twice
    expect(s.calls.filter(([id]) => id === "new")).toHaveLength(1);
  });

  it("does not undo the new take when the old take-out landed but its reply was lost (never neither in)", async () => {
    const s = fakeServer({ old: true, new: false }, ["ok", "lost"]);
    expect(await replaceInMix("new", "old", s.put, s.reread)).toBe("replaced");
    expect([s.inMix.get("new"), s.inMix.get("old")]).toEqual([true, false]);
  });

  it("tries the first write again when it was refused, and a take-out that was refused", async () => {
    const s = fakeServer({ old: true, new: false }, ["refused", "ok", "refused", "ok"]);
    expect(await replaceInMix("new", "old", s.put, s.reread)).toBe("replaced");
  });

  it("puts the new take back out when the old one will not leave: never both in the mix", async () => {
    const s = fakeServer({ old: true, new: false });
    const refuseOld = async (id: string, value: boolean) => {
      if (id === "old") {
        s.calls.push([id, value]);
        throw new Error("down");
      }
      return s.put(id, value);
    };
    expect(await replaceInMix("new", "old", refuseOld, s.reread)).toBe("kept-old");
    expect([s.inMix.get("new"), s.inMix.get("old")]).toEqual([false, true]);
  });

  it("says both when the mix cannot be read, and does not guess", async () => {
    const s = fakeServer({ old: true, new: false }, ["refused"]);
    expect(await replaceInMix("new", "old", s.put, async () => null)).toBe("both");
  });
});

describe("switching the mix", () => {
  it("takes the others out together, from what is known after the first write", async () => {
    const known = [a, b, c, bass];
    const calls: Array<[string, boolean]> = [];
    const outcome = await switchTakeIn(
      "b",
      async (id, inMix) => void calls.push([id, inMix]),
      () => [...known, track({ id: "late", instrument: "guitar", inMix: true, authorId: "you" })],
      async () => null,
    );
    expect(outcome).toBe("swapped");
    expect(calls[0]).toEqual(["b", true]);
    expect(calls.slice(1).map(([id]) => id).sort()).toEqual(["a", "c", "late"]);
  });

  it("is swapped when a take-out landed but its reply was lost", async () => {
    const s = fakeServer({ a: true, b: false, c: true }, ["ok", "lost", "ok"]);
    const outcome = await switchTakeIn("b", s.put, () => [a, b, c], s.reread);
    expect(outcome).toBe("swapped");
    expect(s.inMix.get("a")).toBe(false);
    expect(s.inMix.get("c")).toBe(false);
  });

  it("retries a refused take-out once, and says partial only for what is still in", async () => {
    const s = fakeServer({ a: true, b: false, c: true }, ["ok", "refused", "ok", "refused"]);
    const outcome = await switchTakeIn("b", s.put, () => [a, b, c], s.reread);
    expect(outcome).toBe("partial");
    expect(s.inMix.get("a")).toBe(true); // refused twice
    expect(s.inMix.get("c")).toBe(false);
  });

  it("goes on when the first write landed with a lost reply, and stops when it did not", async () => {
    const landed = fakeServer({ a: true, b: false }, ["lost"]);
    expect(await switchTakeIn("b", landed.put, () => [a, b], landed.reread)).toBe("swapped");
    const refused = fakeServer({ a: true, b: false }, ["refused"]);
    await expect(switchTakeIn("b", refused.put, () => [a, b], refused.reread)).rejects.toThrow("refused");
    expect(refused.inMix.get("a")).toBe(true);
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
    expect(await serial(async () => "third")).toBe("third");
  });
});

