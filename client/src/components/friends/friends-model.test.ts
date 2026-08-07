import { describe, expect, it } from "vitest";
import type { Friend } from "@pqp/shared";
import {
  onlineFriends,
  pendingActionCount,
  sortOnlineFirst,
} from "./friends-model";

function friend(name: string, status: Friend["status"]): Friend {
  return {
    id: `00000000-0000-4000-8000-${name.padEnd(12, "0")}`,
    displayName: name,
    username: name,
    tag: `${name}#0001`,
    avatarUrl: null,
    status,
    friendsSince: "2026-01-01T00:00:00.000Z",
  };
}

describe("onlineFriends", () => {
  it("counts idle and dnd as around, and only offline as gone", () => {
    const everyone = [
      friend("ana", "online"),
      friend("bia", "idle"),
      friend("caio", "dnd"),
      friend("duda", "offline"),
    ];
    expect(onlineFriends(everyone).map((f) => f.displayName)).toEqual([
      "ana",
      "bia",
      "caio",
    ]);
  });

  it("is empty for an empty list", () => {
    expect(onlineFriends([])).toEqual([]);
  });
});

describe("pendingActionCount", () => {
  it("counts only incoming — outgoing is not a call to action", () => {
    const entry = {
      ...friend("ana", "online"),
      requestedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(
      pendingActionCount({ incoming: [entry, entry] }),
    ).toBe(2);
    expect(pendingActionCount({ incoming: [] })).toBe(0);
  });
});

describe("sortOnlineFirst", () => {
  it("floats the reachable half without reordering within it", () => {
    const everyone = [
      friend("ana", "offline"),
      friend("bia", "online"),
      friend("caio", "offline"),
      friend("duda", "idle"),
    ];
    expect(sortOnlineFirst(everyone).map((f) => f.displayName)).toEqual([
      "bia",
      "duda",
      "ana",
      "caio",
    ]);
  });
});
