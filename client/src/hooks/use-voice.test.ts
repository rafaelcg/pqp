import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * The client obeys the room's transport, or leaves and says so.
 *
 * It used to pick mesh-vs-SFU for itself, once per join, silently, and fall
 * back to mesh whenever the SFU path failed for any reason. In a room where
 * everyone else was on the SFU that produced a participant who could neither
 * hear nor be heard, with no error on any screen and no way to tell them apart
 * from someone sitting there muted. Every assertion about `transportFailure`
 * below is really an assertion that the user finds out.
 */

const managers: ManagerStub[] = [];

interface ManagerStub {
  peerIds: string[];
  disposed: boolean;
  /** Every capture handed to the mesh, in order. `null` means "stop sharing". */
  screenStreams: (MediaStream | null)[];
}

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = {
      peerIds: [],
      disposed: false,
      screenStreams: [],
    };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      setLocalScreenStream: async (stream: MediaStream | null) => {
        stub.screenStreams.push(stream);
      },
      setLocalCameraStream: async () => {},
      setCameraMaxBitrate: () => {},
      setPeerCameraStreamId: () => {},
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

/** Screen publications the SFU stub was asked for, in order. */
const sfuScreenPublishes: (MediaStream | null)[] = [];

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async () => {},
    publishScreen: async (stream: MediaStream) => {
      sfuScreenPublishes.push(stream);
    },
    unpublishScreen: async () => {
      sfuScreenPublishes.push(null);
    },
    unpublishScreenAudio: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");

// ------------------------------------------------------------------ browser
// Just enough of the media APIs for the mic pipeline; the speaking loop never
// ticks because rAF is a no-op, which is all this suite needs.

const stoppedTracks: string[] = [];

function fakeTrack(label: string) {
  return {
    enabled: true,
    stop: () => stoppedTracks.push(label),
  };
}

function fakeStream(label: string) {
  const tracks = [fakeTrack(label)];
  return {
    getTracks: () => tracks,
    getAudioTracks: () => tracks,
  };
}

/** A track with the two things the share paths touch: `stop` and `onended`. */
interface FakeCaptureTrack {
  kind: "video" | "audio";
  onended: (() => void) | null;
  stop: () => void;
}

interface FakeCapture {
  id: string;
  getTracks: () => FakeCaptureTrack[];
  getVideoTracks: () => FakeCaptureTrack[];
  getAudioTracks: () => FakeCaptureTrack[];
  removeTrack: (track: FakeCaptureTrack) => void;
}

/**
 * A `getDisplayMedia` result, with or without the system-audio track.
 *
 * Without is the case that must keep working untouched: Safari, Firefox, and
 * every macOS screen or window share land here.
 */
function fakeCapture(id: string, withAudio: boolean): FakeCapture {
  let tracks: FakeCaptureTrack[] = [
    { kind: "video", onended: null, stop: () => stoppedTracks.push(`${id}:video`) },
  ];
  if (withAudio) {
    tracks.push({
      kind: "audio",
      onended: null,
      stop: () => stoppedTracks.push(`${id}:audio`),
    });
  }
  return {
    id,
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    removeTrack: (track) => {
      tracks = tracks.filter((t) => t !== track);
    },
  };
}

/** Arguments every `getDisplayMedia` of the current test received. */
let displayMediaCalls: unknown[] = [];
/** What the next `getDisplayMedia` does. Replaced per test. */
let displayMedia: () => Promise<unknown> = async () => fakeCapture("screen", false);

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  displayMediaCalls = [];
  displayMedia = async () => fakeCapture("screen", false);
  // Node exposes `navigator` as a getter-only global, so define the one
  // property the mic pipeline reaches for rather than replacing the object.
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => fakeStream("mic"),
      getDisplayMedia: async (options: unknown) => {
        displayMediaCalls.push(options);
        return displayMedia();
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

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";

function welcome(
  transport?: "mesh" | "livekit",
  peers: { peerId: string; sharingScreen?: boolean }[] = [],
  voiceChannelId: string = CHANNEL,
): VoiceSignalingMessage {
  const self = {
    peerId: PEER,
    userId: "00000000-0000-4000-8000-0000000000cc",
    displayName: "Me",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
  };
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId,
    self,
    peers: peers.map((p) => ({ ...self, ...p })),
    ...(transport ? { transport } : {}),
  };
}

/** Let the promise chain inside the welcome handler settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sfuSession() {
  return {
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  };
}

/**
 * Screen share carries the machine's audio when the browser will give it, and
 * is silent, working and unremarkable when it will not.
 *
 * The silent case is the majority one (Safari, Firefox, every macOS screen or
 * window capture, and anyone who leaves the box unticked), which is why most of
 * what is pinned here is that nothing about it looks like a failure.
 */
describe("screen share audio", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    sfuScreenPublishes.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  async function connectedMesh() {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    return { voice, sent };
  }

  it("asks for system audio, and for a picker that cannot offer our own tab", async () => {
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(1);
    expect(displayMediaCalls[0]).toMatchObject({
      audio: { echoCancellation: false },
      systemAudio: "include",
      // The anti-feedback rule: sharing the call's own tab would put the call
      // back into the call.
      selfBrowserSurface: "exclude",
    });
  });

  it("publishes the capture and announces its audio stream id", async () => {
    displayMedia = async () => fakeCapture("cap-1", true);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    expect(managers[0]?.screenStreams).toHaveLength(1);
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: "cap-1",
    });
    expect(voice.getState().isSharingScreenAudio).toBe(true);
  });

  it("shares silently, with no error, when the browser gives no audio track", async () => {
    displayMedia = async () => fakeCapture("cap-2", false);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      // Not the id: there is no audio to file under it, and a receiver acting
      // on a stale one would mute the presenter's voice.
      audioStreamId: null,
    });
    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingScreenAudio).toBe(false);
    expect(voice.getState().error).toBeNull();
  });

  it("falls back to a plain video request when the audio one is refused", async () => {
    let attempt = 0;
    displayMedia = async () => {
      attempt += 1;
      if (attempt === 1) {
        const err = new Error("nope");
        err.name = "NotSupportedError";
        throw err;
      }
      return fakeCapture("cap-3", false);
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(2);
    expect(displayMediaCalls[1]).toEqual({ video: true });
    expect(voice.getState().isSharingScreen).toBe(true);
  });

  it("does not reopen the picker when the capture itself failed", async () => {
    displayMedia = async () => {
      // Raised after the user has already chosen a surface. Asking again would
      // put a second picker on screen with nothing to explain it.
      const err = new Error("could not start");
      err.name = "NotReadableError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    expect(displayMediaCalls).toHaveLength(1);
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).not.toBeNull();
  });

  it("does not reopen the picker when the user dismissed it", async () => {
    displayMedia = async () => {
      const err = new Error("denied");
      err.name = "NotAllowedError";
      throw err;
    };
    const { voice } = await connectedMesh();
    await voice.startScreenShare();

    // Asking twice would be arguing with someone who just said no.
    expect(displayMediaCalls).toHaveLength(1);
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).not.toBeNull();
  });

  it("stops both tracks and withdraws the announcement", async () => {
    displayMedia = async () => fakeCapture("cap-4", true);
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();
    await voice.stopScreenShare();

    expect(stoppedTracks).toContain("cap-4:video");
    expect(stoppedTracks).toContain("cap-4:audio");
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: false,
      audioStreamId: null,
    });
    expect(managers[0]?.screenStreams.at(-1)).toBeNull();
    expect(voice.getState().isSharingScreenAudio).toBe(false);
  });

  it("keeps the picture when only the audio track ends", async () => {
    const capture = fakeCapture("cap-5", true);
    displayMedia = async () => capture;
    const { voice, sent } = await connectedMesh();
    await voice.startScreenShare();

    const audio = capture.getAudioTracks()[0]!;
    audio.onended?.();
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingScreenAudio).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      type: "set-sharing-screen",
      sharing: true,
      audioStreamId: null,
    });
    // Re-published without the audio half rather than torn down.
    expect(managers[0]?.screenStreams.at(-1)).not.toBeNull();
  });

  it("hands the whole capture to the SFU, audio included", async () => {
    displayMedia = async () => fakeCapture("cap-6", true);
    const { transport } = createTransport();
    const voice = createVoiceController(transport);
    voice.setSessionProvider(async () => sfuSession());
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("livekit"));
    await settle();

    await voice.startScreenShare();
    expect(sfuScreenPublishes).toHaveLength(1);
    expect(
      (sfuScreenPublishes[0] as unknown as FakeCapture).getAudioTracks(),
    ).toHaveLength(1);

    await voice.stopScreenShare();
    expect(sfuScreenPublishes.at(-1)).toBeNull();
  });
});

describe("concurrent screen shares", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    sfuScreenPublishes.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  function participant(peerId: string, sharingScreen: boolean) {
    return {
      peerId,
      userId: "00000000-0000-4000-8000-0000000000dd",
      displayName: peerId,
      avatarUrl: null,
      sharingScreen,
      muted: false,
      deafened: false,
    };
  }

  async function connectedMesh() {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome("mesh"));
    await settle();
    return { voice, sent };
  }

  it("tracks every sharer and plays both when there are two", async () => {
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    const state = voice.getState();
    expect(state.screenSharePeerIds).toEqual(["aaa", "bbb"]);
    expect(state.focusedScreenPeerId).toBe("aaa");
    expect(state.audibleScreenPeerIds).toEqual(["aaa", "bbb"]);
  });

  it("skips the picker when the mesh cap is already full", async () => {
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    await voice.startScreenShare();
    expect(displayMediaCalls).toHaveLength(0);
    expect(voice.getState().error).toMatch(/2/);
    expect(voice.getState().isSharingScreen).toBe(false);
  });

  it("stops the capture when the server denies a share at the cap", async () => {
    const { voice } = await connectedMesh();
    await voice.startScreenShare();
    expect(voice.getState().isSharingScreen).toBe(true);
    voice.handleSignaling({
      type: "screen-share-denied",
      voiceChannelId: CHANNEL,
    });
    await settle();
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().error).toMatch(/2/);
  });

  it("treats a channel switch as a join into live shares, not a newest-diff", async () => {
    const other = "00000000-0000-4000-8000-0000000000ee";
    const { voice } = await connectedMesh();
    voice.handleSignaling({
      type: "voice-roster",
      voiceChannelId: CHANNEL,
      transport: "mesh",
      participants: [
        participant(PEER, false),
        participant("aaa", true),
        participant("bbb", true),
      ],
    });
    expect(voice.getState().focusedScreenPeerId).toBe("aaa");

    await voice.join(other);
    expect(voice.getState().screenSharePeerIds).toEqual([]);

    voice.handleSignaling(
      welcome(
        "mesh",
        [
          { peerId: "ccc", sharingScreen: true },
          { peerId: "ddd", sharingScreen: true },
        ],
        other,
      ),
    );
    await settle();
    expect(voice.getState().screenSharePeerIds).toEqual(["ccc", "ddd"]);
    expect(voice.getState().focusedScreenPeerId).toBe("ccc");
    expect(voice.getState().audibleScreenPeerIds).toEqual(["ccc", "ddd"]);
  });
});

describe("voice transport is the server's decision", () => {
  beforeEach(() => {
    installBrowserStubs();
    managers.length = 0;
    stoppedTracks.length = 0;
    vi.mocked(connectLiveKit).mockClear();
  });

  describe("mesh room", () => {
    it("builds a peer mesh and never asks for an SFU session", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      const provider = vi.fn(async () => sfuSession());
      voice.setSessionProvider(provider);

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("mesh", [{ peerId: "other" }]));
      await settle();

      // Having an SFU available does not entitle a client to use it: the room
      // is mesh, so the room is mesh for everybody.
      expect(provider).not.toHaveBeenCalled();
      expect(managers[0]?.peerIds).toEqual(["other"]);
      expect(voice.getState().status).toBe("connected");
      expect(voice.getState().usingSfu).toBe(false);
      expect(voice.getState().transportFailure).toBeNull();
    });

    it("declares mesh-only capability when it has no SFU provider", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);

      expect(sent[0]).toEqual({
        type: "join-voice-room",
        voiceChannelId: CHANNEL,
        transports: ["mesh"],
      });
    });

    it("declares both transports when it can run either", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => sfuSession());

      await voice.join(CHANNEL);

      expect(sent[0]).toMatchObject({ transports: ["mesh", "livekit"] });
    });
  });

  describe("SFU room", () => {
    it("connects to the SFU and reports connected only once media is up", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      let release: (() => void) | null = null;
      voice.setSessionProvider(
        () =>
          new Promise((resolve) => {
            release = () => resolve(sfuSession());
          }),
      );

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      // The old code said "Voice connected" here and stayed there for the 15s
      // LiveKit takes to give up on a black-holed host, with no audio either way.
      expect(voice.getState().status).toBe("joining");

      release!();
      await settle();

      expect(voice.getState().status).toBe("connected");
      expect(voice.getState().usingSfu).toBe(true);
      // No mesh was built alongside it.
      expect(managers).toHaveLength(0);
    });

    it("leaves the call when the SFU cannot be reached, instead of joining the mesh", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => {
        throw new Error("503 Voice backend unavailable");
      });

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      const state = voice.getState();
      // THE FIX. Previously: a peer mesh, a roster entry, and total silence.
      expect(managers).toHaveLength(0);
      expect(state.status).toBe("idle");
      expect(state.transportFailure).toEqual({
        transport: "livekit",
        reason: "unreachable",
      });
      expect(state.error).toContain("you have not joined");
      // Nobody is left seeing a participant who is not in the call.
      expect(sent.map((m) => m.type)).toContain("leave-voice-room");
      // And the mic is released, so the recording indicator does not linger.
      expect(stoppedTracks).toContain("mic");
    });

    it("refuses up front when this build cannot run an SFU at all", async () => {
      const { transport, sent } = createTransport();
      const voice = createVoiceController(transport);
      // e.g. VITE_VOICE_BACKEND=mesh, against a server that predates the
      // server-side capability check.

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome("livekit"));
      await settle();

      expect(managers).toHaveLength(0);
      expect(voice.getState().transportFailure).toEqual({
        transport: "livekit",
        reason: "unsupported",
      });
      expect(sent.map((m) => m.type)).toContain("leave-voice-room");
    });

    it("surfaces a server-side refusal as its own outcome, not a generic drop", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);
      voice.handleSignaling({
        type: "voice-transport-unsupported",
        voiceChannelId: CHANNEL,
        transport: "livekit",
      });

      const state = voice.getState();
      expect(state.status).toBe("idle");
      expect(state.transportFailure).toEqual({
        transport: "livekit",
        reason: "unsupported",
      });
      expect(state.voiceChannelId).toBeNull();
      expect(managers).toHaveLength(0);
    });

    it("ignores a refusal aimed at a channel it is not joining", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);

      await voice.join(CHANNEL);
      voice.handleSignaling({
        type: "voice-transport-unsupported",
        voiceChannelId: "00000000-0000-4000-8000-0000000000ff",
        transport: "livekit",
      });

      expect(voice.getState().status).toBe("joining");
      expect(voice.getState().transportFailure).toBeNull();
    });
  });

  describe("server too old to state the transport", () => {
    it("uses mesh, which is what a mesh-only deployment has always done", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      // Provider registered, backend probe said mesh — the old behaviour.
      voice.setSessionProvider(async () => sfuSession(), "mesh");

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome(undefined, [{ peerId: "other" }]));
      await settle();

      expect(managers).toHaveLength(1);
      expect(voice.getState().status).toBe("connected");
      expect(connectLiveKit).not.toHaveBeenCalled();
    });

    it("uses the SFU when the backend probe said so", async () => {
      const { transport } = createTransport();
      const voice = createVoiceController(transport);
      voice.setSessionProvider(async () => sfuSession(), "livekit");

      await voice.join(CHANNEL);
      voice.handleSignaling(welcome());
      await settle();

      expect(managers).toHaveLength(0);
      expect(voice.getState().usingSfu).toBe(true);
    });
  });
});
