import { describe, expect, it } from "vitest";
import {
  callStartKey,
  callStartedAt,
  cameraSoloId,
  formatCallDuration,
  hasWatchableVideo,
  isCameraSoloId,
  isStageCollapsed,
  markCallStarted,
  nearestCorner,
  personKeyFromCameraSoloId,
  rememberStageCollapsed,
  rememberStagePinnedKey,
  shouldShowExpandedStage,
  stagePinnedKey,
} from "./call-stage-state";

describe("hasWatchableVideo", () => {
  it("is false for a voice-only room", () => {
    expect(
      hasWatchableVideo({
        localCameraOn: false,
        remoteHasCamera: false,
        screenShareCount: 0,
      }),
    ).toBe(false);
  });

  it("is true for a local camera, a remote camera, or a share", () => {
    expect(
      hasWatchableVideo({
        localCameraOn: true,
        remoteHasCamera: false,
        screenShareCount: 0,
      }),
    ).toBe(true);
    expect(
      hasWatchableVideo({
        localCameraOn: false,
        remoteHasCamera: true,
        screenShareCount: 0,
      }),
    ).toBe(true);
    expect(
      hasWatchableVideo({
        localCameraOn: false,
        remoteHasCamera: false,
        screenShareCount: 1,
      }),
    ).toBe(true);
  });
});

describe("shouldShowExpandedStage", () => {
  it("hides the stage when there is nothing to watch", () => {
    expect(shouldShowExpandedStage(false, false)).toBe(false);
    expect(shouldShowExpandedStage(false, true)).toBe(false);
  });

  it("expands for video unless the user tucked it away", () => {
    expect(shouldShowExpandedStage(true, false)).toBe(true);
    expect(shouldShowExpandedStage(true, true)).toBe(false);
  });

  it("expands an outgoing ring so Calling and declined stay on the stage", () => {
    expect(shouldShowExpandedStage(false, false, true)).toBe(true);
    expect(shouldShowExpandedStage(false, true, true)).toBe(false);
  });
});

describe("camera solo ids", () => {
  it("prefixes so they cannot collide with a screen share from the same peer", () => {
    expect(cameraSoloId("peer-1")).toBe("camera:peer-1");
    expect(isCameraSoloId("camera:peer-1")).toBe(true);
    expect(isCameraSoloId("peer-1")).toBe(false);
    expect(personKeyFromCameraSoloId("camera:peer-1")).toBe("peer-1");
  });
});

describe("formatCallDuration", () => {
  it("formats seconds and minutes without an hours field", () => {
    expect(formatCallDuration(0)).toBe("0:00");
    expect(formatCallDuration(7_000)).toBe("0:07");
    expect(formatCallDuration(61_000)).toBe("1:01");
    expect(formatCallDuration(12 * 60_000 + 41_000)).toBe("12:41");
  });

  it("adds hours once a call has earned them", () => {
    expect(formatCallDuration(3_600_000)).toBe("1:00:00");
    expect(formatCallDuration(3_600_000 + 5 * 60_000 + 9_000)).toBe("1:05:09");
  });

  it("never renders a negative time, whatever the clocks did", () => {
    expect(formatCallDuration(-5_000)).toBe("0:00");
  });

  it("truncates rather than rounds part-seconds", () => {
    expect(formatCallDuration(1_999)).toBe("0:01");
  });
});

describe("nearestCorner", () => {
  it("snaps to the quadrant the pointer let go in", () => {
    expect(nearestCorner(10, 10, 100, 100)).toBe("tl");
    expect(nearestCorner(90, 10, 100, 100)).toBe("tr");
    expect(nearestCorner(10, 90, 100, 100)).toBe("bl");
    expect(nearestCorner(90, 90, 100, 100)).toBe("br");
  });

  it("treats the exact centre as the bottom-right, the default corner", () => {
    expect(nearestCorner(50, 50, 100, 100)).toBe("br");
  });
});

describe("stage collapse memory", () => {
  it("defaults to expanded", () => {
    expect(isStageCollapsed("never-seen")).toBe(false);
  });

  it("remembers a choice per conversation", () => {
    rememberStageCollapsed("conv-a", true);
    rememberStageCollapsed("conv-b", false);
    expect(isStageCollapsed("conv-a")).toBe(true);
    expect(isStageCollapsed("conv-b")).toBe(false);
    rememberStageCollapsed("conv-a", false);
    expect(isStageCollapsed("conv-a")).toBe(false);
  });
});

describe("pin memory", () => {
  it("remembers a pin per channel", () => {
    expect(stagePinnedKey("never-seen-pin")).toBeNull();
    rememberStagePinnedKey("chan-pin", "camera:alice");
    expect(stagePinnedKey("chan-pin")).toBe("camera:alice");
    rememberStagePinnedKey("chan-pin", null);
    expect(stagePinnedKey("chan-pin")).toBeNull();
  });
});

describe("call start bookkeeping", () => {
  it("keeps the first start of a join across re-marks (collapse/expand)", () => {
    const key = callStartKey("chan", "peer-1");
    expect(markCallStarted(key, 1_000)).toBe(1_000);
    expect(markCallStarted(key, 9_999)).toBe(1_000);
    expect(callStartedAt(key)).toBe(1_000);
  });

  it("restarts the clock for a rejoin (fresh peer id), dropping stale entries", () => {
    const first = callStartKey("chan", "peer-1");
    markCallStarted(first, 1_000);
    const second = callStartKey("chan", "peer-2");
    expect(markCallStarted(second, 5_000)).toBe(5_000);
    // The finished call's entry is gone — the map cannot grow for the session.
    expect(callStartedAt(first)).toBeNull();
  });
});
