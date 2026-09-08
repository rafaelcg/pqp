import { describe, expect, it } from "vitest";
import { hlsSourceFor } from "./hls-source-quality";

describe("hlsSourceFor", () => {
  const live = {
    streamTopHeight: 1080,
    isSharingScreen: true,
    usingSfu: true,
    uplinkBps: 9_000_000,
  };

  it("is on only when a session is live, this machine shares, and it is the SFU", () => {
    expect(hlsSourceFor(live)).toEqual({
      ladderTopHeight: 1080,
      uplinkBps: 9_000_000,
    });
  });

  it("is off for somebody else's share in the same watch party", () => {
    // Everyone in the room sees the stream frame. Only the presenter's own
    // published track is the ladder's source.
    expect(hlsSourceFor({ ...live, isSharingScreen: false })).toBeNull();
  });

  it("is off on the mesh, where there is no egress to feed", () => {
    expect(hlsSourceFor({ ...live, usingSfu: false })).toBeNull();
  });

  it("is off when no session is live, which is every ordinary call", () => {
    expect(hlsSourceFor({ ...live, streamTopHeight: null })).toBeNull();
    expect(hlsSourceFor({ ...live, streamTopHeight: undefined })).toBeNull();
  });

  it("passes an unmeasured uplink through rather than inventing one", () => {
    // Null means unmeasured, and `hlsSourceTopHeight` treats that as
    // permission. Substituting a number here would turn "we have not looked"
    // into a claim.
    expect(hlsSourceFor({ ...live, uplinkBps: null })).toEqual({
      ladderTopHeight: 1080,
      uplinkBps: null,
    });
  });

  it("carries a 720p-only ladder's top through unchanged", () => {
    expect(hlsSourceFor({ ...live, streamTopHeight: 720 })?.ladderTopHeight).toBe(
      720,
    );
  });
});
