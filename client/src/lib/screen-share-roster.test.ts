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

  // THE VOICE SERVER HAS NO COUNT. It had eight until 2026-09-08, and eight
  // was ours rather than the box's. On the SFU one more camera costs its
  // publisher nothing extra and costs the box egress, so the question is the
  // box's budget and only the server can answer it: the client never greys the
  // button and never invents a number, and a refusal arrives as
  // `camera-denied` with words rather than a count.
  it("never caps a voice-server room, however many cameras are on", () => {
    const many = Array.from({ length: 40 }, (_, at) => `p${at}`);
    expect(isCameraAtCap(many, "me", "livekit")).toBe(false);
    expect(isCameraAtCap(many.slice(0, 8), "me", "livekit")).toBe(false);
  });

  it("still caps mesh at three, which is physics and does not move", () => {
    expect(isCameraAtCap(["a", "b"], "me", "mesh")).toBe(false);
    expect(isCameraAtCap(["a", "b", "c"], "me", "mesh")).toBe(true);
    expect(isCameraAtCap(["a", "b", "c", "d"], "me", "mesh")).toBe(true);
  });
});
