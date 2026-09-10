import { describe, expect, it } from "vitest";
import {
  RAISED_HAND_LIST_LIMIT,
  raisedHandPosition,
  raisedHandQueue,
} from "./raised-hands.js";

/**
 * The ordering rule, which is the only thing about a raised hand that every
 * screen in the room has to agree on. The timestamps are the server's; this
 * file is what everybody does with them.
 */

function person(userId: string, handRaisedAt: number | null) {
  return { userId, handRaisedAt };
}

describe("raisedHandQueue", () => {
  it("orders by when the hand went up, not by roster order", () => {
    const room = [
      person("carol", 300),
      person("alice", 100),
      person("bob", 200),
    ];
    expect(raisedHandQueue(room).map((p) => p.userId)).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("leaves the hands above alone when somebody else raises or lowers", () => {
    const before = [person("alice", 100), person("bob", 200)];
    const order = raisedHandQueue(before).map((p) => p.userId);

    // A latecomer goes to the back.
    const withLatecomer = [...before, person("dave", 400)];
    expect(raisedHandQueue(withLatecomer).map((p) => p.userId)).toEqual([
      ...order,
      "dave",
    ]);

    // Somebody at the back leaving does not reshuffle the front.
    const afterLower = [person("alice", 100), person("bob", null)];
    expect(raisedHandQueue(afterLower).map((p) => p.userId)).toEqual(["alice"]);

    // And the person who was second moves up rather than sideways.
    const frontLeaves = [person("alice", null), person("bob", 200)];
    expect(raisedHandPosition(frontLeaves, "bob")).toBe(1);
  });

  it("breaks a same-millisecond tie the same way for everyone", () => {
    const one = [person("bob", 100), person("alice", 100)];
    const other = [person("alice", 100), person("bob", 100)];
    expect(raisedHandQueue(one).map((p) => p.userId)).toEqual(
      raisedHandQueue(other).map((p) => p.userId),
    );
    expect(raisedHandQueue(one).map((p) => p.userId)).toEqual([
      "alice",
      "bob",
    ]);
  });

  it("counts a person once however many seats they hold", () => {
    const room = [
      { userId: "alice", handRaisedAt: 100 },
      { userId: "alice", handRaisedAt: 100 },
      { userId: "bob", handRaisedAt: 200 },
    ];
    expect(raisedHandQueue(room)).toHaveLength(2);
    expect(raisedHandPosition(room, "bob")).toBe(2);
  });

  it("treats a missing field as a hand that is down", () => {
    const room = [{ userId: "alice" }, person("bob", 200)];
    expect(raisedHandQueue(room).map((p) => p.userId)).toEqual(["bob"]);
    expect(raisedHandPosition(room, "alice")).toBeNull();
  });

  it("gives a position past the list limit, since that is the whole point", () => {
    const room = Array.from({ length: RAISED_HAND_LIST_LIMIT + 6 }, (_, i) =>
      person(`u${i}`, 100 + i),
    );
    expect(raisedHandPosition(room, `u${RAISED_HAND_LIST_LIMIT + 5}`)).toBe(
      RAISED_HAND_LIST_LIMIT + 6,
    );
  });
});
