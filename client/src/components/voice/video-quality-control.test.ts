import { describe, expect, it } from "vitest";
import {
  callControlsMayIdle,
  showsVideoQualityControl,
  videoQualityMenuOpen,
} from "./video-quality-control";

describe("showsVideoQualityControl", () => {
  it("appears once the camera is on", () => {
    expect(showsVideoQualityControl({ isCameraOn: true, collapsed: false })).toBe(
      true,
    );
  });

  it("is absent with the camera off, so an audio call's bar is untouched", () => {
    expect(
      showsVideoQualityControl({ isCameraOn: false, collapsed: false }),
    ).toBe(false);
  });

  it("stays out of the collapsed strip even with the camera on", () => {
    expect(showsVideoQualityControl({ isCameraOn: true, collapsed: true })).toBe(
      false,
    );
  });
});

describe("videoQualityMenuOpen", () => {
  it("is open when asked for and the control is there", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        collapsed: false,
      }),
    ).toBe(true);
  });

  it("closes itself when the camera goes off under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: false,
        collapsed: false,
      }),
    ).toBe(false);
  });

  it("closes itself when the stage collapses under it", () => {
    expect(
      videoQualityMenuOpen({
        requested: true,
        isCameraOn: true,
        collapsed: true,
      }),
    ).toBe(false);
  });

  it("stays shut when nobody asked", () => {
    expect(
      videoQualityMenuOpen({
        requested: false,
        isCameraOn: true,
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
