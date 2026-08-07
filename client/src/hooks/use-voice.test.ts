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
}

vi.mock("@/lib/peer-connection-manager", () => ({
  getDefaultIceServers: () => [],
  createPeerConnectionManager: vi.fn(() => {
    const stub: ManagerStub = { peerIds: [], disposed: false };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      setLocalScreenStream: async () => {},
      setLocalCameraStream: async () => {},
      setPeerCameraStreamId: () => {},
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
    publishCamera: async () => {},
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

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  // Node exposes `navigator` as a getter-only global, so define the one
  // property the mic pipeline reaches for rather than replacing the object.
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => fakeStream("mic") },
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
  peers: { peerId: string }[] = [],
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
    voiceChannelId: CHANNEL,
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
