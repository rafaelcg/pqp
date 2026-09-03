import { describe, expect, it } from "vitest";
import { pickServerLandingTarget } from "./landing";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

const channels = [
  { id: "cat", type: "category" as const },
  { id: "geral", type: "text" as const },
  { id: "lobby", type: "voice" as const },
];

describe("pickServerLandingTarget", () => {
  it("opens the first text channel when Baú is off, whatever else is true", () => {
    expect(pickServerLandingTarget(channels, false, true, true)).toEqual({
      kind: "channel",
      id: "geral",
    });
  });

  it("opens the Baú on a community every time", () => {
    expect(pickServerLandingTarget(channels, true, true, false)).toEqual({
      kind: "home",
      id: COMMUNITY_HOME_CHANNEL_ID,
    });
  });

  it("opens the Baú once on a hall nobody has opened it in, then stops", () => {
    // The whole point of the pinned welcome post: a new member meets it.
    expect(pickServerLandingTarget(channels, true, false, true)).toEqual({
      kind: "home",
      id: COMMUNITY_HOME_CHANNEL_ID,
    });
    // Been there: the conversation is what they came back for.
    expect(pickServerLandingTarget(channels, true, false, false)).toEqual({
      kind: "channel",
      id: "geral",
    });
  });

  it("falls back to any non-category channel, and to nothing at all", () => {
    expect(
      pickServerLandingTarget([{ id: "lobby", type: "voice" }], false),
    ).toEqual({ kind: "channel", id: "lobby" });
    expect(pickServerLandingTarget([{ id: "cat", type: "category" }], false)).toBeNull();
  });
});
