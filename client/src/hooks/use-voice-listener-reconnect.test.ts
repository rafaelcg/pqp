import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * A LISTENER'S SEAT SURVIVES A SOCKET RECONNECT, THE WAY A SPEAKER'S DOES.
 *
 * Seen in production on 2026-10-24, one LiveKit room with about 74 people
 * watching a screen share: 210 joins, every one cold, 6 of 74 orphaned seats
 * ever resumed, and some people joining 14 times in 90 minutes. A drop on the
 * socket (a phone changing network) is not a hangup, and the server holds the
 * seat for 90 s for exactly that.
 *
 * `notifyReconnected` read "no mic pipeline" as "the media was dropped" and
 * called `join()`. A seat with no pipeline is not a dropped seat: it is an
 * AUDIENCE seat (`audienceOnly`, no device ever asked for) or the listen-only
 * fallback of a microphone that would not open, which is most of a share's
 * viewers. `join()`'s idempotency guard sends such a seat to
 * `retakeSeatWithMicrophone`, which sends `leave-voice-room` WITH the resume
 * pair (retiring the seat the server was holding) and joins cold, asking for
 * the microphone too. The reconnect tests next door only ever had a pipeline.
 */

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

const faroEvents = vi.hoisted(
  () => [] as { name: string; attributes: Record<string, string> }[],
);
vi.mock("@/lib/faro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/faro")>()),
  reportFaroEvent: (name: string, attributes: Record<string, string> = {}) => {
    faroEvents.push({ name, attributes });
  },
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
    reconcileCameraLadder: async () => {},
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setScreenHlsPublishHeight: () => {},
    setReceiveQuality: async () => {},
    setHlsSource: async () => {},
    setAudioDelivery: () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    screenPublishLive: () => false,
    setCallActive: () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");
const { connectLiveKit } = await import("@/lib/livekit-session");

// ------------------------------------------------------------------ browser

/** Every `getUserMedia({ audio })`, so "did this seat open a microphone" is countable. */
let micRequests = 0;
/** The browser refuses the microphone: the seat falls back to listen-only. */
let micDenied = false;

function fakeTrack(kind: "audio" | "video") {
  return {
    kind,
    id: `${kind}-track`,
    enabled: true,
    contentHint: "",
    onended: null as null | (() => void),
    stop: () => {},
    applyConstraints: async () => {},
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
          return fakeStream("camera", "video");
        }
        micRequests += 1;
        if (micDenied) {
          throw new DOMException("denied", "NotAllowedError");
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
const TOKEN = "resume-token-1";

function welcome(
  extra: { resumed?: boolean; canSpeak?: boolean } = {},
): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self: {
      peerId: PEER,
      userId: ME,
      displayName: "Viewer",
      avatarUrl: null,
      sharingScreen: false,
      muted: true,
      deafened: false,
      serverMuted: false,
    },
    peers: [],
    transport: "livekit",
    canSpeak: extra.canSpeak ?? false,
    canStream: false,
    resumeToken: TOKEN,
    ...(extra.resumed ? { resumed: true } : {}),
  } as unknown as VoiceSignalingMessage;
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
    setCallActive: () => {},
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return { transport, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function seat(kind: "audience" | "listen-only" | "mic") {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => ({
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  }));
  micDenied = kind === "listen-only";
  await voice.join(
    CHANNEL,
    kind === "audience" ? { audienceOnly: true } : undefined,
  );
  voice.handleSignaling(welcome());
  await settle();
  await settle();
  expect(voice.getState().status).toBe("connected");
  expect(voice.getState().usingSfu).toBe(true);
  expect(micRequests).toBe(kind === "audience" ? 0 : 1);
  micRequests = 0;
  sent.length = 0;
  faroEvents.length = 0;
  vi.mocked(connectLiveKit).mockClear();
  return { voice, sent };
}

beforeEach(() => {
  installBrowserStubs();
  micRequests = 0;
  micDenied = false;
  faroEvents.length = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe.each(["audience", "listen-only"] as const)(
  "a %s seat in a LiveKit room when the socket comes back",
  (kind) => {
    it("asks to resume the same seat, with no leave and no microphone", async () => {
      const { voice, sent } = await seat(kind);

      voice.notifyDisconnected();
      await voice.notifyReconnected();

      expect(sent.map((m) => m.type)).toEqual(["join-voice-room"]);
      expect(sent[0]).toMatchObject({
        type: "join-voice-room",
        voiceChannelId: CHANNEL,
        resume: true,
        resumePeerId: PEER,
        resumeToken: TOKEN,
      });
      expect(micRequests).toBe(0);
      expect(voice.getState().isAudienceSeat).toBe(kind === "audience");
    });

    it("keeps the media session and the seat when the server says resumed", async () => {
      const { voice, sent } = await seat(kind);

      voice.notifyDisconnected();
      await voice.notifyReconnected();
      voice.handleSignaling(welcome({ resumed: true }));
      await settle();

      expect(voice.getState().status).toBe("connected");
      expect(voice.getState().peerId).toBe(PEER);
      expect(voice.getState().usingSfu).toBe(true);
      expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(0);
      // The SFU session was never rebuilt: the same one carried the seat.
      expect(connectLiveKit).not.toHaveBeenCalled();
      expect(micRequests).toBe(0);
    });

    it("says what it did, without saying who it is", async () => {
      const { voice } = await seat(kind);

      voice.notifyDisconnected();
      await voice.notifyReconnected();

      const events = faroEvents.filter((e) => e.name === "voice.reconnect");
      expect(events).toHaveLength(1);
      expect(events[0]?.attributes).toMatchObject({
        hadMic: "false",
        seat: kind,
        path: "resume",
        transport: "livekit",
        hasPeerId: "true",
        hasToken: "true",
      });
      const text = JSON.stringify(events);
      expect(text).not.toContain(PEER);
      expect(text).not.toContain(ME);
      expect(text).not.toContain(CHANNEL);
    });

    it("joins cold as a listener, still without a leave, once the resume window has passed", async () => {
      const { voice, sent } = await seat(kind);
      vi.useFakeTimers();
      try {

        voice.notifyDisconnected();
        // The outage outlasted the orphan window: the held session is
        // dropped and the grace timer cold-joins by itself, so the
        // reconnect that follows finds a seat with no token.
        await vi.advanceTimersByTimeAsync(90_001);
        sent.length = 0;
        await voice.notifyReconnected();

        expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(0);
        expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(1);
        expect(sent[0]).not.toHaveProperty("resumePeerId");
        // A cold rejoin of a listener is not a request for the microphone.
        expect(micRequests).toBe(0);
        expect(voice.getState().isAudienceSeat).toBe(kind === "audience");
      } finally {
        vi.useRealTimers();
      }
    });
  },
);

describe("a seat with a microphone", () => {
  it("still resumes exactly as before", async () => {
    const { voice, sent } = await seat("mic");

    voice.notifyDisconnected();
    await voice.notifyReconnected();

    expect(sent.map((m) => m.type)).toEqual(["join-voice-room"]);
    expect(sent[0]).toMatchObject({
      resumePeerId: PEER,
      resumeToken: TOKEN,
    });
    expect(faroEvents.find((e) => e.name === "voice.reconnect")?.attributes).toMatchObject({
      hadMic: "true",
      seat: "mic",
      path: "resume",
    });
  });
});

describe("an audience join whose welcome never came", () => {
  it("rejoins as audience on a reconnect, never asking for a microphone", async () => {
    const { transport, sent } = createTransport();
    const voice = createVoiceController(transport);
    // No welcome yet: no peer id and no token, so there is nothing to resume.
    await voice.join(CHANNEL, { audienceOnly: true });
    sent.length = 0;
    voice.notifyDisconnected();
    await voice.notifyReconnected();

    // A plain cold join; the point is that it is not a retake.
    expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(1);
    expect(micRequests).toBe(0);
    expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(0);
  });
});
