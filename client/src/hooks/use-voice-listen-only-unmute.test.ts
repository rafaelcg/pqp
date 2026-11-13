import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * AN UNMUTE ON A LISTEN-ONLY SEAT RETRIES THE MICROPHONE.
 *
 * A join whose microphone could not be opened (permission refused, no device,
 * another app holding it) lands listen-only: muted, no pipeline. The person
 * fixes the cause, presses the microphone button, and `toggleMute` /
 * `setMuted(false)` used to return at once because there was no pipeline to
 * unmute: a control that did nothing. The comment above it claimed it covered
 * "a join whose device could not be opened"; the code only covered audience
 * seats.
 *
 * Pinned here, on both transports (the retry is the join's own leave and
 * rejoin, so the welcome is what differs):
 *  - success makes a normal, unmuted, speaking seat and tells the server
 *    (a second `join-voice-room` after a `leave-voice-room`);
 *  - each way the microphone can fail says why, in words, and never throws;
 *  - an audience seat, a seat the room does not let speak, a seat still
 *    joining and a seat that is presenting are not turned into a rejoin.
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
    setCallActive: () => {},
  })),
}));

const { createVoiceController } = await import("./use-voice");

// ------------------------------------------------------------------ browser

/** Every `getUserMedia({ audio })`, so "did this seat try a microphone" is countable. */
let micRequests = 0;
/** When set, `getUserMedia({ audio })` rejects with an error of this name. */
let micFailure: string | null = null;

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
        if (micFailure) {
          throw Object.assign(new Error(`mic failed: ${micFailure}`), {
            name: micFailure,
          });
        }
        return fakeStream("mic");
      },
      enumerateDevices: async () => [],
      getSupportedConstraints: () => ({ restrictOwnAudio: true }),
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

type Transport = "mesh" | "livekit";

function welcome(transport: Transport, canSpeak = true): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self: {
      peerId: PEER,
      userId: ME,
      displayName: "Me",
      avatarUrl: null,
      sharingScreen: false,
      muted: true,
      deafened: false,
      serverMuted: false,
    },
    peers: [],
    transport,
    canSpeak,
    canStream: true,
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

const joins = (sent: { type: string }[]) =>
  sent.filter((m) => m.type === "join-voice-room").length;
const leaves = (sent: { type: string }[]) =>
  sent.filter((m) => m.type === "leave-voice-room").length;

function controller() {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => ({
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  }));
  return { voice, sent };
}

/** Seated listen-only: the microphone was refused when joining. */
async function seatedListenOnly(kind: Transport, canSpeak = true) {
  micFailure = "NotAllowedError";
  const { voice, sent } = controller();
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome(kind, canSpeak));
  await settle();
  await settle();
  expect(voice.getState().status).toBe("connected");
  expect(voice.getState().isMuted).toBe(true);
  expect(micRequests).toBe(1);
  // The call bar's "listen only" badge reads this, so an audio-only call
  // (no stage, no notice strip) still says why.
  expect(voice.getState().micUnavailableReason).toMatch(/blocked/i);
  return { voice, sent };
}

beforeEach(() => {
  installBrowserStubs();
  micRequests = 0;
  micFailure = null;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe.each(["mesh", "livekit"] as const)("%s: unmute on a listen-only seat", (kind) => {
  it("retries the microphone and becomes a normal speaking seat", async () => {
    const { voice, sent } = await seatedListenOnly(kind);
    // The person has since allowed the microphone.
    micFailure = null;

    voice.toggleMute();
    await settle();
    voice.handleSignaling(welcome(kind));
    await settle();
    await settle();

    expect(micRequests).toBe(2);
    expect(voice.getState().isAudienceSeat).toBe(false);
    expect(voice.getState().isMuted).toBe(false);
    expect(voice.getState().micUnavailableReason).toBeNull();
    // The join's own way of adding a microphone: one leave and a second join,
    // so the roster, the SFU grant and the mesh offers are a normal join's.
    expect(leaves(sent)).toBe(1);
    expect(joins(sent)).toBe(2);
  });

  it("does the same for setMuted(false), and nothing for setMuted(true)", async () => {
    const { voice, sent } = await seatedListenOnly(kind);
    micFailure = null;

    voice.setMuted(true);
    await settle();
    expect(micRequests).toBe(1);
    expect(joins(sent)).toBe(1);

    voice.setMuted(false);
    await settle();
    voice.handleSignaling(welcome(kind));
    await settle();
    await settle();
    expect(micRequests).toBe(2);
    expect(voice.getState().isMuted).toBe(false);
  });

  it.each([
    ["NotAllowedError", /blocked/i],
    ["NotFoundError", /no microphone/i],
    ["NotReadableError", /could not be started/i],
  ] as const)("says why in words when the microphone still fails: %s", async (name, words) => {
    const { voice, sent } = await seatedListenOnly(kind);
    micFailure = name;

    voice.toggleMute();
    await settle();
    voice.handleSignaling(welcome(kind));
    await settle();
    await settle();

    expect(micRequests).toBeGreaterThan(1);
    // Back to a listen-only seat, with the reason, and no error that ends it.
    expect(voice.getState().isMuted).toBe(true);
    expect(voice.getState().error).toBeNull();
    expect(voice.getState().notice).toMatch(words);
    expect(voice.getState().notice).toMatch(/without a microphone/i);
    expect(voice.getState().micUnavailableReason).toMatch(words);
    expect(joins(sent)).toBe(2);
  });

  it("does nothing while the room does not let this person speak", async () => {
    const { voice, sent } = await seatedListenOnly(kind, false);
    micFailure = null;

    voice.toggleMute();
    await settle();

    expect(micRequests).toBe(1);
    expect(joins(sent)).toBe(1);
    expect(leaves(sent)).toBe(0);
  });

  it("does not tear the call down while presenting, and says how to proceed", async () => {
    const { voice, sent } = await seatedListenOnly(kind);
    micFailure = null;
    await voice.startScreenShare();
    expect(voice.getState().isSharingScreen).toBe(true);

    voice.toggleMute();
    await settle();

    expect(micRequests).toBe(1);
    expect(joins(sent)).toBe(1);
    expect(leaves(sent)).toBe(0);
    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().notice).toMatch(/ends your share or camera/i);
  });
});

describe("a seat that is still joining", () => {
  it("is not rejoined by an unmute pressed before the welcome", async () => {
    micFailure = "NotAllowedError";
    const { voice, sent } = controller();
    await voice.join(CHANNEL);
    expect(voice.getState().status).not.toBe("connected");

    voice.toggleMute();
    await settle();

    expect(micRequests).toBe(1);
    expect(leaves(sent)).toBe(0);
    expect(joins(sent)).toBe(1);
  });
});

describe("an audience seat is unchanged", () => {
  it("takes the stage on unmute only when the room allows it", async () => {
    const { voice, sent } = controller();
    await voice.join(CHANNEL, { audienceOnly: true });
    voice.handleSignaling(welcome("livekit", false));
    await settle();
    await settle();
    expect(voice.getState().isAudienceSeat).toBe(true);
    expect(micRequests).toBe(0);

    // SPEAK not granted: silent, exactly as before.
    voice.toggleMute();
    await settle();
    expect(micRequests).toBe(0);
    expect(voice.getState().isAudienceSeat).toBe(true);

    voice.handleSignaling({
      type: "voice-speak-changed",
      voiceChannelId: CHANNEL,
      canSpeak: true,
      canStream: false,
    } as unknown as VoiceSignalingMessage);
    voice.toggleMute();
    await settle();
    voice.handleSignaling(welcome("livekit", true));
    await settle();
    await settle();

    expect(micRequests).toBe(1);
    expect(voice.getState().isAudienceSeat).toBe(false);
    expect(leaves(sent)).toBe(1);
    expect(joins(sent)).toBe(2);
  });
});
