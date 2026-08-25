import { describe, expect, it } from "vitest";
import {
  callControlsMayIdle,
  showsVideoQualityControl,
  videoQualityMenuOpen,
} from "./video-quality-control";

describe("showsVideoQualityControl", () => {
  it("appears once the camera is on", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: true,
        isSharingScreen: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("appears for a screen share with the camera off", () => {
    // THE CASE THE BUG REPORT CAME FROM. The setting governs the screen sender
    // now, and the person presenting with no webcam on is the one who most
    // wants it. Under the old camera-only rule the control was hidden from
    // exactly them.
    expect(
      showsVideoQualityControl({
        isCameraOn: false,
        isSharingScreen: true,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("is absent when nothing is going out, so an audio call's bar is untouched", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: false,
        isSharingScreen: false,
        collapsed: false,
      }),
    ).toBe(false);
  });

  it("stays out of the collapsed strip whatever is being sent", () => {
    expect(
      showsVideoQualityControl({
        isCameraOn: true,
        isSharingScreen: true,
        collapsed: true,
      }),
    ).toBe(false);
  });
});

describe("videoQualityMenuOpen", () => {
  it("is open when asked for and the control is there", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        isSharingScreen: false,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("closes itself when the last outgoing video stops under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        isSharingScreen: false,
        collapsed: false,
      }),
    ).toBe(false);
  });

  it("stays open when the camera goes off mid-share", () => {
    // The control still governs the share, so yanking the menu away here would
    // be the popover-over-nothing bug in reverse: removing a button that is
    // still on screen.
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        isSharingScreen: true,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("closes itself when the stage collapses under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        isSharingScreen: true,
        collapsed: true,
      }),
    ).toBe(false);
  });

  it("stays shut when nobody asked", () => {
    expect(
      videoQualityMenuOpen({
        requested: false,
        isCameraOn: true,
        isSharingScreen: true,
        collapsed: false,
      }),
    ).toBe(false);
  });
});

describe("callControlsMayIdle", () => {
  const base = {
    autoHide: true,
    anyVideo: true,
    collapsed: false,
    menuOpen: false,
  };

  it("fades a video call's bar as it always did", () => {
    expect(callControlsMayIdle(base)).toBe(true);
  });

  it("never fades while the quality menu is open", () => {
    expect(callControlsMayIdle({ ...base, menuOpen: true })).toBe(false);
  });

  it("keeps the pre-existing terms: touch, no video, collapsed", () => {
    expect(callControlsMayIdle({ ...base, autoHide: false })).toBe(false);
    expect(callControlsMayIdle({ ...base, anyVideo: false })).toBe(false);
    expect(callControlsMayIdle({ ...base, collapsed: true })).toBe(false);
  });
});
