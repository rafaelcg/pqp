import { describe, expect, it } from "vitest";
import {
  INITIAL_SHARE_VIEW_MODE,
  nextShareViewMode,
  sharePopoutApplies,
  sharePopoutPlacement,
  type ShareViewMode,
} from "./share-view-mode";

describe("nextShareViewMode", () => {
  it("starts as a popout", () => {
    expect(INITIAL_SHARE_VIEW_MODE).toBe("popout");
  });

  it("maximizes into the theater and comes back with minimize or escape", () => {
    expect(nextShareViewMode("popout", { type: "maximize" })).toBe("theater");
    expect(nextShareViewMode("theater", { type: "minimize" })).toBe("popout");
    expect(nextShareViewMode("theater", { type: "escape" })).toBe("popout");
  });

  it("ignores escape and minimize outside the theater", () => {
    expect(nextShareViewMode("popout", { type: "escape" })).toBe("popout");
    expect(nextShareViewMode("hidden", { type: "escape" })).toBe("hidden");
    expect(nextShareViewMode("hidden", { type: "minimize" })).toBe("hidden");
  });

  it("stays closed until the person chooses something to watch", () => {
    const closed = nextShareViewMode("popout", { type: "close" });
    expect(closed).toBe("hidden");
    expect(nextShareViewMode(closed, { type: "watch" })).toBe("popout");
  });

  it("keeps the theater when a share is chosen from it", () => {
    expect(nextShareViewMode("theater", { type: "watch" })).toBe("theater");
  });

  it("starts over when the call changes, whatever the state", () => {
    for (const mode of ["popout", "theater", "hidden"] as ShareViewMode[]) {
      expect(nextShareViewMode(mode, { type: "call-changed" })).toBe("popout");
    }
  });
});

describe("sharePopoutApplies", () => {
  it("needs the flag and a wide window, and never applies to a watch party", () => {
    expect(sharePopoutApplies({ flagOn: true, wide: true, isWatchPartyChannel: false })).toBe(true);
    expect(sharePopoutApplies({ flagOn: false, wide: true, isWatchPartyChannel: false })).toBe(false);
    expect(sharePopoutApplies({ flagOn: true, wide: false, isWatchPartyChannel: false })).toBe(false);
    expect(sharePopoutApplies({ flagOn: true, wide: true, isWatchPartyChannel: true })).toBe(false);
  });
});

describe("sharePopoutPlacement", () => {
  it("draws nothing when closed or when there is nothing to show", () => {
    expect(
      sharePopoutPlacement({ mode: "hidden", viewingCallChannel: true, hasTarget: true }),
    ).toBe("none");
    expect(
      sharePopoutPlacement({ mode: "popout", viewingCallChannel: true, hasTarget: false }),
    ).toBe("none");
  });

  it("floats in any channel", () => {
    expect(
      sharePopoutPlacement({ mode: "popout", viewingCallChannel: true, hasTarget: true }),
    ).toBe("floating");
    expect(
      sharePopoutPlacement({ mode: "popout", viewingCallChannel: false, hasTarget: true }),
    ).toBe("floating");
  });

  it("draws the theater only in the call's own channel and floats elsewhere", () => {
    expect(
      sharePopoutPlacement({ mode: "theater", viewingCallChannel: true, hasTarget: true }),
    ).toBe("theater");
    expect(
      sharePopoutPlacement({ mode: "theater", viewingCallChannel: false, hasTarget: true }),
    ).toBe("floating");
  });
});
