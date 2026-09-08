import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * THE ROOM MOVED UNDER US, ON PURPOSE.
 *
 * `voice-transport-changed` is the one frame that breaks the rule the rest of
 * the transport machinery enforces: a room keeps the transport it opened on.
 * Somebody turned on a fourth camera, the mesh could not carry it, and the
 * server moved the whole room to the SFU (see the promotion section in
 * `server/src/ws/voice.ts`).
 *
 * What has to be true on this side, and is asserted below:
 *
 * - the mesh comes down, exactly once, and a LiveKit session comes up, exactly
 *   once, against the SAME peer id (a rejoin would tell the room we left),
 * - mute and camera intent survive the move,
 * - the person is told, in their language, that the call became a large room,
 * - a transport this build does not know is ignored and we stay put, because
 *   guessing is what produced the split-brain in the first place,
 * - a second copy of the frame does not tear a live session down.
 */

interface ManagerStub {
  peerIds: string[];
  localCameraStreams: (MediaStream | null)[];
  disposed: boolean;
}

const managers: ManagerStub[] = [];

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
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = {
      peerIds: [],
      localCameraStreams: [],
      disposed: false,
    };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      // Null is "nothing measured", which is the old constant: these
      // fakes hold no peer connections to read an uplink from.
      measureUplinkBps: async () => null,
      setLocalScreenStream: async () => {},
      setLocalCameraStream: async (stream: MediaStream | null) => {
        stub.localCameraStreams.push(stream);
      },
      setCameraMaxBitrate: () => {},
      setScreenQuality: () => {},
      setPeerCameraStreamId: () => {},
      setPeerScreenAudioStreamId: () => {},
      setPeerSharingScreen: () => {},
      onPeerStateChange: () => {},
      connectToPeer: (peerId: string) => stub.peerIds.push(peerId),
      setPeerIdentity: () => {},
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

/** What the LiveKit session the promotion built was asked to publish. */
const sfuCameraPublishes: MediaStream[] = [];
const sfuMicPublishes: MediaStream[] = [];
const sfuMuteCalls: boolean[] = [];
let sfuFails = false;
/**
 * While true, `connectLiveKit` parks until `releaseSfuConnect` is called.
 * A promotion is not instant, and the interesting duplicate is the one that
 * lands while the first connect is still in flight.
 */
let holdSfuConnect = false;
let releaseSfuConnect: (() => void) | null = null;

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => {
    if (sfuFails) {
      throw new Error("SFU unreachable");
    }
    if (holdSfuConnect) {
      await new Promise<void>((resolve) => {
        releaseSfuConnect = resolve;
      });
    }
    return {
      publish: async (stream: MediaStream) => {
        sfuMicPublishes.push(stream);
      },
      replaceTrack: async () => {},
      setMuted: async (muted: boolean) => {
        sfuMuteCalls.push(muted);
      },
      publishScreen: async () => {},
      unpublishScreen: async () => {},
      unpublishScreenAudio: async () => {},
      publishCamera: async (stream: MediaStream) => {
        sfuCameraPublishes.push(stream);
      },
      setCameraMaxBitrate: async () => {},
      setScreenMaxBitrate: async () => {},
      setScreenQuality: async () => {},
      setReceiveQuality: async () => {},
      setAudioDelivery: () => {},
      unpublishCamera: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
    };
  }),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");
const { isCameraAtCap, isScreenShareAtCap } = await import(
  "@/lib/screen-share-roster"
);

// ------------------------------------------------------------------ browser

function fakeTrack(kind: "audio" | "video") {
  return { kind, enabled: true, onended: null, stop: () => {} };
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
  };
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  g.setInterval = () => 1;
  g.clearInterval = () => {};
  g.window = {
    addEventListener: () => {},
    dispatchEvent: () => true,
  };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: { video?: unknown }) =>
        constraints.video ? fakeStream("camera", "video") : fakeStream("mic"),
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

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const OTHER = "00000000-0000-4000-8000-0000000000bc";
const ME = "00000000-0000-4000-8000-0000000000cc";

function participant(peerId: string, extra = {}) {
  return {
    peerId,
    userId: ME,
    displayName: "Someone",
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
    peers: [participant(OTHER)],
    transport: "mesh",
  };
}

function promoted(
  extra: Partial<{ transport: "mesh" | "livekit"; reason: "cameras" | "screens" }> = {},
): VoiceSignalingMessage {
  return {
    type: "voice-transport-changed",
    voiceChannelId: CHANNEL,
    transport: "livekit",
    reason: "cameras",
    participants: [participant(PEER), participant(OTHER)],
    ...extra,
  } as VoiceSignalingMessage;
}

function sfuSession() {
  return {
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function connectedMesh() {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => sfuSession());
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome());
  await settle();
  expect(voice.getState().roomTransport).toBe("mesh");
  expect(managers).toHaveLength(1);
  return { voice, sent };
}

beforeEach(() => {
  installBrowserStubs();
  managers.length = 0;
  sfuCameraPublishes.length = 0;
  sfuMicPublishes.length = 0;
  sfuMuteCalls.length = 0;
  sfuFails = false;
  holdSfuConnect = false;
  releaseSfuConnect = null;
  vi.mocked(connectLiveKit).mockClear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("following a room onto the voice server", () => {
  it("tears the mesh down and connects LiveKit once, keeping the seat", async () => {
    const { voice, sent } = await connectedMesh();

    voice.handleSignaling(promoted());
    await settle();
    await settle();

    expect(managers[0]!.disposed).toBe(true);
    expect(connectLiveKit).toHaveBeenCalledTimes(1);
    const state = voice.getState();
    expect(state.roomTransport).toBe("livekit");
    expect(state.usingSfu).toBe(true);
    expect(state.status).toBe("connected");
    // The seat is the same one. A rejoin would have told the room we left.
    expect(state.peerId).toBe(PEER);
    expect(sent.map((m) => m.type)).not.toContain("leave-voice-room");
    expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(1);
  });

  it("carries the mute across the move", async () => {
    const { voice } = await connectedMesh();
    voice.setMuted(true);
    expect(voice.getState().isMuted).toBe(true);

    voice.handleSignaling(promoted());
    await settle();
    await settle();

    expect(voice.getState().isMuted).toBe(true);
    // The mic was published and then held muted on the SFU, in that order, so
    // no live packet escapes between the publish and the mute.
    expect(sfuMicPublishes).toHaveLength(1);
    expect(sfuMuteCalls).toContain(true);
    expect(sfuMuteCalls).not.toContain(false);
  });

  it("carries the camera across the move and re-announces it", async () => {
    const { voice, sent } = await connectedMesh();
    await voice.toggleCamera();
    expect(voice.getState().isCameraOn).toBe(true);

    voice.handleSignaling(promoted());
    await settle();
    await settle();

    expect(voice.getState().isCameraOn).toBe(true);
    expect(sfuCameraPublishes).toHaveLength(1);
    expect(
      sent
        .filter((m) => m.type === "set-camera")
        .map((m) => m.streamId as string | null),
    ).toEqual(["stream-camera", "stream-camera", "stream-camera"]);
  });

  it("says what happened, in the app's voice", async () => {
    const { voice } = await connectedMesh();

    voice.handleSignaling(promoted());
    await settle();

    expect(voice.getState().notice).toBe(
      "This call became a large room so more cameras fit",
    );
  });

  it("says the right thing when a screen share is what moved the room", async () => {
    const { voice } = await connectedMesh();

    voice.handleSignaling(promoted({ reason: "screens" }));
    await settle();

    expect(voice.getState().notice).toBe(
      "This call became a large room so more screens fit",
    );
  });

  it("never follows a demotion: a live SFU room stays on the SFU", async () => {
    // Nothing demotes a room today, so a `mesh` here is either a server this
    // build does not understand or a frame that should not exist. Following
    // it would put this client on a peer mesh while the rest of the room is
    // on the SFU, which is the exact split-brain the transport rule exists
    // to prevent, and it is invisible on every screen.
    const { voice } = await connectedMesh();
    voice.handleSignaling(promoted());
    await settle();
    await settle();
    expect(voice.getState().roomTransport).toBe("livekit");
    vi.mocked(connectLiveKit).mockClear();

    voice.handleSignaling(promoted({ transport: "mesh" }));
    await settle();
    await settle();

    expect(voice.getState().roomTransport).toBe("livekit");
    expect(voice.getState().usingSfu).toBe(true);
    expect(voice.getState().status).toBe("connected");
    // No second mesh was built behind the SFU session.
    expect(managers).toHaveLength(1);
    expect(connectLiveKit).not.toHaveBeenCalled();
  });

  it("ignores a promotion for another room", async () => {
    const { voice } = await connectedMesh();

    voice.handleSignaling({
      ...(promoted() as Record<string, unknown>),
      voiceChannelId: "00000000-0000-4000-8000-0000000000ff",
    } as VoiceSignalingMessage);
    await settle();

    expect(connectLiveKit).not.toHaveBeenCalled();
    expect(voice.getState().roomTransport).toBe("mesh");
  });

  it("does not start a second session when the frame arrives twice mid-connect", async () => {
    // Two instances announcing the same promotion, or a bus replay. The
    // window that matters is while the first connect is still in flight: a
    // second `connectLiveKit` there leaves an orphan session publishing this
    // microphone into the room nobody is reading.
    const { voice } = await connectedMesh();
    holdSfuConnect = true;

    voice.handleSignaling(promoted());
    await settle();
    expect(connectLiveKit).toHaveBeenCalledTimes(1);

    voice.handleSignaling(promoted());
    await settle();

    expect(connectLiveKit).toHaveBeenCalledTimes(1);

    releaseSfuConnect?.();
    await settle();
    await settle();
    expect(voice.getState().usingSfu).toBe(true);
    expect(sfuMicPublishes).toHaveLength(1);
  });

  it("leaves and says so when the promoted room cannot be reached", async () => {
    const { voice, sent } = await connectedMesh();
    sfuFails = true;

    voice.handleSignaling(promoted());
    await settle();
    await settle();

    const state = voice.getState();
    // Never a mesh rebuilt behind the room's back: everyone else has moved.
    expect(state.status).toBe("idle");
    expect(state.transportFailure).toEqual({
      transport: "livekit",
      reason: "unreachable",
    });
    expect(sent.map((m) => m.type)).toContain("leave-voice-room");
  });
});

describe("a build that could not follow", () => {
  it("leaves with the promotion's own sentence, not the generic one", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    await settle();

    voice.handleSignaling({
      type: "voice-transport-unsupported",
      voiceChannelId: CHANNEL,
      transport: "livekit",
      reason: "promoted",
    });

    const state = voice.getState();
    expect(state.status).toBe("idle");
    expect(state.transportFailure).toEqual({
      transport: "livekit",
      reason: "promoted",
    });
    expect(state.error).toContain("Join again");
  });
});

describe("the local camera and share caps defer to a room that can move", () => {
  it("does not refuse locally on a mesh room with a voice server behind it", async () => {
    const { voice } = await connectedMesh();
    expect(voice.getState().canPromoteTransport).toBe(true);

    // Three other cameras: the mesh cap, and the exact moment the complaint
    // was about. The click has to reach the server, or the server can never
    // move the room.
    expect(isCameraAtCap(["a", "b", "c"], PEER, "mesh", true)).toBe(false);
    expect(isScreenShareAtCap(["a", "b"], PEER, "mesh", true)).toBe(false);
  });

  it("still refuses locally where the room cannot move", async () => {
    // No SFU on this deployment: the cap is the whole truth and the button
    // should be dead rather than refused a round trip later.
    expect(isCameraAtCap(["a", "b", "c"], PEER, "mesh", false)).toBe(true);
  });

  it("never refuses locally on a voice-server room, however many are on", () => {
    // The SFU's own ceiling used to be eight and is now the box's budget,
    // which only the server can price (`server/src/voice/promotion.ts`). So
    // the button stays live and a refusal arrives as `camera-denied` in
    // words. Greying it here would be the client inventing a number.
    const eight = ["a", "b", "c", "d", "e", "f", "g", "h"];
    expect(isCameraAtCap(eight, PEER, "livekit", true)).toBe(false);
    expect(
      isCameraAtCap([...eight, ...eight, ...eight], PEER, "livekit", false),
    ).toBe(false);
  });

  it("reports no promotion available when this build has no SFU provider", async () => {
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome());
    await settle();

    expect(voice.getState().canPromoteTransport).toBe(false);
  });
});
