import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * "VOZ SEPARADA": THE PRESENTER'S MIC STAYS OUT OF THE FILM'S OWN AUDIO.
 *
 * `LIVE_HLS_VOICE_TRACK` (`docs/plans/WATCH_PARTY_SEPARATE_TRACKS.md`) lets a
 * presenter keep their voice off the screen-share mix entirely, so it can
 * ride the camera/voice egress instead. What matters here is the wiring in
 * `use-voice.ts`, not the audio graph itself (`lib/screen-mix.test.ts` owns
 * that): whether the mix is ever handed the mic stream, and whether the
 * presenter's ordinary microphone publication is muted (as it always was,
 * "junto") or left open (new, "separada" — it is the only path left that
 * carries the voice to anyone at all).
 *
 * `createScreenMix` is mocked rather than driven through a fake `AudioContext`
 * the way `screen-mix.test.ts` does: the question here is which stream
 * `use-voice.ts` PASSES to the mix, never what the mix does with it.
 */

const screenMixInstances: {
  setMic: ReturnType<typeof vi.fn>;
  initialMic: MediaStream | null;
}[] = [];

vi.mock("@/lib/screen-mix", () => ({
  createScreenMix: vi.fn((display: MediaStream, mic: MediaStream | null) => {
    const setMic = vi.fn();
    screenMixInstances.push({ setMic, initialMic: mic });
    return {
      stream: display,
      setMic,
      micIn: () => mic !== null,
      setMicGain: () => {},
      setDisplayGain: () => {},
      micLevelDb: () => null,
      micArchiveStream: () => null,
      outputLevelDb: () => null,
      close: () => {},
    };
  }),
}));

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

/** Every `setMuted` call the SFU session got, in order. */
const mutedCalls: boolean[] = [];

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async (muted: boolean) => {
      mutedCalls.push(muted);
    },
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    unpublishScreenAudio: async () => {},
    publishMicArchive: async () => {},
    unpublishMicArchive: async () => {},
    publishCamera: async () => {},
    unpublishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    reconcileCameraLadder: async () => {},
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setScreenHlsPublishHeight: () => {},
    setReceiveQuality: async () => {},
    setHlsSource: async () => {},
    setAudioDelivery: () => {},
    disconnect: async () => {},
    isConnected: () => true,
  })),
}));

const { createVoiceController } = await import("./use-voice");

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
  g.window = { addEventListener: () => {}, dispatchEvent: () => true };
  try {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  } catch {
    // Already absent.
  }
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, value);
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
    },
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async (constraints: MediaStreamConstraints) =>
        constraints.video ? fakeStream("camera", "video") : fakeStream("mic"),
      getDisplayMedia: async () => fakeStream("screen", "video"),
    },
  });
  // Needed for the mic PIPELINE (gain node on the raw capture), not for
  // `createScreenMix` — that is mocked above, so this file never touches
  // the real audio graph `screen-mix.test.ts` owns.
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
  } as VoiceSignalingMessage;
}

function createTransport() {
  const transport: RealtimeTransport = {
    connect: () => {},
    disconnect: () => {},
    sendChat: () => {},
    sendVoice: () => {},
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
  return { transport };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Joined, in a LiveKit room, mic open. */
async function joinedHost() {
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
  expect(voice.getState().usingSfu).toBe(true);
  return voice;
}

beforeEach(() => {
  installBrowserStubs();
  screenMixInstances.length = 0;
  mutedCalls.length = 0;
});

describe("voiceTrackMode defaults", () => {
  it("starts on 'junto' when nothing was ever chosen", async () => {
    const voice = await joinedHost();
    expect(voice.getState().voiceTrackMode).toBe("junto");
  });
});

describe("starting a watch-party share with the mic already on", () => {
  it("'junto' (default): the mix gets the mic, and the ordinary publication mutes", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    // The mix was built WITH a mic stream, not null.
    expect(screenMixInstances[0]!.initialMic).not.toBeNull();
    // The separate publication goes quiet: the mix already carries it, and a
    // second copy would double every seated listener.
    expect(mutedCalls.at(-1)).toBe(true);
  });

  it("'separada': the mix stays mic-free, and the ordinary publication unmutes", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();

    expect(voice.getState().isSharingScreen).toBe(true);
    // Voice still reaches the audience — just not through this bus.
    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    expect(screenMixInstances[0]!.initialMic).toBeNull();
    // Nothing else carries the voice in this mode, so the publication has to
    // stay open, never muted for "the mix already has it" reasons.
    expect(mutedCalls.at(-1)).toBe(false);
  });
});

describe("flipping the mode on a running share", () => {
  it("moves the mic out of the mix and unmutes the publication live", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(mutedCalls.at(-1)).toBe(true);

    voice.setVoiceTrackMode("separada");
    await settle();

    expect(voice.getState().voiceTrackMode).toBe("separada");
    // setMic(null) is the live move: the running mix drops the mic branch
    // without a republish or an interruption to the share.
    expect(screenMixInstances[0]!.setMic).toHaveBeenLastCalledWith(null);
    expect(mutedCalls.at(-1)).toBe(false);
  });

  it("moves it back into the mix and re-mutes the publication", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(mutedCalls.at(-1)).toBe(false);

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(screenMixInstances[0]!.setMic).toHaveBeenLastCalledWith(
      expect.anything(),
    );
    expect(screenMixInstances[0]!.setMic.mock.calls.at(-1)![0]).not.toBeNull();
    expect(mutedCalls.at(-1)).toBe(true);
  });

  it("is a no-op when set to the mode already in force", async () => {
    const voice = await joinedHost();
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    const callsBefore = screenMixInstances[0]!.setMic.mock.calls.length;
    const mutedBefore = mutedCalls.length;

    voice.setVoiceTrackMode("junto");
    await settle();

    expect(screenMixInstances[0]!.setMic.mock.calls.length).toBe(callsBefore);
    expect(mutedCalls.length).toBe(mutedBefore);
  });
});

describe("turning 'meu mic vai no stream' on while already 'separada'", () => {
  it("builds the mix — mic-free — only once the switch is actually flipped on", async () => {
    const voice = await joinedHost();
    voice.setVoiceTrackMode("separada");
    voice.setMicInStream(false);
    // The switch is off, so the share starts with no mix at all — same as
    // any "junto" share started muted.
    await voice.startScreenShare(false, { watchParty: true });
    await settle();
    expect(screenMixInstances).toHaveLength(0);
    expect(voice.getState().isSharingMic).toBe(false);

    // Flipping it on builds the mix now, and "separada" means mic-free.
    voice.setMicInStream(true);
    await settle();

    expect(voice.getState().isSharingMic).toBe(true);
    expect(screenMixInstances).toHaveLength(1);
    expect(screenMixInstances[0]!.initialMic).toBeNull();
    expect(mutedCalls.at(-1)).toBe(false);
  });
});
