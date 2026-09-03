import type { VoiceSignalingMessage } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * The quality menu, end to end, on the wire.
 *
 * WHY THIS FILE EXISTS ALONGSIDE THE OTHER TWO. `use-voice-calls.test.ts`
 * drives the real controller against a *stub* mesh, so it can only prove the
 * controller called `setScreenQuality`. `peer-connection-tuning.test.ts` drives
 * the real mesh directly, so it can only prove the mesh obeys a call nobody
 * made from the app. The seam between them — a person in a call, picking a
 * size from the menu, and the encoder of every peer they are actually talking
 * to — was tested by neither, and it is the seam the report is about.
 *
 * So: real `createVoiceController`, real `createPeerConnectionManager`, a fake
 * `RTCPeerConnection` that records what reaches `setParameters`. Both call
 * shapes are exercised, because "works in a DM, does nothing in a channel" is
 * the specific claim, and the two paths join at `join()`.
 */

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async () => {},
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    unpublishScreenAudio: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    setScreenMaxBitrate: async () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { meshScreenBitrate } = await import("@/lib/peer-connection-manager");

// ----------------------------------------------------------- fake WebRTC

interface FakeSender {
  track: { id: string; kind: string } | null;
  params: RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
  getParameters: () => RTCRtpSendParameters;
  replaceTrack: ReturnType<typeof vi.fn>;
}

const senders: FakeSender[] = [];

function makeSender(track: { id: string; kind: string }): FakeSender {
  const sender: FakeSender = {
    track,
    params: { encodings: [{}] } as RTCRtpSendParameters,
    getParameters: () => sender.params,
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => {
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
  connectionState = "connected";
  localDescription = { sdp: "fake", type: "offer" };
  remoteDescription = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  onnegotiationneeded: unknown = null;
  onsignalingstatechange: unknown = null;

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

// ----------------------------------------------------------- fake media

const stoppedTracks: string[] = [];

function mediaTrack(id: string, kind: "audio" | "video") {
  return {
    id,
    kind,
    enabled: true,
    contentHint: "",
    onended: null as null | (() => void),
    stop: () => stoppedTracks.push(id),
  };
}

function mediaStream(id: string, tracks: ReturnType<typeof mediaTrack>[]) {
  return {
    id,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    removeTrack: () => {},
  } as unknown as MediaStream;
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: { video?: unknown }) =>
        constraints.video
          ? mediaStream("cam-stream", [mediaTrack("camera", "video")])
          : mediaStream("mic-stream", [mediaTrack("mic", "audio")]),
      getDisplayMedia: async () =>
        mediaStream("screen-stream", [mediaTrack("screen", "video")]),
    },
  });
  g.AudioContext = class {
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
    createAnalyser() {
      return { fftSize: 0, smoothingTimeConstant: 0, connect: () => {} };
    }
    createMediaStreamDestination() {
      return {
        stream: mediaStream("processed", [mediaTrack("processed", "audio")]),
      };
    }
    close() {
      return Promise.resolve();
    }
  };
}

// ----------------------------------------------------------- fake signaling

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SELF = "00000000-0000-4000-8000-0000000000b0";
const PEERS = [
  "00000000-0000-4000-8000-0000000000b1",
  "00000000-0000-4000-8000-0000000000b2",
  "00000000-0000-4000-8000-0000000000b3",
];

function participant(peerId: string) {
  return {
    peerId,
    userId: `user-${peerId}`,
    displayName: "Someone",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
  };
}

function welcome(peerIds: string[]): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: SELF,
    voiceChannelId: CHANNEL,
    self: participant(SELF),
    peers: peerIds.map(participant),
    transport: "mesh",
  };
}

function peerJoined(peerId: string): VoiceSignalingMessage {
  return { type: "peer-joined", peer: participant(peerId) };
}

function createTransport() {
  const sent: { type: string; [key: string]: unknown }[] = [];
  const transport: RealtimeTransport = {
    connect: () => {},
    disconnect: () => {},
    sendChat: () => {},
    sendVoice: (message) => sent.push(message),
    onMessage: () => {},
    onReady: () => {},
    onError: () => {},
    onClose: () => {},
    onStatusChange: () => {},
    getStatus: () => "online",
    isConnected: () => true,
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return { transport, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const originalPeerConnection = globalThis.RTCPeerConnection;

beforeEach(() => {
  installBrowserStubs();
  senders.length = 0;
  stoppedTracks.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection =
    FakePeerConnection;
});

afterEach(() => {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection =
    originalPeerConnection;
  vi.restoreAllMocks();
});

/** The ceiling a sender is currently running at, per the last accepted call. */
function ceilingOf(sender: FakeSender): number | undefined {
  const accepted = sender.setParameters.mock.calls.at(-1)?.[0] as
    | RTCRtpSendParameters
    | undefined;
  return accepted?.encodings?.[0]?.maxBitrate;
}

/**
 * The divisor a sender is currently running at, per the last accepted call.
 *
 * Separate from the ceiling because they are separate failures. A ceiling that
 * lands while the divisor does not is precisely the bug this feature shipped
 * with: every rung below 1080p arrived at 1920x1080, starved of bits rather
 * than scaled, so "360p" looked like blocky 1080p instead of clean 360p. A
 * test that only reads `maxBitrate` calls that a pass.
 */
function scaleOf(sender: FakeSender): number | undefined {
  const accepted = sender.setParameters.mock.calls.at(-1)?.[0] as
    | RTCRtpSendParameters
    | undefined;
  return accepted?.encodings?.[0]?.scaleResolutionDownBy;
}

const screenCeilings = () =>
  senders.filter((s) => s.track?.id === "screen").map(ceilingOf);
const cameraCeilings = () =>
  senders.filter((s) => s.track?.id === "camera").map(ceilingOf);
const screenScales = () =>
  senders.filter((s) => s.track?.id === "screen").map(scaleOf);

/** A call in progress, with `count` other people in it. Mesh, always. */
async function inCall(count: number) {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome(PEERS.slice(0, count)));
  await settle();
  return { voice, sent };
}

describe("the quality menu reaches the screen encoder of every peer", () => {
  it("moves a live share in a one-to-one call (the DM shape)", async () => {
    const { voice } = await inCall(1);
    await voice.startScreenShare();
    await settle();

    await voice.setVideoQuality("360p");
    await settle();

    expect(screenCeilings()).toEqual([600_000]);
    // The size too, not just the bits. See `scaleOf`.
    expect(screenScales()).toEqual([3]);
  });

  it("moves a live share in a channel call with three other members", async () => {
    const { voice } = await inCall(3);
    await voice.startScreenShare();
    await settle();

    await voice.setVideoQuality("360p");
    await settle();

    // Every peer, not just the first: a mesh has one sender per person.
    expect(screenCeilings()).toEqual([600_000, 600_000, 600_000]);
    // And the size reaches every one of them, which is the half that was
    // missing entirely until the divisor was written at all.
    expect(screenScales()).toEqual([3, 3, 3]);
  });

  it("gives a peer who joins after the choice the same ceiling", async () => {
    const { voice } = await inCall(1);
    await voice.startScreenShare();
    await settle();
    await voice.setVideoQuality("360p");
    await settle();

    voice.handleSignaling(peerJoined(PEERS[1]!));
    await settle();

    expect(screenCeilings()).toHaveLength(2);
    expect(screenCeilings()).toEqual([600_000, 600_000]);
  });

  it("gives a share started after the choice the chosen ceiling", async () => {
    const { voice } = await inCall(2);
    await voice.setVideoQuality("480p");
    await settle();

    await voice.startScreenShare();
    await settle();

    expect(screenCeilings()).toEqual([1_000_000, 1_000_000]);
  });

  it("raises a one-to-one share above what auto spends", async () => {
    const { voice } = await inCall(1);
    await voice.startScreenShare();
    await settle();
    expect(screenCeilings()).toEqual([3_000_000]);

    await voice.setVideoQuality("1080p");
    await settle();

    expect(screenCeilings()).toEqual([4_000_000]);
  });

  it("still clamps a crowded room to its budget share", async () => {
    const { voice } = await inCall(3);
    await voice.startScreenShare();
    await settle();

    await voice.setVideoQuality("1080p");
    await settle();

    // 5 Mbps split three ways. Documented, deliberate, and the reason a
    // channel call cannot be raised the way a DM can.
    expect(screenCeilings()).toEqual([
      meshScreenBitrate(3, "1080p"),
      meshScreenBitrate(3, "1080p"),
      meshScreenBitrate(3, "1080p"),
    ]);
  });
});

describe("a choice made outside a call still governs the call", () => {
  it("applies a size pinned in Settings before the join", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    // Exactly what App.tsx does on mount with the stored setting: no call yet,
    // so there is no mesh to tell.
    await voice.setVideoQuality("480p");

    await voice.join(CHANNEL);
    voice.handleSignaling(welcome(PEERS.slice(0, 2)));
    await settle();
    await voice.startScreenShare();
    await settle();

    expect(screenCeilings()).toEqual([1_000_000, 1_000_000]);
  });

  it("keeps the choice for the next call after leaving this one", async () => {
    const { voice } = await inCall(1);
    await voice.setVideoQuality("360p");
    voice.leave();

    await voice.join(CHANNEL);
    voice.handleSignaling(welcome(PEERS.slice(0, 1)));
    await settle();
    await voice.startScreenShare();
    await settle();

    expect(screenCeilings()).toEqual([600_000]);
  });
});

describe("the quality menu reaches the camera encoder of every peer", () => {
  it("moves every live camera sender in a channel call", async () => {
    const { voice } = await inCall(3);
    await voice.toggleCamera();
    await settle();

    await voice.setVideoQuality("360p");
    await settle();

    expect(cameraCeilings()).toEqual([400_000, 400_000, 400_000]);
  });

  it("gives a peer who joins after the choice the same camera ceiling", async () => {
    const { voice } = await inCall(1);
    await voice.toggleCamera();
    await settle();
    await voice.setVideoQuality("1080p");
    await settle();

    voice.handleSignaling(peerJoined(PEERS[1]!));
    await settle();

    expect(cameraCeilings()).toEqual([2_500_000, 2_500_000]);
  });
});
