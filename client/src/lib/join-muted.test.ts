import { describe, expect, it } from "vitest";
import { LARGE_ROOM_JOIN_MUTED_THRESHOLD, shouldJoinMuted } from "./join-muted";

describe("shouldJoinMuted", () => {
  it("honours the user's mute-on-join preference in any room", () => {
    expect(shouldJoinMuted(true, 0)).toBe(true);
    expect(shouldJoinMuted(true, 3)).toBe(true);
  });

  it("joins a small room with the mic open when the preference is off", () => {
    expect(shouldJoinMuted(false, 0)).toBe(false);
    expect(shouldJoinMuted(false, LARGE_ROOM_JOIN_MUTED_THRESHOLD - 1)).toBe(false);
  });

  it("joins a crowded room muted even when the preference is off", () => {
    expect(shouldJoinMuted(false, LARGE_ROOM_JOIN_MUTED_THRESHOLD)).toBe(true);
    expect(shouldJoinMuted(false, 100)).toBe(true);
  });
});
