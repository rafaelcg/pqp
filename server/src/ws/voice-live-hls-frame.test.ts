import { describe, expect, it } from "vitest";
import type { LiveHlsStream } from "@pqp/shared";

/**
 * `liveHlsFrameChanged` — the gate in front of `pushLiveHls`'s per-recipient
 * fan-out.
 *
 * WHY THIS RULE IS WORTH ITS OWN FILE. The frame is encoded once per socket
 * (the playlist URL carries a token bound to the recipient), so sending one
 * the room does not need is a rebuffer for everybody, and NOT sending one the
 * room does need leaves every player on a playlist that may no longer be
 * written. The second half is the expensive one: a low-latency session that
 * the remux gives up on is demoted to the conventional ladder mid-party
 * (`sweepLlDemotions` -> `notifyChanged` -> `pushLiveHls`), and a viewer who
 * is never told reads "A transmissão caiu".
 *
 * Pure, so none of this needs a room, a socket or a transcode.
 */

const { liveHlsCameraUntold, liveHlsFrameChanged } = await import("./voice.js");

function stream(overrides: Partial<LiveHlsStream> = {}): LiveHlsStream {
  return {
    hlsUrl: "/api/voice/hls-playlist/chan/1757865600000",
    startedAt: 1_757_865_600_000,
    presenterPeerId: "peer-1",
    ...overrides,
  };
}

describe("liveHlsFrameChanged", () => {
  it("is false for the same stream twice: an idle party must not re-fan-out on every roster event", () => {
    expect(liveHlsFrameChanged(stream(), stream())).toBe(false);
  });

  it("is false for a change nobody re-reads after attaching", () => {
    expect(
      liveHlsFrameChanged(
        stream({ delaySeconds: 26, topHeight: 720, hasAudio: true }),
        stream({ delaySeconds: 30, topHeight: 1080, hasAudio: false }),
      ),
    ).toBe(false);
  });

  it("is true when a session starts, and when one ends", () => {
    expect(liveHlsFrameChanged(null, stream())).toBe(true);
    expect(liveHlsFrameChanged(stream(), null)).toBe(true);
  });

  it("is true when the presenter changes under an identical URL", () => {
    expect(
      liveHlsFrameChanged(stream(), stream({ presenterPeerId: "peer-2" })),
    ).toBe(true);
  });

  it("is true when the camera rung appears or disappears", () => {
    const withCamera = stream({ cameraHlsUrl: "/api/voice/hls-playlist/chan/1757865600000/cam" });
    expect(liveHlsFrameChanged(stream(), withCamera)).toBe(true);
    expect(liveHlsFrameChanged(withCamera, stream())).toBe(true);
  });

  it("is true for an LL demotion, even if nothing else moved", () => {
    // The case that costs an audience a party. A demotion normally mints a
    // new `startedAt` and therefore a new `hlsUrl` too, so this is belt and
    // braces -- but `mode` IS what the client keys its engine configuration
    // on, and a frame that changed it without saying so is exactly the
    // silent-disagreement shape this whole change exists to remove.
    expect(
      liveHlsFrameChanged(
        stream({ mode: "ll", partTargetMs: 500 }),
        stream({ mode: "conventional" }),
      ),
    ).toBe(true);
  });

  it("is true when the part target changes for the same LL session", () => {
    expect(
      liveHlsFrameChanged(
        stream({ mode: "ll", partTargetMs: 500 }),
        stream({ mode: "ll", partTargetMs: 320 }),
      ),
    ).toBe(true);
  });

  it("is true when an LL master URL replaces a conventional one", () => {
    expect(
      liveHlsFrameChanged(
        stream(),
        stream({
          hlsUrl: "/api/voice/hls-playlist/chan/1757865600000?mode=ll",
          mode: "ll",
        }),
      ),
    ).toBe(true);
  });
});

describe("liveHlsCameraUntold", () => {
  const cam = "/api/voice/hls-playlist/chan/1757865600000/cam360p30";

  it("is true when the audience was told the session without the camera it now has", () => {
    // The 2026-09-25 shape: the room's own stream already carries the camera
    // (so `liveHlsFrameChanged(prev, next)` is false), the audience does not.
    const told = stream();
    const next = stream({ cameraHlsUrl: cam, cameraHasVideo: true });
    expect(liveHlsFrameChanged(next, next)).toBe(false);
    expect(liveHlsCameraUntold(told, next)).toBe(true);
  });

  it("is true when the camera went away and the audience still holds it", () => {
    expect(liveHlsCameraUntold(stream({ cameraHlsUrl: cam }), stream())).toBe(true);
  });

  it("is true when only the camera's shape moved (voice attached)", () => {
    expect(
      liveHlsCameraUntold(
        stream({ cameraHlsUrl: cam, cameraHasVoiceAudio: false }),
        stream({ cameraHlsUrl: cam, cameraHasVoiceAudio: true }),
      ),
    ).toBe(true);
  });

  it("is false once told, and for a start, an end or another session", () => {
    const withCam = stream({ cameraHlsUrl: cam });
    expect(liveHlsCameraUntold(withCam, withCam)).toBe(false);
    expect(liveHlsCameraUntold(null, withCam)).toBe(false);
    expect(liveHlsCameraUntold(withCam, null)).toBe(false);
    expect(
      liveHlsCameraUntold(stream(), stream({ startedAt: 1, cameraHlsUrl: cam })),
    ).toBe(false);
  });
});
