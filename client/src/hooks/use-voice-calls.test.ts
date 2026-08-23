import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * Conversation calls, client side: the controller rings only once it is
 * genuinely in the room, an incoming ring is state the UI can answer, and the
 * camera is off until its own toggle turns it on — and announced to the room
 * every time it changes.
 */

interface ManagerStub {
  peerIds: string[];
  cameraStreamIds: [string, string | null][];
  localCameraStreams: (MediaStream | null)[];
  /** Ceilings handed to the manager, in order. See the video-quality tests. */
  cameraMaxBitrates: number[];
  disposed: boolean;
}

const managers: ManagerStub[] = [];

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = {
      peerIds: [],
      cameraStreamIds: [],
      cameraMaxBitrates: [],
      localCameraStreams: [],
      disposed: false,
    };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      setLocalScreenStream: async () => {},
      setLocalCameraStream: async (stream: MediaStream | null) => {
        stub.localCameraStreams.push(stream);
      },
      setCameraMaxBitrate: (maxBitrate: number) => {
        stub.cameraMaxBitrates.push(maxBitrate);
      },
      setPeerCameraStreamId: (peerId: string, streamId: string | null) => {
        stub.cameraStreamIds.push([peerId, streamId]);
      },
      setPeerScreenAudioStreamId: () => {},
      onPeerStateChange: () => {},
      connectToPeer: (peerId: string) => stub.peerIds.push(peerId),
      removePeer: () => {},
      handleOffer: async () => {},
      handleAnswer: async () => {},
      handleIceCandidate: async () => {},
      retryPeer: async () => {},
      replaceLocalTrack: async () => {},
      setIceServers: () => {},
      dispose: () => {
        stub.disposed = true;
      },
    };
  }),
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
    unpublishCamera: async () => {},
    disconnect: async () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");

// ------------------------------------------------------------------ browser

const stoppedTracks: string[] = [];

function fakeTrack(label: string, kind: "audio" | "video") {
  return {
    kind,
    enabled: true,
    onended: null as null | (() => void),
    stop: () => stoppedTracks.push(label),
  };
}

function fakeStream(label: string, kind: "audio" | "video" = "audio") {
  const tracks = [fakeTrack(label, kind)];
  return {
    id: `stream-${label}`,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
  };
}

/** Every `video` constraint the controller asked for, in order. */
const videoRequests: unknown[] = [];
/**
 * Makes the first *constrained* camera request fail, the way a webcam that
 * cannot manage the requested size does. The bare retry still succeeds, which
 * is the behaviour the fallback exists to guarantee.
 */
let refuseConstrainedCamera = false;

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: { video?: unknown }) => {
        if (!constraints.video) {
          return fakeStream("mic", "audio");
        }
        videoRequests.push(constraints.video);
        if (refuseConstrainedCamera && constraints.video !== true) {
          const err = new Error("OverconstrainedError");
          err.name = "OverconstrainedError";
          throw err;
        }
        return fakeStream("camera", "video");
      },
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
  };
  return { transport, sent };
}

const CONVERSATION = "00000000-0000-4000-8000-0000000000aa";
const OTHER_CONVERSATION = "00000000-0000-4000-8000-0000000000ab";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const REMOTE_PEER = "00000000-0000-4000-8000-0000000000bd";
const CALLER_ID = "00000000-0000-4000-8000-0000000000cc";
const REMOTE_USER = "00000000-0000-4000-8000-0000000000cd";

function participant(peerId: string, userId: string, extra = {}) {
  return {
    peerId,
    userId,
    displayName: "Someone",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    ...extra,
  };
}

function welcome(
  peers: ReturnType<typeof participant>[] = [],
  voiceChannelId = CONVERSATION,
): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId,
    self: participant(PEER, CALLER_ID),
    peers,
    transport: "mesh",
  };
}

function incoming(conversationId = CONVERSATION): VoiceSignalingMessage {
  return {
    type: "call-incoming",
    conversationId,
    kind: "dm",
    caller: { userId: REMOTE_USER, displayName: "Ana", avatarUrl: null },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  installBrowserStubs();
  managers.length = 0;
  stoppedTracks.length = 0;
  videoRequests.length = 0;
  refuseConstrainedCamera = false;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("ringing out", () => {
  it("joinConversationCall rings only after the welcome, never before", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);

    await voice.joinConversationCall(CONVERSATION);
    expect(sent.map((m) => m.type)).toEqual(["join-voice-room"]);

    voice.handleSignaling(welcome());
    const types = sent.map((m) => m.type);
    expect(types).toEqual(["join-voice-room", "call-ring"]);
    expect(sent[1]!.conversationId).toBe(CONVERSATION);
  });

  it("a plain join (accepting, or a server channel) rings nobody", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);

    await voice.join(CONVERSATION);
    voice.handleSignaling(welcome());
    expect(sent.filter((m) => m.type === "call-ring")).toEqual([]);
  });

  it("a ring armed for one channel does not fire for a later join elsewhere", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);

    await voice.joinConversationCall(CONVERSATION);
    // The user changes their mind and joins a different room instead.
    await voice.join(OTHER_CONVERSATION);
    voice.handleSignaling(welcome([], OTHER_CONVERSATION));
    expect(sent.filter((m) => m.type === "call-ring")).toEqual([]);
  });

  it("surfaces a decline from the room", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);

    await voice.joinConversationCall(CONVERSATION);
    voice.handleSignaling(welcome());
    voice.handleSignaling({
      type: "call-declined",
      conversationId: CONVERSATION,
      userId: REMOTE_USER,
    });
    expect(voice.getState().callDeclinedUserIds).toEqual([REMOTE_USER]);

    // Foreign conversations' declines are not ours.
    voice.handleSignaling({
      type: "call-declined",
      conversationId: OTHER_CONVERSATION,
      userId: CALLER_ID,
    });
    expect(voice.getState().callDeclinedUserIds).toEqual([REMOTE_USER]);
  });
});

describe("being rung", () => {
  it("an incoming ring becomes answerable state, once per conversation", () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);

    voice.handleSignaling(incoming());
    voice.handleSignaling(incoming());
    const calls = voice.getState().incomingCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]!.caller.displayName).toBe("Ana");
  });

  it("a server-side cancel dismisses the surface", () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);

    voice.handleSignaling(incoming());
    voice.handleSignaling({
      type: "call-ring-cancelled",
      conversationId: CONVERSATION,
      reason: "timeout",
    });
    expect(voice.getState().incomingCalls).toEqual([]);
  });

  it("declining sends the frame and dismisses; dismissing sends nothing", () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);

    voice.handleSignaling(incoming());
    voice.declineIncomingCall(CONVERSATION);
    expect(voice.getState().incomingCalls).toEqual([]);
    expect(sent).toEqual([
      { type: "call-decline", conversationId: CONVERSATION },
    ]);

    voice.handleSignaling(incoming(OTHER_CONVERSATION));
    voice.dismissIncomingCall(OTHER_CONVERSATION);
    expect(voice.getState().incomingCalls).toEqual([]);
    // Still only the decline frame: dismissing is local silence.
    expect(sent).toHaveLength(1);
  });

  it("accepting is joining: the surface comes down when the call is entered", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);

    voice.handleSignaling(incoming());
    await voice.acceptIncomingCall(CONVERSATION);
    expect(voice.getState().incomingCalls).toEqual([]);
    expect(sent.map((m) => m.type)).toEqual(["join-voice-room"]);
    // And accepting never re-rings the room.
    voice.handleSignaling(welcome());
    expect(sent.filter((m) => m.type === "call-ring")).toEqual([]);
  });

  it("an invitation to another conversation survives leaving this call", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);

    await voice.join(CONVERSATION);
    voice.handleSignaling(welcome());
    voice.handleSignaling(incoming(OTHER_CONVERSATION));
    voice.leave();
    expect(voice.getState().incomingCalls).toHaveLength(1);
  });
});

describe("camera", () => {
  async function connectedController() {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CONVERSATION);
    voice.handleSignaling(
      welcome([participant(REMOTE_PEER, REMOTE_USER)]),
    );
    await settle();
    return { voice, sent };
  }

  it("is off by default and announces itself to the room when toggled on", async () => {
    const { voice, sent } = await connectedController();
    expect(voice.getState().isCameraOn).toBe(false);

    await voice.toggleCamera();
    const state = voice.getState();
    expect(state.isCameraOn).toBe(true);
    expect(state.localCameraStream).not.toBeNull();

    const announced = sent.filter((m) => m.type === "set-camera");
    expect(announced).toEqual([
      { type: "set-camera", streamId: "stream-camera" },
    ]);
    // And the capture reached the mesh.
    expect(managers[0]!.localCameraStreams).toHaveLength(1);
  });

  it("toggling off stops the capture and announces null", async () => {
    const { voice, sent } = await connectedController();
    await voice.toggleCamera();
    await voice.toggleCamera();

    const state = voice.getState();
    expect(state.isCameraOn).toBe(false);
    expect(state.localCameraStream).toBeNull();
    expect(stoppedTracks).toContain("camera");
    expect(sent.filter((m) => m.type === "set-camera").map((m) => m.streamId))
      .toEqual(["stream-camera", null]);
    expect(managers[0]!.localCameraStreams[1]).toBeNull();
  });

  it("leaving the call releases the camera", async () => {
    const { voice } = await connectedController();
    await voice.toggleCamera();
    voice.leave();
    expect(stoppedTracks).toContain("camera");
    expect(voice.getState().isCameraOn).toBe(false);
  });

  it("asks the hardware for a real size instead of taking whatever it offers", async () => {
    // The bug this replaced: `{ video: true }` resolves to 640x480 in every
    // browser, so 480p was the ceiling of a pqp video call.
    const { voice } = await connectedController();
    await voice.toggleCamera();

    expect(videoRequests).toHaveLength(1);
    expect(videoRequests[0]).toMatchObject({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });

  it("still opens the camera when the webcam refuses that size", async () => {
    // A 480p webcam must give 480p video, never an error and a dead button.
    refuseConstrainedCamera = true;
    const { voice, sent } = await connectedController();
    await voice.toggleCamera();

    expect(voice.getState().isCameraOn).toBe(true);
    expect(voice.getState().error).toBeNull();
    expect(videoRequests[1]).toBe(true);
    expect(sent.filter((m) => m.type === "set-camera")).toHaveLength(1);
  });

  it("moves the encoder ceiling mid-call without touching the capture", async () => {
    const { voice } = await connectedController();
    await voice.toggleCamera();
    const before = managers[0]!.cameraMaxBitrates.length;

    await voice.setVideoQuality("360p");

    expect(managers[0]!.cameraMaxBitrates.at(-1)).toBe(400_000);
    expect(managers[0]!.cameraMaxBitrates.length).toBeGreaterThan(before);
    // No re-capture: the webcam light does not blink and no video is dropped.
    expect(stoppedTracks).not.toContain("camera");
    expect(voice.getState().isCameraOn).toBe(true);
  });

  it("opens a later camera at the chosen size", async () => {
    const { voice } = await connectedController();
    await voice.setVideoQuality("1080p");
    await voice.toggleCamera();

    expect(videoRequests.at(-1)).toMatchObject({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
    });
  });

  it("does not open a camera while not in a call", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.toggleCamera();
    expect(voice.getState().isCameraOn).toBe(false);
    expect(sent).toEqual([]);
  });

  it("feeds roster camera stream ids to the mesh for classification", async () => {
    const { voice } = await connectedController();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CONVERSATION,
      participants: [
        participant(PEER, CALLER_ID),
        participant(REMOTE_PEER, REMOTE_USER, {
          cameraStreamId: "their-camera",
        }),
      ],
      transport: "mesh",
    });
    expect(managers[0]!.cameraStreamIds).toContainEqual([
      REMOTE_PEER,
      "their-camera",
    ]);
    // Our own entry is never pushed down: we do not classify ourselves.
    expect(
      managers[0]!.cameraStreamIds.some(([peerId]) => peerId === PEER),
    ).toBe(false);
  });
});
