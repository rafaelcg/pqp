import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPeerConnectionManager,
  screenBitrateFor,
} from "./peer-connection-manager";

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

const videoTrack = (id: string) => ({ id, kind: "video" });

/** A stream carrying exactly one video track, which is all these paths read. */
function fakeStream(id: string): MediaStream {
  const track = videoTrack(id);
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
        screenBitrateFor(3),
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
        screenBitrateFor(2),
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
      screenBitrateFor(1),
    );
  });

  it("clamps a two-person call to the maximum rather than the raw share", () => {
    // Which is why the peer-count arithmetic could never explain a bad DM.
    expect(screenBitrateFor(1)).toBe(2_500_000);
    expect(screenBitrateFor(2)).toBe(2_500_000);
    expect(screenBitrateFor(3)).toBeLessThan(2_500_000);
  });
});
