import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPeerConnectionManager,
  meshScreenBitrate,
} from "./peer-connection-manager";
import { screenBitrateFor } from "./video-quality";

/**
 * What the encoder is told, and whether saying no to it can break a call.
 *
 * These are the two questions the rest of this module's behaviour cannot be
 * reasoned about from a diff. A fake `RTCPeerConnection` is enough for both:
 * nothing here exercises SDP, ICE or media, only which numbers reach
 * `setParameters` and what happens when that rejects. Everything real about
 * WebRTC stays out of scope on purpose, because a fake that tried to model it
 * would be testing itself.
 *
 * SEPARATE FROM `peer-connection-manager.test.ts` because that file's fake
 * models track plumbing and has no `getParameters` on its senders. Bolting a
 * parameters surface onto it would make every test there carry state that only
 * these ones read.
 */

interface FakeSender {
  track: { id: string; kind: string } | null;
  params: RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
  getParameters: () => RTCRtpSendParameters;
  replaceTrack: ReturnType<typeof vi.fn>;
}

const senders: FakeSender[] = [];
/** Set by a test to make every `setParameters` reject, as a browser may. */
let rejectSetParameters = false;

function makeSender(track: { id: string; kind: string }): FakeSender {
  const sender: FakeSender = {
    track,
    params: { encodings: [{}] } as RTCRtpSendParameters,
    getParameters: () => sender.params,
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => {
      if (rejectSetParameters) {
        throw new Error("InvalidStateError");
      }
      sender.params = next;
    }),
    replaceTrack: vi.fn(async (next: { id: string; kind: string } | null) => {
      sender.track = next;
    }),
  };
  senders.push(sender);
  return sender;
}

class FakePeerConnection {
  senders: FakeSender[] = [];
  signalingState = "stable";
  iceConnectionState = "new";
  connectionState = "new";
  localDescription = { sdp: "fake", type: "offer" };
  remoteDescription = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;

  addTrack(track: { id: string; kind: string }) {
    const sender = makeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "fake" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fake" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  setConfiguration() {}
  close() {}
  async getStats() {
    return new Map();
  }
}

/**
 * A video track that can be asked how big it is.
 *
 * `getSettings` is here because the screen tuning now has to divide the capture
 * down to the size the menu names, and the divisor can only come from the
 * track's own dimensions: a hard-coded one would mean 360p on a 1080p monitor
 * and 480p on a 1440p one.
 */
const videoTrack = (id: string, height = 1080) => ({
  id,
  kind: "video",
  getSettings: () => ({ width: Math.round((height * 16) / 9), height }),
});

/** A stream carrying exactly one video track, which is all these paths read. */
function fakeStream(id: string, height = 1080): MediaStream {
  const track = videoTrack(id, height);
  return {
    id,
    getTracks: () => [track],
    getVideoTracks: () => [track],
    getAudioTracks: () => [],
  } as unknown as MediaStream;
}

const original = globalThis.RTCPeerConnection;

beforeEach(() => {
  senders.length = 0;
  rejectSetParameters = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = original;
  vi.restoreAllMocks();
});

/** The parameters last accepted by a sender, whichever call won. */
const lastParams = (sender: FakeSender) =>
  sender.setParameters.mock.calls.at(-1)?.[0] as
    | RTCRtpSendParameters
    | undefined;

const cameraSenders = () => senders.filter((s) => s.track?.id === "camera");
const screenSenders = () => senders.filter((s) => s.track?.id === "screen");

describe("camera sender tuning", () => {
  it("gives a camera a ceiling and a framerate preference", async () => {
    // Before this existed the camera sender was added and never touched, so it
    // ran with no ceiling at all against a shared bandwidth estimate.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setCameraMaxBitrate(900_000);
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));

    const params = lastParams(cameraSenders()[0]!);
    expect(params?.degradationPreference).toBe("maintain-framerate");
    expect(params?.encodings[0]?.maxBitrate).toBe(900_000);
    expect(params?.encodings[0]?.maxFramerate).toBe(30);
  });

  it("gives the same ceiling to somebody who joins mid-call", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setCameraMaxBitrate(700_000);
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    manager.connectToPeer("b-remote");

    await Promise.resolve();
    expect(cameraSenders()).toHaveLength(2);
    for (const sender of cameraSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(700_000);
    }
  });

  it("moves the ceiling on a live call without touching the track", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    const sender = cameraSenders()[0]!;

    manager.setCameraMaxBitrate(2_500_000);
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(2_500_000);
    // The whole point of doing it this way: no re-capture, so the webcam light
    // never blinks and no video is dropped.
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sender.track?.id).toBe("camera");
  });

  it("leaves a working camera when the encoder refuses the parameters", async () => {
    // The worst case of this whole change must be "no improvement", never
    // "no video". A browser that rejects setParameters gets browser defaults.
    rejectSetParameters = true;
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");

    await expect(
      manager.setLocalCameraStream(fakeStream("camera")),
    ).resolves.toBeUndefined();
    expect(cameraSenders()[0]?.track?.id).toBe("camera");
    // And it is not silent, which is how the missing ceiling went unnoticed.
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not re-tune every sender when the ceiling has not moved", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalCameraStream(fakeStream("camera"));
    const before = cameraSenders()[0]!.setParameters.mock.calls.length;

    manager.setCameraMaxBitrate(1_500_000);
    manager.setCameraMaxBitrate(1_500_000);
    await Promise.resolve();

    expect(cameraSenders()[0]!.setParameters.mock.calls.length).toBe(before);
  });
});

describe("screen budget across a growing room", () => {
  it("splits by the room everyone is about to be in, not the one they were in", async () => {
    // REGRESSION. The re-tune fired from inside `createPeerConnection`, which
    // runs before the caller files the new peer, so `peers.size` was one short
    // and every existing sender stayed budgeted for a smaller room for the
    // rest of the call.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    manager.connectToPeer("c-remote");
    await Promise.resolve();

    expect(screenSenders()).toHaveLength(3);
    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(3),
      );
    }
  });

  it("hands the budget back when somebody leaves", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    manager.connectToPeer("b-remote");
    manager.connectToPeer("c-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    manager.removePeer("c-remote");
    await Promise.resolve();

    const remaining = screenSenders().filter((s) => s.track !== null);
    for (const sender of remaining.slice(0, 2)) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2),
      );
    }
  });

  it("gives a re-share the same ceiling as the first one", async () => {
    // The reported bug was a *second* share, so the peer count the second
    // `setLocalScreenStream` tunes with is worth pinning: a stop-and-restart
    // must not leave the new sender budgeted for a room that is not there.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    await manager.setLocalScreenStream(null);
    await manager.setLocalScreenStream(fakeStream("screen"));

    expect(lastParams(screenSenders().at(-1)!)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1),
    );
  });

  it("clamps a call to the chosen ceiling rather than the raw share", () => {
    // Which is why the peer-count arithmetic could never explain a bad DM: the
    // clamp, not the division, is what a small call actually runs into.
    expect(meshScreenBitrate(1)).toBe(3_000_000);
    expect(meshScreenBitrate(2)).toBe(2_500_000);
    expect(meshScreenBitrate(3)).toBeLessThan(2_500_000);
  });
});

describe("the quality choice reaches the screen sender", () => {
  it("gives a 1080p share more than the old hard-coded 2.5 Mbps", () => {
    // THE REPORTED BUG, pinned. "I selected 1080p, shared, it was blurry": the
    // choice moved the camera and nothing else, and the screen sender ran on a
    // constant no setting could reach.
    expect(meshScreenBitrate(1, "1080p")).toBe(4_000_000);
    expect(meshScreenBitrate(1, "1080p")).toBeGreaterThan(2_500_000);
  });

  it("orders the five settings, and separates every one of them", () => {
    const rungs = ["360p", "480p", "720p", "auto", "1080p"] as const;
    const rates = rungs.map((rung) => meshScreenBitrate(1, rung));
    expect(rates).toEqual([...rates].sort((a, b) => a - b));
    expect(new Set(rates).size).toBe(rungs.length);
  });

  it("lets the chosen ceiling win over an empty room's budget", () => {
    // The room has bandwidth going spare and the user still said 480p. A
    // budget that could overrule that would make the control a suggestion.
    expect(meshScreenBitrate(1, "480p")).toBe(1_000_000);
    expect(meshScreenBitrate(1, "480p")).toBeLessThan(
      meshScreenBitrate(1, "auto"),
    );
  });

  it("lets a crowded room's budget win over a generous choice", () => {
    // And the other direction, because a mesh presenter uploads one copy per
    // peer: picking 1080p in an eight-way call cannot be allowed to ask one
    // domestic uplink for 32 Mbps.
    expect(meshScreenBitrate(8, "1080p")).toBeLessThan(
      meshScreenBitrate(1, "1080p"),
    );
    expect(meshScreenBitrate(8, "1080p")).toBe(meshScreenBitrate(8, "auto"));
  });

  it("never drops a share below the floor, whatever is chosen", () => {
    for (const rung of ["auto", "1080p", "720p", "480p", "360p"] as const) {
      for (const peers of [1, 2, 4, 8, 16]) {
        expect(meshScreenBitrate(peers, rung)).toBeGreaterThanOrEqual(600_000);
      }
    }
  });

  it("leaves every crowded room exactly where it was before the raise", () => {
    // The point of choosing 4 Mbps rather than more: the 5 Mbps budget still
    // binds from two peers up, so the raise reaches small calls only. If this
    // fails, somebody moved the budget and changed group calls by accident.
    for (const peers of [2, 3, 4, 6, 8]) {
      expect(meshScreenBitrate(peers, "1080p")).toBe(
        Math.round(Math.max(600_000, 5_000_000 / peers)),
      );
    }
  });

  it("defaults to auto when no quality is passed at all", () => {
    // Every pre-existing caller passes one argument. They must keep meaning
    // what they meant.
    expect(meshScreenBitrate(4)).toBe(meshScreenBitrate(4, "auto"));
  });

  it("keeps the mesh cap and the ladder's top rung agreed", () => {
    // Two constants in two modules that must not drift: the mesh's own hard cap
    // and the most any quality may ask for. If they part company, one of them
    // silently stops doing anything.
    expect(screenBitrateFor("1080p")).toBe(4_000_000);
  });

  it("moves a live share's ceiling without touching the capture", async () => {
    // Mid-call, the same promise the camera makes: no re-publish, so the OS
    // picker never reappears and the share never blinks out for its viewers.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("1080p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1, "1080p"),
    );
    expect(sender.replaceTrack).not.toHaveBeenCalled();
    expect(sender.track?.id).toBe("screen");
  });

  it("carries the choice to a share that starts after it", async () => {
    // The order people actually do it in: set the quality, then share. The
    // manager has to hold the choice, not merely react to a live sender.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("360p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));

    expect(lastParams(screenSenders()[0]!)?.encodings[0]?.maxBitrate).toBe(
      meshScreenBitrate(1, "360p"),
    );
  });

  it("carries the choice to somebody who joins mid-share", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("1080p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    manager.connectToPeer("b-remote");

    await Promise.resolve();
    expect(screenSenders()).toHaveLength(2);
    for (const sender of screenSenders()) {
      expect(lastParams(sender)?.encodings[0]?.maxBitrate).toBe(
        meshScreenBitrate(2, "1080p"),
      );
    }
  });

  it("does not re-tune every sender when the choice has not moved", async () => {
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const before = screenSenders()[0]!.setParameters.mock.calls.length;

    manager.setScreenQuality("720p");
    manager.setScreenQuality("720p");
    await Promise.resolve();

    expect(screenSenders()[0]!.setParameters.mock.calls.length).toBe(
      before + 1,
    );
  });

  it("divides the picture down to the size the label names", async () => {
    // THE REPORTED BUG. Measured at the receiver in a server voice channel:
    // every rung below 1080p arrived as 1920x1080, because the choice moved
    // `maxBitrate` and nothing else. A ceiling on its own does not make a
    // smaller picture, it makes the same picture worse, which is exactly what
    // "I picked 360p and it did not look like 360p" describes.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("360p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBeCloseTo(
      3,
      2,
    );
    // And no re-capture to do it, so the OS picker never reappears.
    expect(sender.replaceTrack).not.toHaveBeenCalled();
  });

  it("divides by what this screen is, not by a number", async () => {
    // A 1440p monitor asked for 360p needs a divisor of 4 where a 1080p one
    // needs 3. Same label, same picture, different hardware.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.setScreenQuality("360p");
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen", 1440));

    expect(
      lastParams(screenSenders()[0]!)?.encodings[0]?.scaleResolutionDownBy,
    ).toBeCloseTo(4, 2);
  });

  it("gives the full picture back when the choice goes back up", async () => {
    // The failure this guards is a divisor that is only ever written on the way
    // down: 360p then 1080p would leave a 3x scale in place forever, and the
    // menu would become a one-way trip.
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");
    await manager.setLocalScreenStream(fakeStream("screen"));
    const sender = screenSenders()[0]!;

    manager.setScreenQuality("360p");
    await Promise.resolve();
    manager.setScreenQuality("1080p");
    await Promise.resolve();

    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBe(1);

    manager.setScreenQuality("auto");
    await Promise.resolve();
    // Auto is not "no divisor": it asks for 720 lines out of a 1080-line
    // capture, the same as the named rung, and spends its own 3 Mbps on them.
    expect(lastParams(sender)?.encodings[0]?.scaleResolutionDownBy).toBeCloseTo(
      1.5,
      2,
    );
  });

  it("leaves a working share when the encoder refuses the parameters", async () => {
    // Raising a ceiling must not be able to cost anybody their share.
    rejectSetParameters = true;
    const manager = createPeerConnectionManager("z-local", () => {});
    manager.connectToPeer("a-remote");

    await expect(
      manager.setLocalScreenStream(fakeStream("screen")),
    ).resolves.toBeUndefined();
    expect(screenSenders()[0]?.track?.id).toBe("screen");
  });
});
