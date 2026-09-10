import { describe, expect, it } from "vitest";
import { pickServerLandingTarget } from "./landing";
import { COMMUNITY_HOME_CHANNEL_ID } from "./id";

const channels = [
  { id: "cat", type: "category" as const },
  { id: "geral", type: "text" as const },
  { id: "lobby", type: "voice" as const },
];

describe("pickServerLandingTarget", () => {
  it("opens the first text channel when Baú is off", () => {
    expect(pickServerLandingTarget(channels, false)).toEqual({
      kind: "channel",
      id: "geral",
    });
  });

  it("opens the Baú whenever it is on, community or hall, first visit or not", () => {
    expect(pickServerLandingTarget(channels, true)).toEqual({
      kind: "home",
      id: COMMUNITY_HOME_CHANNEL_ID,
    });
  });

  it("falls back to any non-category channel, and to nothing at all", () => {
    expect(
      pickServerLandingTarget([{ id: "lobby", type: "voice" }], false),
    ).toEqual({ kind: "channel", id: "lobby" });
    expect(pickServerLandingTarget([{ id: "cat", type: "category" }], false)).toBeNull();
  });
});
