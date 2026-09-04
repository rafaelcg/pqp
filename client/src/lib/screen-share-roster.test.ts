import { describe, expect, it } from "vitest";
import {
  audibleScreenPeerIds,
  isCameraAtCap,
  isScreenShareAtCap,
  nextScreenShareFocus,
} from "./screen-share-roster";

describe("nextScreenShareFocus", () => {
  it("picks the first roster id when joining a room that already has shares", () => {
    expect(nextScreenShareFocus([], ["a", "b"], null)).toBe("a");
  });

  it("focuses the newest id that appeared in this snapshot", () => {
    expect(nextScreenShareFocus(["a"], ["a", "b"], "a")).toBe("b");
  });

  it("falls back to the last remaining id when the focused person stops or leaves", () => {
    expect(nextScreenShareFocus(["a", "b"], ["a"], "b")).toBe("a");
    expect(nextScreenShareFocus(["a"], [], "a")).toBeNull();
  });

  it("keeps the current focus when the set did not gain or lose them", () => {
    expect(nextScreenShareFocus(["a", "b"], ["a", "b"], "a")).toBe("a");
  });
});

describe("audibleScreenPeerIds", () => {
  it("plays both when two people are sharing", () => {
    expect(audibleScreenPeerIds(["a", "b"], "a")).toEqual(["a", "b"]);
  });

  it("plays only the focused share once there are three or more", () => {
    expect(audibleScreenPeerIds(["a", "b", "c"], "b")).toEqual(["b"]);
  });
});

describe("isScreenShareAtCap", () => {
  it("uses the mesh cap of two, ignoring our own share", () => {
    expect(isScreenShareAtCap(["me", "them"], "me", "mesh")).toBe(false);
    expect(isScreenShareAtCap(["a", "b"], "me", "mesh")).toBe(true);
  });

  it("uses the LiveKit cap of four", () => {
    expect(isScreenShareAtCap(["a", "b", "c"], "me", "livekit")).toBe(false);
    expect(isScreenShareAtCap(["a", "b", "c", "d"], "me", "livekit")).toBe(true);
  });
});

describe("isCameraAtCap", () => {
  it("uses the mesh cap of three, ignoring our own camera", () => {
    expect(isCameraAtCap(["me", "a", "b"], "me", "mesh")).toBe(false);
    expect(isCameraAtCap(["a", "b", "c"], "me", "mesh")).toBe(true);
  });

  it("uses the LiveKit cap of eight", () => {
    const seven = ["a", "b", "c", "d", "e", "f", "g"];
    expect(isCameraAtCap(seven, "me", "livekit")).toBe(false);
    expect(isCameraAtCap([...seven, "h"], "me", "livekit")).toBe(true);
  });
});
