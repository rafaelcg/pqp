import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * A WATCH PARTY GUEST WHO IS CALLED UP GETS A MICROPHONE.
 *
 * Seen live on 2026-09-18: a host invited a viewer to the stage, the viewer
 * accepted, the on-air strip appeared over their video, and their microphone
 * button did nothing at all. Ever.
 *
 * The seat was the problem, not the permission. A watch party viewer sits in
 * an AUDIENCE SEAT: `audienceOnly` opens no `getUserMedia`, so there is no
 * pipeline and nothing to unmute. Going on air
 * (`handleWatchPartyGuestGoOnAir`) asks for the room again WITH a microphone,
 * and `join()` opened with an idempotency guard — "already in this channel,
 * nothing to do" — that swallowed it whole. So the server accepted the guest,
 * the UI said they were on air, and the seat underneath was still the
 * seatless one. `toggleMute` no-ops without a pipeline, which is why the
 * button was silent rather than broken.
 *
 * Two doors are pinned here, because a guest reaches the stage through
 * either: the join that asks for a microphone, and the unmute pressed on a
 * seat that has none. Both must end with a real capture, and the guard must
 * still hold for every join that is genuinely redundant.
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
  })),
}));

const { createVoiceController } = await import("./use-voice");

// ------------------------------------------------------------------ browser

/** Every `getUserMedia({ audio })`, so "did this seat open a microphone" is countable. */
let micRequests = 0;

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

function welcome(canSpeak: boolean): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self: {
      peerId: PEER,
      userId: ME,
      displayName: "Guest",
      avatarUrl: null,
      sharingScreen: false,
      muted: true,
      deafened: false,
      serverMuted: false,
    },
    peers: [],
    transport: "livekit",
    canSpeak,
    canStream: false,
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
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return { transport, sent };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A viewer watching a party from an audience seat: seated, no microphone. */
async function seatedAudience(canSpeak = false) {
  const { transport, sent } = createTransport();
  const voice = createVoiceController(transport);
  voice.setSessionProvider(async () => ({
    backend: "livekit" as const,
    url: "ws://sfu",
    token: "t",
    room: CHANNEL,
    identity: PEER,
  }));
  await voice.join(CHANNEL, { audienceOnly: true });
  voice.handleSignaling(welcome(canSpeak));
  await settle();
  await settle();
  expect(voice.getState().isAudienceSeat).toBe(true);
  expect(micRequests).toBe(0);
  return { voice, sent };
}

beforeEach(() => {
  installBrowserStubs();
  micRequests = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("a watch party guest going on air", () => {
  it("opens a microphone when the room is asked for again with one", async () => {
    const { voice, sent } = await seatedAudience(true);

    // `handleWatchPartyGuestGoOnAir`: the server has accepted the guest, and
    // this is the same channel they are already watching from.
    await voice.join(CHANNEL);
    voice.handleSignaling(welcome(true));
    await settle();
    await settle();

    expect(micRequests).toBe(1);
    expect(voice.getState().isAudienceSeat).toBe(false);
    // Arriving on the stage unmuted is the point: they asked to be there.
    expect(voice.getState().isMuted).toBe(false);
    // The seat was rebuilt, not patched: one leave and a second join.
    expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(1);
    expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(2);
  });

  it("opens a microphone when the guest presses unmute on a seatless seat", async () => {
    const { voice } = await seatedAudience(false);

    // The host calls them up: the server grants SPEAK and says so.
    voice.handleSignaling({
      type: "voice-speak-changed",
      voiceChannelId: CHANNEL,
      canSpeak: true,
      canStream: false,
    } as unknown as VoiceSignalingMessage);
    expect(voice.getState().canSpeak).toBe(true);

    // The on-air strip's microphone button is `toggleMute`.
    voice.toggleMute();
    await settle();
    voice.handleSignaling(welcome(true));
    await settle();
    await settle();

    expect(micRequests).toBe(1);
    expect(voice.getState().isAudienceSeat).toBe(false);
    expect(voice.getState().isMuted).toBe(false);
  });

  it("stays silent when the room has not granted SPEAK", async () => {
    const { voice } = await seatedAudience(false);

    voice.toggleMute();
    await settle();

    // No device asked for, and no seat torn down, on a press the server
    // would refuse anyway.
    expect(micRequests).toBe(0);
    expect(voice.getState().isAudienceSeat).toBe(true);
  });
});

describe("the join guard still holds", () => {
  it("ignores a second audience join into the room already being watched", async () => {
    const { voice, sent } = await seatedAudience(true);

    await voice.join(CHANNEL, { audienceOnly: true });
    await settle();

    expect(micRequests).toBe(0);
    expect(voice.getState().isAudienceSeat).toBe(true);
    expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(1);
  });

  it("ignores a second join into a room this seat already has a microphone in", async () => {
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
    voice.handleSignaling(welcome(true));
    await settle();
    await settle();
    expect(micRequests).toBe(1);

    await voice.join(CHANNEL);
    await settle();

    expect(micRequests).toBe(1);
    expect(sent.filter((m) => m.type === "leave-voice-room")).toHaveLength(0);
    expect(sent.filter((m) => m.type === "join-voice-room")).toHaveLength(1);
  });
});
