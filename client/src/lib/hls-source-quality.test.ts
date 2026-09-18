import { describe, expect, it } from "vitest";
import { hlsSourceFor } from "./hls-source-quality";
import { SCREEN_CAPTURE_HEIGHT } from "./video-quality";

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
      limitedBy: null,
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
    // Null means unmeasured, and `hlsSourceTopHeight` treats that as a
    // refusal. Substituting a number here would turn "we have not looked"
    // into a claim.
    expect(hlsSourceFor({ ...live, uplinkBps: null })).toEqual({
      ladderTopHeight: 1080,
      uplinkBps: null,
      limitedBy: null,
    });
  });

  it("carries a 720p-only ladder's top through unchanged", () => {
    expect(hlsSourceFor({ ...live, streamTopHeight: 720 })?.ladderTopHeight).toBe(
      720,
    );
  });

  it("treats a low-latency session with no stated top as a live ladder", () => {
    // AN LL SESSION STATES NO `topHeight`, AND IT NEVER WILL. The remux is a
    // CMAF passthrough: it does not transcode a ladder, it forwards the
    // presenter's own top simulcast layer verbatim, so there is no server-side
    // rendition height for the frame to name (`server/src/voice/hls-remux.ts`
    // builds the stream with `mode`, `partTargetMs` and nothing about size).
    //
    // Reading that absence as "no egress is running" is what put TWO active
    // screen encodings on a production presenter's uplink for a whole 21
    // minute party: a null here means `setHlsSource(null)`, which means the
    // share is never pinned and its 360p rung is never deactivated, while the
    // remux quietly works around it by pinning its subscription to HIGH.
    //
    // For a passthrough the ladder's top IS the presenter's own ceiling, so
    // that is what goes on the wire. The 720p publish cap and the measured
    // uplink gate then decide the height exactly as on the conventional path.
    expect(
      hlsSourceFor({ ...live, streamTopHeight: undefined, streamMode: "ll" }),
    ).toEqual({
      ladderTopHeight: SCREEN_CAPTURE_HEIGHT,
      uplinkBps: 9_000_000,
      limitedBy: null,
    });
  });

  it("prefers a stated top over the passthrough assumption", () => {
    // Belt and braces: if an LL session ever does state one, it wins.
    expect(
      hlsSourceFor({ ...live, streamTopHeight: 720, streamMode: "ll" })
        ?.ladderTopHeight,
    ).toBe(720);
  });

  it("is still off for an LL session somebody else is presenting", () => {
    expect(
      hlsSourceFor({
        ...live,
        streamTopHeight: undefined,
        streamMode: "ll",
        isSharingScreen: false,
      }),
    ).toBeNull();
    expect(
      hlsSourceFor({
        ...live,
        streamTopHeight: undefined,
        streamMode: "ll",
        usingSfu: false,
      }),
    ).toBeNull();
  });
});
