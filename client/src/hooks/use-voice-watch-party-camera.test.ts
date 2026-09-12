import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * THE CAMERA IS HELD SMALL WHILE THIS MACHINE FEEDS THE WATCH PARTY, AND GIVEN
 * BACK WHEN IT STOPS.
 *
 * Measured on staging 2026-09-12: a presenter turned their camera on during a
 * live party and it went up at 720p with three simulcast layers, roughly
 * 1.5 Mbit/s, while their 3.5 Mbit/s H.264 share was what 500 people were
 * watching. The two bid against the same bandwidth estimate on the same
 * uplink, the client raised the "your upload is not keeping up" warning, and
 * the SHARE lost: 640x360 at 17 fps. Nothing capped the camera because nothing
 * knew it was a watch party.
 *
 * `effectiveCameraQuality` is the decision and `video-quality.test.ts` pins it.
 * What is pinned here is the wiring, which is the half that can silently not
 * run: the cap has to arrive when `voice-stream` says an egress is live, come
 * off when it says the session ended, survive a quality picked mid-party
 * without eating the person's choice, and apply to a camera opened AFTER the
 * party started (captured small, not captured big and shrunk a tick later).
 */

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

vi.mock("@/lib/voice-leave-beacon", () => ({
  beaconVoiceLeave: () => {},
}));

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => ({
    setLocalStream: () => {},
    measureUplinkBps: async () => null,
    setLocalScreenStream: async () => {},
    setLocalCameraStream: async () => {},
    setCameraMaxBitrate: () => {},
    setScreenQuality: () => {},
    setPeerCameraStreamId: () => {},
    setPeerScreenAudioStreamId: () => {},
    setPeerSharingScreen: () => {},
    onPeerStateChange: () => {},
    connectToPeer: () => {},
    setPeerIdentity: () => {},
    removePeer: () => {},
    handleOffer: async () => {},
    handleAnswer: async () => {},
    handleIceCandidate: async () => {},
    retryPeer: async () => {},
    replaceLocalTrack: async () => {},
    setIceServers: () => {},
    dispose: () => {},
  })),
}));

/** Every camera ceiling the SFU session was handed, in order. */
const cameraCeilings: number[] = [];
/** Every `setHlsSource` the session was handed, so the two halves can be paired. */
const hlsSources: (unknown | null)[] = [];
let ladderReconciles = 0;

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async () => {},
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    unpublishScreenAudio: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async (bitrate: number) => {
      cameraCeilings.push(bitrate);
    },
    reconcileCameraLadder: async () => {
      ladderReconciles += 1;
    },
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setReceiveQuality: async () => {},
    setHlsSource: async (next: unknown | null) => {
      hlsSources.push(next);
    },
    setAudioDelivery: () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");

// ------------------------------------------------------------------ browser

/** What `getUserMedia` was asked for, so a capture size can be read back. */
const cameraRequests: MediaTrackConstraints[] = [];
/** What `applyConstraints` moved a live capture to, in order. */
const appliedConstraints: MediaTrackConstraints[] = [];

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    id: `${kind}-track`,
    enabled: true,
    contentHint: "",
    onended: null as null | (() => void),
    stop: () => {},
    applyConstraints: async (constraints: MediaTrackConstraints) => {
      appliedConstraints.push(constraints);
    },
    getSettings: () => ({}),
  };
}

function fakeStream(label: string, kind: "audio" | "video" = "audio") {
  const tracks = [fakeTrack(kind)];
  return {
    id: `stream-${label}`,
    getTracks: () => [...tracks],
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    addTrack: () => {},
    removeTrack: () => {},
  } as unknown as MediaStream;
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  // The 2 s `setHlsSource` sampler would otherwise keep the suite awake. Every
  // assertion below drives the state change directly, which is the path a
  // `voice-stream` frame takes.
  g.setInterval = () => 1;
  g.clearInterval = () => {};
  g.window = {
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) => {
        if (constraints.video) {
          cameraRequests.push(constraints.video as MediaTrackConstraints);
          return fakeStream("camera", "video");
        }
        return fakeStream("mic");
      },
      getDisplayMedia: async () => fakeStream("screen", "video"),
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
      return { stream: fakeStream("processed") };
    }
    close() {
      return Promise.resolve();
    }
  };
}

// ---------------------------------------------------------------- signaling

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const ME = "00000000-0000-4000-8000-0000000000cc";

function participant(peerId: string, extra = {}) {
  return {
    peerId,
    userId: ME,
    displayName: "Host",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    ...extra,
  };
}

function welcome(): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self: participant(PEER),
    peers: [],
    transport: "livekit",
  };
}

/** The server saying an egress is (or is no longer) transcoding this channel. */
function voiceStream(topHeight: number | null): VoiceSignalingMessage {
  return {
    type: "voice-stream",
    channelId: CHANNEL,
    stream:
      topHeight === null
        ? null
        : {
            hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/1`,
            startedAt: 1,
            presenterPeerId: PEER,
            delaySeconds: 10,
            topHeight,
            topFramerate: 60,
            hasAudio: true,
          },
  } as VoiceSignalingMessage;
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
    onAuthUnavailable: () => {},
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

/** In a LiveKit room, sharing a screen. The shape a watch-party host is in. */
async function presentingHost() {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => ({
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  }));
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome());
  await settle();
  await settle();
  expect(voice.getState().usingSfu).toBe(true);
  await voice.startScreenShare();
  await settle();
  expect(voice.getState().isSharingScreen).toBe(true);
  return { voice, sent };
}

/** `cameraProfileFor("360p").maxBitrate` and `("auto")`, spelt out on purpose. */
const CAP_BPS = 400_000;
const AUTO_BPS = 1_500_000;

beforeEach(() => {
  installBrowserStubs();
  cameraCeilings.length = 0;
  cameraRequests.length = 0;
  appliedConstraints.length = 0;
  hlsSources.length = 0;
  ladderReconciles = 0;
  vi.mocked(connectLiveKit).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the presenter's camera while a watch party is transcoding", () => {
  it("holds a live camera at 360p when the egress goes up, and gives it back", async () => {
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);

    voice.handleSignaling(voiceStream(1080));
    await settle();

    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);
    // The capture itself moved too, not only the encoder's allowance: a
    // ceiling alone buys a blocky 720p rather than a clean 360p, which is the
    // lesson already written into `video-quality.ts`.
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 360 },
    });
    // The simulcast ladder was solved against the old capture size.
    expect(ladderReconciles).toBeGreaterThan(0);

    voice.handleSignaling(voiceStream(null));
    await settle();

    expect(cameraCeilings.at(-1)).toBe(AUTO_BPS);
    expect(appliedConstraints.at(-1)).toMatchObject({
      height: { ideal: 720 },
    });
  });

  it("captures a camera opened mid-party small rather than shrinking it after", async () => {
    const { voice } = await presentingHost();
    voice.handleSignaling(voiceStream(1080));
    await settle();

    await voice.toggleCamera();
    await settle();

    // The FIRST thing the hardware was asked for. Opening at 720p and
    // applying 360p a tick later is a visible pop and a wasted republish.
    expect(cameraRequests).toHaveLength(1);
    expect(cameraRequests[0]).toMatchObject({ height: { ideal: 360 } });
  });

  it("stores a quality picked mid-party without publishing it", async () => {
    const { voice } = await presentingHost();
    await voice.toggleCamera();
    await settle();
    voice.handleSignaling(voiceStream(1080));
    await settle();

    await voice.setVideoQuality("1080p");
    await settle();

    // The choice is theirs and it survives; what goes on the wire is the
    // choice under the cap, and the menu never appears to move on its own.
    expect(voice.getVideoQuality()).toBe("1080p");
    expect(cameraCeilings.at(-1)).toBe(CAP_BPS);

    voice.handleSignaling(voiceStream(null));
    await settle();

    // 1080p's own ceiling, because that is what they picked while capped.
    expect(cameraCeilings.at(-1)).toBe(2_500_000);
  });

  it("leaves a presenter who already picked 360p exactly where they were", async () => {
    const { voice } = await presentingHost();
    await voice.setVideoQuality("360p");
    await voice.toggleCamera();
    await settle();
    const before = cameraCeilings.length;

    voice.handleSignaling(voiceStream(1080));
    await settle();

    // Nothing to do, so nothing is done: the cap never raises, and a no-op
    // republish mid-party is a stutter for every viewer of the camera.
    expect(cameraCeilings.slice(before)).toEqual([]);
    expect(ladderReconciles).toBe(0);
  });

  it("does nothing for somebody else's share in the same party", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => ({
      backend: "livekit" as const,
      url: "ws://sfu",
      token: "t",
      room: CHANNEL,
      identity: PEER,
    }));
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    await settle();
    await settle();
    await voice.toggleCamera();
    await settle();
    const before = cameraCeilings.length;

    // Everyone in the room gets this frame. Only the machine whose share is
    // the ladder's source pays for it.
    voice.handleSignaling(voiceStream(1080));
    await settle();

    expect(cameraCeilings.slice(before)).toEqual([]);
  });
});
