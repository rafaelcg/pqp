import { describe, expect, it } from "vitest";
import {
  popoutChoices,
  popoutTarget,
  type PopoutCameraInput,
  type PopoutScreenInput,
} from "./popout-target";

const screen = (peerId: string, hasAudio = false, isSelf = false): PopoutScreenInput => ({
  peerId,
  hasAudio,
  isSelf,
});
const camera = (key: string, isSelf = false): PopoutCameraInput => ({ key, isSelf });

const base = {
  screens: [] as PopoutScreenInput[],
  dismissedScreenIds: [] as string[],
  cameras: [] as PopoutCameraInput[],
  pickedId: null as string | null,
  currentId: null as string | null,
  focusedScreenPeerId: null as string | null,
};

describe("popoutChoices", () => {
  it("lists watched shares then cameras, never our own and never a dismissed share", () => {
    expect(
      popoutChoices({
        screens: [screen("a"), screen("me", false, true), screen("b")],
        dismissedScreenIds: ["b"],
        cameras: [camera("c"), camera("self", true)],
      }),
    ).toEqual([
      { id: "a", kind: "screen", key: "a" },
      { id: "camera:c", kind: "camera", key: "c" },
    ]);
  });
});

describe("popoutTarget", () => {
  it("shows nothing when nobody else is publishing", () => {
    expect(popoutTarget(base)).toBeNull();
    expect(
      popoutTarget({ ...base, screens: [screen("me", true, true)], cameras: [camera("me", true)] }),
    ).toBeNull();
  });

  it("keeps the person's pick over everything else", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a", true), screen("b")],
        pickedId: "b",
        currentId: "a",
        focusedScreenPeerId: "a",
      }),
    ).toBe("b");
  });

  it("lets a pick land on a camera while shares are live", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a")],
        cameras: [camera("c")],
        pickedId: "camera:c",
      }),
    ).toBe("camera:c");
  });

  it("ignores a pick that is no longer there", () => {
    expect(
      popoutTarget({ ...base, screens: [screen("a")], pickedId: "gone" }),
    ).toBe("a");
  });

  it("does not jump away from the share it is showing when another arrives", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a"), screen("b", true)],
        currentId: "a",
        focusedScreenPeerId: "b",
      }),
    ).toBe("a");
  });

  it("picks the focused share (the audible one, and the newest) when nothing is showing", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a", true), screen("b")],
        focusedScreenPeerId: "b",
      }),
    ).toBe("b");
  });

  it("skips a focused share the person has not chosen to watch", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a"), screen("b", true), screen("c")],
        dismissedScreenIds: ["c"],
        focusedScreenPeerId: "c",
      }),
    ).toBe("b");
  });

  it("falls back to the last share in roster order when none has sound", () => {
    expect(
      popoutTarget({ ...base, screens: [screen("a"), screen("b")] }),
    ).toBe("b");
  });

  it("moves from a camera to a share once somebody shares", () => {
    expect(
      popoutTarget({
        ...base,
        screens: [screen("a")],
        cameras: [camera("c")],
        currentId: "camera:c",
      }),
    ).toBe("a");
  });

  it("with no share, shows whoever is speaking, then keeps the camera it had", () => {
    const cameras = [camera("c"), camera("d")];
    expect(
      popoutTarget({ ...base, cameras, speakingKeys: new Set(["d"]) }),
    ).toBe("camera:d");
    expect(
      popoutTarget({ ...base, cameras, currentId: "camera:d", speakingKeys: new Set(["c"]) }),
    ).toBe("camera:c");
    expect(popoutTarget({ ...base, cameras, currentId: "camera:d" })).toBe("camera:d");
  });

  it("does not open for a camera nobody has spoken from yet", () => {
    expect(popoutTarget({ ...base, cameras: [camera("c")] })).toBeNull();
  });
});
