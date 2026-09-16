import { describe, expect, it } from "vitest";

import {
  screenPublishState,
  shouldRepublishScreen,
} from "./screen-publish-recovery";

describe("screenPublishState", () => {
  const base = {
    usingSfu: true,
    sharing: true,
    captureTrackLive: true,
    publicationLive: true,
  };

  it("is idle for a viewer / mesh / nothing shared", () => {
    expect(screenPublishState({ ...base, usingSfu: false })).toBe("idle");
    expect(screenPublishState({ ...base, sharing: false })).toBe("idle");
  });

  it("is live when the SFU reports a live publication for our capture", () => {
    expect(screenPublishState(base)).toBe("live");
  });

  it("is recovering when we still hold a live capture but the publication is gone", () => {
    // The incident: capture survived the WS resume, the LiveKit publish did not.
    expect(screenPublishState({ ...base, publicationLive: false })).toBe(
      "recovering",
    );
  });

  it("is ended when the capture track itself died", () => {
    expect(
      screenPublishState({
        ...base,
        captureTrackLive: false,
        publicationLive: false,
      }),
    ).toBe("ended");
    // A dead capture is dead even if the SFU still thinks it has our track.
    expect(
      screenPublishState({ ...base, captureTrackLive: false }),
    ).toBe("ended");
  });
});

describe("shouldRepublishScreen", () => {
  it("republishes exactly once on a dropped publication with a connected room", () => {
    expect(
      shouldRepublishScreen({
        state: "recovering",
        roomConnected: true,
        republishInFlight: false,
      }),
    ).toBe(true);
  });

  it("never republishes a healthy, idle or ended share", () => {
    for (const state of ["live", "idle", "ended"] as const) {
      expect(
        shouldRepublishScreen({
          state,
          roomConnected: true,
          republishInFlight: false,
        }),
      ).toBe(false);
    }
  });

  it("waits for the room before publishing (mid-reconnect)", () => {
    expect(
      shouldRepublishScreen({
        state: "recovering",
        roomConnected: false,
        republishInFlight: false,
      }),
    ).toBe(false);
  });

  it("does not stack a second republish while one is in flight (no loop)", () => {
    expect(
      shouldRepublishScreen({
        state: "recovering",
        roomConnected: true,
        republishInFlight: true,
      }),
    ).toBe(false);
  });
});
