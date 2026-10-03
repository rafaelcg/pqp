import type { VoiceSignalingMessage } from "@pqp/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RealtimeTransport } from "@/lib/realtime";

/**
 * `share_high_motion_guard`, wired: the real controller, the real mesh, a fake
 * `RTCPeerConnection` whose sender stats can be made to say "the encoder is
 * behind", and a fake capture that remembers every constraint it is given.
 *
 * What these pin is the wiring, which the state machine's own tests cannot:
 *
 *  - the flag off is the share exactly as it was (no constraint written, the
 *    shell never told anything);
 *  - the flag on, for an ordinary share, verifies the capture's frame rate,
 *    tells the shell a share is live, and steps the capture and the senders
 *    down in place when the stats say so;
 *  - a watch party is never put under it, flag or no flag.
 */

vi.mock("@/lib/sounds", () => ({
  playCue: () => {},
  stopAllSoundLoops: () => {},
  whenCueSettled: async () => {},
}));

vi.mock("@/lib/livekit-session", () => ({
  connectLiveKit: vi.fn(async () => ({})),
}));

const { createVoiceController } = await import("./use-voice");

// ----------------------------------------------------------- fake WebRTC

interface FakeSender {
  track: { id: string; kind: string } | null;
  params: RTCRtpSendParameters;
  setParameters: ReturnType<typeof vi.fn>;
  getParameters: () => RTCRtpSendParameters;
  replaceTrack: ReturnType<typeof vi.fn>;
  getStats: () => Promise<Map<string, unknown>>;
}

const senders: FakeSender[] = [];
/** What every sender's stats say; a test moves it to starve the encoder. */
let encoderBehind = false;
let framesEncoded = 0;

function makeSender(track: { id: string; kind: string }): FakeSender {
  const sender: FakeSender = {
    track,
    params: { encodings: [{}] } as RTCRtpSendParameters,
    getParameters: () => sender.params,
    setParameters: vi.fn(async (next: RTCRtpSendParameters) => {
      sender.params = next;
    }),
    replaceTrack: vi.fn(async (next: { id: string; kind: string } | null) => {
      sender.track = next;
    }),
    getStats: async () => {
      framesEncoded += 120;
      return new Map<string, unknown>([
        [
          "out",
          {
            id: "out",
            type: "outbound-rtp",
            kind: "video",
            frameWidth: 1920,
            frameHeight: 1080,
            framesPerSecond: encoderBehind ? 30 : 60,
            framesEncoded,
            totalEncodeTime: framesEncoded * (encoderBehind ? 0.018 : 0.004),
            bytesSent: framesEncoded * 4_000,
            targetBitrate: 3_000_000,
            qualityLimitationReason: "none",
          },
        ],
      ]);
    },
  };
  senders.push(sender);
  return sender;
}

class FakePeerConnection {
  senders: FakeSender[] = [];
  signalingState = "stable";
  iceConnectionState = "new";
  connectionState = "connected";
  localDescription = { sdp: "fake", type: "offer" };
  remoteDescription = null;
  onicecandidate: unknown = null;
  ontrack: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  onnegotiationneeded: unknown = null;
  onsignalingstatechange: unknown = null;
  addTrack(track: { id: string; kind: string }) {
    const sender = makeSender(track);
    this.senders.push(sender);
    return sender as unknown as RTCRtpSender;
  }
  removeTrack() {}
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return [];
  }
  async createOffer() {
    return { type: "offer", sdp: "fake" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fake" };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async addIceCandidate() {}
  setConfiguration() {}
  close() {}
  async getStats() {
    return new Map();
  }
}

// ----------------------------------------------------------- fake media

const applied: MediaTrackConstraints[] = [];
const shellCalls: boolean[] = [];
/** Track clones the dead-picture watch opened, and the shell's fullscreen answers asked for. */
let clones = 0;
let fullscreenAsks = 0;
let exclusiveFullscreen: boolean | null = true;
/** Interval callbacks the controller (and the guard) registered, by handle. */
const intervals = new Map<number, () => void>();
let nextHandle = 1;
let clock = 1_000_000;

function screenTrack(reportedFps: number) {
  const settings: { frameRate: number; height: number; width: number } = {
    frameRate: reportedFps,
    height: 1080,
    width: 1920,
  };
  let constraints: MediaTrackConstraints = {
    frameRate: { ideal: 60, max: 60 },
    width: { max: 1920 },
    height: { max: 1080 },
  };
  return {
    id: "screen",
    kind: "video",
    enabled: true,
    readyState: "live",
    contentHint: "",
    muted: false,
    onended: null as null | (() => void),
    stop() {
      (this as { readyState: string }).readyState = "ended";
    },
    // For the dead-picture watch (`share_game_capture_hint`): a clone feeds
    // the frame reader, and mute / unmute re-arm it.
    clone() {
      clones += 1;
      return { stop: () => {} };
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    getSettings: () => ({ ...settings }),
    getConstraints: () => constraints,
    applyConstraints: async (next: MediaTrackConstraints) => {
      applied.push(next);
      constraints = next;
      const fps = next.frameRate;
      if (fps && typeof fps === "object" && typeof fps.max === "number") {
        settings.frameRate = fps.max;
      }
      const h = next.height;
      if (h && typeof h === "object" && typeof h.max === "number") {
        settings.height = h.max;
      }
    },
  };
}

function mediaTrack(id: string, kind: "audio" | "video") {
  return { id, kind, enabled: true, contentHint: "", onended: null, stop: () => {} };
}

function mediaStream(id: string, tracks: Array<ReturnType<typeof mediaTrack> | ReturnType<typeof screenTrack>>) {
  return {
    id,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === "audio"),
    getVideoTracks: () => tracks.filter((t) => t.kind === "video"),
    removeTrack: () => {},
  } as unknown as MediaStream;
}

let reportedFps = 60;

function installBrowserStubs() {
  const g = globalThis as unknown as Record<string, unknown>;
  g.requestAnimationFrame = () => 1;
  g.cancelAnimationFrame = () => {};
  g.setInterval = (run: () => void) => {
    const handle = nextHandle++;
    intervals.set(handle, run);
    return handle;
  };
  g.clearInterval = (handle: number) => {
    intervals.delete(handle);
  };
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => mediaStream("mic-stream", [mediaTrack("mic", "audio")]),
      getDisplayMedia: async () => mediaStream("screen-stream", [screenTrack(reportedFps)]),
    },
  });
  // A frame reader that never hands over a frame: the capture of a game the
  // compositor no longer sees (or of a still slide, which is why the shell's
  // answer decides).
  g.MediaStreamTrackProcessor = class {
    readable = {
      getReader: () => ({
        read: () => new Promise(() => {}),
        cancel: () => {},
      }),
    };
  };
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
      return { stream: mediaStream("processed", [mediaTrack("processed", "audio")]) };
    }
    close() {
      return Promise.resolve();
    }
  };
  vi.stubGlobal("window", {
    pqpDesktop: {
      isElectron: true,
      platform: "win32",
      setShareLive: async (live: boolean) => {
        shellCalls.push(live);
        return { live, boost: "raised", processes: 3 };
      },
      fullscreenAppState: async () => {
        fullscreenAsks += 1;
        return { state: "d3d-fullscreen", raw: 3, exclusiveFullscreen };
      },
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    location: { hostname: "localhost" },
  });
}

// ----------------------------------------------------------- fake signaling

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const SELF = "00000000-0000-4000-8000-0000000000b0";
const PEER = "00000000-0000-4000-8000-0000000000b1";

function participant(peerId: string) {
  return {
    peerId,
    userId: `user-${peerId}`,
    displayName: "Someone",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
  };
}

function welcome(): VoiceSignalingMessage {
  return {
    type: "welcome",
    peerId: SELF,
    voiceChannelId: CHANNEL,
    self: participant(SELF),
    peers: [participant(PEER)],
    transport: "mesh",
  };
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
    setCallActive: () => {},
    retryNow: () => {},
    getLastClose: () => null,
    getUnauthorizedStreak: () => 0,
  };
  return transport;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const originalPeerConnection = globalThis.RTCPeerConnection;

beforeEach(() => {
  installBrowserStubs();
  senders.length = 0;
  applied.length = 0;
  shellCalls.length = 0;
  clones = 0;
  fullscreenAsks = 0;
  exclusiveFullscreen = true;
  intervals.clear();
  encoderBehind = false;
  framesEncoded = 0;
  reportedFps = 60;
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = FakePeerConnection;
});

afterEach(() => {
  (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection = originalPeerConnection;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function inCall() {
  const voice = createVoiceController(createTransport());
  await voice.join(CHANNEL);
  voice.handleSignaling(welcome());
  await settle();
  return voice;
}

/** Run every registered interval once per simulated 2 s, `seconds` long. */
async function runIntervals(seconds: number) {
  for (let spent = 0; spent < seconds; spent += 2) {
    clock += 2_000;
    for (const run of [...intervals.values()]) {
      run();
    }
    await settle();
  }
}

const screenSenderParams = () =>
  senders.find((s) => s.track?.id === "screen")?.setParameters.mock.calls.at(-1)?.[0] as
    | RTCRtpSendParameters
    | undefined;

describe("share_high_motion_guard off (the default)", () => {
  it("writes no constraint and tells the shell nothing", async () => {
    reportedFps = 144;
    const voice = await inCall();
    await voice.startScreenShare();
    await settle();
    encoderBehind = true;
    await runIntervals(60);

    expect(applied).toHaveLength(0);
    expect(shellCalls).toEqual([]);
    // The mesh tuning is the ordinary one: no ceiling was ever placed.
    expect(screenSenderParams()?.encodings?.[0]?.maxFramerate).toBe(60);
    await voice.stopScreenShare();
  });
});

describe("share_high_motion_guard on", () => {
  it("reads the capture's frame rate back and asks again when it is over what was requested", async () => {
    reportedFps = 144;
    const voice = await inCall();
    await voice.startScreenShare(false, { shareHighMotionGuard: true, maxFrameRate: 60 });
    await settle();

    expect(applied[0]).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 1080 },
    });
    await voice.stopScreenShare();
  });

  it("leaves a capture that already reports the asked rate alone", async () => {
    reportedFps = 60;
    const voice = await inCall();
    await voice.startScreenShare(false, { shareHighMotionGuard: true, maxFrameRate: 60 });
    await settle();
    expect(applied).toHaveLength(0);
    await voice.stopScreenShare();
  });

  it("tells the shell a share is live, and that it is over", async () => {
    const voice = await inCall();
    await voice.startScreenShare(false, { shareHighMotionGuard: true, maxFrameRate: 60 });
    await settle();
    expect(shellCalls).toEqual([true]);
    await voice.stopScreenShare();
    await settle();
    expect(shellCalls).toEqual([true, false]);
  });

  it("steps the capture and the senders down in place when the encoder is starved", async () => {
    const voice = await inCall();
    await voice.startScreenShare(false, { shareHighMotionGuard: true, maxFrameRate: 60 });
    await settle();
    expect(applied).toHaveLength(0);

    encoderBehind = true;
    // About six seconds of starvation is one step; the readings right after
    // it are not trusted, so twelve seconds is still exactly one.
    await runIntervals(12);

    // Resolution first: 1080 to 720, frame rate untouched.
    const last = applied.at(-1);
    expect(last).toMatchObject({
      frameRate: { ideal: 60, max: 60 },
      width: { max: 1920 },
      height: { max: 720 },
    });
    const encoding = screenSenderParams()?.encodings?.[0];
    expect(encoding?.maxFramerate).toBe(60);
    // A smaller ceiling than an unguarded share of this room gets.
    expect(encoding?.maxBitrate).toBeLessThan(3_000_000);

    // The share ends: the ceiling is let go with it.
    await voice.stopScreenShare();
    await settle();
    expect(shellCalls.at(-1)).toBe(false);
  });

  it("never covers a watch party's share", async () => {
    const voice = await inCall();
    await voice.startScreenShare(false, {
      shareHighMotionGuard: true,
      watchParty: true,
      maxFrameRate: 60,
    });
    await settle();
    encoderBehind = true;
    await runIntervals(60);

    expect(applied).toHaveLength(0);
    expect(shellCalls).toEqual([]);
    await voice.stopScreenShare();
  });

  it("never covers a stream a watch party already opened", async () => {
    const voice = await inCall();
    const stream = mediaStream("party-stream", [screenTrack(144)]);
    await voice.startScreenShare(false, { shareHighMotionGuard: true, stream, maxFrameRate: 60 });
    await settle();
    encoderBehind = true;
    await runIntervals(60);
    expect(applied).toHaveLength(0);
    expect(shellCalls).toEqual([]);
    await voice.stopScreenShare();
  });
});

/**
 * `share_game_capture_hint`, wired: the same controller, a capture whose frame
 * reader never hands over a frame, and a shell that answers the fullscreen
 * question. Off must be today's share exactly: no clone, no question.
 */
describe("share_game_capture_hint", () => {
  it("off (the default): samples nothing and asks the shell nothing", async () => {
    const voice = await inCall();
    await voice.startScreenShare();
    await settle();
    await runIntervals(60);
    expect(clones).toBe(0);
    expect(fullscreenAsks).toBe(0);
    expect(voice.getState().shareCaptureHint).toBeNull();
    await voice.stopScreenShare();
  });

  it("on: a share with no frames while the shell confirms exclusive fullscreen raises the card", async () => {
    const voice = await inCall();
    await voice.startScreenShare(false, { shareGameCaptureHint: true });
    await settle();
    expect(clones).toBe(1);
    await runIntervals(12);
    expect(fullscreenAsks).toBeGreaterThan(0);
    expect(voice.getState().shareCaptureHint).toMatchObject({ kind: "stalled" });
    // The next share answers it.
    await voice.stopScreenShare();
    await voice.startScreenShare(false, { shareGameCaptureHint: true });
    await settle();
    expect(voice.getState().shareCaptureHint).toBeNull();
    await voice.stopScreenShare();
  });

  it("on: a capture that ends by itself in its first minute raises the card only if confirmed", async () => {
    const voice = await inCall();
    await voice.startScreenShare(false, { shareGameCaptureHint: true });
    await settle();
    const track = voice.getState().localScreenStream!.getVideoTracks()[0] as unknown as {
      onended: () => void;
    };
    clock += 5_000;
    track.onended();
    await settle();
    expect(voice.getState().isSharingScreen).toBe(false);
    expect(voice.getState().shareCaptureHint).toMatchObject({ kind: "ended" });

    // The same end with no exclusive-fullscreen app (the window was closed).
    exclusiveFullscreen = false;
    await voice.startScreenShare(false, { shareGameCaptureHint: true });
    await settle();
    const second = voice.getState().localScreenStream!.getVideoTracks()[0] as unknown as {
      onended: () => void;
    };
    clock += 5_000;
    second.onended();
    await settle();
    expect(voice.getState().shareCaptureHint).toBeNull();
  });

  it("on: the same silence with no exclusive-fullscreen app (a still slide) raises nothing", async () => {
    exclusiveFullscreen = false;
    const voice = await inCall();
    await voice.startScreenShare(false, { shareGameCaptureHint: true });
    await settle();
    await runIntervals(60);
    expect(fullscreenAsks).toBeGreaterThan(0);
    expect(voice.getState().shareCaptureHint).toBeNull();
    await voice.stopScreenShare();
  });
});
