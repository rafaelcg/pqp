import { describe, expect, it } from "vitest";
import {
  audibleScreenPeerIds,
  isCameraAtCap,
  isScreenShareAtCap,
  videoLimitOf,
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

  // THE VOICE SERVER HAS NO SHARE COUNT EITHER, since 2026-09-08. Four was
  // Zoom's number, not this box's; the box is priced instead
  // (`decideVideoAdmission`), and a refusal arrives in words.
  it("never caps a voice-server room, however many shares are up", () => {
    const many = Array.from({ length: 20 }, (_, at) => `p${at}`);
    expect(isScreenShareAtCap(["a", "b", "c", "d"], "me", "livekit")).toBe(
      false,
    );
    expect(isScreenShareAtCap(many, "me", "livekit")).toBe(false);
  });

  it("uses the measured link on mesh, not the constant", () => {
    // Three people on fibre: the constant said two, the link says more.
    expect(
      isScreenShareAtCap(["a", "b"], "me", "mesh", false, {
        roomSize: 3,
        uplinkBps: 16_000_000,
      }),
    ).toBe(false);
    // Five people on 2 Mbit/s: one share is already four copies.
    expect(
      isScreenShareAtCap(["a"], "me", "mesh", false, {
        roomSize: 5,
        uplinkBps: 2_000_000,
      }),
    ).toBe(true);
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

  it("still caps mesh at three when nothing has been measured", () => {
    expect(isCameraAtCap(["a", "b"], "me", "mesh")).toBe(false);
    expect(isCameraAtCap(["a", "b", "c"], "me", "mesh")).toBe(true);
    expect(isCameraAtCap(["a", "b", "c", "d"], "me", "mesh")).toBe(true);
  });

  it("moves that mesh cap in both directions once the link is measured", () => {
    const fibre = { roomSize: 3, uplinkBps: 16_000_000 };
    const weak = { roomSize: 5, uplinkBps: 2_000_000 };
    expect(isCameraAtCap(["a", "b", "c"], "me", "mesh", false, fibre)).toBe(
      false,
    );
    expect(isCameraAtCap(["a"], "me", "mesh", false, weak)).toBe(true);
  });
});

describe("videoLimitOf", () => {
  it("has no number to show on the voice server", () => {
    const state = {
      remotePeers: [1, 2, 3],
      uplinkBps: null,
      roomTransport: "livekit" as const,
    };
    expect(videoLimitOf(state, "screens")).toBeNull();
    expect(videoLimitOf(state, "cameras")).toBeNull();
  });

  it("counts ourselves into the room size", () => {
    // Two remote peers is a room of three, which is two viewers per copy.
    const state = {
      remotePeers: [1, 2],
      uplinkBps: 2_000_000,
      roomTransport: "mesh" as const,
    };
    expect(videoLimitOf(state, "screens")).toBe(1);
    expect(
      videoLimitOf({ ...state, uplinkBps: 16_000_000 }, "screens"),
    ).toBeGreaterThan(1);
  });
});
