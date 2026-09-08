import type { VoiceSignalingMessage } from "@pqp/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";
import { SPEAKING_HANGOVER_MS, SPEAKING_THRESHOLD } from "@/lib/voice-audio";

/**
 * Voice-activity gate: silence must not leave this machine, speech must open
 * the mic, and a short tail must keep the last syllable.
 */

interface ManagerStub {
  disposed: boolean;
  replacedTracks: number;
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
    const stub: ManagerStub = { disposed: false, replacedTracks: 0 };
    managers.push(stub);
    return {
      setLocalStream: () => {},
      // Null is "nothing measured", which is the old constant: these
      // fakes hold no peer connections to read an uplink from.
      measureUplinkBps: async () => null,
      setLocalScreenStream: async () => {},
      setLocalCameraStream: async () => {},
      setCameraMaxBitrate: () => {},
      setScreenQuality: () => {},
      setPeerCameraStreamId: () => {},
      onPeerStateChange: () => {},
      connectToPeer: () => {},
      removePeer: () => {},
      handleOffer: async () => {},
      handleAnswer: async () => {},
      handleIceCandidate: async () => {},
      retryPeer: async () => {},
      replaceLocalTrack: async () => {
        stub.replacedTracks++;
      },
      setIceServers: () => {},
      dispose: () => {
        stub.disposed = true;
      },
    };
  }),
}));

const sfuMuteLog: boolean[] = [];

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({
    publish: async () => {},
    replaceTrack: async () => {},
    setMuted: async (muted: boolean) => {
      sfuMuteLog.push(muted);
    },
    publishScreen: async () => {},
    unpublishScreen: async () => {},
    publishCamera: async () => {},
    setCameraMaxBitrate: async () => {},
    setScreenMaxBitrate: async () => {},
    setScreenQuality: async () => {},
    setReceiveQuality: async () => {},
    unpublishCamera: async () => {},
    disconnect: async () => {},
    isConnected: () => false,
  })),
}));

const { createVoiceController } = await import("./use-voice");

type TrackStub = { enabled: boolean; stopped: boolean; kind: "raw" | "processed" };

const tracks: TrackStub[] = [];
const rafQueue: FrameRequestCallback[] = [];
const intervalQueue: Array<() => void> = [];
let analyserLevel = 0;
let nowMs = 1_000;

function fakeTrack(kind: TrackStub["kind"]) {
  const track = {
    enabled: true,
    stopped: false,
    kind,
    stop() {
      track.stopped = true;
    },
  };
  tracks.push(track);
  return track;
}

function fakeStream(kind: TrackStub["kind"]) {
  const list = [fakeTrack(kind)];
  return { getTracks: () => list, getAudioTracks: () => list };
}

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  rafQueue.length = 0;
  intervalQueue.length = 0;
  g.requestAnimationFrame = (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };
  g.cancelAnimationFrame = () => {
    rafQueue.length = 0;
  };
  g.setInterval = (cb: TimerHandler) => {
    intervalQueue.push(typeof cb === "function" ? () => cb() : () => {});
    return intervalQueue.length;
  };
  g.clearInterval = () => {
    intervalQueue.length = 0;
  };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => fakeStream("raw"),
    },
  });
  g.AudioContext = class {
    private destinations: { getTracks: () => { stop: () => void }[] }[] = [];
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    createGain() {
      return { gain: { value: 1 }, connect: () => {} };
    }
    createAnalyser() {
      return {
        fftSize: 256,
        frequencyBinCount: 128,
        smoothingTimeConstant: 0,
        connect: () => {},
        getByteFrequencyData(data: Uint8Array) {
          const byte = Math.round(Math.min(1, Math.max(0, analyserLevel)) * 255);
          data.fill(byte);
        },
      };
    }
    createMediaStreamDestination() {
      const stream = fakeStream("processed");
      this.destinations.push(stream);
      return { stream };
    }
    close() {
      for (const stream of this.destinations) {
        for (const track of stream.getTracks()) {
          track.stop();
        }
      }
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

function welcome(roomTransport: "mesh" | "livekit"): VoiceSignalingMessage {
  const self = {
    peerId: PEER,
    userId: "00000000-0000-4000-8000-0000000000cc",
    displayName: "Me",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
  };
  return {
    type: "welcome",
    peerId: PEER,
    voiceChannelId: CHANNEL,
    self,
    peers: [],
    transport: roomTransport,
  };
}

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

function flushVoiceFrame() {
  const cbs = rafQueue.splice(0);
  for (const cb of cbs) {
    cb(nowMs);
  }
}

function flushVoiceActivityPoll() {
  const cbs = intervalQueue.slice();
  for (const cb of cbs) {
    cb();
  }
}

const outgoingOpen = () =>
  tracks.some((track) => track.kind === "processed" && track.enabled && !track.stopped);

async function connected(roomTransport: "mesh" | "livekit" = "mesh") {
  const { transport } = createTransport();
  const voice = createVoiceController(transport);
  if (roomTransport === "livekit") {
    voice.setSessionProvider(async () => sfuSession());
  }
  await voice.join(CHANNEL, { inputMode: "voice-activity" });
  voice.handleSignaling(welcome(roomTransport));
  await settle();
  expect(voice.getState().status).toBe("connected");
  return { voice };
}

beforeEach(() => {
  installBrowserStubs();
  managers.length = 0;
  tracks.length = 0;
  sfuMuteLog.length = 0;
  analyserLevel = 0;
  nowMs = 1_000;
  vi.spyOn(performance, "now").mockImplementation(() => nowMs);
});

describe("voice-activity gate", () => {
  it("joins silent and opens the outgoing track only while speaking", async () => {
    const { voice } = await connected();

    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);

    analyserLevel = SPEAKING_THRESHOLD + 0.05;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(true);
    expect(outgoingOpen()).toBe(true);

    analyserLevel = 0;
    nowMs += SPEAKING_HANGOVER_MS + 20;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);
  });

  it("holds the mic open through the hangover tail", async () => {
    const { voice } = await connected();

    analyserLevel = 0.2;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(true);

    analyserLevel = 0;
    nowMs += SPEAKING_HANGOVER_MS - 40;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(true);
    expect(outgoingOpen()).toBe(true);

    nowMs += 80;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);
  });

  it("stays closed when the level is under the sensitivity line", async () => {
    const { voice } = await connected();
    voice.setVadThreshold(0.2);

    analyserLevel = 0.1;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);

    analyserLevel = 0.25;
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(true);
  });

  it("refuses to open the mic while muted or deafened", async () => {
    const { voice } = await connected();
    analyserLevel = 0.4;

    voice.toggleMute();
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);

    voice.toggleMute();
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(true);

    voice.toggleDeafen();
    flushVoiceFrame();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);
  });

  it("gates LiveKit with the track and only publishes mute for the mute button", async () => {
    const { voice } = await connected("livekit");
    expect(sfuMuteLog.at(-1)).toBe(false);
    expect(outgoingOpen()).toBe(false);
    const mutesAtJoin = sfuMuteLog.length;

    analyserLevel = 0.3;
    flushVoiceFrame();
    expect(outgoingOpen()).toBe(true);
    expect(voice.getState().isTransmitting).toBe(true);
    expect(sfuMuteLog.at(-1)).toBe(false);
    expect(sfuMuteLog.length).toBe(mutesAtJoin);

    analyserLevel = 0;
    nowMs += SPEAKING_HANGOVER_MS + 20;
    flushVoiceFrame();
    expect(outgoingOpen()).toBe(false);
    expect(voice.getState().isTransmitting).toBe(false);
    expect(sfuMuteLog.at(-1)).toBe(false);
    expect(sfuMuteLog.length).toBe(mutesAtJoin);

    voice.toggleMute();
    expect(sfuMuteLog.at(-1)).toBe(true);
    expect(outgoingOpen()).toBe(false);
  });

  it("re-applies LiveKit mute after a publish that replaces the track", async () => {
    const { voice } = await connected("livekit");
    voice.toggleMute();
    expect(sfuMuteLog.at(-1)).toBe(true);
    const mutesAfterButton = sfuMuteLog.length;

    await voice.setInputDevice("other-mic");
    expect(sfuMuteLog.length).toBe(mutesAfterButton + 1);
    expect(sfuMuteLog.at(-1)).toBe(true);
    expect(outgoingOpen()).toBe(false);
  });

  it("opens and closes the gate from the poll when rAF does not tick", async () => {
    const { voice } = await connected();

    // Hidden tab / occluded Electron window: rAF is frozen. The interval
    // still fires, which is what keeps the transmit gate alive.
    analyserLevel = 0.3;
    expect(rafQueue).toHaveLength(1);
    flushVoiceActivityPoll();
    expect(voice.getState().isTransmitting).toBe(true);
    expect(outgoingOpen()).toBe(true);
    expect(rafQueue).toHaveLength(1);

    analyserLevel = 0;
    nowMs += SPEAKING_HANGOVER_MS + 20;
    flushVoiceActivityPoll();
    expect(voice.getState().isTransmitting).toBe(false);
    expect(outgoingOpen()).toBe(false);
  });
});
